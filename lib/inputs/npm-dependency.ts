import * as path from 'path';
import { BuildDirectory } from '../builds1/build-directory';
import { NpmPackageBuild } from '../builds1/npm-package-build';
import { PackageJson } from '../file-schemas';
import { FileSet, standardHash } from '../util/files';
import { debug } from '../util/log';
import { findNpmPackage, npmRuntimeDependencies, readPackageJson } from '../util/npm';
import { cachedPromise } from '../util/runtime';
import { IBuildInput } from './build-input';

const objectCache: any = {};
const hashSym = Symbol();
const sourcesSym = Symbol();


type PromisedDependencies = Record<string, Promise<NpmDependencyInput>>;

export abstract class NpmDependencyInput implements IBuildInput {
  public static async fromDirectory(packageDirectory: string, alreadyIncluded?: string[]) {
    return cachedPromise(objectCache, packageDirectory, async () => {
      const packageJson = await readPackageJson(packageDirectory);

      const trans: PromisedDependencies = {};
      for (const name of npmRuntimeDependencies(packageJson)) {
        if (alreadyIncluded?.includes(name)) {
          debug(`Dependency cycle: ${[...alreadyIncluded.slice(alreadyIncluded.indexOf(name)), name].join(' → ')}`);
          continue;
        }

        const found = await findNpmPackage(name, packageDirectory);
        trans[name] = NpmDependencyInput.fromDirectory(found, [...alreadyIncluded ?? [], name]);
      }

      return isMonoRepoPackage(packageDirectory)
        ? new MonoRepoBuildDependencyInput(packageDirectory, packageJson, trans, await NpmPackageBuild.fromCache(packageDirectory))
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
  public static async installAll(dir: BuildDirectory, npmDependencies: NpmDependencyInput[]) {
    // Turn list into map
    const deps: PromisedDependencies = {};
    for (const dep of npmDependencies) {
      deps[dep.name] = Promise.resolve(dep);
    }
    // Build tree from map and hoist
    const packageTree = await buildNaiveTree(deps);
    hoistDependencies(packageTree);

    // Install
    await this.installDependencyTree(dir, '.', packageTree);
  }

  private static async installDependencyTree(dir: BuildDirectory, subdir: string, tree: DependencyTree) {
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

  public files() {
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
function buildNaiveTree(deps: PromisedDependencies): Promise<DependencyTree> {
  return recurse(deps, []);

  async function recurse(deps: PromisedDependencies, cycle: string[]) {
    const ret: Record<string, DependencyNode> = {};

    for (const [dep, promise] of Object.entries(deps)) {
      if (!cycle.includes(dep)) {
        const npm = await promise;

        ret[dep] = {
          npmDependency: npm,
          dependencies: await recurse(npm.transitiveDeps, [...cycle, dep]),
        };
      }
    }

    return ret;
  }
}

interface DependencyNode {
  npmDependency: NpmDependencyInput;
  dependencies?: Record<string, DependencyNode>;
}

type DependencyTree = Record<string, DependencyNode>;

/**
 * Hoist package-lock dependencies in-place
 */
function hoistDependencies(packageLockDeps: Record<string, DependencyNode>) {
  let didChange;
  do {
    didChange = false;
    simplify(packageLockDeps);
  } while (didChange);

  // For each of the deps, move each dependency that has the same version into the current array
  function simplify(dependencies: Record<string, DependencyNode>) {
    for (const depPackage of Object.values(dependencies)) {
      moveChildrenUp(depPackage, dependencies);
    }
    return dependencies;
  }

  // Move the children of the parent onto the same level if there are no conflicts
  function moveChildrenUp(parent: DependencyNode, parentContainer: Record<string, DependencyNode>) {
    if (!parent.dependencies) { return; }

    // Then push packages from the mutable parent into ITS parent
    for (const [depName, depPackage] of Object.entries(parent.dependencies)) {
      if (!parentContainer[depName]) {
        // It's new, we can move it up.
        parentContainer[depName] = depPackage;
        delete parent.dependencies[depName];
        didChange = true;

        // Recurse on the package we just moved
        moveChildrenUp(depPackage, parentContainer);
      } else if (parentContainer[depName].npmDependency.version === depPackage.npmDependency.version) {
        // Already exists, no conflict, delete the child, no need to recurse
        delete parent.dependencies[depName];
        didChange = true;
      } else {
        // There is a conflict, leave the second package where it is, but do recurse.
        moveChildrenUp(depPackage, parent.dependencies);
      }
    }

    // Cleanup for nice printing
    if (Object.keys(parent.dependencies).length === 0) {
      delete parent.dependencies;
      didChange = true;
    }
  }
}