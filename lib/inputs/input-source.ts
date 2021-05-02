import { BuildDirectory } from '../build-tools/build-directory';
import { FileSet } from '../util/files';
import { IHashable, IHashableElements } from '../util/merkle';
import { IBuildInput } from './build-input';

export class SourceInput implements IBuildInput, IHashableElements {
  constructor(public readonly files: FileSet) {
  }

  public get hashableElements(): Record<string, IHashable> {
    return this.files.hashableElements;
  }

  public async install(dir: BuildDirectory): Promise<void> {
    await dir.addSrcFiles(this.files);
  }
}