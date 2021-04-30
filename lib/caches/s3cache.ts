import { createWriteStream } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as log from '../util/log';
import * as tar from 'tar';
import { S3 } from '@aws-sdk/client-s3';
import { fromIni, parseKnownFiles } from '@aws-sdk/credential-provider-ini';
import { fromEnv } from '@aws-sdk/credential-provider-env';
import { awsAuthMiddleware, awsAuthMiddlewareOptions } from '@aws-sdk/middleware-signing';
import { readStream, s3BodyToStream } from '../util/streams';

import { ensureDirForFile, exists, FileSet, FileSetSchema, readJsonIfExists } from '../util/files';
import { CacheLocator, IArtifactCache, ICachedArtifacts } from './icache';
import { Credentials } from 'aws-sdk';

export class S3Cache implements IArtifactCache {
  private _s3?: S3;
  private readonly indexDirectory: string;

  /**
   *  Circuit breakers for reading or writing
   */
  private _enabled = true;

  /**
   * Circuit breaker for writing only (might just not have permissions)
   */
  private _writeEnabled = true;

  constructor(private readonly bucketName: string, private readonly region?: string) {
    this.indexDirectory = path.join(os.homedir(), '.cache', 'nozem', 's3index', bucketName);
    this.startS3IndexScan();
  }

  public async lookup(loc: CacheLocator): Promise<ICachedArtifacts | undefined> {
    if (!this._enabled) { return undefined; }

    const localIndex = await readJsonIfExists<S3IndexFileSchema>(this.localIndexPath(loc));
    if (localIndex) {
      return new S3Artifact(await this.s3(), this.bucketName, this.remoteDataKey(loc), localIndex);
    }

    // Not available locally, poke S3 to be sure
    if (await this.remoteContains(loc)) {
      const remoteIndex: S3IndexFileSchema = JSON.parse(await this.fetchRemote(this.remoteIndexKey(loc)));
      return new S3Artifact(await this.s3(), this.bucketName, this.remoteDataKey(loc), remoteIndex);
    }

    return undefined;
  }

  private async remoteContains(pv: CacheLocator): Promise<boolean> {
    if (!this._enabled) { return false; }

    try {
      // Must do listObject not getObject to avoid creating a false negative cache entry
      const response = await (await this.s3()).listObjectsV2({
        Bucket: this.bucketName,
        Prefix: this.remoteIndexKey(pv),
        MaxKeys: 1
      });

      return (response.KeyCount ?? 0) > 0;
    } catch (e) {
      log.warning(`S3 error: ${e} (s3 cache disabled)`);
      this._enabled = false;
      return false;
    }
  }

  private async fetchRemote(key: string): Promise<string> {
    const response = await (await this.s3()).getObject({
      Bucket: this.bucketName,
      Key: key,
    });

    return response.Body?.toString() ?? '';
  }

