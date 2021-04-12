import { promises as fs, Stats } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as log from './log';
import { cachedPromise, escapeRegExp } from './runtime';
import { combinedGitIgnores } from './ignorefiles';

const hashSym = Symbol();

export interface FileSetSchema {
  readonly relativePaths: string[];
}

/**
 * A set of files, relative to a directory
 */
export class FileSet {
  public static fromSchema(dir: string, schema: FileSetSchema) {
    return new FileSet(dir, schema.relativePaths);
  }

  public static async fromGitignored(root: string, extraIgnores?: string[]) {
    const ignores = await combinedGitIgnores(root);
    ignores.push(...extraIgnores ?? []);
    return await FileSet.fromDirectoryWithIgnores(root, ignores);
  }

  public static async fromMatcher(root: string, matcher: FileMatcher) {
    const files = new Array<string>();
    await walkFiles(root, matcher, async (f) => { files.push(f); });
    return new FileSet(root, files);
  }

  public static async fromDirectory(root: string) {
    return FileSet.fromMatcher(root, ALL_FILES_MATCHER);
  }

  public static fromDirectoryWithIgnores(root: string, ignorePatterns: string[]) {
    const ignorePattern = new FilePatterns(ignorePatterns);
    return FileSet.fromMatcher(root, ignorePattern.toComplementaryMatcher());
  }

  constructor(public readonly root: string, public readonly fileNames: string[]) {
    this.fileNames.sort();
  }

  public get fullPaths() {
    return this.fileNames.map(f => this.absPath(f));
  }

  public absPath(f: string) {
    return path.join(this.root, f);
  }

  public print() {
    for (const f of this.fileNames) {
      console.log(f);
    }
  }

  public async copyTo(targetDir: string): Promise<FileSet> {
    await promiseAllBatch(8, this.fileNames.map((f) => () => copy(
        path.join(this.root, f),
        path.join(targetDir, f))));

    return this.rebase(targetDir);
  }

  public rebase(newDirectory: string) {
    return new FileSet(newDirectory, this.fileNames);
  }

  public except(rhs: FileSet) {
    const ignorePaths = new Set(rhs.fileNames);
    return new FileSet(this.root, this.fileNames.filter(f => !ignorePaths.has(f)));
  }

  public async hash() {
    return cachedPromise(this, hashSym, async () => {
      const start = Date.now();

      const d = standardHash();

      // error: Uncaught Error: Too many open files (os error 24)
      d.update(await this.fileHashes());

      const delta = (Date.now() - start) / 1000;
      if (delta > 2) {
        log.warning(`Hashing ${this.root} (${this.fileNames.length} files) took ${delta.toFixed(1)}s`);
      }

      return d.digest('hex');
    });
  }

  public toSchema(): FileSetSchema {
    return {
      relativePaths: this.fileNames,
    };
  }

  public async fileHashes() {
    return (await promiseAllBatch(4, this.fileNames.map((file) => async () => {
      const fullPath = path.join(this.root, file);
      return `${file}\n${await fileHash(fullPath)}\n`;
    }))).join('');
  }
}

const hashCache = new Map<string, string>();

async function fileHash(fullPath: string) {
  /*
  const existing = hashCache.get(fullPath);
  if (existing) { return existing; }
  */

  const stats = await fs.lstat(fullPath);
  const hash = standardHash();
  if (stats.isSymbolicLink()) {
    hash.update(await fs.readlink(fullPath));
  } else {
    hash.update(await fs.readFile(fullPath));
  }
  const ret = hash.digest('hex');
  /*
  hashCache.set(fullPath, ret);
  */
  return ret;
}

export interface FileMatcher {
  visitDirectory(name: string): boolean;
  visitFile(name: string): boolean;
}

export const ALL_FILES_MATCHER: FileMatcher = {
  visitDirectory: () => true,
  visitFile: () => true,
};

