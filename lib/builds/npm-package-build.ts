import chalk from 'chalk';
import * as path from 'path';
import * as util from 'util';
import { PackageJson, TsconfigJson } from "../file-schemas";
import { IBuildInput } from "../inputs/build-input";
import { SourceInput } from "../inputs/input-source";
import { NonPackageFileInput } from '../inputs/non-package-file';
import { isMonoRepoBuildDependencyInput, MonoRepoBuildDependencyInput, NpmDependencyInput } from "../inputs/npm-dependency";
import { OsToolInput } from "../inputs/os-tool-input";
import { FileSet, FileSetSchema, readJsonIfExists, standardHash, TEST_clearFileHashCache, writeJson } from "../util/files";
import * as log from '../util/log';
import { findNpmPackage, npmBuildDependencies, readPackageJson } from "../util/npm";
import { cachedPromise, mkdict, partition, partitionT } from "../util/runtime";
import { BuildDirectory, shellExecute, Workspace } from '../build-tools';
import { CumulativeTimer } from '../util/timer';
import { constantHashable, hashOf, IHashable, MerkleComparison, MerkleDifference, MerkleTree, renderComparison, SerializedMerkleTree } from '../util/merkle';
import { ICachedArtifacts } from '../caches/icache';
import { NpmCopyInstall } from '../npm-installs/copy-install';
import { NpmSourceLinkInstall } from '../npm-installs/sourcelink-install';

const artifactsCacheSymbol = Symbol();
const inputHashCacheSymbol = Symbol();
const cacheLookupSymbol = Symbol();

const CACHE_FILE = '.nzm-buildcache';

export const INSTALL_TIMER = new CumulativeTimer('install');
export const BUILD_TIMER = new CumulativeTimer('build');
export const TEST_TIMER = new CumulativeTimer('test');

/**
 * How far to recurse in the tree to track changes
 *
 * Less recursion saves space, and at some point more
 * detail/history isn't really helpful/interesting anymore.
 */
const CHANGE_DETAIL_LEVELS = 3;

export interface BuildCacheSchema {
  readonly inputTree: SerializedMerkleTree;
  readonly artifacts: FileSetSchema;
  readonly artifactHash: string;

  /**
   * This is strictly speaking not necessary, but we need this to debug
   * strange build behavior
   */
  readonly artifactTree: SerializedMerkleTree;
}

export abstract class NpmPackageBuild {

  public static async fromDirectory(dir: string, workspace: Workspace): Promise<NpmPackageBuild> {
    const pj = await readPackageJson(dir);

    const npmDependencyInputs = mkdict(await Promise.all(npmBuildDependencies(pj).map(async dep => {
      const found = await findNpmPackage(dep, dir);
      return [dep, await NpmDependencyInput.fromDirectory(workspace, found)] as const;
    })));

    if (pj.nozem === false) {
      log.debug(`${dir}: nozem disabled in package.json`);
      return new NonHermeticNpmPackageBuild(workspace, dir, pj, npmDependencyInputs);
    }

    if (Object.values(npmDependencyInputs).some(i => !i.isHashable)) {
      log.debug(`${dir}: has unhashable dependencies`);
      return new NonHermeticNpmPackageBuild(workspace, dir, pj, npmDependencyInputs);
    }

    const sources = await FileSet.fromGitignored(dir, workspace.root, { directory: dir, patterns: ['.nzm-*'] });
    const sourceInput = new SourceInput(sources);

    const deps = new MerkleTree(npmDependencyInputs);

    let osTools = new MerkleTree(await Promise.all(
      (pj.nozem?.ostools ?? []).map(async (name) =>
      [name, await OsToolInput.fromExecutable(name)] as const
    )));
    // NPM packages always need node
    osTools = osTools.add({ node: await OsToolInput.fromExecutable('node') });

    // External files
    const externalFiles = new MerkleTree([
      ...(pj.nozem?.nonPackageFiles ?? []).map(file => [file, new NonPackageFileInput(dir, file)] as const),
      ...workspace.absoluteGlobalNonPackageFiles(dir).map(file => [file, new NonPackageFileInput(dir, file)] as const),
    ]);

    const env = NpmPackageBuild.determineEnv(pj.nozem?.env, pj.nozem?.ostools);

    const merkle = new MerkleTree({
      source: sourceInput,
      env: MerkleTree.fromDict(removeHiddenKeys(env)),
      deps,
      osTools,
      externalFiles,
    });

    const inputs = [
      sourceInput,
      ...deps.values,
      ...osTools.values,
      ...externalFiles.values,
    ];

    return new NozemNpmPackageBuild(workspace, dir, pj, sources, inputs, env, merkle);
  }

