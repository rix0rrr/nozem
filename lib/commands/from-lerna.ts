import * as path from 'path';
import { promises as fs } from 'fs';
import * as log from '../util/log';

import { PackageJson, LernaJson } from '../file-schemas';
import { writeJson, readJson, exists, globMany } from '../util/files';
import { UnitDefinition, NazelJson, InternalNpmDepSpec, NpmDepSpec, CopyDepSpec, BuildDepSpec, depSpecRepr, OsDepSpec } from '../nozem-schema';

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

    log.info('Writing nozem.json');
    await writeJson('nozem.json', nazelFile);
  }

  private async findPackages() {
    const lernaJson: LernaJson = await readJson('lerna.json');
    const pjs = await globMany('.', lernaJson.packages.map(s => `/${s}/package.json`));
    for (const p of pjs.fullPaths) {
      log.debug(p);
      const packageJson: PackageJson = await readJson(p);
      this.packages.set(packageJson.name, { filename: p, packageJson });
    }
    log.info(`Found ${this.packages.size} packages`);
  }

  private async addBuildNodes(filename: string, packageJson: PackageJson) {
    log.info(`${filename}`);
    const workspaceRoot = process.cwd();
    const root = path.dirname(filename);
    const tsApiOptimization = !packageJson.nozem?.skipTsApiOptimization;

    const dependencies = await this.dependenciesFromPackageJson(workspaceRoot, root);
    const buildDependencies = [
      ...dependencies.repoDependencies.map(d => ({
        type: 'link-npm',
        node: d.dependencyType === 'dev' || !tsApiOptimization ? d.name : `${d.name}:tsapi`,
        executables: d.dependencyType === 'dev' || !tsApiOptimization ? true : false,
      }) as InternalNpmDepSpec),
      ...dependencies.externalDependencies
    ]
    // Replace 'pkglint' dependency with a fake pkglint dependency
    .map(d => d.type === 'link-npm' && d.node === 'pkglint' ? { type: 'os', executable: 'true', rename: 'pkglint' } as OsDepSpec : d);

    const runtimeDependencies = [
      ...dependencies.repoDependencies.map(d => ({
        type: 'link-npm',
        node: d.name,
        executables: true,
      }) as InternalNpmDepSpec),
      ...dependencies.externalDependencies
    ];

    const nonSources = await combinedGitIgnores(root, workspaceRoot);
    const nonArtifacts = await loadPatternFiles(path.join(root, '.npmignore'));

    // Build job
    this.addUnit({
      type: 'typescript-build',
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
        } as CopyDepSpec)),
        ...runtimeDependencies,
      ],
    });

    // Test job
    this.addUnit({
      type: 'command',
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

    const externalDependencies = new Array<BuildDepSpec>();
    const repoDependencies = new Array<PackageJsonDependency>();

    const thisPj: PackageJson = await readJson(path.join(packageDir, 'package.json'));

    const deps = new Map<string, PackageJsonDependency>();
    for (const pjName of await findFilesUp('package.json', packageDir, workspaceRoot)) {
      const pj: PackageJson = await readJson(pjName);

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
        const resolvedLocation = path.relative(workspaceRoot, await findPackageDirectory(pjDep.name, packageDir));

        externalDependencies.push({
          type: 'npm',
          name: pjDep.name,
          versionRange: pjDep.versionRange,
          version: require(path.resolve(resolvedLocation, 'package.json')).version,
          resolvedLocation,
        });
      }
    }

    externalDependencies.push(...(thisPj.nozem?.ostools ?? []).map(executable => ({ type: 'os', executable } as OsDepSpec)));
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
  externalDependencies: BuildDepSpec[];
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
    if (await exists(path.join(loc, 'package.json'))) {
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

async function findFilesUp(filename: string, startDir: string, rootDir: string): Promise<string[]> {
  const ret = new Array<string>();

  startDir = path.resolve(startDir);
  rootDir = path.resolve(rootDir);

  let currentDir = startDir;
  while (true) {
    const fullPath = path.join(currentDir, filename);
    if (await exists(fullPath)) {
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

function removeDuplicateDependencies(ret: BuildDepSpec[]) {
  ret.sort((a, b) => depSpecRepr(a).localeCompare(depSpecRepr(b)));
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