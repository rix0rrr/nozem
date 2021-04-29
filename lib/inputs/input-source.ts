import { BuildDirectory } from '../build-tools/build-directory';
import { FileSet } from '../util/files';
import { IHashable, IMerkleTree } from '../util/merkle';
import { IBuildInput } from './build-input';

export class SourceInput implements IBuildInput, IMerkleTree {
  constructor(public readonly files: FileSet) {
  }

  public get elements(): Record<string, IHashable> {
    return this.files.elements;
  }

  public hash(): Promise<string> {
    return this.files.hash();
  }

  public async install(dir: BuildDirectory): Promise<void> {
    await dir.addSrcFiles(this.files);
  }
}