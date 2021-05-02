/* eslint-disable @typescript-eslint/member-ordering */
import * as path from 'path';
import { BuildDirectory } from '../build-tools/build-directory';
import { NonHermeticNpmPackageBuild, NozemNpmPackageBuild, NpmPackageBuild } from '../builds/npm-package-build';
import { Workspace } from '../build-tools/workspace';
import { PackageJson } from '../file-schemas';
import { ensureSymlink, FileSet } from '../util/files';
import { debug } from '../util/log';
import { findNpmPackage, npmRuntimeDependencies, readPackageJson } from '../util/npm';
import { cachedPromise, mkdict } from '../util/runtime';
import { IBuildInput } from './build-input';
import { constantHashable, hashOf, IHashable, IHashableElements, MerkleTree } from '../util/merkle';
import { NpmDependencyNode, NpmDependencyTree, PromisedDependencies } from '../npm-installs/copy-install';

const objectCache: any = {};
const hashSym = Symbol();
const sourcesSym = Symbol();


export abstract class NpmDependencyInput implements IBuildInput, IHashableElements {
  public static fromDirectory(workspace: Workspace, packageDirectory: string, alreadyIncluded?: string[]): Promise<NpmDependencyInput> {
    return cachedPromise(objectCache, packageDirectory, async () => {
      const packageJson = await readPackageJson(packageDirectory);

      const trans: PromisedDependencies = {};
      for (const name of npmRuntimeDependencies(packageJson)) {
        if (alreadyIncluded?.includes(name)) {
          debug(`Dependency cycle: ${[...alreadyIncluded.slice(alreadyIncluded.indexOf(name)), name].join(' → ')}`);
          continue;
        }

        const found = await findNpmPackage(name, packageDirectory);

        trans[name] = NpmDependencyInput.fromDirectory(workspace, found, [...alreadyIncluded ?? [], name]);
      }

      if (isMonoRepoPackage(packageDirectory)) {
        const monoRepoBuild = await workspace.npmPackageBuild(packageDirectory);
        if (monoRepoBuild instanceof NozemNpmPackageBuild) {
          return new MonoRepoBuildDependencyInput(packageDirectory, packageJson, trans, monoRepoBuild);
        }
        if (monoRepoBuild instanceof NonHermeticNpmPackageBuild) {
          return new MonoRepoInPlaceBuildDependencyInput(packageDirectory, packageJson, monoRepoBuild);
        }
        throw new Error(`Unrecognized type of NPM package build: ${monoRepoBuild}`);
      }
      return new NpmRegistryDependencyInput(packageDirectory, packageJson, trans);
    });
  }

  public abstract readonly isHashable: boolean;

  constructor(
    protected readonly packageDirectory: string,
    protected readonly packageJson: PackageJson,
    // TransitiveDeps needs to be an set of { string -> Promise }, because
    // yarn's dependency graph is riddled with cyclic dependencies, and otherwise
    // we would be stuck trying to build the dependency graph.
    public readonly transitiveDeps: PromisedDependencies) {
  }

  public get hashableElements(): Promise<Record<string, IHashable>> {
    return new Promise(async (ok, ko) => {
      try {
        const ret: Record<string, IHashable> = {};
        ret['@'] = constantHashable(this.filesIdentifier());
        for (const [name, pkg] of Object.entries(this.transitiveDeps)) {
          ret[name] = await pkg;
        }
        ok(ret);
      } catch (e) {
        ko(e);
      }
    });
  }

  public get version(): string {
    return this.packageJson.version;
  }

  public get name(): string {
    return this.packageJson.name;
  }

  public toJSON() {
    return { name: this.name, version: this.version };
  }

  public async install(dir: BuildDirectory): Promise<void> {
    throw new Error('NPM dependencies are expected to be installed via installAll');
  }

  public async installInto(dir: BuildDirectory, packageDir: string): Promise<void> {
    const files = await this.files();
    await dir.addFiles(files, path.join(packageDir, 'node_modules', this.name));
    await this.installBinLinks(dir, files.root);
  }

