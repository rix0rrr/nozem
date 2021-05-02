import * as path from 'path';
import { BuildDirectory, Workspace } from "../build-tools";
import { NpmDependencyInput } from '../inputs/npm-dependency';
import { ensureSymlink } from "../util/files";
import { constantHashable, hashOf, IHashable, MerkleTree } from '../util/merkle';
import { mkdict } from '../util/runtime';
import { buildNaiveTree, NpmDependencyNode, NpmDependencyTree, PromisedDependencies } from "./copy-install";

/**
 * Install NPM packages by building a symlink farm in a cache
 *
 * Does not use hoisting, but uses symlinks and caching to stay (relatively)
 * cheap.
 *
 * This depends on dependency information being accurately represented and
 * no hoisting being necessary to make dependencies work out. Would have been
 * a good idea but it doesn't work because:
 *
 * - Jest's packages have cyclic dependencies, which this strategy cannot represent
 * - @types/eslint depends on being able to require 'eslint', but did not
 *   declare that package as one of its dependencies.
 */
export abstract class SymlinkFarmInstall {
  public static async installAll(ws: Workspace, dir: BuildDirectory, npmDependencies: NpmDependencyInput[], subdir: string = '.') {
    // Turn list into map
    const deps: PromisedDependencies = {};
    for (const dep of npmDependencies) {
      deps[dep.name] = Promise.resolve(dep);
    }
    // Build tree from map (no hoisting!)
    const packageTree = await buildNaiveTree(deps);

    await this.installSymlinkedDependencyTree(ws, dir, subdir, packageTree.dependencies ?? {});
  }

  private static async installSymlinkedDependencyTree(ws: Workspace, dir: BuildDirectory, subdir: string, tree: NpmDependencyTree) {
    const installed = await Promise.all(Object.entries(tree).map(async ([key, dep]) => {
      const installDir = await this.createNpmDependencyTree(ws, dep);
      await ensureSymlink(installDir, path.join(dir.directory, subdir, 'node_modules', key));

      return [installDir, dep.npmDependency] as const;
    }));

    // Many scripts will try to install the same binaries, and the linking/unlinking processes
    // will trample on each other if installed in parallel; do all of them in serial afterwards.
    // We might still run into version conflicts. Booh.
    for (const [installDir, npmDependency] of installed) {
      await npmDependency.installBinLinks(dir, installDir);
    }
  }

  private static async createNpmDependencyTree(ws: Workspace, node: NpmDependencyNode) {
    const hash = await hashOf(merkleizeNpmDependency(node));

    const cacheName = `${node.npmDependency.name.replace(/[^a-zA-Z0-9]/g, '-')}-${hash}`;

    return ws.nodeFarmCache.obtain(cacheName, async (targetDir) => {
      const files = await node.npmDependency.files();

      // Use hardlinking to save disk space
      await files.hardLinkTo(targetDir);

      // Install every dependency just the same, and then symlink them into OUR node_modules
      await Promise.all(Object.entries(node.dependencies ?? {}).map(async ([key, value]) => {
        const depDir = await this.createNpmDependencyTree(ws, value);
        await ensureSymlink(depDir, path.join(targetDir, 'node_modules', key));
      }));
    });
  }
}

function merkleizeNpmDependency(n: NpmDependencyNode): IHashable {
  return new MerkleTree<IHashable>({
    '@': constantHashable(`${n.npmDependency.name}=${n.version}`),
    ...mkdict(Object.entries(n.dependencies ?? {}).map(([key, value]) =>
      [key, merkleizeNpmDependency(value)] as const)),
  });
}

function* allDependenciesT(node: NpmDependencyTree): IterableIterator<NpmDependencyNode> {
  for (const v of Object.values(node)) {
    yield* allDependencies(v);
  }
}

function* allDependencies(node: NpmDependencyNode) {
  const stack: NpmDependencyNode[] = [node];

  while (stack.length > 0) {
    const next = stack.pop()!;
    yield next;

    stack.push(...Object.values(next.dependencies ?? {}));
  }
}
