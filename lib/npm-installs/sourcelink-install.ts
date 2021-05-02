import * as path from 'path';
import { BuildDirectory } from "../build-tools";
import { NpmDependencyInput, NpmRegistryDependencyInput } from "../inputs/npm-dependency";
import { DependencyNode, DependencySet, hoistDependencies } from './hoisting';

export type PromisedDependencies = Record<string, Promise<NpmDependencyInput>>;

/**
 * Install NPM packages by symlinking to source
 *
 * Similar to the copy install, but for registry dependencies
 * create a symlink to the source location of the package instead of
 * copying the files.
 *
 * This relies on the observation that Yarn has already created the correct
 * symlink farms WITH hoisting for us for all packages, and so we might as well
 * reuse that. Since the packages can be treated as effectively immutable, it shouldn't
 * change behavior.
 *
 * This only works for Repo packages, not for monorepo packages -- those
 * still need to be copied.
 */
export class NpmSourceLinkInstall {
  constructor(private readonly npmDependencies: NpmDependencyInput[]) {
  }

  public async installAll(dir: BuildDirectory, subdir: string = '.') {
    const packageTree = await hoistedDependencyTree(this.npmDependencies);

    // Install
    await this.installDependencyTree(dir, subdir, packageTree.dependencies ?? {});
  }

  private async installDependencyTree(dir: BuildDirectory, subdir: string, tree: NpmDependencyTree) {
    await Promise.all(Object.entries(tree).map(async ([key, dep]) => {
      const shouldRecurse = await this.installDependencyNode(dir, subdir, dep);
      if (!shouldRecurse) { return; }

      const depDir = path.join(subdir, 'node_modules', key);
      await this.installDependencyTree(dir, depDir, dep.dependencies ?? {});
    }));
  }

  private async installDependencyNode(dir: BuildDirectory, subdir: string, node: NpmDependencyNode): Promise<boolean> {
    if (node.npmDependency instanceof NpmRegistryDependencyInput) {
      await node.npmDependency.symlinkToSource(dir, subdir);
      return false;
    }
    await node.npmDependency.installInto(dir, subdir);
    return true;
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


export function makeDependencyTree(npmDependencies: NpmDependencyInput[]) {
  // Turn list into map
  const deps: PromisedDependencies = {};
  for (const dep of npmDependencies) {
    deps[dep.name] = Promise.resolve(dep);
  }
  // Build tree from map and hoist
  return buildNaiveTree(deps);
}

export async function hoistedDependencyTree(npmDependencies: NpmDependencyInput[]) {
  const packageTree = await makeDependencyTree(npmDependencies);
  hoistDependencies(packageTree);
  return packageTree;
}
