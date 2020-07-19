import * as fs from 'https://deno.land/std@0.56.0/fs/mod.ts';
import * as log from 'https://deno.land/std@0.56.0/log/mod.ts';
import * as path from 'https://deno.land/std@0.56.0/path/mod.ts';
import { Sha1 as Digest } from 'https://deno.land/std/hash/sha1.ts';

export class FileSet {
  public static async fromFileSystem(root: string, matcher: FileMatcher) {
    const files = new Array<string>();
    await walkFiles(root, matcher, async (f) => { files.push(f); });
    return new FileSet(root, files);
  }

  public static async fromDirectory(root: string) {
    return FileSet.fromFileSystem(root, ALL_FILES_MATCHER);
  }

  private _hash?: string;

  constructor(public readonly root: string, public readonly files: string[]) {
    this.files.sort();
  }

  public absPath(f: string) {
    return path.join(this.root, f);
  }

  public print() {
    for (const f of this.files) {
      console.log(f);
    }
  }

  public async copyTo(targetDir: string) {
    return promiseAllBatch(8, this.files.map((f) => () => copy(
        path.join(this.root, f),
        path.join(targetDir, f))));
  }

  public async hash() {
    if (this._hash === undefined) {
      const start = Date.now();

      const d = new Digest();

       // error: Uncaught Error: Too many open files (os error 24)
      d.update((await promiseAllBatch(8, this.files.map((file) => async () => {
        const fullPath = path.join(this.root, file);
        if ((await Deno.lstat(fullPath)).isSymlink) {
          return `${file}\n${await Deno.readLink(fullPath)}\n`;
        } else {
          return `${file}\n${await Deno.readFile(fullPath)}\n`;
        }
      }))).join(''));

      /*
      for (const file of this.files) {
        d.update(file);
        d.update('\n');

        const fullPath = path.join(this.root, file);
        if ((await Deno.lstat(fullPath)).isSymlink) {
          d.update(await Deno.readLink(fullPath));
        } else {
          d.update(await Deno.readFile(fullPath));
        }
        d.update('\n');
      }
      */

      const delta = (Date.now() - start) / 1000;
      if (delta > 2) {
        log.warning(`Hashing ${this.root} (${this.files.length} files) took ${delta.toFixed(1)}s`);
      }

      this._hash = d.hex();
    }

    return this._hash;
  }
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
    for await (const child of Deno.readDir(path.join(root, relPath))) {
      const relChildPath = path.join(relPath, child.name);
      if (child.isDirectory && matcher.visitDirectory(relChildPath)) {
        relPaths.push(relChildPath);
      }
      if ((child.isFile || child.isSymlink) && matcher.visitFile(relChildPath)) {
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

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
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
      const d = new Digest();
      for (const file of this.patterns) {
        d.update(`${file}\n`);
      }
      this._patternHash = d.hex();
    }
    return this._patternHash;
  }

  public toIncludeMatcher(): FileMatcher {
    return {
      visitDirectory: (dirname) => this.matches(dirname, true),
      visitFile: (filename) => this.matches(filename, false),
    };
  }

  public toIgnoreMatcher(): FileMatcher {
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
  await fs.ensureDir(path.dirname(target));
  let errorMessage = `Error copying ${src} -> ${target}`;
  try {
    const stat = await Deno.lstat(src);
    if (stat.isSymlink) {
      const linkTarget = await Deno.readLink(src);
      errorMessage = `Error copying symlink ${src} (${linkTarget}) -> ${target}`;
      if (await fs.exists(target)) {
        await Deno.remove(target);
      }
      await Deno.symlink(linkTarget, target);
    } else {
      await fs.copy(src, target, { preserveTimestamps: true, overwrite: true });
    }
  } catch (e) {
    console.error(errorMessage);
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
