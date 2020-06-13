import * as path from 'https://deno.land/std@0.56.0/path/mod.ts';
import * as fs from 'https://deno.land/std@0.56.0/fs/mod.ts';
import * as log from 'https://deno.land/std@0.56.0/log/mod.ts';

export interface NazelJson {
  units: UnitDefinition[];
}

/**
 * A single buildable unit
 */
export interface UnitDefinition {
  /**
   * A unique identifier for this build unit
   */
  readonly identifier: string;

  /**
   * (Relative) root of the build unit
   */
  readonly root: string;

  /**
   * Dependencies for this build unit
   */
  readonly dependencies?: BuildDependency[];

  /**
   * Build artifacts relative to the root
   *
   * (Everything EXCEPT what matches this is considered a source file)
   */
  readonly buildArtifacts: string[];

  /**
   * Build command
   */
  readonly buildCommand?: string;
}

export type BuildScope = 'build' | 'run';

/**
 * Description of a dependency
 */
export type BuildDependency = NpmDependency | RepoDependency;

export type NpmDependency = { type: 'npm'; scope: BuildScope; name: string; versionRange: string; resolvedLocation: string };
export type RepoDependency = { type: 'repo'; scope: BuildScope; identifier: string };


export function isRepoDependency(x: BuildDependency): x is RepoDependency {
  return x.type === 'repo';
}

export interface IDependency {
}

export class BuildNode implements IDependency {
  public static async fromDefinition(def: UnitDefinition, dependencies: IDependency[]) {
    const files = await FileSet.fromFileSystem(def.root, new Ignores(def.buildArtifacts));
    return new BuildNode(def, dependencies, files);
  }

  public readonly identifier: string;

  private constructor(
    private readonly def: UnitDefinition,
    private readonly dependencies: IDependency[],
    private readonly files: FileSet,
    ) {
    this.identifier = def.identifier;
  }

  public async build(root: string) {
    log.info(this.identifier);
    for (const f of this.files.files) {
      console.log(f);
    }
  }
}

export class NpmDependencyNode implements IDependency {
  constructor(private readonly def: NpmDependency) {
  }
}


class Ignores {
  private readonly patterns = new Array<{ neg: boolean, requireDir: boolean, regex: RegExp }>();

  constructor(patterns: string[]) {
    for (const pattern of patterns) {
      const neg = pattern.startsWith('!');
      const isDir = pattern.endsWith('/');
      const shortPattern = pattern.replace(/^!/, '').replace(/\/$/, '');
      const regex = globToRegex(shortPattern);
      this.patterns.push({ neg, requireDir: isDir, regex });
    }
  }

  public matches(file: string, isDir: boolean) {
    let ret = false;
    for (const pattern of this.patterns) {
      if (pattern.requireDir && !isDir) { continue; }
      if (pattern.regex.test(file)) {
        ret = !pattern.neg;
      }
    }
    return ret;
  }
}


class FileSet {
  public static async fromFileSystem(root: string, ignores: Ignores) {
    const files = await walkIgnores(root, ignores);
    return new FileSet(root, files);
  }

  constructor(private readonly root: string, public readonly files: string[]) {
  }
}

async function walkIgnores(root: string, ignores: Ignores) {
  const ret = [];

  const relPaths = ['.'];
  while (relPaths.length > 0) {
    const relPath = relPaths.pop()!;
    for await (const child of Deno.readDir(path.join(root, relPath))) {
      const relChildPath = path.join(relPath, child.name);
      if (child.isDirectory && !ignores.matches(relChildPath, true)) {
        relPaths.push(relChildPath);
      }
      if (child.isFile && !ignores.matches(relChildPath, false)) {
        ret.push(relChildPath);
      }
    }
  }

  return ret;
}

function globToRegex(pattern: string) {
  const matchAnywhere = pattern.indexOf('/') === -1;

  const regexParts = [];
  const globChars = /\*\*|\*/g;

  let match: RegExpExecArray | null;
  let start = 0;
  while ((match = globChars.exec(pattern))) {
    regexParts.push(escapeRegExp(pattern.substring(start, match.index)));
    start = globChars.lastIndex;

    switch (match[0]) {
      case '*':
        regexParts.push('[^/]*');
        break;
      case '**':
        regexParts.push('.*');
        break;
    }
  }
  regexParts.push(pattern.substring(start));

  if (matchAnywhere) {
    return new RegExp(`(^|/)${regexParts.join('')}($|/)`);
  }
  return new RegExp(`^${regexParts.join('')}`);
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string

}