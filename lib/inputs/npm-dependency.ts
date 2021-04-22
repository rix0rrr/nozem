import * as path from 'path';
import { BuildDirectory } from '../build-tools/build-directory';
import { NonHermeticNpmPackageBuild, NozemNpmPackageBuild, NpmPackageBuild } from '../builds/npm-package-build';
import { Workspace } from '../build-tools/workspace';
import { PackageJson } from '../file-schemas';
import { FileSet, standardHash } from '../util/files';
import { DependencyNode, DependencySet, hoistDependencies, renderTree } from '../util/hoisting';
import { debug } from '../util/log';
import { findNpmPackage, npmRuntimeDependencies, readPackageJson } from '../util/npm';
import { cachedPromise } from '../util/runtime';
import { IBuildInput } from './build-input';

const objectCache: any = {};
const hashSym = Symbol();
const sourcesSym = Symbol();


type PromisedDependencies = Record<string, Promise<NpmDependencyInput>>;

export abstract class NpmDependencyInput implements IBuildInput {
  public static async fromDirectory(workspace: Workspace, packageDirectory: string, alreadyIncluded?: string[]): Promise<NpmDependencyInput> {
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
      return new NpmRepoDependencyInput(packageDirectory, packageJson, trans);
    });
  }

  public static fromMonoRepoBuild(npmBuild: NpmPackageBuild) {
  }

  constructor(
    protected readonly packageDirectory: string,
    protected readonly packageJson: PackageJson,
    // TransitiveDeps needs to be an set of { string -> Promise }, because
    // yarn's dependency graph is riddled with cyclic dependencies, and otherwise
    // we would be stuck trying to build the dependency graph.
    public readonly transitiveDeps: PromisedDependencies) {
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

  public async hash(): Promise<string> {
    return cachedPromise(this, hashSym, async () => {
      const h = standardHash();
      h.update(`files:${await this.filesIdentifier()}\n`);
      for (const [name, pkg] of Object.entries(this.transitiveDeps)) {
        h.update(`${name}:${await (await pkg).hash()}\n`);
      }
      return h.digest('hex');
    });
  }

  public async install(dir: BuildDirectory): Promise<void> {
    return this.installInto(dir, path.join('node_modules', this.name));
  }

  /**
   * Install hoisted
   */
  public static async installAll(dir: BuildDirectory, npmDependencies: NpmDependencyInput[], subdir: string = '.') {
    // Turn list into map
    const deps: PromisedDependencies = {};
    for (const dep of npmDependencies) {
      deps[dep.name] = Promise.resolve(dep);
    }
    // Build tree from map and hoist
    const packageTree = await buildNaiveTree(deps);
    hoistDependencies(packageTree);

    // Install
    await this.installDependencyTree(dir, subdir, packageTree.dependencies ?? {});
  }

  private static async installDependencyTree(dir: BuildDirectory, subdir: string, tree: NpmDependencyTree) {
    for (const [key, dep] of Object.entries(tree)) {
      const depDir = path.join(subdir, 'node_modules', key);
      await dep.npmDependency.installInto(dir, depDir);
      await this.installDependencyTree(dir, depDir, dep.dependencies ?? {});
    }
  }

  private async installInto(dir: BuildDirectory, subdir: string): Promise<void> {
    const files = await this.files();
    await dir.addFiles(files, subdir);

    if (typeof this.packageJson.bin === 'string') {
      const fullBinPath = path.resolve(dir.directory, subdir, this.packageJson.bin);
      await dir.installExecutable(fullBinPath, this.name, true);
    }
    if (typeof this.packageJson.bin === 'object') {
      for (const [binName, binLoc] of Object.entries(this.packageJson.bin ?? {})) {
        const fullBinPath = path.resolve(dir.directory, subdir, binLoc);
        await dir.installExecutable(fullBinPath, binName);
      }
    }
  }

  public abstract readonly isHashable: boolean;

  public abstract build(): Promise<void>;

  protected abstract files(): Promise<FileSet>;
  protected abstract filesIdentifier(): Promise<string>;
}

class NpmRepoDependencyInput extends NpmDependencyInput {
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

  protected files(): Promise<FileSet> {
    throw new Error(`Cannot get files of this directory -- it is not nozem-compatible`);
  }

  protected filesIdentifier(): Promise<string> {
    throw new Error(`Cannot get hash of this directory -- it is not nozem-compatible`);
  }
}

class MonoRepoBuildDependencyInput extends NpmDependencyInput {
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
    return this.packageBuild.build();
  }

  public async filesIdentifier() {
    return (await this.packageBuild.build()).hash();
  }
}

function isMonoRepoPackage(packageDirectory: string) {
  // FIXME: This could be implemented better but as of now this is cheap
  return !packageDirectory.includes('node_modules');
}

/**
 * Build a naive package tree using a recursion breaker.
 *
 * A -> B -> A -> B -> ...
 *
 * Will be returned as:
 *
 *  A
 *   +- B
 */
async function buildNaiveTree(deps: PromisedDependencies): Promise<NpmDependencyNode> {
  return {
    version: '*',
    npmDependency: undefined as any, // <-- OH NO. This is never looked at anyway, don't know how to make this better.
    dependencies: await recurse(deps, []),
  };

  async function recurse(deps: PromisedDependencies, cycle: string[]) {
    const ret: NpmDependencyTree = {};

    for (const [dep, promise] of Object.entries(deps)) {
      if (!cycle.includes(dep)) {
        const npm = await promise;

        ret[dep] = {
          version: npm.version,
          npmDependency: npm,
          dependencies: await recurse(npm.transitiveDeps, [...cycle, dep]),
        };
      }
    }

    return ret;
  }
}

interface NpmNodeInfo {
  npmDependency: NpmDependencyInput;
}

type NpmDependencyNode = DependencyNode<NpmNodeInfo>;

export type NpmDependencyTree = DependencySet<NpmNodeInfo>;
