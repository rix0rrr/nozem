import * as path from 'path';
import { PackageJson, TsconfigJson } from "../file-schemas";
import { IBuildInput } from "../inputs/build-input";
import { SourceInput } from "../inputs/input-source";
import { NonPackageFileInput } from '../inputs/non-package-file';
import { NpmDependencyInput } from "../inputs/npm-dependency";
import { OsToolInput } from "../inputs/os-tool-input";
import { FileSet, FileSetSchema, readJsonIfExists, standardHash, writeJson } from "../util/files";
import { debug, info, warning } from "../util/log";
import { findNpmPackage, npmBuildDependencies, readPackageJson } from "../util/npm";
import { cachedPromise, mkdict, partition, partitionT } from "../util/runtime";
import { BuildDirectory, shellExecute, Workspace } from '../build-tools';
import { CumulativeTimer } from '../util/timer';

const artifactsCacheSymbol = Symbol();
const inputHashCacheSymbol = Symbol();

const CACHE_FILE = '.nzm-buildcache';

export const INSTALL_TIMER = new CumulativeTimer('install');
export const BUILD_TIMER = new CumulativeTimer('build');
export const TEST_TIMER = new CumulativeTimer('test');

export interface BuildCacheSchema {
  readonly inputHash: string;
  readonly artifacts: FileSetSchema;
}

export abstract class NpmPackageBuild {

  public static async fromDirectory(dir: string, workspace: Workspace): Promise<NpmPackageBuild> {
    const pj = await readPackageJson(dir);

    const npmDependencyInputs = mkdict(await Promise.all(npmBuildDependencies(pj).map(async dep => {
      const found = await findNpmPackage(dep, dir);
      return [dep, await NpmDependencyInput.fromDirectory(workspace, found)] as const;
    })));

    if (pj.nozem === false) {
      debug(`${dir}: nozem disabled in package.json`);
      return new NonHermeticNpmPackageBuild(workspace, dir, pj, npmDependencyInputs);
    }

    if (Object.values(npmDependencyInputs).some(i => !i.isHashable)) {
      debug(`${dir}: has unhashable dependencies`);
      return new NonHermeticNpmPackageBuild(workspace, dir, pj, npmDependencyInputs);
    }

    const inputs: Record<string, IBuildInput> = {};
    const sources = await FileSet.fromGitignored(dir, { directory: dir, patterns: ['.nzm-*'] });
    inputs.source = new SourceInput(sources);

    for (const [dep, npmDependency] of Object.entries(npmDependencyInputs)) {
      inputs[`dep_${dep}`] = npmDependency;
    }

    // NPM packages always need node
    inputs[`os_node`] = await OsToolInput.fromExecutable('node');
    // Other OS tools from package.json
    for (const name of pj.nozem?.ostools ?? []) {
      inputs[`os_${name}`] = await OsToolInput.fromExecutable(name);
    }

    // External files
    for (const file of pj.nozem?.nonPackageFiles ?? []) {
      inputs[`ext_${file}`] = new NonPackageFileInput(dir, file);
    }
    for (const file of workspace.absoluteGlobalNonPackageFiles(dir)) {
      inputs[`ext_${file}`] = new NonPackageFileInput(dir, file);
    }

    const env = NpmPackageBuild.determineEnv(pj.nozem?.env, pj.nozem?.ostools);

    return new NozemNpmPackageBuild(workspace, dir, pj, sources, inputs, env);
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

    warning(`uncacheable build ${this.packageJson.name}`);

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
  }
}

export class NozemNpmPackageBuild extends NpmPackageBuild {
  /**
   * Serves as a cache buster when something about the build logic changes
   */
  private static logicVersion = 1;

  constructor(
    private readonly workspace: Workspace,
    public readonly directory: string,
    public readonly packageJson: PackageJson,
    private readonly sources: FileSet,
    private readonly inputs: Record<string, IBuildInput>,
    private readonly env: Record<string, string>) {
    super();
  }

  public async inputHash() {
    return cachedPromise(this, inputHashCacheSymbol, async () => {
      const inputHash = standardHash();
      inputHash.update(`version:${NozemNpmPackageBuild.logicVersion}\n`);
      for (const [k, v] of Object.entries(this.inputs)) {
        inputHash.update(`${k}:${await v.hash()}\n`);
      }
      for (const key of Object.keys(this.env).sort()) {
        // Magic prefix to make keys not appear in the hash o_O NASTY NASTY
        if (key.startsWith('&')) { continue; }
        inputHash.update(`${key}=${this.env[key]}\n`);
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

      info(`building ${this.packageJson.name}`);

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

      const testT = TEST_TIMER.start();
      try {
        const testCommand = this.packageJson.scripts?.test;
        if (testCommand) {
          await buildDir.execute(testCommand, removeAmpersands(this.env), buildDir.directory);
        }
      } finally {
        testT.stop();
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

      // We make an exception for .ts files that have a corresponding .d.ts file.
      // If we include the .ts file then downstream TypeScript compiler will prefer
      // the .ts files but they will reference types from devDependencies which may not
      // be available.
      return stripTypescriptSources(builtFiles.rebase(this.directory));
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

    // Hoist dependencies for 2 reasons:
    // 1) Optimization
    // 2) Yarn is a rat's nest of a cyclic dependencies (https://github.com/facebook/jest/issues/9712)
    //    and otherwise we'll never be able to properly install these.

    // Bundled dependencies are installed into the src directory (otherwise `npm pack`
    // would not bundle them), regular dependencies are not.
    // Bundled dependencies still need to be hoisted, otherwise `npm-bundled` will not
    // properly detect them.
    const bundledDependencies = this.packageJson.bundledDependencies ?? [];
    const [bundled, other] = partition(npms, npm => bundledDependencies.includes(npm.name));

    await NpmDependencyInput.installAll(dir, bundled, dir.relativePath(dir.srcDir));
    await NpmDependencyInput.installAll(dir, other, '.');
  }
}

function isNpmDependency(x: IBuildInput): x is NpmDependencyInput {
  return x instanceof NpmDependencyInput;
}

/**
 * Strip files that will mess up downstream TypeScript compilation
 */
function stripTypescriptSources(fs: FileSet) {
  return fs.filter(not(f =>
    // .ts file for which a .d.ts file also exists
    (isTypescriptSourceFile(f) && fs.fileNames.includes(makeTypescriptDeclarationFile(f)))
    // tsconfig but only in the root
    || (f == 'tsconfig.json')
  ));
}

function makeTypescriptDeclarationFile(x: string) {
  return x.replace(/\.ts$/, '.d.ts');
}

function isTypescriptSourceFile(x: string) {
  return x.endsWith('.ts') && !x.endsWith('.d.ts');
}

function not<A>(fn: (x: A) => boolean): (x: A) => boolean {
  return (x) => !fn(x);
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