import { BuildDirectory } from '../build-tools/build-directory';

export interface IBuildInput {
  hash(): Promise<string>
  install(dir: BuildDirectory): Promise<void>;
}

