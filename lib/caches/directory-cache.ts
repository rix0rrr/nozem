import { allFilesRecursive, ensureDirForFile, ensureSymlink, FileSet, FileSetSchema, newestFirst, readJsonIfExists, writeJson } from '../util/files';
import { CacheLocator, IArtifactCache, ICachedArtifacts } from './icache';
import * as log from '../util/log';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { promises as fs } from 'fs';
import { PROMISE_POOL } from '../util/concurrency';
import { OneAtATime } from '../util/one-at-a-time';
import { hashOf } from '../util/merkle';

export interface DirectoryCacheOptions {
  readonly maxSizeMB?: number;
}

export class DirectoryCache implements IArtifactCache {
  public static default(options: DirectoryCacheOptions = {}) {
    return new DirectoryCache(path.join(os.homedir(), '.cache', 'nozem', 'local'), options);
  }

  private cleaning = new OneAtATime();

  constructor(private readonly directory: string, private readonly options: DirectoryCacheOptions = {}) {
  }

  public async lookup(pv: CacheLocator): Promise<ICachedArtifacts | undefined> {
    const index = await readJsonIfExists<IndexFileSchema>(this.indexFilePath(pv));
    return index ? new DirectoryArtifact(this.dataFilePath(pv), index) : undefined;
  }

  public queueForStoring(pv: CacheLocator, files: FileSet): Promise<void> {
    return PROMISE_POOL.queue(async () => {
      // First write data, then write index (because we do the lookup in reverse order)
      await ensureDirForFile(this.dataFilePath(pv));
      await tar.c({
        file: this.dataFilePath(pv),
        gzip: true,
        cwd: files.root,
      }, files.fileNames);

      await ensureDirForFile(this.indexFilePath(pv));
      await writeJson<IndexFileSchema>(this.indexFilePath(pv), {
        artifactHash: await hashOf(files),
        artifacts: files.toSchema(),
      });

      log.debug(`Stored ${pv.displayName ?? 'package'}`);

      // FIXME: Doing this every time is probably causing a lot of disk churn.
      // Can we be more efficient?
      this.cleanCache();
    });
  }

  private indexFilePath(loc: CacheLocator): string {
    return path.join(this.directory, loc.inputHash.substr(0, 4), loc.inputHash + '.json');
  }

  private dataFilePath(loc: CacheLocator): string {
    return path.join(this.directory, loc.inputHash.substr(0, 4), loc.inputHash + '.tar.gz');
  }

  private cleanCache() {
    if (this.options.maxSizeMB === undefined) { return; }

    const maxSizeBytes = this.options.maxSizeMB * 1_000_000;

    this.cleaning.tryRun(async () => {
      const files = await allFilesRecursive(this.directory);
      const tarballs = files.filter(f => f.fullPath.endsWith('.tar.gz'));
      tarballs.sort(newestFirst);

      let size = 0;
      for (const f of tarballs) {
        size += f.size;

        if (size >= maxSizeBytes) {
          // Delete index file and data file
          log.debug(`Cleaning cache: ${f.fullPath}`);
          await fs.unlink(f.fullPath.replace(/\.tar\.gz$/, '.json'));
          await fs.unlink(f.fullPath);
        }
      }
    });
  }
}

class DirectoryArtifact implements ICachedArtifacts {
  public readonly source = 'machine';

  public readonly artifactHash: string;

  constructor(private readonly dataFile: string, private readonly schema: IndexFileSchema) {
    this.artifactHash = schema.artifactHash;
  }

  public async fetch(targetDir: string): Promise<FileSet> {
    await tar.x({
      file: this.dataFile,
      cwd: targetDir,
    });

    return FileSet.fromSchema(targetDir, this.schema.artifacts);
  }
}

interface IndexFileSchema {
  readonly artifactHash: string;
  readonly artifacts: FileSetSchema;
}