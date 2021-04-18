import { kStringMaxLength } from "buffer";
import { DependencyNode, DependencyTree, hoistDependencies, renderTree, Versionable } from "../lib/util/hoisting";

type V = Versionable;

test('nonconflicting tree gets flattened', () => {
  // GIVEN
  const tree: DependencyTree<V> = {
    stringutil: {
      npmDependency: { version: '1.0.0' },
      dependencies: {
        leftpad: { npmDependency: { version: '2.0.0' } },
      },
    },
    numutil: {
      npmDependency: { version: '3.0.0' },
      dependencies: {
        isodd: { npmDependency: { version: '4.0.0' } },
      },
    },
  };

  // WHEN
  hoistDependencies(tree);

  // THEN
  expect(tree).toEqual({
    stringutil: { npmDependency: { version: '1.0.0' } },
    leftpad: { npmDependency: { version: '2.0.0' } },
    numutil: { npmDependency: { version: '3.0.0' } },
    isodd: { npmDependency: { version: '4.0.0' } },
  });
});

test('matching versions get deduped', () => {
  // GIVEN
  const tree: DependencyTree<V> = {
    stringutil: {
      npmDependency: { version: '1.0.0' },
      dependencies: {
        leftpad: { npmDependency: { version: '2.0.0' } },
      },
    },
    numutil: {
      npmDependency: { version: '3.0.0' },
      dependencies: {
        leftpad: { npmDependency: { version: '2.0.0' } },
        isodd: { npmDependency: { version: '4.0.0' } },
      },
    },
  };

  // WHEN
  hoistDependencies(tree);

  // THEN
  expect(tree).toEqual({
    stringutil: { npmDependency: { version: '1.0.0' } },
    leftpad: { npmDependency: { version: '2.0.0' } },
    numutil: { npmDependency: { version: '3.0.0' } },
    isodd: { npmDependency: { version: '4.0.0' } },
  });
});

test('conflicting versions get left in place', () => {
  // GIVEN
  const tree: DependencyTree<V> = {
    stringutil: {
      npmDependency: { version: '1.0.0' },
      dependencies: {
        leftpad: { npmDependency: { version: '2.0.0' } },
      },
    },
    numutil: {
      npmDependency: { version: '3.0.0' },
      dependencies: {
        leftpad: { npmDependency: { version: '5.0.0' } },
        isodd: { npmDependency: { version: '4.0.0' } },
      },
    },
  };

  // WHEN
  hoistDependencies(tree);

  // THEN
  expect(tree).toEqual({
    stringutil: { npmDependency: { version: '1.0.0' } },
    leftpad: { npmDependency: { version: '2.0.0' } },
    numutil: {
      npmDependency: { version: '3.0.0' },
      dependencies: {
        leftpad: { npmDependency: { version: '5.0.0' } },
      },
    },
    isodd: { npmDependency: { version: '4.0.0' } },
  });
});

test('dependencies of deduped packages are not hoisted into useless positions', () => {
  // GIVEN
  const tree: DependencyTree<V> = {
    stringutil: pkg('1.0.0', {
      leftpad: pkg('2.0.0', {
        spacemaker: pkg('3.0.0'),
      }),
    }),
    leftpad: pkg('2.0.0', {
      spacemaker: pkg('3.0.0'),
    }),
    spacemaker: pkg('4.0.0'),
  };

  // WHEN
  hoistDependencies(tree);

  // THEN
  expect(renderTree(tree)).toEqual([
    'stringutil=1.0.0',
    'leftpad=2.0.0',
    'leftpad.spacemaker=3.0.0',
    'spacemaker=4.0.0',
  ]);
});

test('dont hoist into a parent if it would cause an incorrect version there', () => {
  // GIVEN
  const tree: DependencyTree<V> = {
    stringutil: { ...pkg('1.0.0'),
      dependencies: {
        spacemaker: pkg('10.0.0'),
        leftPad: { ...pkg('2.0.0'),
          dependencies: {
            spacemaker: pkg('3.0.0'),
          }
        }
      },
    },
    leftPad: pkg('1.0.0'), // Prevents previous leftPad from being hoisted
  };

  // WHEN
  hoistDependencies(tree);

  // THEN
  expect(renderTree(tree)).toEqual([
    'stringutil=1.0.0',
    'stringutil.leftPad=2.0.0',
    'stringutil.leftPad.spacemaker=3.0.0',
    'leftPad=1.0.0',
    'spacemaker=10.0.0',
  ]);
});

test('order of hoisting shouldnt produce a broken situation', () => {
  // GIVEN
  const tree: DependencyTree<V> = {
    stringutil: pkg('1.0.0', {
      wrapper: pkg('100.0.0', {
        leftPad: pkg('2.0.0', {
          spacemaker: pkg('3.0.0'),
        }),
      }),
      spacemaker: pkg('4.0.0'), // Prevents spacemaker from being hoisted here, but then leftPad also shouldn't be
    }),
  };

  // WHEN
  hoistDependencies(tree);

  // THEN
  expect(renderTree(tree)).toEqual([
    'stringutil=1.0.0',
    'stringutil.spacemaker=4.0.0',
    'wrapper=100.0.0',
    'leftPad=2.0.0',
    'spacemaker=3.0.0',
  ]);
});

function pkg(version: string, dependencies?: DependencyTree<V>) {
  return {
    npmDependency: { version },
    ...dependencies? { dependencies } : undefined,
  };
}

