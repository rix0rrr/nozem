import { mkdict } from "./runtime";

export interface Versionable { readonly version: string };

export interface DependencyNode<I extends Versionable> {
  npmDependency: I;
  dependencies?: Record<string, DependencyNode<I>>;
}
export type DependencyTree<I extends Versionable> = Record<string, DependencyNode<I>>;

/**
 * Hoist package-lock dependencies in-place
 */
export function hoistDependencies<I extends Versionable>(packageLockDeps: DependencyTree<I>) {
  // For each node in the tree, remember the dependencies that were originally
  // there so we don't accidentally hoist packages with the wrong versions into
  // the wrong places.
  const originalDependencies = new Map<any, Record<string, string>>();
  recordOriginalDependencies(packageLockDeps);

  let didChange;
  do {
    didChange = false;
    simplify(packageLockDeps);
  } while (didChange);

  // For each of the deps, move each dependency that has the same version into the current array
  function simplify(dependencies: DependencyTree<I>) {
    for (const depPackage of Object.values(dependencies)) {
      moveChildrenUp(depPackage, undefined, dependencies);
    }
    return dependencies;
  }

  // Move the children of the parent onto the same level if there are no conflicts
  function moveChildrenUp(node: DependencyNode<I>, parent: DependencyNode<I> | undefined, parentDependencies: DependencyTree<I>) {
    if (!node.dependencies) { return; }

    // Then push packages from the current node into its parent
    for (const [depName, depPackage] of Object.entries(node.dependencies)) {
      if (!parentDependencies[depName]) {
        if (!hasVersionConflict(parent, depName, depPackage.npmDependency.version)) {
          // It's new and there's no version conflict, we can move it up.
          parentDependencies[depName] = depPackage;
          delete node.dependencies[depName];
          didChange = true;
        }

        // Recurse on the package
        moveChildrenUp(depPackage, parent, parentDependencies);
      } else if (parentDependencies[depName].npmDependency.version === depPackage.npmDependency.version) {
        // Already exists, no conflict, delete the child, no need to recurse
        delete node.dependencies[depName];
        didChange = true;
      } else {
        // First thing we to do is recurse into all children, to simplify them as much as possible
        for (const [_, depPackage] of Object.entries(node.dependencies)) {
          moveChildrenUp(depPackage, node, node.dependencies);
        }
      }
    }

    // Cleanup for nice printing
    if (Object.keys(node.dependencies).length === 0) {
      delete node.dependencies;
      didChange = true;
    }
  }

  function recordOriginalDependencies(tree: DependencyTree<I>) {
    for (const v of Object.values(tree)) {
      if (v.dependencies) {
        const versions = mkdict(Object.entries(v.dependencies).map(([k, v]) => [k, v.npmDependency.version]));
        originalDependencies.set(v, versions);
        recordOriginalDependencies(v.dependencies);
      }
    }
  }

  function hasVersionConflict(parent: any, name: string, version: string) {
    const existingVersion = originalDependencies.get(parent)?.[name];
    return existingVersion !== undefined && existingVersion !== version;
  }
}

export function renderTree(tree: DependencyTree<Versionable>): string[] {
  const ret = new Array<string>();
  recurse(tree, []);
  return ret;

  function recurse(n: DependencyTree<Versionable>, parts: string[]) {
    for (const [k, v] of Object.entries(n)) {
      ret.push([...parts, k].join('.') + '=' + v.npmDependency.version);
      recurse(v.dependencies ?? {}, [...parts, k]);
    }
  }
}