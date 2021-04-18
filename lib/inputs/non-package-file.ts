import * as path from 'path';
import { BuildDirectory } from '../build-tools/build-directory';
import { fileHash } from '../util/files';
import { IBuildInput } from './build-input';

export class NonPackageFileInput implements IBuildInput {
  private readonly absPath: string;

  constructor(public readonly directory: string, public readonly relativePath: string) {
    this.absPath = path.join(this.directory, this.relativePath);
  }

  public hash(): Promise<string> {
    return fileHash(this.absPath);
  }

  public async install(dir: BuildDirectory): Promise<void> {
    await dir.addSrcFile(this.absPath, this.relativePath);
  }
}
