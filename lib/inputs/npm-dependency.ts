import * as path from 'path';
import { BuildDirectory } from '../builds1/build-directory';
import { NpmPackageBuild } from '../builds1/npm-package-build';
import { Workspace } from '../builds1/workspace';
import { PackageJson } from '../file-schemas';
import { FileSet, standardHash } from '../util/files';
import { DependencyNode, DependencySet, hoistDependencies, renderTree } from '../util/hoisting';
import { debug } from '../util/log';
import { findNpmPackage, npmRuntimeDependencies, readPackageJson } from '../util/npm';
import { cachedPromise, mkdict } from '../util/runtime';
import { IBuildInput } from './build-input';

const objectCache: any = {};
const hashSym = Symbol();
const sourcesSym = Symbol();


type PromisedDependencies = Record<string, Promise<NpmDependencyInput>>;

export abstract class NpmDependencyInput implements IBuildInput {
  public static async fromDirectory(workspace: Workspace, packageDirectory: string, alreadyIncluded?: string[]) {
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

      return isMonoRepoPackage(packageDirectory)
        ? new MonoRepoBuildDependencyInput(packageDirectory, packageJson, trans, await workspace.npmPackageBuild(packageDirectory))
        : new NpmRepoDependencyInput(packageDirectory, packageJson, trans);
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
    // console.log(renderTree(packageTree).join('\n'));
    console.log('begin hoist');
    hoistDependencies(packageTree);
    console.log('end hoist');
    // console.log('----------');
    // console.log(renderTree(packageTree).join('\n'));

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

  protected abstract files(): Promise<FileSet>;
  protected abstract filesIdentifier(): Promise<string>;
}

class NpmRepoDependencyInput extends NpmDependencyInput {
  public files() {
    return cachedPromise(this, sourcesSym, () => {
      return FileSet.fromDirectoryWithIgnores(this.packageDirectory, ['node_modules']);
    });
  }
  public filesIdentifier() {
    return Promise.resolve(this.packageJson.version);
  }
}

class MonoRepoBuildDependencyInput extends NpmDependencyInput {
  constructor(
    packageDirectory: string,
    packageJson: PackageJson,
    transitiveDeps: PromisedDependencies,
    private readonly build: NpmPackageBuild) {
      super(packageDirectory, packageJson, transitiveDeps);
  }

  public async files() {
    return this.build.build();
  }

  public async filesIdentifier() {
    return (await this.build.build()).hash();
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
