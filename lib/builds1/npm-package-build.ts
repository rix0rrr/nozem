import * as path from 'path';
import { PackageJson } from "../file-schemas";
import { IBuildInput } from "../inputs/build-input";
import { SourceInput } from "../inputs/input-source";
import { NpmDependencyInput } from "../inputs/npm-dependency";
import { OsToolInput } from "../inputs/os-tool-input";
import { FileSet, FileSetSchema, readJson, readJsonIfExists, standardHash, writeJson } from "../util/files";
import { debug, info } from "../util/log";
import { findNpmPackage, npmDependencies, readPackageJson } from "../util/npm";
import { cachedPromise, partition } from "../util/runtime";
import { BuildDirectory } from "./build-directory";

const buildCache = new Map<string, NpmPackageBuild>();

const artifactsCacheSymbol = Symbol();
const inputHashCacheSymbol = Symbol();

const CACHE_FILE = '.nzm-buildcache';

export interface BuildCacheSchema {
  readonly inputHash: string;
  readonly artifacts: FileSetSchema;
}

export class NpmPackageBuild {
  public static async fromCache(dir: string): Promise<NpmPackageBuild> {
    // Builds are memoized because there is a lot of package reuse in the tree.
    const existing = buildCache.get(dir);
    if (existing) { return existing; }

    const build = await NpmPackageBuild.fromDirectory(dir);
    buildCache.set(dir, build);
    return build;
  }

  public static async fromDirectory(dir: string): Promise<NpmPackageBuild> {
    const pj = await readPackageJson(dir);

    const inputs: Record<string, IBuildInput> = {};
    const sources = await FileSet.fromGitignored(dir);
    inputs.source = new SourceInput(sources);

    for (const dep of npmDependencies(pj)) {
      const found = await findNpmPackage(dep, dir);
      inputs[`dep_${dep}`] = await NpmDependencyInput.fromDirectory(found);
    }

    // NPM packages always need node
    inputs[`os_node`] = await OsToolInput.fromExecutable('node');
    // Other OS tools from package.json
    for (const name of pj.nozem?.ostools ?? []) {
      inputs[`os_${name}`] = await OsToolInput.fromExecutable(name);
    }

    return new NpmPackageBuild(dir, pj, sources, inputs);
  }

  constructor(public readonly directory: string, public readonly packageJson: PackageJson, private readonly sources: FileSet, private readonly inputs: Record<string, IBuildInput>) {
  }

  public async inputHash() {
    return cachedPromise(this, inputHashCacheSymbol, async () => {
      const inputHash = standardHash();
      for (const [k, v] of Object.entries(this.inputs)) {
        inputHash.update(`${k}:${await v.hash()}\n`);
      }
      return inputHash.digest('hex');
    });
  }

  public async build(): Promise<FileSet> {
    return cachedPromise(this, artifactsCacheSymbol, async () => {
      debug(`Calculating inputHash for ${this.packageJson.name}`);
      const inputHash = await this.inputHash();

      const cacheFile = path.join(this.directory, CACHE_FILE);
      const cache: BuildCacheSchema | undefined = await readJsonIfExists(cacheFile);
      if (cache && cache.inputHash === inputHash) {
        debug(`Cached ${this.packageJson.name}`);
        return FileSet.fromSchema(this.directory, cache.artifacts);
      }

      info(`will build ${this.packageJson.name}`);
      const artifacts = await this.doBuild();
      await writeJson(cacheFile, {
        inputHash,
        artifacts: artifacts.toSchema(),
      } as BuildCacheSchema);
      return artifacts;
    });
  }

  public async doBuild(): Promise<FileSet> {
    return BuildDirectory.with(async (buildDir) => {
      await this.installDependencies(buildDir, Object.values(this.inputs));

      info(`building ${this.packageJson.name}`);

      const buildCommand = this.packageJson.scripts?.build;
      if (buildCommand) {
        await buildDir.execute(buildCommand, {}, buildDir.directory);
      }
      const testCommand = this.packageJson.scripts?.test;
      if (testCommand) {
        await buildDir.execute(testCommand, {}, buildDir.directory);
      }

      // Copy back new files to source directory
      // FIXME: delete files in source directory that are "over" ?

      const builtFiles = await FileSet.fromDirectory(buildDir.srcDir);
      builtFiles.except(this.sources).copyTo(this.directory);

      // The artifacts may include something that was a source file.
      // FIXME: We could be parsing .npmignore here (mucho correct) but right now
      // it's simpler to say everything in the source dir is the output of this package build
      // (will hash+copy more files than necessary, but oh well)

      // Everything that's new in the srcDir is an artifact
      return builtFiles.rebase(this.directory);
    });
  }

  /**
   * Install build dependencies into the given dir
   *
   * Treat NPM dependencies specially, because they can all be hoisted
   * together.
   */
  private async installDependencies(dir: BuildDirectory, inputs: IBuildInput[]) {
    const [npms, others] = partition(inputs, isNpmDependency);
    for (const other of others) {
      await other.install(dir);
    }

    // Hoist dependencies for 2 reasons:
    // 1) Optimization
    // 2) Yarn is a rat's nest of a cyclic dependencies (https://github.com/facebook/jest/issues/9712)
    //    and otherwise we'll never be able to properly install these.
    await NpmDependencyInput.installAll(dir, npms);
  }
}

function isNpmDependency(x: IBuildInput): x is NpmDependencyInput {
  return x instanceof NpmDependencyInput;
}