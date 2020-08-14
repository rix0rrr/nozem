import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import { promises as fs } from 'fs';
import * as log from './util/log';
import { exists, FileSet, FilePatterns, FileMatcher, copy, rimraf, ensureSymlink, ignoreEnoent, removeOldSubDirectories, findFilesUp, readJson } from './util/files';
import * as util from 'util';
import { cachedPromise } from './util/runtime';
import { NozemCacheJson } from './nozem-schema';
import { S3Cache } from './aws/s3cache';

const cpExec = util.promisify(child_process.exec);

const outHashSym = Symbol();

const RETAIN_CACHE_DIRS = 2;

export interface PackageVersion {
  readonly packageName: string;
  readonly inHash: string;
}

export interface IRemoteCache {
  contains(pv: PackageVersion): Promise<boolean>;
  fetch(pv: PackageVersion, targetDir: string): Promise<void>;
  queueForStoring(pv: PackageVersion, sourceDir: string): void;
}

export class BuildWorkspace {
  public static defaultWorkspace(remoteCache?: IRemoteCache) {
    return new BuildWorkspace(path.resolve(os.homedir() ?? '.', '.nozem-build'), remoteCache);
  }

  public static async detectConfiguration(dir: string) {
    const cacheConfigs = await findFilesUp('nozem-cache.json', dir);
    const cacheConfig: NozemCacheJson | undefined = cacheConfigs.length > 0 ? await readJson(cacheConfigs[cacheConfigs.length - 1]) : undefined;

    const cacheDir = cacheConfig?.cacheDir ?? path.resolve(os.homedir() ?? '.', '.nozem-build');
    let remoteCache;
    if (cacheConfig?.cacheBucket) {
      log.info(`Using remote caching bucket ${cacheConfig.cacheBucket.bucketName}`);
      remoteCache = new S3Cache(cacheConfig.cacheBucket.bucketName, cacheConfig?.cacheBucket?.region, cacheConfig?.cacheBucket?.profileName)
    }
    return new BuildWorkspace(cacheDir, remoteCache);
  }

  private readonly buildDir: string;
  private readonly cacheDir: string;
  private readonly cached = new Map<string, BuildOutput>();

  constructor(private readonly root: string, public readonly remoteCache?: IRemoteCache) {
    this.buildDir = path.join(this.root, 'build');
    this.cacheDir = path.join(this.root, 'cache');
  }

  public async fromCache(pv: PackageVersion): Promise<BuildOutput | undefined> {
    const dir = this.outputCacheDir(pv.packageName, pv.inHash);
    if (!await exists(dir)) { return undefined; }

    if (!this.cached.has(dir)) {
      this.cached.set(dir, new BuildOutput(dir));
    }
    return this.cached.get(dir)!;
  }

  public async makeBuildEnvironment(pv: PackageVersion) {
    const dir = path.join(this.buildDir, slugify(pv.packageName));
    if (await exists(dir)) {
      await rimraf(dir);
    }
    await fs.mkdir(dir, { recursive: true });

    const cacheDir = this.outputCacheDir(pv.packageName, pv.inHash);
    await removeOldSubDirectories(RETAIN_CACHE_DIRS, path.dirname(cacheDir));

    return new BuildEnvironment(this, dir, cacheDir);
  }

  private outputCacheDir(packageName: string, inHash: string) {
    return path.join(this.cacheDir, slugify(packageName), inHash);
  }
}

/**
 * Build environment
 *
 * A build environment is structured like:
 *
 * $root/
 *    bin/
 *    src/
 *    node_modules/
 *    out/
 */
export class BuildEnvironment {
  public readonly binDir: string;
  public readonly srcDir: string;

  constructor(
    public readonly workspace: BuildWorkspace,
    public readonly root: string,
    private readonly finalOutDir: string,
    ) {
    this.binDir = path.join(root, 'bin');
    this.srcDir = path.join(root, 'src');
  }

  public async cleanup() {
    await rimraf(this.root);
  }

