import * as path from 'https://deno.land/std@0.56.0/path/mod.ts';
import * as fs from 'https://deno.land/std@0.56.0/fs/mod.ts';
import * as log from 'https://deno.land/std@0.56.0/log/mod.ts';

import { LernaJson, PackageJson } from './file-schemas.ts';
import { UnitDefinition, BuildDependency, BuildScope, NazelJson, NpmDependency, RepoDependency } from './build-graph.ts';

export async function fromLerna() {
  log.info('Building model from Lerna monorepo');
  const lernaJson: LernaJson = JSON.parse(await Deno.readTextFile('lerna.json'));

  const packages = new Map<string, [string, PackageJson]>();
  for await (const entry of fs.walk(".", {
    match: lernaJson.packages.map(s => path.globToRegExp(s + '/package.json')),
  })) {
    log.debug(entry.path);
    const packageJson: PackageJson = JSON.parse(await Deno.readTextFile(entry.path));
    packages.set(packageJson.name, [entry.path, packageJson]);
  }

  const buildUnits = await Promise.all(Array.from(packages.values())
    .map(([filename, packageJson]) => unitDefinition(filename, packageJson, name => packages.has(name))));

  const nazelFile: NazelJson = {
    units: buildUnits,
  };

  log.info('Writing nazel.json');
  await Deno.writeTextFile('nazel.json', JSON.stringify(nazelFile, undefined, 2));

}

async function unitDefinition(filename: string, packageJson: PackageJson, isRepoPackage: (x: string) => boolean): Promise<UnitDefinition> {
  const workspaceRoot = Deno.cwd();
  const root = path.dirname(filename);

  return {
    root,
    identifier: `repo:${packageJson.name}`,
    buildCommand: packageJson.scripts?.build,
    dependencies: [
      ...await dependenciesFrom('run', packageJson.dependencies),
      ...await dependenciesFrom('build', packageJson.devDependencies)
    ],
    buildArtifacts: await combinedGitIgnores(path.dirname(filename), workspaceRoot),
  };

  async function dependenciesFrom(scope: BuildScope, deps?: Record<string, string>): Promise<BuildDependency[]> {
    if (deps === undefined) { return []; }

    return await Promise.all(Object.entries(deps).map(async ([name, versionRange]) =>
      isRepoPackage(name) ? await repoDependency(name) : await npmDependency(name, versionRange)));

    async function repoDependency(name: string): Promise<RepoDependency> {
      return { type: 'repo', scope, identifier: `repo:${name}` };
    }

    async function npmDependency(name: string, versionRange: string): Promise<NpmDependency> {
      return {
        type: 'npm',
        scope,
        name,
        versionRange,
        resolvedLocation: path.relative(workspaceRoot, await findPackageDirectory(name, root)),
      };
    }
  }
}

async function findPackageDirectory(packageName: string, root: string): Promise<string> {
  let dir = root;
  while (true) {
    const loc = path.join(dir, 'node_modules', packageName);
    if (await fs.exists(path.join(loc, 'package.json'))) {
      return loc;
    }

    const next = path.dirname(dir);
    if (next === dir) {
      throw new Error(`Could not find node package ${packageName} starting at ${root}`);
    }
    dir = next;
  }
}

async function combinedGitIgnores(buildDir: string, rootDir: string) {
  const ret = new Array<string>();

  buildDir = path.resolve(buildDir);
  rootDir = path.resolve(rootDir);

  let currentDir = buildDir;
  while (true) {
    try {
      const gitIgnoreLines = (await Deno.readTextFile(path.join(currentDir, '.gitignore'))).split('\n');

      const importantLines = gitIgnoreLines
        .map(l => l.trim())
        .filter(l => l) // Nonempty
        .filter(l => !l.startsWith('#')) // # are comment lines
        // If a '/' occurs anywhere except at the end, the pattern cannot be inherited
        .filter(l => l.indexOf('/') < l.length - 1 || currentDir === buildDir);

      // Add at the start, move upward
      ret.splice(0, 0, ...importantLines);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) { throw e; }
    }

    currentDir = path.dirname(currentDir);
    if (currentDir === rootDir) { break; }
  }

  return ret;
}
