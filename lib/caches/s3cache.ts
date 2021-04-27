import { createWriteStream } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as stream from 'stream';
import * as log from '../util/log';
import * as tar from 'tar';

import { exists, FileSet, FileSetSchema, readJsonIfExists } from '../util/files';
import { CacheLocator, IArtifactCache, ICachedArtifacts } from './icache';

type S3Client = import('aws-sdk').S3;

export class S3Cache implements IArtifactCache {
  private readonly s3: S3Client;
  private readonly indexDirectory: string;

  constructor(private readonly bucketName: string, region?: string, profileName?: string) {
    process.env.AWS_NODEJS_CONNECTION_REUSE_ENABLED = '1';
    process.env.AWS_SDK_LOAD_CONFIG = '1';
    if (profileName) {
      process.env.AWS_PROFILE = profileName;
    }

    this.s3 = new (require('aws-sdk')).S3({ region });
    this.indexDirectory = path.join(os.homedir(), '.cache', 'nozem', 's3index', bucketName);
    this.startS3IndexScan();
  }

  public async lookup(loc: CacheLocator): Promise<ICachedArtifacts | undefined> {
    const localIndex = await readJsonIfExists<S3IndexFileSchema>(this.localIndexPath(loc));
    if (localIndex) {
      return new S3Artifact(this.s3, this.bucketName, this.remoteDataKey(loc), localIndex);
    }

    // Not available locally, poke S3 to be sure
    if (await this.remoteContains(loc)) {
      const remoteIndex: S3IndexFileSchema = JSON.parse(await this.fetchRemote(this.remoteIndexKey(loc)));
      return new S3Artifact(this.s3, this.bucketName, this.remoteDataKey(loc), remoteIndex);
    }

    return undefined;
  }

  private async remoteContains(pv: CacheLocator): Promise<boolean> {
    // Must do listObject not getObject to avoid creating a false negative cache entry
    const response = await this.s3.listObjectsV2({
      Bucket: this.bucketName,
      Prefix: this.remoteIndexKey(pv),
      MaxKeys: 1
    }).promise();

    return (response.KeyCount ?? 0) > 0;
  }

  private async fetchRemote(key: string): Promise<string> {
    const response = await this.s3.getObject({
      Bucket: this.bucketName,
      Key: key,
    }).promise();

    return response.Body?.toString() ?? '';
  }

  public queueForStoring(pv: CacheLocator, files: FileSet): void {
    const start = Date.now();

    (async () => {
      const strm = new stream.PassThrough();
      const query = this.s3.upload({
        Bucket: this.bucketName,
        Key: this.remoteDataKey(pv),
        Body: strm
      });

      tar.c({
        gzip: true,
        cwd: files.root,
      }, files.fileNames).pipe(strm);

      await query.promise();

      const delta = (Date.now() - start) / 1000;
      log.info(`Uploaded ${pv.displayName ?? 'package'} in ${delta.toFixed(1)}s`);
    });
  }

  private localIndexPath(loc: CacheLocator) {
    return path.join(this.indexDirectory, loc.inputHash.substr(0, 4), loc.inputHash + '.json');
  }

  private remoteIndexKey(loc: CacheLocator) {
    return `nozem/index/${loc.inputHash}.json`;
  }

  private locFromRemoteIndexKey(key: string): CacheLocator {
    const parts = key.split('/');
    const inputHash = parts[parts.length - 1].replace(/\.json$/, '');
    return { inputHash };
  }


  private remoteDataKey(pv: CacheLocator) {
    return `nozem/data/${pv.inputHash}.tar.gz`;
  }

  /**
   * Mirror the remote S3 index to a local directory
   */
  private startS3IndexScan() {
    (async () => {
      let continuationToken = undefined;
      while (true) {
        const response: import('aws-sdk').S3.ListObjectsV2Output = await this.s3.listObjectsV2({
          Bucket: this.bucketName,
          Prefix: 'nozem/index/',
          ...continuationToken ? { ContinuationToken: continuationToken } : undefined,
        }).promise();

        await Promise.all((response.Contents ?? []).map(async (f) => {
          const loc = this.locFromRemoteIndexKey(f.Key ?? '');
          if (!await exists(this.localIndexPath(loc))) {
            return this.downloadRemoteIndexFile(loc);
          }
        }));


        if (!response.IsTruncated) { break; }
        continuationToken = response.NextContinuationToken;
      }
    })();
  }

  private async downloadRemoteIndexFile(loc: CacheLocator): Promise<void> {
    const localFile = createWriteStream(this.localIndexPath(loc));
    await new Promise((ok, ko) => this.s3.getObject({
      Bucket: this.bucketName,
      Key: this.remoteIndexKey(loc),
    }).createReadStream()
      .pipe(localFile)
      .on('finish', ok)
      .on('error', ko));
  }
}

class S3Artifact implements ICachedArtifacts {
  public readonly source = 's3';

  public readonly artifactHash: string;

  constructor(
    private readonly s3: S3Client,
    private readonly bucketName: string,
    private readonly remoteKey: string,
    private readonly schema: S3IndexFileSchema) {
    this.artifactHash = schema.artifactHash;
  }

  public async fetch(targetDir: string): Promise<FileSet> {
    await new Promise((ok, ko) => this.s3.getObject({
      Bucket: this.bucketName,
      Key: this.remoteKey,
    }).createReadStream()
      .pipe(tar.x({
        cwd: path.resolve(targetDir),
      }))
      .on('finish', ok)
      .on('error', ko));

    return FileSet.fromSchema(targetDir, this.schema.artifacts);
  }
}

interface S3IndexFileSchema {
  readonly artifactHash: string;
  readonly artifacts: FileSetSchema;
}