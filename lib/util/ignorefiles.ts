import * as path from 'path';
import { promises as fs } from 'fs';
import { findFilesUp, pathExists } from './files';

/**
 * Load a set of pattern files, from the least specific to the most specific
 */
export async function loadPatternFiles(...files: string[]) {
  const ret = new Array<string>();
  for (const file of files) {
    try {
      const lines = (await fs.readFile(file, { encoding: 'utf-8' })).split('\n');

      const importantLines = lines
        .map(l => l.trim())
        .filter(l => l) // Nonempty
        .filter(l => !l.startsWith('#')) // # are comment lines
        // If a '/' occurs anywhere except at the most specific file, the pattern cannot be inherited
        .filter(l => [l.length - 1, -1].includes(l.indexOf('/')) || file === files[files.length - 1]);

      // Add at the start, move upward
      ret.push(...importantLines);
    } catch (e) {
      if (e.code !== 'ENOENT') { throw e; }
    }
  }
  return ret;
}

export async function combinedGitIgnores(buildDir: string) {
  const gitIgnores = await findFilesUp('.gitignore', buildDir, (dir) => pathExists(path.join(dir, '.git')));
  return loadPatternFiles(...gitIgnores);
}