  private static determineEnv(envs?: Record<string, string>, ostools?: string[]) {
    // FIXME: The use of 'CODEBUILD_RESOLVED_SOURCE_VERSION' as environment
    // variable in the CLI and not trying to come up with our own variant will
    // make it rather impossible to share artifacts between build server and
    // local builds.
    const ret: Record<string, string> = {};
    for (const [key, value] of Object.entries(envs ?? {})) {
      if (value.startsWith('|')) {
        // Inherit from process or use remainder as default
        ret[key] = process.env[key] ?? value.substr(1);
      } else {
        ret[key] = value;
      }
    }

    // Special environment variable for package that has "dotnet" in its list of tools.
    // Not strictly hermetic anymore, but it seems hard to achieve success otherwise
    // Running into variants of https://github.com/dotnet/sdk/issues/5658
    if (ostools?.includes('dotnet')) {
      ret['&DOTNET_CLI_HOME'] = process.env.HOME ?? '.';
    }

    return ret;
  }

  public abstract build(): Promise<FileSet | void>;
}

export class NonHermeticNpmPackageBuild extends NpmPackageBuild {
  private built = false;

  constructor(
    private readonly workspace: Workspace,
    public readonly directory: string,
    public readonly packageJson: PackageJson,
    private readonly dependencies: Record<string, NpmDependencyInput>,
    ) {
    super();
  }

  public async build() {
    if (this.built) { return; }
    this.built = true;

    // Need to make sure all dependencies have been built
    for (const dep of Object.values(this.dependencies)) {
      await dep.build();
    }

    log.warning(`uncacheable build ${this.packageJson.name}`);

    const buildT = BUILD_TIMER.start();
    try {
      const buildCommand = this.packageJson.scripts?.build;
      if (buildCommand) {
        // FIXME: We force 'yarn' here, whereas we could also use npm. Not so nice?
        await shellExecute('yarn build', this.directory, process.env);
      }
    } finally {
      buildT.stop();
    }

    if (this.workspace.options.test) {
      const testT = TEST_TIMER.start();
      try {
        const testCommand = this.packageJson.scripts?.test;
        if (testCommand) {
          // FIXME: We force 'yarn' here, whereas we could also use npm. Not so nice?
          await shellExecute('yarn test', this.directory, process.env);
        }
      } finally {
        testT.stop();
      }
    } else {
      log.warning(`${this.directory}: skipping tests`);
    }
  }
}

export class NozemNpmPackageBuild extends NpmPackageBuild {
  /**
   * Serves as a cache buster when something about the build logic changes
   */
  private static logicVersion = 1;

  private readonly packageName: string;
  private readonly merkle: MerkleTree<IHashable>;

  constructor(
    private readonly workspace: Workspace,
    public readonly directory: string,
    public readonly packageJson: PackageJson,
    private readonly sources: FileSet,
    private readonly inputs: IBuildInput[],
    private readonly env: Record<string, string>,
    inputTree: MerkleTree<IHashable>,
    ) {
    super();

    this.packageName = this.packageJson.name;

    this.merkle = inputTree.add({ v: constantHashable(`${NozemNpmPackageBuild.logicVersion}`) });
  }

  public async inputHash(): Promise<string> {
    return cachedPromise(this, inputHashCacheSymbol, async () => {
      log.debug(`Calculating inputHash for ${this.packageJson.name}`);
      return hashOf(this.merkle);
    });
  }

  public async artifactHash(): Promise<string> {
    // If we can get this build from the cache, we can get the artifact hash
    // quickly. Otherwise, we need to do a build.

    const cached = await this.cacheLookup();
    if (cached) { return cached.artifactHash; }

    return hashOf(await this.build());
  }

  public async build(): Promise<FileSet> {
    return cachedPromise(this, artifactsCacheSymbol, async () => {
      const cached = await this.cacheLookup();
      if (cached) {
        // Even if we didn't build this package, we do have to make sure that
        // all dependencies are put into place (either built or also downloaded)
        await this.ensureDependenciesBuilt();

        const files = await cached.fetch(this.directory);
        // Register an in-place copy of these files after fetching them
        if (cached.source !== 'inplace') {
          await this.storeInPlaceCache(files);
        }
        return files;
      }

      const artifacts = await this.doBuild();

      await this.storeInPlaceCache(artifacts);

      // Store in external cache
      this.workspace.artifactCache.queueForStoring({
        inputHash: await this.inputHash(),
        displayName: this.packageJson.name,
      }, artifacts);

      // Do a validation -- we should remove this once we feel confident that shit works, or
      // once we've better scoped the FS caching.
      TEST_clearFileHashCache();
      const artifactHash = await hashOf(artifacts);
      if (artifactHash !== await hashOf(artifacts)) {
        log.error(`[BUG] The artifact hash was not consistent! (${artifactHash} vs ${await hashOf(artifacts)})`);
      }

      return artifacts;
    });
  }

