import { promises as fs, Stats } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as log from './log';
import { cachedPromise, errorWithCode, escapeRegExp, mkdict } from './runtime';
import { allGitIgnores, FilePattern, loadPatternFile } from './ignorefiles';
import { IHashable, IMerkleTree, MerkleTree } from './merkle';
import { PROMISE_POOL } from './concurrency';

const hashSym = Symbol();

export interface FileSetSchema {
  readonly relativePaths: string[];
}

/**
 * A set of files, relative to a directory
 */
export class FileSet implements IMerkleTree {
  public static fromSchema(dir: string, schema: FileSetSchema) {
    return new FileSet(dir, schema.relativePaths);
  }

  public static async fromGitignored(root: string, ...extraIgnores: FilePattern[]) {
    const matcher = await IgnoreFileMatcher.fromGitignore(root);
    matcher.addPatterns(...extraIgnores);
    return await FileSet.fromMatcher(root, matcher);
  }

  public static async fromMatcher(root: string, matcher: FileMatcher) {
    const files = new Array<string>();
    await walkFiles(root, matcher, async (f) => { files.push(path.relative(root, f)); });
    return new FileSet(root, files);
  }

  public static async fromDirectory(root: string) {
    return FileSet.fromMatcher(root, ALL_FILES_MATCHER);
  }

  public static fromDirectoryWithIgnores(directory: string, ignorePatterns: string[]) {
    const ignorePattern = new FilePatterns({ directory, patterns: ignorePatterns });
    return FileSet.fromMatcher(directory, ignorePattern.toComplementaryMatcher());
  }

  public readonly elements: Record<string, File>;

