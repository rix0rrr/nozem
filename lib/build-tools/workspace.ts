import * as os from 'os';
import * as path from 'path';
import { PackageJson } from '../file-schemas';
import { exists } from '../util/files';
import { readPackageJson } from '../util/npm';
import { NpmPackageBuild } from '../builds/npm-package-build';
import { IArtifactCache } from '../caches/icache';
import { DirectoryCache } from '../caches/directory-cache';
import { CacheChain } from '../caches/cache-chain';
import { S3Cache } from '../caches/s3cache';
import { NullCache } from '../caches/null-cache';
import { NodeFarmCache } from '../caches/node-farm-cache';

export interface WorkspaceOptions {
  readonly test: boolean;
  readonly cache: boolean;
}

const MAX_CACHE_SIZE_MB = 1000;

export class Workspace {
  public static async fromDirectory(root: string, options: WorkspaceOptions) {
    const pj = await exists(path.join(root, 'package.json')) ? await readPackageJson(root) : undefined;
    return new Workspace(root, pj, options);
  }

  public readonly artifactCache: IArtifactCache;
  public readonly nodeFarmCache: NodeFarmCache;
  private packageBuildCache = new Map<string, NpmPackageBuild>();

  constructor(
    public readonly root: string,
    private readonly packageJson: PackageJson | undefined,
    public readonly options: WorkspaceOptions) {

    this.nodeFarmCache = new NodeFarmCache(path.join(os.tmpdir(), 'nozem-nodefarm'));

    if (options.cache) {
      const localCache = DirectoryCache.default({
        maxSizeMB: MAX_CACHE_SIZE_MB,
      });

      if (packageJson?.nozem !== false && packageJson?.nozem?.cacheBucket) {
        this.artifactCache = new CacheChain(
          localCache,
          new S3Cache(
            packageJson.nozem?.cacheBucket,
            packageJson?.nozem.cacheBucketRegion ?? 'us-east-1'
          ),
        );
      } else {
        this.artifactCache = localCache;
      }
    } else {
      this.artifactCache = new NullCache();
    }
  }

  /**
   * Return a relative path from the workspace root to the given directory
   */
  public relativePath(absPath: string) {
    return path.relative(this.root, path.resolve(absPath));
  }

  /**
   * Return a relative path from the given path to the root of the workspace
   */
  public relativeToRoot(absPath: string) {
    return path.relative(absPath, this.root);
  }

  public async npmPackageBuild(dir: string): Promise<NpmPackageBuild> {
    // Builds are memoized because there is a lot of package reuse in the tree.
    const existing = this.packageBuildCache.get(dir);
    if (existing) { return existing; }

    const build = await NpmPackageBuild.fromDirectory(dir, this);
    this.packageBuildCache.set(dir, build);
    return build;
  }

  public absoluteGlobalNonPackageFiles(relativeToDir: string): string[] {
    if (!this.packageJson?.nozem) { return []; }

    return (this.packageJson?.nozem?.globalNonPackageFiles ?? []).map(p => path.relative(relativeToDir, path.join(this.root, p)));
  }
}