  public async doBuild(): Promise<FileSet> {
    return BuildDirectory.with(async (buildDir) => {
      // Create a file so that pkglint can find the root (because 'lerna.json' might not be there)
      await buildDir.touchFile('.nzmroot');

      const installT = INSTALL_TIMER.start();
      try {
        // Mirror the monorepo directory structure inside the build dir
        await buildDir.moveSrcDir(this.workspace.relativePath(this.directory));

        await this.installDependencies(buildDir, Object.values(this.inputs));
      } finally {
        installT.stop();
      }

      log.info(`building ${this.packageJson.name}`);

      const buildT = BUILD_TIMER.start();
      try {
        await patchTsConfig(buildDir.srcDir);

        const buildCommand = this.packageJson.scripts?.build;
        if (buildCommand) {
          await buildDir.execute(buildCommand, removeAmpersands(this.env), buildDir.directory);
        }
      } finally {
        buildT.stop();
      }

      // All the files that are there after the build step are the build result. We do this before
      // testing etc because testing will create coverage reports etc which contain runtimes and
      // the time of day, which are definitely not deterministic.
      //
      // The artifacts MAY include files that were source files.
      // FIXME: We could be parsing .npmignore here (mucho correct) but right now
      // it's simpler to say everything in the source dir is the output of this package build
      // (will hash+copy more files than necessary, but oh well)
      const buildIgnores = [
        // This thing is created by TypeScript and will contain timestamps and other
        // nondeterministic stuff.
        '*.tsbuildinfo',

        // Definitely don't include node_modules in the artifacts
        'node_modules',
      ];
      const buildResult = await FileSet.fromDirectoryWithIgnores(buildDir.srcDir, buildIgnores);

      if (this.workspace.options.test) {
        const testT = TEST_TIMER.start();
        try {
          const testCommand = this.packageJson.scripts?.test;
          if (testCommand) {
            await buildDir.execute(testCommand, removeAmpersands(this.env), buildDir.directory);
          }
        } finally {
          testT.stop();
        }
      } else {
        log.warning(`${this.directory}: skipping tests`);
      }

      // Copy back new files to source directory (this DOES include test results)
      // FIXME: delete files in source directory that are "over" ?

      const allOutputFiles = await FileSet.fromDirectoryWithIgnores(buildDir.srcDir, buildIgnores);
      await allOutputFiles.except(this.sources).copyTo(this.directory);

      // Return only the files built during the 'build' step as artifacts
      return buildResult.rebase(this.directory);
    });
  }

  /**
   * Install build dependencies into the given dir
   *
   * Treat NPM dependencies specially, because they can all be hoisted
   * together.
   */
  private async installDependencies(dir: BuildDirectory, inputs: IBuildInput[]) {
    const [npms, others] = partitionT(inputs, isNpmDependency);
    for (const other of others) {
      await other.install(dir);
    }

    // Bundled dependencies are installed into the src directory (otherwise `npm pack`
    // would not bundle them), regular dependencies are not.
    //
    // Bundled dependencies still need to be hoisted, otherwise `npm-bundled` (which
    // CDK uses in 'pkglint') will not properly detect them, so we always COPY them.
    const bundledDependencies = this.packageJson.bundledDependencies ?? [];
    const [bundled, other] = partition(npms, npm => bundledDependencies.includes(npm.name));
    await new NpmCopyInstall(bundled).installAll(dir, dir.relativePath(dir.srcDir));

    // Try an optimized install
    await new NpmSourceLinkInstall(other).installAll(dir, '.');
  }

  private async ensureDependenciesBuilt(): Promise<void> {
    const [npmDependencies, _] = partition(Object.values(this.inputs), isNpmDependency);
    const buildableNpmDependencies = npmDependencies.filter(isMonoRepoBuildDependencyInput);
    await Promise.all(buildableNpmDependencies.map(d => d.build()));
  }

