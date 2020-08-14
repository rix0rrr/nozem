import * as path from 'path';
import * as stream from 'stream';
import * as log from '../util/log';
import { promises as fs } from 'fs';
import * as tar from 'tar';

process.env.AWS_NODEJS_CONNECTION_REUSE_ENABLED = '1';
process.env.AWS_SDK_LOAD_CONFIG = '1';

import * as AWS from 'aws-sdk';
import { IRemoteCache, PackageVersion } from '../build-tools';
import { exists } from '../util/files';

export class S3Cache implements IRemoteCache {
  private readonly s3: AWS.S3;

  constructor(private readonly bucketName: string) {
    this.s3 = new AWS.S3();
  }

  public async contains(pv: PackageVersion): Promise<boolean> {
    // Must do listObject not getObject to avoid creating a false negative cache entry
    const response = await this.s3.listObjectsV2({
      Bucket: this.bucketName,
      Prefix: this.objectLocation(pv),
      MaxKeys: 1
    }).promise();

    return (response.KeyCount ?? 0) > 0;
  }

  public async fetch(pv: PackageVersion, targetDir: string): Promise<void> {
    await fs.mkdir(targetDir, { recursive: true });
    return new Promise((ok, ko) => this.s3.getObject({
      Bucket: this.bucketName,
      Key: this.objectLocation(pv),
    }).createReadStream()
      .pipe(tar.x({
        cwd: path.resolve(targetDir),
      }))
      .on('finish', ok)
      .on('error', ko));
  }

  public queueForStoring(pv: PackageVersion, sourceDir: string): void {
    const start = Date.now();

    exists(sourceDir).then(dirExists => {
      if (!dirExists) { return undefined; }

      const strm = new stream.PassThrough();
      const query = this.s3.upload({
        Bucket: this.bucketName,
        Key: this.objectLocation(pv),
        Body: strm
      });

      tar.c({
        gzip: true,
        cwd: sourceDir,
      }, ['.']).pipe(strm);

      return query.promise();
    })?.then(() => {
      const delta = (Date.now() - start) / 1000;
      log.info(`Cached ${pv.packageName} in ${delta.toFixed(1)}s`);
    });
  }

  private objectLocation(pv: PackageVersion) {
    return `nozem/${pv.packageName}/${pv.inHash}.tgz`;
  }
}