export async function walkFiles(root: string, matcher: FileMatcher, visitor: (cb: string) => Promise<void>) {
  const relPaths = ['.'];
  while (relPaths.length > 0) {
    const relPath = relPaths.pop()!;
    // opendir is Node 12+, so use readdir instead
    for await (const child of await fs.readdir(path.join(root, relPath), { withFileTypes: true })) {
      const relChildPath = path.join(relPath, child.name);
      if (child.isDirectory() && matcher.visitDirectory(relChildPath)) {
        relPaths.push(relChildPath);
      }
      if ((child.isFile() || child.isSymbolicLink()) && matcher.visitFile(relChildPath)) {
        await visitor(relChildPath);
      }
    }
  }
}

function globToRegex(pattern: string) {
  const matchAnywhere = [pattern.length - 1, -1].includes(pattern.indexOf('/'));
  const mustMatchDir = pattern.endsWith('/');

  // Starting with '/' or './' just means 'match here'
  if (pattern.startsWith('/')) { pattern = pattern.substr(1); }
  else if (pattern.startsWith('./')) { pattern = pattern.substr(2); }

  const regexParts = [];
  const globChars = /\*\*\/|\*/g;

  let match: RegExpExecArray | null;
  let start = 0;
  while ((match = globChars.exec(pattern))) {
    regexParts.push(escapeRegExp(pattern.substring(start, match.index)));
    start = globChars.lastIndex;

    switch (match[0]) {
      case '*':
        regexParts.push('[^/]*');
        break;
      case '**/':
        regexParts.push('(|.*\/)');
        break;
    }
  }
  regexParts.push(escapeRegExp(pattern.substring(start)));

  const dirSuffix = mustMatchDir ? '$' /* Pattern already contains literal / */ : '($|/)';

  if (matchAnywhere) {
    return new RegExp(`(^|/)${regexParts.join('')}${dirSuffix}`);
  }
  return new RegExp(`^${regexParts.join('')}${dirSuffix}`);
}

export class FilePatterns {
  private readonly regexes = new Array<{ neg: boolean, regex: RegExp }>();
  private _patternHash?: string;

  constructor(private readonly patterns: string[]) {
    for (const pattern of patterns) {
      const neg = pattern.startsWith('!');
      const shortPattern = pattern.replace(/^!/, '');
      const regex = globToRegex(shortPattern);
      this.regexes.push({ neg, regex });
    }
  }

  public patternHash() {
    if (!this._patternHash) {
      const d = standardHash();
      for (const file of this.patterns) {
        d.update(`${file}\n`);
      }
      this._patternHash = d.digest('hex');
    }
    return this._patternHash;
  }

  public toIncludeMatcher(): FileMatcher {
    return {
      visitDirectory: (dirname) => this.matches(dirname, true),
      visitFile: (filename) => this.matches(filename, false),
    };
  }

  public toComplementaryMatcher(): FileMatcher {
    return {
      visitDirectory: (dirname) => !this.matches(dirname, true),
      visitFile: (filename) => !this.matches(filename, false),
    };
  }

  public matches(file: string, isDir: boolean) {
    if (isDir) { file += '/'; }
    let ret = false;
    for (const pattern of this.regexes) {
      if (pattern.regex.test(file)) {
        ret = !pattern.neg;
      }
    }
    return ret;
  }
}

export async function copy(src: string, target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  let errorMessage = `Error copying ${src} -> ${target}`;
  try {
    const stat = await fs.lstat(src);
    if (stat.isSymbolicLink()) {
      const linkTarget = await fs.readlink(src);
      errorMessage = `Error copying symlink ${src} (${linkTarget}) -> ${target}`;
      if (await exists(target)) {
        await fs.unlink(target);
      }
      await fs.symlink(linkTarget, target);
    } else {
      await fs.copyFile(src, target);
    }
  } catch (e) {
    log.error(errorMessage);
    throw e;
  }
}

/**
 * Resolve a number of promises concurrently
 *
 * Some concurrency is good but too much concurrency actually breaks
 * (copying ~4k files concurrently completely locks up my machine).
 *
 * Control the concurrency.
 */
async function promiseAllBatch<A>(n: number, thunks: Array<() => Promise<A>>): Promise<A[]> {
  const ret: A[] = [];

  let active = 0;
  let next = 0;
  let failed = false;
  return new Promise((ok, ko) => {
    function launchMore() {
      if (failed) { return; }

      // If there's no work left to do and nothing in progress, we're done
      if (next === thunks.length && active === 0) {
        ok(ret);
      }

      // Launch as many parallel "threads" as we can
      while (active < n && next < thunks.length) {
        const index = next++;
        active++;

        thunks[index]().then(result => {
          active--;
          ret[index] = result;
          launchMore();
        }).catch(fail);
      }
    }

    function fail(e: Error) {
      failed = true;
      ko(e);
    }

    launchMore();
  });
}

