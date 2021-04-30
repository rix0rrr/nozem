import * as path from 'path';
import * as log from '../util/log';
import { CacheFile } from '../util/cache-file';
import { fileHash, HashableFile, readJsonIfExists, writeJson } from '../util/files';
import { shellExecute } from '../build-tools';
import { MonoRepoPackage } from '../util/monorepo';
import { constantHashable, IHashable, MerkleTree, standardHash } from '../util/merkle';

/**
 * A fake build-like thing
 *
 * Its only job is to do a 'yarn install', which may be skipped if the
 * 'yarn.lock' hasn't changed since the last install.
 *
 * It's not hermetic at all, we install straight into the workspace
 * directory.
 */
export class YarnInstall {
  constructor(private readonly root: string, private readonly monoRepoPackages: Array<MonoRepoPackage>) {
  }

  public async install() {
    const lockFilename = path.join(this.root, 'yarn.lock');

    const lockTree = new MerkleTree({
      'yarn.lock': new HashableFile(lockFilename),
      'monoRepoLayout': this.monoRepoDependencyTree(),
    });
    const lockHash = await lockTree.hash();

    const cacheFile = new CacheFile<InstallCacheSchema>(path.join(this.root, CACHE_FILE));
    const cache = await cacheFile.read();
    if (cache?.lockHash === lockHash)  {
      log.debug('install still valid');
      return;
    };

    log.info('yarn install');
    await shellExecute('yarn install --frozen-lockfile', this.root, process.env);

    await cacheFile.write({ lockHash, });
  }

  private monoRepoDependencyTree(): MerkleTree<IHashable> {
    const ret = new MerkleTree<IHashable>();

    for (const p of this.monoRepoPackages) {
      ret.add(p.packageJson.name, MerkleTree.fromDict({
        ...p.packageJson.dependencies,
        ...p.packageJson.devDependencies,
      }));
    }

    return ret;
  }
}

const CACHE_FILE = '.nzm-installcache';

export interface InstallCacheSchema {
  readonly lockHash: string;
}