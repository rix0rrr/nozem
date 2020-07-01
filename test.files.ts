import * as path from 'https://deno.land/std@0.56.0/path/mod.ts';
import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { FilePatterns, FileMatcher } from "./files.ts";

const file = '';

const FILESET1 = {
  'bloop.ts': file,
  'node_modules': {
    'inner': file,
  },
  'subdir': {
    'bla.log': file,
  },
  '.eslintrc.js': file,
};

Deno.test('ignore node_modules', () => {
  const result = negMatch(FILESET1, [
    'node_modules/',
  ]);

  assertEquals(result, [
    'bloop.ts',
    '.eslintrc.js',
    'subdir/bla.log',
  ]);
});

Deno.test('unignore previous ignore', () => {
  const result = negMatch(FILESET1, [
    '*.js',
    '!.eslintrc.js',
  ]);

  assertEquals(result, [
    'bloop.ts',
    '.eslintrc.js',
    'node_modules/inner',
    'subdir/bla.log',
  ]);
});

Deno.test('ignore rooted path here', () => {
  const result = negMatch({
    'bla.log': file,
    'subdir': {
      'bla.log': false,
    },
    'sub': {
      'subdir': {
        'bla.log': false,
      },
    },
  }, [
    'subdir/bla.log',
  ]);

  assertEquals(result, [
    'bla.log',
    'sub/subdir/bla.log',
  ]);
});

Deno.test('ignore rooted path', () => {
  const result = negMatch(FILESET1, [
    'subdir/bla.log',
  ]);

  assertEquals(result, [
    'bloop.ts',
    '.eslintrc.js',
    'node_modules/inner',
  ]);
});

Deno.test('posmatch in subdirectory', () => {
  const result = posMatch(FILESET1, [
    '*/',
    '*.log',
  ]);

  assertEquals(result, [
    'subdir/bla.log',
  ]);
});

Deno.test('posmatch inverse to exclude subdirectory', () => {
  const result = posMatch(FILESET1, [
    '*/',
    '*',
    '!subdir',
  ]);

  assertEquals(result, [
    'bloop.ts',
    '.eslintrc.js',
    'node_modules/inner',
  ]);
});

Deno.test('posmatch inverse to exclude subdirectory with slash', () => {
  const result = posMatch(FILESET1, [
    '*/',
    '*',
    '!subdir/',
  ]);

  assertEquals(result, [
    'bloop.ts',
    '.eslintrc.js',
    'node_modules/inner',
  ]);
});

Deno.test('**/* also matches in current directory', () => {
  const result = posMatch(FILESET1, [
    '**/*',
  ]);

  assertEquals(result, [
    'bloop.ts',
    '.eslintrc.js',
    'node_modules/inner',
    'subdir/bla.log',
  ]);
});

//----------------------------------------------------------------------

function posMatch(folder: Record<string, any>, patterns: string[]) {
  return walk(folder, new FilePatterns(patterns).toIncludeMatcher());
}

function negMatch(folder: Record<string, any>, patterns: string[]) {
  return walk(folder, new FilePatterns(patterns).toIgnoreMatcher());
}

function walk(folder: Record<string, any>, matcher: FileMatcher): string[] {
  const ret = new Array<string>();
  const relPaths = [{ path: '.', folder }];
  while (relPaths.length > 0) {
    const relPath = relPaths.splice(0, 1)[0];

    for (const [name, child] of Object.entries(relPath.folder)) {
      const relChildPath = path.join(relPath.path, name);

      if (typeof child === 'object') {
        if (matcher.visitDirectory(relChildPath)) {
          relPaths.push({ path: relChildPath, folder: child });
        }
      }
      if (typeof child !== 'object') {
        if (matcher.visitFile(relChildPath)) {
          ret.push(relChildPath);
        }
      }
    }
  }
  return ret;
}