  private async cacheLookup(): Promise<ICachedArtifacts | undefined> {
    return cachedPromise(this, cacheLookupSymbol, async () => {
      const inplaceCache = await this.inPlaceCacheLookup();
      if (inplaceCache.result === 'ok') {
        log.debug(`Unchanged ${this.packageJson.name}`);
        return {
          source: 'inplace',
          artifactHash: await hashOf(inplaceCache.files),
          // Files are by definition already in the right place, so fetch doesn't
          // move or copy.
          fetch: (targetDir) => Promise.resolve(inplaceCache.files),
        } as ICachedArtifacts;
      }

      const fromRemoteCache = await this.workspace.artifactCache.lookup({
        inputHash: await this.inputHash(),
      });
      if (fromRemoteCache) {
        log.info(`From cache ${this.packageJson.name} (${fromRemoteCache.source})`);
        return fromRemoteCache;
      }

      // We failed both cache lookups. The error message we print depends on
      // the state of the in-place cache.
      switch (inplaceCache.result) {
        case 'mismatch':
          log.info(`will build ${this.packageJson.name} ` +
            chalk.grey(`(${renderComparison(inplaceCache.comparison, 1)})`));
          return undefined;
        default:
          log.info(`will build ${this.packageJson.name}`);
          return undefined;
      }
    });
  }

  private async inPlaceCacheLookup(): Promise<InPlaceCacheLookup> {
    const inputHash = await this.inputHash();

    try {
      // Try in-place cache
      const cache = await readJsonIfExists<BuildCacheSchema>(this.inPlaceCacheFile);
      if (!cache || !cache.inputTree) { return { result: 'missing' }; };

      const prevInputTree = await MerkleTree.deserialize(cache.inputTree);

      if (await hashOf(prevInputTree) === inputHash) {
        // Account for the fact that some files may have disappeared
        const cachedArtifacts = await FileSet.fromSchema(this.directory, cache.artifacts).onlyExisting();

        // Do a validation -- we don't control the files on disk since the cache stamp,
        // who knows what happened to 'em?
        const currentHash = await hashOf(cachedArtifacts);
        if (currentHash !== cache.artifactHash) {
          log.warning(`${this.directory}: artifact files changed since last build (${currentHash} vs ${cache.artifactHash})`);
          if (cache.artifactTree) {
            const oldArtifactTree = await MerkleTree.deserialize(cache.artifactTree);
            const comparison = await MerkleTree.compare(oldArtifactTree, cachedArtifacts);
            log.warning(`Changes: ${renderComparison(comparison)}`);
          }
          return { result: 'missing' };
        }

        return { result: 'ok', files: cachedArtifacts };
      }

      const comparison = await MerkleTree.compare(prevInputTree, this.merkle);
      return { result: 'mismatch', comparison: comparison };

    } catch (e) {
      log.error(`Error performing cache lookup for ${this.directory}`);
      throw e;
    }
  }

  private async storeInPlaceCache(artifacts: FileSet) {
    await writeJson<BuildCacheSchema>(this.inPlaceCacheFile, {
      inputTree: await MerkleTree.serialize(this.merkle, CHANGE_DETAIL_LEVELS),
      artifacts: artifacts.toSchema(),
      artifactHash: await hashOf(artifacts),
      artifactTree: await MerkleTree.serialize(artifacts),
    });
  }

  private get inPlaceCacheFile(): string  {
    return path.join(this.directory, CACHE_FILE);
  }
}

type InPlaceCacheLookup = { readonly result: 'missing' }
  | { readonly result: 'ok', readonly files: FileSet }
  | { readonly result: 'mismatch', readonly comparison: MerkleComparison };


function isNpmDependency(x: IBuildInput): x is NpmDependencyInput {
  return x instanceof NpmDependencyInput;
}

/**
 * Patch a tsconfig file in-place, to not rely on source repo layouts anymore
 *
 * It's fine if `tsconfig.json` does not exist.
 */
async function patchTsConfig(directory: string) {
  const filename = path.join(directory, 'tsconfig.json');
  const tsconfig: TsconfigJson | undefined = await readJsonIfExists(filename);
  if (!tsconfig) { return; }

  delete tsconfig.references;
  delete tsconfig.compilerOptions.composite;
  delete tsconfig.compilerOptions.inlineSourceMap;
  delete tsconfig.compilerOptions.inlineSources;

  await writeJson(filename, tsconfig);
}

function removeAmpersands(xs: Record<string, string>): Record<string, string> {
  if (!xs) { return xs; }
  return mkdict(Object.entries(xs).map(([k, v]) => [k.replace(/^&/, ''), v]));
}

function removeHiddenKeys(xs: Record<string, string>): Record<string, string> {
  if (!xs) { return xs; }
  return mkdict(Object.entries(xs).filter(([k, v]) => !k.startsWith('&')));
}