  /**
   * Install symlinks to bin scripts in the BuildDirectory, assuming the package has been installed into `installDir`
   */
  public async installBinLinks(dir: BuildDirectory, installDir: string) {
    if (typeof this.packageJson.bin === 'string') {
      const fullBinPath = path.resolve(dir.directory, installDir, this.packageJson.bin);
      await dir.installExecutable(fullBinPath, this.name);
    }
    if (typeof this.packageJson.bin === 'object') {
      for (const [binName, binLoc] of Object.entries(this.packageJson.bin ?? {})) {
        const fullBinPath = path.resolve(dir.directory, installDir, binLoc);
        await dir.installExecutable(fullBinPath, binName);
      }
    }
  }

  public abstract build(): Promise<void>;

  public abstract files(): Promise<FileSet>;

  /**
   * Unique identifier for the set of files backing this NPM dependency
   *
   * - For a built dependency, this is the artifact hash.
   * - For a downloaded dependency, the version number of the package suffices
   *   (because it is guaranteed to be unique by the NPM protocol).
   */
  protected abstract filesIdentifier(): Promise<string>;
}

/**
 * An NPM dependency downloaded from npmjs
 */
export class NpmRegistryDependencyInput extends NpmDependencyInput {
  public readonly isHashable = true;

  public async build() {
  }

  public files() {
    return cachedPromise(this, sourcesSym, () => {
      return FileSet.fromDirectoryWithIgnores(this.packageDirectory, ['node_modules']);
    });
  }

  public filesIdentifier() {
    return Promise.resolve(this.packageJson.version);
  }

  public async symlinkToSource(dir: BuildDirectory, packageDir: string): Promise<void> {
    await ensureSymlink(this.packageDirectory, path.join(dir.directory, packageDir, 'node_modules', this.name));
    await this.installBinLinks(dir, this.packageDirectory);
  }
}

/**
 * Monorepo dependency that is not nozem-compatible
 */
class MonoRepoInPlaceBuildDependencyInput extends NpmDependencyInput {
  public readonly isHashable = false;

  constructor(packageDirectory: string,
    packageJson: PackageJson,
    private readonly packageBuild: NonHermeticNpmPackageBuild) {
    super(packageDirectory, packageJson, {});
  }

  public async build() {
    await this.packageBuild.build();
  }

  public files(): Promise<FileSet> {
    throw new Error(`${this.name} cannot be a Nozem dependency -- it is not a nozem-compatible package`);
  }

  protected filesIdentifier(): Promise<string> {
    throw new Error(`${this.name} cannot be a Nozem dependency -- it is not a nozem-compatible package`);
  }
}

export function isMonoRepoBuildDependencyInput(x: IBuildInput): x is MonoRepoBuildDependencyInput {
  return x instanceof MonoRepoBuildDependencyInput;
}

/**
 * An hermetically built NPM dependency
 */
export class MonoRepoBuildDependencyInput extends NpmDependencyInput {
  public readonly isHashable = true;

  constructor(
    packageDirectory: string,
    packageJson: PackageJson,
    transitiveDeps: PromisedDependencies,
    private readonly packageBuild: NozemNpmPackageBuild) {
      super(packageDirectory, packageJson, transitiveDeps);
  }

  public async build() {
    await this.packageBuild.build();
  }

  public async files() {
    // Remove .ts files that have a corresponding .d.ts file from the artifact set.
    // (If we include the .ts file then downstream TypeScript compiler will prefer
    // the .ts files but they will reference types from devDependencies which may not
    // be available).
    return stripTypescriptSources(await this.packageBuild.build());
  }

  public async filesIdentifier() {
    return this.packageBuild.artifactHash();
  }
}

function isMonoRepoPackage(packageDirectory: string) {
  // FIXME: This could be implemented better but as of now this is cheap
  return !packageDirectory.includes('node_modules');
}

/**
 * Strip files that will mess up downstream TypeScript compilation
 */
function stripTypescriptSources(fs: FileSet) {
  return fs.filter(not(f =>
    // .ts file for which a .d.ts file also exists
    (isTypescriptSourceFile(f) && fs.fileNames.includes(makeTypescriptDeclarationFile(f)))
    // tsconfig but only in the root
    || (f == 'tsconfig.json')
  ));
}

function makeTypescriptDeclarationFile(x: string) {
  return x.replace(/\.ts$/, '.d.ts');
}

function isTypescriptSourceFile(x: string) {
  return x.endsWith('.ts') && !x.endsWith('.d.ts');
}

function not<A>(fn: (x: A) => boolean): (x: A) => boolean {
  return (x) => !fn(x);
}
