import { BuildDirectory } from '../build-tools/build-directory';

export interface IBuildInput {
  install(dir: BuildDirectory): Promise<void>;
}

