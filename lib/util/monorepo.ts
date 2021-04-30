import { readFile } from 'fs';
import * as path from 'path';
import { LernaJson, PackageJson } from "../file-schemas";
import { FilePatterns, FileSet, readJson } from "./files";

export interface MonoRepoPackage {
  readonly fullPath: string;
  readonly relativePath: string;
  readonly packageJson: PackageJson;
}

export async function findMonoRepoPackages(root: string): Promise<MonoRepoPackage[]> {
  const lernaJson: LernaJson = await readJson(path.join(root, 'lerna.json'));
  const packageJsonGlobs = lernaJson.packages.map(s => `./${s}/package.json`);
  const pjs = await FileSet.fromMatcher(root, new FilePatterns({
    directory: root,
    patterns: ['*/', '!node_modules', ...packageJsonGlobs],
  }).toIncludeMatcher());

  return await Promise.all(pjs.fullPaths.map(async (pjPath) => ({
    fullPath: path.dirname(pjPath),
    relativePath: path.relative(root, path.dirname(pjPath)),
    packageJson: await readJson(pjPath),
  })));
}