  public async installExecutable(absTarget: string, binName?: string) {
    const targetPath = path.join(this.binDir, binName ?? path.basename(absTarget));
    try {
      await ensureSymlink(
        absTarget,
        targetPath);
    } catch (e) {
      throw new Error(`Error symlinking ${absTarget} -> ${targetPath}: ${e.message}`);
    }
  }

  public async installSymlink(relSource: string, absTarget: string) {
    try {
      await ensureSymlink(
        absTarget,
        path.join(this.root, relSource),
        );
    } catch (e) {
      throw new Error(`Error symlinking ${absTarget} -> ${path.join(this.root, relSource)}: ${e.message}`);
    }
  }

  public async addSrcFiles(files: FileSet, subdir: string = '.') {
    return files.copyTo(path.join(this.srcDir, subdir));
  }

  public async addSrcFile(absSource: string, relTarget: string) {
    const absTarget = path.join(this.srcDir, relTarget);
    await copy(absSource, absTarget);
  }

  /**
   * Grab artifacts out of an in-source build
   */
  public async inSourceArtifacts(matcher: FileMatcher) {
    return await FileSet.fromMatcher(this.srcDir, matcher);
  }

  public async execute(command: string, env: Record<string, string>, logDir: string) {
    log.debug(`[${this.srcDir}] ${command}`);

    try {
      const { stdout, stderr } = await cpExec(command, {
        cwd: this.srcDir,
        env: {
          PATH: this.binDir,
          ...env
        }
      });

      await fs.writeFile(path.join(logDir, 'stdout.log'), stdout, { encoding: 'utf-8' });
      await fs.writeFile(path.join(logDir, 'stderr.log'), stderr, { encoding: 'utf-8' });
    } catch (e) {
      if (e.stdout) { process.stderr.write(e.stdout); }
      if (e.stderr) { process.stderr.write(e.stderr); }
      throw e;
    }
  }

  public async makeTemporaryOutput() {
    return new TemporaryBuildOutput(this.finalOutDir, this.root);
  }
}

/**
 * Output directory while it's being built
 *
 * An output directory is structured like:
 *
 * $root/
 *    out/<...files here...>
 *    deriv/<name>/...
 *       <derivations>
 */
export class TemporaryBuildOutput {
  public static async create(dir: string) {
    const tmpDir = await fs.mkdtemp(dir);
    return new TemporaryBuildOutput(dir, tmpDir);
  }

  constructor(private readonly targetDir: string, private readonly workDir: string) {
  }

  public get mainWritingDirectory() {
    return path.join(this.workDir, 'out');
  }

  public async matchArtifacts(matcher: FileMatcher) {
    return await FileSet.fromMatcher(this.mainWritingDirectory, matcher);
  }

  public async finalize(): Promise<BuildOutput> {
    await rimraf(this.targetDir);

    await fs.mkdir(path.dirname(this.targetDir), { recursive: true });
    await fs.rename(this.workDir, this.targetDir);

    return new BuildOutput(this.targetDir);
  }

  public async cleanup() {
    await rimraf(this.workDir);
  }
}

export class BuildOutput {
  private _outFiles?: FileSet;

  constructor(public readonly root: string) {
  }

  public get mainDirectory() {
    return path.join(this.root, 'out');
  }

  /**
   * Hash over the main output files
   */
  public outHash(): Promise<string> {
    return cachedPromise(this, outHashSym, async () => {
      // Cache this in file, saves recalculation
      const cacheFile = path.join(this.root, 'out.hash');
      if (await exists(cacheFile)) {
        return await fs.readFile(cacheFile, { encoding: 'utf-8' });
      } else {
        const h = await (await this.outFiles()).hash();
        await fs.writeFile(cacheFile, h, { encoding: 'utf-8' });
        return h;
      }
    });
  }

  /**
   * Actual OUT files
   */
  public async outFiles(): Promise<FileSet> {
    if (this._outFiles === undefined) {
      this._outFiles = await FileSet.fromDirectory(this.mainDirectory);
    }
    return this._outFiles;
  }
}

function slugify(x: string) {
  return x.replace(/[^a-zA-Z0-9!$@.-]/g, '-');
}