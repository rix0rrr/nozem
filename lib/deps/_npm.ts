import * as path from 'path';
import { PackageJson } from '../file-schemas';
import { readJson } from '../util/files';
import { BuildEnvironment } from '../build-tools';

export async function installNpmPackage(dir: string, env: BuildEnvironment, includeDependencies: boolean) {
  const pj: PackageJson = await readJson(path.join(dir, 'package.json'));

  await env.installSymlink(
    path.join('node_modules', pj.name),
    path.resolve(dir),
  );

  if (includeDependencies) {
    if (typeof pj.bin === 'string') {
      await env.installExecutable(path.resolve(dir, pj.bin), pj.name);
    }
    if (typeof pj.bin === 'object') {
      for (const [name, target] of Object.entries(pj.bin ?? {})) {
        await env.installExecutable(path.resolve(dir, target), name);
      }
    }
  }
}