  public queueForStoring(pv: CacheLocator, files: FileSet): void {
    if (!this._enabled || !this._writeEnabled) { return; }

    const start = Date.now();

    void(async () => {
      try {
        const s3 = await this.s3();

        // We need to read everything into memory, because there's a bug in the S3 client which doesn't allow
        // passing a stream. In any case, there's no benefit at all since the API call needs to know the content
        // length so it would read the file into memory anyway.
        const source = tar.c({
          gzip: true,
          cwd: files.root,
        }, files.fileNames);

        const remoteKey = this.remoteDataKey(pv);
        await s3.putObject({
          Bucket: this.bucketName,
          Key: remoteKey,
          Body: await readStream(source),
        });

        await s3.putObject({
          Bucket: this.bucketName,
          Key: this.remoteIndexKey(pv),
          Body: JSON.stringify({
            artifactHash: await files.hash(),
            artifacts: files.toSchema(),
          } as S3IndexFileSchema),
        });

        const delta = (Date.now() - start) / 1000;
        log.debug(`Uploaded s3://${this.bucketName}/${remoteKey} in ${delta.toFixed(1)}s`);
      } catch (e) {
        log.debug(`S3 error: ${e} (s3 writes disabled)`);
        this._writeEnabled = false;
      }
    })();
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

  private async s3() {
    if (!this._s3) {
      let credentials;

      const profileName = `${this.bucketName}-profile`;
      const profiles = await parseKnownFiles({});
      const haveProfile = !!profiles[profileName];
      const haveEnv = process.env.AWS_ACCESS_KEY_ID || process.env.CODEBUILD_CI;

      if (haveProfile) {
        log.debug(`Using S3 cache '${this.bucketName}' with profile '${profileName}'`);
        credentials = fromIni({ profile: profileName });
      } else if (haveEnv) {
        log.debug(`Using S3 cache '${this.bucketName}' using $AWS_ACCESS_KEY_ID credentials (tried profile '${profileName}')`);
        credentials = fromEnv();
      } else {
        log.debug(`Using S3 cache '${this.bucketName}' anonymously (tried profile '${profileName}')`);
        credentials = () => Promise.resolve(new Credentials({ accessKeyId: '', secretAccessKey: '' }));
      }

      this._s3 = new S3({ region: this.region, credentials });

      if (!haveProfile && !haveEnv) {
        // Replace AWSAuth middleware with one that doesn't do signing to effectively be
        // anonymous.
        this._s3.middlewareStack.addRelativeTo(awsAuthMiddleware({
          credentials,
          signer: () => Promise.resolve({
            sign: (request) => Promise.resolve(request),
          }),
          signingEscapePath: false,
          systemClockOffset: 0,
        }), awsAuthMiddlewareOptions);
      }
    }
    return this._s3;
  }

  /**
   * Mirror the remote S3 index to a local directory
   */
  private startS3IndexScan() {
    void(async () => {
      try {
        let continuationToken = undefined;
        while (true) {
          const response: import('aws-sdk').S3.ListObjectsV2Output = await (await this.s3()).listObjectsV2({
            Bucket: this.bucketName,
            Prefix: 'nozem/index/',
            ...continuationToken ? { ContinuationToken: continuationToken } : undefined,
          });

          await Promise.all((response.Contents ?? []).map(async (f) => {
            const loc = this.locFromRemoteIndexKey(f.Key ?? '');
            if (!await exists(this.localIndexPath(loc))) {
              return this.downloadRemoteIndexFile(loc);
            }
          }));


          if (!response.IsTruncated) { break; }
          continuationToken = response.NextContinuationToken;
        }
      } catch (e) {
        log.warning(`S3 error: ${e} (s3 cache disabled)`);
        this._enabled = false;
      }
    })();
  }

  private async downloadRemoteIndexFile(loc: CacheLocator): Promise<void> {
    await ensureDirForFile(this.localIndexPath(loc));

    return new Promise(async (ok, ko) => {
      const localFile = createWriteStream(this.localIndexPath(loc));
      const response = await (await this.s3()).getObject({
        Bucket: this.bucketName,
        Key: this.remoteIndexKey(loc),
      });
      s3BodyToStream(response.Body!)
        .pipe(localFile)
        .on('finish', ok)
        .on('error', ko);
    });
  }
}

class S3Artifact implements ICachedArtifacts {
  public readonly source = 's3';

  public readonly artifactHash: string;

  constructor(
    private readonly s3: S3,
    private readonly bucketName: string,
    private readonly remoteKey: string,
    private readonly schema: S3IndexFileSchema) {
    this.artifactHash = schema.artifactHash;
  }

  public async fetch(targetDir: string): Promise<FileSet> {
    const start = Date.now();

    await new Promise(async (ok, ko) => {
      const response = await this.s3.getObject({
        Bucket: this.bucketName,
        Key: this.remoteKey,
      });

      s3BodyToStream(response.Body!)
        .pipe(tar.x({
          cwd: path.resolve(targetDir),
        }))
        .on('finish', ok)
        .on('error', ko);
    });
    const delta = (Date.now() - start) / 1000;
    log.debug(`Downloaded s3://${this.bucketName}/${this.remoteKey} in ${delta.toFixed(1)}s`);

    return FileSet.fromSchema(targetDir, this.schema.artifacts);
  }
}

interface S3IndexFileSchema {
  readonly artifactHash: string;
  readonly artifacts: FileSetSchema;
}