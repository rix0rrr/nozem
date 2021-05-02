import * as path from 'path';
import { BuildDirectory } from "../build-tools";
import { NpmDependencyInput } from "../inputs/npm-dependency";
import { DependencyNode, DependencySet, hoistDependencies } from '../util/hoisting';

export type PromisedDependencies = Record<string, Promise<NpmDependencyInput>>;

/**
 * Install NPM packages by copying files
 *
 * Hoist to reduce useless copies in the dependency tree.
 *
 * Also because Jest is a rat's nest of a cyclic dependencies
 * (https://github.com/facebook/jest/issues/9712) and otherwise we'll never be
  * able to properly install these.
 *
 * Produces a dependency tree equivalent to what Yarn/NPM would produce, but gets
 * expensive for a big list of dependencies.
 */
export abstract class NpmCopyInstall {
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
    await Promise.all(Object.entries(tree).map(async ([key, dep]) => {
      await dep.npmDependency.installInto(dir, subdir);
      const depDir = path.join(subdir, 'node_modules', key);
      await this.installDependencyTree(dir, depDir, dep.dependencies ?? {});
    }));
  }
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
export async function buildNaiveTree(baseDeps: PromisedDependencies): Promise<NpmDependencyNode> {
  return {
    version: '*',
    npmDependency: undefined as any, // <-- OH NO. This is never looked at anyway, don't know how to make this better.
    dependencies: await recurse(baseDeps, []),
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

export type NpmDependencyNode = DependencyNode<NpmNodeInfo>;
export type NpmDependencyTree = DependencySet<NpmNodeInfo>;