  constructor(public readonly root: string, public readonly fileNames: string[]) {
    this.fileNames.sort();
    this.elements = mkdict(fileNames.map(fn => [fn, new File(path.join(root, fn))] as const));
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
    await PROMISE_POOL.all(this.fileNames.map((f) => () => copy(
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

  public hash(): Promise<string> {
    return MerkleTree.hashTree(this);
  }

  public filter(pred: (x: string) => boolean): FileSet {
    return new FileSet(this.root, this.fileNames.filter(pred));
  }

  public toSchema(): FileSetSchema {
    return {
      relativePaths: this.fileNames,
    };
  }

  /**
   * Filter the list of files down to only files that actually exist
   */
  public async onlyExisting() {
    const existing = await PROMISE_POOL.all(this.fileNames.map((f) => async () =>
      exists(path.join(this.root, f))));
    return new FileSet(this.root, this.fileNames.filter((_, i) => existing[i]));
  }
}

export class File implements IHashable {
  constructor(public readonly absPath: string) {
  }

  public hash(): Promise<string> {
    return fileHash(this.absPath);
  }
}

const hashCache = new Map<string, Promise<string>>();

export function TEST_clearFileHashCache() {
  hashCache.clear();
}

export async function fileHash(fullPath: string) {
  const existing = hashCache.get(fullPath);
  if (existing) { return existing; }

  const ret = PROMISE_POOL.queue(async () => {
    const stats = await fs.lstat(fullPath);
    const hash = standardHash();
    if (stats.isSymbolicLink()) {
      hash.update(await fs.readlink(fullPath));
    } else {
      hash.update(await fs.readFile(fullPath));
    }
    return hash.digest('hex');
  });

  hashCache.set(fullPath, ret);
  return ret;
}

export interface FileMatcher {
  visitDirectory(name: string): boolean | Promise<boolean>;
  visitFile(name: string): boolean | Promise<boolean>;
}

export const ALL_FILES_MATCHER: FileMatcher = {
  visitDirectory: () => true,
  visitFile: () => true,
};

export async function walkFiles(root: string, matcher: FileMatcher, visitor: (cb: string) => Promise<void>) {
  const absPaths = [path.resolve(root)];
  while (absPaths.length > 0) {
    const absPath = absPaths.pop()!;
    // opendir is Node 12+, so use readdir instead
    for await (const child of await fs.readdir(absPath, { withFileTypes: true })) {
      const absChildPath = path.join(absPath, child.name);
      if (child.isDirectory() && await matcher.visitDirectory(absChildPath)) {
        absPaths.push(absChildPath);
      }
      if ((child.isFile() || child.isSymbolicLink()) && await matcher.visitFile(absChildPath)) {
        await visitor(absChildPath);
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

/**
 * Matches files based on ignorefiles (.gitignore/.npmignore)
 *
 * Will load more ignore-files as it's encountering them.
 */
export class IgnoreFileMatcher implements FileMatcher {
  private readonly directoriesLoaded = new Set<string>();
  private readonly patterns = new FilePatterns();

  public static async fromGitignore(dir: string) {
    const gitRoot = await findFileUp('.git', dir);
    if (!gitRoot) { throw new Error(`Could not find '.git' upwards of: ${dir}`); }
    return new IgnoreFileMatcher('.gitignore', path.dirname(gitRoot));
  }

  constructor(private readonly patternFileName: string, private readonly rootDirectory: string) {
  }

  public addPatterns(...patterns: FilePattern[]) {
    this.patterns.addPatterns(...patterns);
  }

  public async visitDirectory(name: string): Promise<boolean> {
    await this.primeCache(name);
    return !this.patterns.matches(name, true);
  }

  public async visitFile(name: string): Promise<boolean> {
    await this.primeCache(name);
    return !this.patterns.matches(name, false);
  }

  private async primeCache(name: string) {
    let dir = path.dirname(name);

    while (true) {
      if (this.directoriesLoaded.has(dir)) { return; }
      this.patterns.addPatterns(await loadPatternFile(path.join(dir, this.patternFileName)));
      this.directoriesLoaded.add(dir);

      if (dir === this.rootDirectory) { return; }
      const next = path.dirname(dir);
      if (dir === next) { return; }
      dir = next;
    }
  }
}

interface FileRegex {
  readonly neg: boolean;
  readonly regex: RegExp;
};

interface RegexGroup {
  readonly directory: string;
  readonly regexes: FileRegex[];
};

export class FilePatterns {
  private readonly regexGroups = new Array<RegexGroup>();

  constructor(...patternses: FilePattern[]) {
    this.addPatterns(...patternses);
  }

  public addPatterns(...patternses: FilePattern[]) {
    if (patternses.length === 0) { return; }

    this.regexGroups.push(...patternses.map(patterns => ({
      directory: ensureAbsolute(patterns.directory),
      regexes: patterns.patterns.map(pattern => {
        const neg = pattern.startsWith('!');
        const shortPattern = pattern.replace(/^!/, '');
        const regex = globToRegex(shortPattern);
        return { neg, regex } as FileRegex;
      }),
    } as RegexGroup)));

    // Sort by directories (shortest first)
    this.regexGroups.sort((a, b) => a.directory.localeCompare(b.directory));
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

  public matches(fileName: string, isDir: boolean) {
    ensureAbsolute(fileName);
    if (isDir) { fileName += '/'; }

    let ret = false;
    for (const group of this.regexGroups) {
      if (!isProperChildOf(fileName, group.directory)) { continue; } // Does not apply

      const relativeName = path.relative(group.directory, fileName) + (isDir ? '/' : '');
      for (const regex of group.regexes) {
        if (regex.regex.test(relativeName)) {
          ret = !regex.neg;
        }
      }
    }
    return ret;
  }
}

export async function copy(src: string, target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const targetExists = await exists(target);
  let errorMessage = `Error copying ${src} -> ${target}`;
  try {
    const stat = await fs.lstat(src);
    if (stat.isSymbolicLink()) {
      const linkTarget = await fs.readlink(src);
      errorMessage = `Error copying symlink ${src} (${linkTarget}) -> ${target}`;
      if (targetExists) {
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
      await fs.rmdir(x);
    } else {
      await fs.unlink(x);
    }
  } catch (e) {
    if (e.code === 'ENOENT') { return; }
    throw e;
  }
}

export async function ensureDirForFile(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
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
  try {
    return JSON.parse(await fs.readFile(filename, { encoding: 'utf-8' }));
  } catch (e) {
    throw errorWithCode(e.code, new Error(`While reading ${filename}: ${e}`));
  }
}

export async function readJsonIfExists<A extends object>(filename: string): Promise<A | undefined> {
  try {
    return JSON.parse(await fs.readFile(filename, { encoding: 'utf-8' }));
  } catch (e) {
    if (e.code === 'ENOENT') { return undefined; }
    throw errorWithCode(e.code, new Error(`While reading ${filename}: ${e}`));
  }
}

export async function writeJson<A extends any>(filename: string, obj: A) {
  await fs.writeFile(filename, JSON.stringify(obj, undefined, 2), { encoding: 'utf-8' });
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
    const es = await PROMISE_POOL.all(entries.map((e) => async () => {
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

export interface FileInfo {
  readonly fullPath: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export async function allFilesRecursive(root: string): Promise<FileInfo[]> {
  const ret = new Array<FileInfo>();
  await recurse(root);
  return ret;

  async function recurse(dirName: string) {
    const entries = await fs.readdir(dirName);
    for (const e of entries) {
      const fullPath = path.join(dirName, e);
      const stat = await fs.lstat(fullPath);
      if (stat.isDirectory()) {
        await recurse(fullPath);
      } else {
        ret.push({ fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  }
}

export function newestFirst(a: FileInfo, b: FileInfo) {
  return b.mtimeMs - a.mtimeMs;
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

function ensureAbsolute(fileName: string) {
  if (!path.isAbsolute(fileName)) {
    throw new Error(`Whoops! Expected an absolute path, got: ${fileName}`);
  }
  return fileName;
}

export function isProperChildOf(fileName: string, directory: string) {
  if (!directory.endsWith(path.sep)) { directory += path.sep; }
  return fileName.startsWith(directory);
}