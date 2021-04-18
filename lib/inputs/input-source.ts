import { BuildDirectory } from '../build-tools/build-directory';
import { FileSet } from '../util/files';
import { IBuildInput } from './build-input';

export class SourceInput implements IBuildInput {
  public static async fromGitDirectory(dir: string) {
    return new SourceInput(await FileSet.fromGitignored(dir));
  }

  constructor(public readonly files: FileSet) {
  }

  public hash(): Promise<string> {
    return this.files.hash();
  }

  public async install(dir: BuildDirectory): Promise<void> {
    await dir.addSrcFiles(this.files);
  }
}