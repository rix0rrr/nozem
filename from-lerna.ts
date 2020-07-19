import * as path from 'https://deno.land/std@0.56.0/path/mod.ts';
import * as fs from 'https://deno.land/std@0.56.0/fs/mod.ts';
import * as log from 'https://deno.land/std@0.56.0/log/mod.ts';

import { LernaJson, PackageJson } from './file-schemas.ts';
import { UnitDefinition, BuildDependency, BuildScope, NazelJson, NpmDependency, LinkNpmDependency, OsDependency, buildDependencyId, IDependency, CopyDependency } from './build-graph.ts';

export async function fromLerna() {
  const analyzer = new MonoRepoAnalyzer();
  await analyzer.build();
}

interface PackageLocation {
 readonly filename: string;
 readonly packageJson: PackageJson;
}

export class MonoRepoAnalyzer {
  private readonly packages = new Map<string, PackageLocation>();
  private readonly units = new Map<string, UnitDefinition>();

  public async build() {
    log.info('Building model from Lerna monorepo');
    await this.findPackages();

    for (const pkg of this.packages.values()) {
      await this.addBuildNodes(pkg.filename, pkg.packageJson);
    }

    const nazelFile: NazelJson = {
      units: Array.from(this.units.values()),
    };

    log.info('Writing nazel.json');
    await Deno.writeTextFile('nazel.json', JSON.stringify(nazelFile, undefined, 2));
  }

  private async findPackages() {
    const lernaJson: LernaJson = JSON.parse(await Deno.readTextFile('lerna.json'));
    for await (const entry of fs.walk(".", {
      match: lernaJson.packages.map(s => path.globToRegExp(s + '/package.json')),
    })) {
      log.debug(entry.path);
      const packageJson: PackageJson = JSON.parse(await Deno.readTextFile(entry.path));
      this.packages.set(packageJson.name, { filename: entry.path, packageJson });
    }
    log.info(`Found ${this.packages.size} packages`);
  }

  private async addBuildNodes(filename: string, packageJson: PackageJson) {
    log.info(`${filename}`);
    const workspaceRoot = Deno.cwd();
    const root = path.dirname(filename);
    const tsApiOptimization = !packageJson.nzl$skipTsApiOptimization;

    const dependencies = await this.dependenciesFromPackageJson(workspaceRoot, root);
    const buildDependencies = [
      ...dependencies.repoDependencies.map(d => ({
        type: 'link-npm',
        node: d.dependencyType === 'dev' || !tsApiOptimization ? d.name : `${d.name}:tsapi`,
        executables: d.dependencyType === 'dev' || !tsApiOptimization ? true : false,
      }) as LinkNpmDependency),
      ...dependencies.externalDependencies
    ]
    // Replace 'pkglint' dependency with a fake pkglint dependency
    .map(d => d.type === 'link-npm' && d.node === 'pkglint' ? { type: 'os', executable: 'true', rename: 'pkglint' } as OsDependency : d);

    const runtimeDependencies = [
      ...dependencies.repoDependencies.map(d => ({
        type: 'link-npm',
        node: d.name,
        executables: true,
      }) as LinkNpmDependency),
      ...dependencies.externalDependencies
    ];

    const nonSources = await combinedGitIgnores(root, workspaceRoot);
    const nonArtifacts = await loadPatternFiles(path.join(root, '.npmignore'));

    // Build job
    this.addUnit({
      type: 'build',
      identifier: `${packageJson.name}:build`,
      root,
      buildCommand: packageJson.scripts?.build,
      dependencies: buildDependencies,
      nonSources,
      nonArtifacts,
      patchTsconfig: true,
    });

    // API closure
    this.addUnit({
      type: 'extract',
      identifier: `${packageJson.name}:tsapi`,
      extractPatterns: [
        '*/',
        'package.json',
        '*.d.ts',
        // Need just the "main.js" to make imports work (which are checked during build)
        // After this file exists the presence of the .d.ts files will take over.
        ...packageJson.main ? [packageJson.main] : [],
        // Need to include jsii assembly to make the jsii build work
        ...packageJson.jsii ? ['.jsii'] : [],
      ],
      dependencies: [
        { type: 'copy', node: `${packageJson.name}:build` },
        ...buildDependencies,
      ],
    });

    // Runtime closure
    this.addUnit({
      type: 'extract',
      identifier: packageJson.name,
      extractPatterns: [
        '**/*',
      ],
      dependencies: [
        { type: 'copy', node: `${packageJson.name}:build` },
        ...this.findNestedPackages(root).map(nested => ({
          type: 'copy', node: nested.packageJson.name, subdir: path.relative(root, path.dirname(nested.filename))
        } as CopyDependency)),
        ...runtimeDependencies,
      ],
    });

    // Test job
    this.addUnit({
      type: 'build',
      identifier: `${packageJson.name}:test`,
      buildCommand: packageJson.scripts?.test ?? 'true',
      root,
      nonArtifacts: ['**/*'],
      // Copy in all source files because there might be data files and we can't know which ones they are.
      // There might be .js files in there that are not considered build output, we should copy those as well,
      // hence we need to respect the .gitignores.
      nonSources,
      dependencies: [
        { type: 'copy', node: packageJson.name },
        ...runtimeDependencies,
      ],
    });

    return ;
  }

