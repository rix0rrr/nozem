import * as path from 'path';
import { BuildDirectory } from "../build-tools";
import { NpmDependencyInput, NpmRegistryDependencyInput } from "../inputs/npm-dependency";
import { hoistedDependencyTree, NpmDependencyNode, NpmDependencyTree } from './copy-install';
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
    // In an attempt to have to create fewer symlinks: we only have to
    // hoist through Monorepo dependencies -- registry dependencies can be
    // fully symlinked as their dependencies will have been satisfied in-source-location
    // by Yarn, but Monorepo dependencies require re-linked dependencies
    // in the root.
    //
    // If we don't do this, we hoist everything to the top-level but that
    // requires making more symlinks. Saves ~1/3rd of symlinking time but
    // requires that all packages have accurate dependencies.
    const limitHoisting = !!process.env.NZM_LIMIT_HOISTING;

    const shouldHoistInside = limitHoisting
      // Recurse only into non-registry dependencies (registry deps can be linked wholesale)
      ? (n: NpmDependencyNode) => !(n.npmDependency instanceof NpmRegistryDependencyInput)
      : undefined;

    const packageTree = await hoistedDependencyTree(this.npmDependencies, shouldHoistInside);

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