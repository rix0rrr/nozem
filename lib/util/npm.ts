import * as path from 'path';
import { promises as fs } from 'fs';
import { PackageJson } from '../file-schemas';
import { exists, readJson } from './files';

export async function readPackageJson(dir: string) {
  return await readJson(path.join(dir, 'package.json')) as PackageJson;
}

export function npmBuildDependencies(pj: PackageJson) {
  return [...Object.keys(pj.dependencies ?? {}), ...Object.keys(pj.devDependencies ?? {})].sort();
}

export function npmRuntimeDependencies(pj: PackageJson) {
  return Object.keys(pj.dependencies ?? {}).sort();
}

export async function findNpmPackage(packageName: string, root: string): Promise<string> {
  let dir = root;
  while (true) {
    const loc = path.join(dir, 'node_modules', packageName);
    if (await exists(path.join(loc, 'package.json'))) {
      return await fs.realpath(loc);
    }

    const next = path.dirname(dir);
    if (next === dir) {
      throw new Error(`Could not find node package ${packageName} starting at ${root}`);
    }
    dir = next;
  }
}

