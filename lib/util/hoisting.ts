export type DependencyNode<I extends object> = I & {
  version: string;
  dependencies?: DependencySet<I>;
}

export type DependencySet<I extends object> = Record<string, DependencyNode<I>>;

/**
 * Hoist package-lock dependencies in-place
 *
 * This happens in two phases:
 *
 * 1) Move every package into the parent scope (as long as it introduces no conflicts).
 *    This step mutates the dependency tree.
 * 2) Once no more packages can be moved up, clean up the tree. This step mutates the
 *    tree declarations but cannot change versions of required packages. Two cleanups:
 *    2a) Remove duplicates down the tree (same version that is inherited from above)
 *    2b) Remove useless packages that aren't depended upon by anything in that subtree.
 *        To determine whether a package is useful or useless in a tree, we record
 *        each package's original dependencies before we start messing around in the
 *        tree.
 *
 * This two-phase process replaces a proces that did move-and-delete as one step, which
 * sometimes would hoist a package into a place that was previously vacated by a conflicting
 * version, thereby causing the wrong version to be loaded.
 */
export function hoistDependencies<I extends object>(packageTree: DependencyNode<I>) {
  const originalDependencies = new Map<DependencyNode<I>, string[]>();
  recordOriginalDependencies(packageTree);

  let didChange;
  do {
    didChange = false;
    moveUp(packageTree);
  } while (didChange);

  removeDupes(packageTree, []);
  removeUseless(packageTree);

  // Move the children of the parent onto the same level if there are no conflicts
  function moveUp(node: DependencyNode<I>, parent?: DependencyNode<I>) {
    if (!node.dependencies) { return; }

    // Then push packages from the current node into its parent
    if (parent) {
      for (const [depName, depPackage] of Object.entries(node.dependencies)) {
        if (!parent.dependencies?.[depName]) {
          // It's new and there's no version conflict, we can move it up.
          parent.dependencies![depName] = depPackage;
          didChange = true;
        }
      }
    }

    // Recurse
    for (const child of Object.values(node.dependencies)) {
      moveUp(child, node);
    }
  }

  function removeDupes(node: DependencyNode<I>, rootPath: Array<DependencyNode<I>>) {
    if (!node.dependencies) { return; }

    // Any dependencies here that are the same in the parent can be removed
    for (const [depName, depPackage] of Object.entries(node.dependencies)) {
      if (findInheritedDepVersion(depName, rootPath) === depPackage.version) {
        delete node.dependencies[depName];
      }
    }

    // Recurse
    for (const child of Object.values(node.dependencies)) {
      removeDupes(child, [node, ...rootPath]);
    }
  }

  function removeUseless(node: DependencyNode<I>) {
    if (!node.dependencies) { return; }
    for (const [depName, depPkg] of Object.entries(node.dependencies)) {
      if (!necessaryInTree(depName, depPkg.version, node)) {
        delete node.dependencies[depName];
      }
    }

    // Recurse
    for (const child of Object.values(node.dependencies)) {
      removeUseless(child);
    }

    // If we ended up with empty dependencies, just get rid of the key (for clean printing)
    if (Object.keys(node.dependencies).length === 0) {
      delete node.dependencies;
    }
  }

  function findInheritedDepVersion(name: string, parentDependenciesChain: Array<DependencyNode<I>>) {
    for (const deps of parentDependenciesChain) {
      if (deps.dependencies?.[name]) {
        return deps.dependencies[name].version;
      }
    }
    return undefined;
  }

  function recordOriginalDependencies(node: DependencyNode<I>) {
    if (!node.dependencies) { return; }

    let list = originalDependencies.get(node);
    if (!list) {
      list = [];
      originalDependencies.set(node, list);
    }

    for (const [depName, depPkg] of Object.entries(node.dependencies)) {
      list.push(`${depName}@${depPkg.version}`);
      recordOriginalDependencies(depPkg);
    }
  }

  function necessaryInTree(name: string, version: string, tree: DependencyNode<I>) {
    if (originalDependencies.get(tree)?.includes(`${name}@${version}`)) {
      return true;
    }
    if (!tree.dependencies) { return false; }

    for (const depPackage of Object.values(tree.dependencies)) {
      if (necessaryInTree(name, version, depPackage)) { return true; }
    }
    return false;
  }
}

export function renderTree<I extends object>(tree: DependencyNode<I>): string[] {
  const ret = new Array<string>();
  recurse(tree.dependencies ?? {}, []);
  return ret.sort(compareSplit);

  function recurse(n: Record<string, DependencyNode<I>>, parts: string[]) {
    for (const [k, v] of Object.entries(n)) {
      ret.push([...parts, k].join('.') + '=' + v.version);
      recurse(v.dependencies ?? {}, [...parts, k]);
    }
  }

  function compareSplit(a: string, b: string): number {
    // Sort so that: 'a=1', 'a.b=2' get sorted in that order.
    const as = a.split(/\.|=/g);
    const bs = b.split(/\.|=/g);

    for (let i = 0; i < as.length && i < bs.length; i++) {
      const cmp = as[i].localeCompare(bs[i]);
      if (cmp !== 0) { return cmp; }
    }

    return as.length - bs.length;
  }
}
