import * as path from 'path';
import { promises as fs } from 'fs';
import { findFilesUp, pathExists } from './files';


/**
 * Patterns loaded from .gitignore/.npmignore
 */
export interface FilePattern {
  /**
   * Directory this pattern was found in
   *
   * If there is a slash in the middle of a pattern, it's only valid relative
   * to this directory; otherwise, it can be inherited into subdirectories.
   */
  readonly directory: string;

  /**
   * Patterns found here.
   *
   * A list of globs or negated globs.
   */
  readonly patterns: string[];
}

export async function loadPatternFile(file: string): Promise<FilePattern> {
  try {
    const lines = (await fs.readFile(file, { encoding: 'utf-8' })).split('\n');

    const importantLines = lines
      .map(l => l.trim())
      .filter(l => l) // Nonempty
      .filter(l => !l.startsWith('#')); // # are comment lines

    // Add at the start, move upward
    return {
      directory: path.resolve(path.dirname(file)),
      patterns: importantLines,
    };
  } catch (e) {
    if (e.code !== 'ENOENT') { throw e; }
    return {
      directory: path.resolve(path.dirname(file)),
      patterns: [],
    };
  }
}

/**
 * Load a set of pattern files, from the least specific to the most specific
 */
export async function loadPatternFiles(...files: string[]): Promise<FilePattern[]> {
  return await Promise.all(files.map(loadPatternFile));
}

/**
 * Return all gitignores to a given directory, up until the .git root
 */
export async function allGitIgnores(directory: string) {
  const gitIgnores = await findFilesUp('.gitignore', directory, (dir) => pathExists(path.join(dir, '.git')));
  return loadPatternFiles(...gitIgnores);
}