export function standardHash() {
  return crypto.createHash('sha1');
}

export async function exists(s: string, cb?: (s: Stats) => boolean) {
  try {
    const st = await fs.lstat(s);
    return cb === undefined || cb(st);
  } catch (e) {
    if (e.code === 'ENOENT') { return false; }
    throw e;
  }
}

export async function rimraf(x: string) {
  try {
    const s = await fs.lstat(x);
    if (s.isDirectory()) {
      for (const child of await fs.readdir(x)) {
        await rimraf(path.join(x, child));
      }
    } else {
      await fs.unlink(x);
    }
  } catch (e) {
    if (e.code === 'ENOENT') { return; }
    throw e;
  }
}

export async function ensureSymlink(target: string, filePath: string, overwrite?: boolean) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.symlink(target, filePath);
  } catch (e) {
    if (e.code !== 'EEXIST') { throw e; }
    await fs.unlink(filePath);
    await fs.symlink(target, filePath);
  }
}

export async function readJson(filename: string) {
  return JSON.parse(await fs.readFile(filename, { encoding: 'utf-8' }));
}

export async function readJsonIfExists(filename: string): Promise<any | undefined> {
  try {
    return JSON.parse(await fs.readFile(filename, { encoding: 'utf-8' }));
  } catch (e) {
    if (e.code === 'ENOENT') { return undefined; }
    throw e;
  }
}

export async function writeJson(filename: string, obj: any) {
  await fs.writeFile(filename, JSON.stringify(obj, undefined, 2), { encoding: 'utf-8' });
}

export function globMany(root: string, globs: string[]): Promise<FileSet> {
  return FileSet.fromMatcher(root, new FilePatterns(['*/', ...globs]).toIncludeMatcher());
}

export async function ignoreEnoent(block: () => Promise<void>): Promise<void> {
  try {
    await block();
  } catch (e) {
    if (e.code !== 'ENOENT') { throw e; }
  }
}

export async function removeOldSubDirectories(n: number, dirName: string) {
  return ignoreEnoent(async () => {
    const entries = await fs.readdir(dirName);
    const es = await promiseAllBatch(8, entries.map((e) => async () => {
      const fullPath = path.join(dirName, e);
      return { fullPath, mtime: (await fs.lstat(fullPath)).mtimeMs };
    }));
    es.sort((a, b) => a.mtime - b.mtime);
    while (es.length > n) {
      const first = es.splice(0, 1)[0];
      await rimraf(first.fullPath);
    }
  });
}

export async function pathExists(f: string) {
  try {
    await fs.stat(f);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') { return false; }
    throw e;
  }
}

/**
 * Find the most specific file with the given name up from the startin directory
 */
export async function findFileUp(filename: string, startDir: string, rootDir?: string): Promise<string | undefined> {
  const ret = await findFilesUp(filename, startDir, rootDir);
  return ret.length > 0 ? ret.pop() : undefined;
}

/**
 * Find all files with the given name up from the starting directory
 *
 * Returns the most specific file at the end.
 */
export async function findFilesUp(filename: string, startDir: string, isRootDir?: string | ((x: string) => Promise<boolean>)): Promise<string[]> {
  const ret = new Array<string>();

  startDir = path.resolve(startDir);

  if (typeof isRootDir === 'string') {
    const resolvedRoot = path.resolve(isRootDir);
    isRootDir = (x: string) => Promise.resolve(x === resolvedRoot);
  }

  let currentDir = startDir;
  while (true) {
    const fullPath = path.join(currentDir, filename);
    if (await exists(fullPath)) {
      ret.push(fullPath);
    }

    if (isRootDir && await isRootDir(currentDir)) { break; }
    const next = path.dirname(currentDir);
    if (next === currentDir) { break; }
    currentDir = next;
  }

  // Most specific file at the end
  return ret.reverse();
}