  /**
   * Find packages that are in the source tree nested in other packages
   *
   * We need to copy them back.
   */
  private findNestedPackages(root: string) {
    root = path.resolve(root);
    const ret = new Array<PackageLocation>();
    for (const p of this.packages.values()) {
      const f = path.resolve(p.filename);
      if (f.startsWith(`${root}/`) && path.dirname(f) !== root) {
        ret.push({ filename: f, packageJson: p.packageJson });
      }
    }
    return ret;
  }

  private addUnit(unit: UnitDefinition) {
    this.units.set(unit.identifier, unit);
  }

  private async dependenciesFromPackageJson(workspaceRoot: string, packageDir: string): Promise<PackageDependencies> {
    workspaceRoot = path.resolve(workspaceRoot);
    packageDir = path.resolve(packageDir);

    const externalDependencies = new Array<BuildDependency>();
    const repoDependencies = new Array<PackageJsonDependency>();

    const thisPj: PackageJson = JSON.parse(await Deno.readTextFile(path.join(packageDir, 'package.json')));

    const deps = new Map<string, PackageJsonDependency>();
    for (const pjName of await findFilesUp('package.json', packageDir, workspaceRoot)) {
      const pj: PackageJson = JSON.parse(await Deno.readTextFile(pjName));

      for (const [name, versionRange] of Object.entries(pj.devDependencies ?? {})) {
        deps.set(name, { name, versionRange, dependencyType: 'dev' });
      }
      for (const [name, versionRange] of Object.entries(pj.dependencies ?? {})) {
        deps.set(name, { name, versionRange, dependencyType: 'runtime' });
      }
      for (const [name, versionRange] of Object.entries(pj.peerDependencies ?? {})) {
        deps.set(name, { name, versionRange, dependencyType: 'runtime' });
      }
    }

    for (const pjDep of deps.values()) {
      const repoPackage = this.packages.get(pjDep.name);
      if (repoPackage) {
        repoDependencies.push(pjDep);
      } else {
        externalDependencies.push({
          type: 'npm',
          name: pjDep.name,
          versionRange: pjDep.versionRange,
          resolvedLocation: path.relative(workspaceRoot, await findPackageDirectory(pjDep.name, packageDir)),
        });
      }
    }

    externalDependencies.push(...(thisPj.ostools ?? []).map(executable => ({ type: 'os', executable } as OsDependency)));
    externalDependencies.push({ type: 'os', executable: 'node' });
    removeDuplicateDependencies(externalDependencies);
    return { externalDependencies, repoDependencies };
  }
}

function transformSome<A, B>(xs: A[], pred: (x: A) => boolean, fn: (x: A) => B): Array<A | B> {
  return xs.map(x => pred(x) ? fn(x) : x);
}


interface PackageDependencies {
  repoDependencies: PackageJsonDependency[];
  externalDependencies: BuildDependency[];
}

interface PackageJsonDependency {
  readonly name: string;
  readonly versionRange: string;
  readonly dependencyType: 'dev' | 'runtime';
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

/**
 * Load a set of pattern files, from the least specific to the most specific
 */
async function loadPatternFiles(...files: string[]) {
  const ret = new Array<string>();
  for (const file of files) {
    try {
      const lines = (await Deno.readTextFile(file)).split('\n');

      const importantLines = lines
        .map(l => l.trim())
        .filter(l => l) // Nonempty
        .filter(l => !l.startsWith('#')) // # are comment lines
        // If a '/' occurs anywhere except at the most specific file, the pattern cannot be inherited
        .filter(l => [l.length - 1, -1].includes(l.indexOf('/')) || file === files[files.length - 1]);

      // Add at the start, move upward
      ret.push(...importantLines);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) { throw e; }
    }
  }
  return ret;
}

async function findFilesUp(filename: string, startDir: string, rootDir: string): Promise<string[]> {
  const ret = new Array<string>();

  startDir = path.resolve(startDir);
  rootDir = path.resolve(rootDir);

  let currentDir = startDir;
  while (true) {
    const fullPath = path.join(currentDir, filename);
    if (await fs.exists(fullPath)) {
      ret.push(fullPath);
    }

    if (currentDir === rootDir) { break; }
    const next = path.dirname(currentDir);
    if (next === currentDir) { break; }
    currentDir = next;
  }

  // Most specific file at the end
  return ret.reverse();
}

async function combinedGitIgnores(buildDir: string, rootDir: string) {
  const gitIgnores = await findFilesUp('.gitignore', buildDir, rootDir);
  return loadPatternFiles(...gitIgnores);
}

function removeDuplicateDependencies(ret: BuildDependency[]) {
  ret.sort((a, b) => buildDependencyId(a).localeCompare(buildDependencyId(b)));
  let i = 0;
  while (i < ret.length - 1) {
    if (ret[i] === ret[i + 1]) {
      ret.splice(i, 1);
    } else {
      i++;
    }
  }
  return ret;
}