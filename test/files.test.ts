import * as path from 'path';
import { FilePatterns, FileMatcher } from "../lib/util/files";

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

test('ignore node_modules', () => {
  const result = negMatch(FILESET1, [
    'node_modules/',
  ]);

  expect(result).toEqual([
    '/bloop.ts',
    '/.eslintrc.js',
    '/subdir/bla.log',
  ]);
});

test('unignore previous ignore', () => {
  const result = negMatch(FILESET1, [
    '*.js',
    '!.eslintrc.js',
  ]);

  expect(result).toEqual([
    '/bloop.ts',
    '/.eslintrc.js',
    '/node_modules/inner',
    '/subdir/bla.log',
  ]);
});

test('ignore rooted path here', () => {
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

  expect(result).toEqual([
    '/bla.log',
    '/sub/subdir/bla.log',
  ]);
});

test('ignore rooted path', () => {
  const result = negMatch(FILESET1, [
    'subdir/bla.log',
  ]);

  expect(result).toEqual([
    '/bloop.ts',
    '/.eslintrc.js',
    '/node_modules/inner',
  ]);
});

test('ignore rooted path with wildcard', () => {
  const result = negMatch(FILESET1, [
    'subdir/*.log',
  ]);

  expect(result).toEqual([
    '/bloop.ts',
    '/.eslintrc.js',
    '/node_modules/inner',
  ]);
});

test('ignore rooted path with ./ prefix', () => {
  const result = negMatch(FILESET1, [
    './subdir/*.log',
  ]);

  expect(result).toEqual([
    '/bloop.ts',
    '/.eslintrc.js',
    '/node_modules/inner',
  ]);
});

test('posmatch in subdirectory', () => {
  const result = posMatch(FILESET1, [
    '*/',
    '*.log',
  ]);

  expect(result).toEqual([
    '/subdir/bla.log',
  ]);
});

test('posmatch inverse to exclude subdirectory', () => {
  const result = posMatch(FILESET1, [
    '*/',
    '*',
    '!subdir',
  ]);

  expect(result).toEqual([
    '/bloop.ts',
    '/.eslintrc.js',
    '/node_modules/inner',
  ]);
});

test('posmatch inverse to exclude subdirectory with slash', () => {
  const result = posMatch(FILESET1, [
    '*/',
    '*',
    '!subdir/',
  ]);

  expect(result).toEqual([
    '/bloop.ts',
    '/.eslintrc.js',
    '/node_modules/inner',
  ]);
});

test('**/* also matches in current directory', () => {
  const result = posMatch(FILESET1, [
    '**/*',
  ]);

  expect(result).toEqual([
    '/bloop.ts',
    '/.eslintrc.js',
    '/node_modules/inner',
    '/subdir/bla.log',
  ]);
});

//----------------------------------------------------------------------

function posMatch(folder: Record<string, any>, patterns: string[]) {
  return walk(folder, new FilePatterns({ directory: '/', patterns }).toIncludeMatcher());
}

function negMatch(folder: Record<string, any>, patterns: string[]) {
  return walk(folder, new FilePatterns({ directory: '/', patterns }).toComplementaryMatcher());
}

function walk(folder: Record<string, any>, matcher: FileMatcher): string[] {
  const ret = new Array<string>();
  const relPaths = [{ path: '/', folder }];
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
