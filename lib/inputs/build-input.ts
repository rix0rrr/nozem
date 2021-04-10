import { BuildDirectory } from '../builds1/build-directory';

export interface IBuildInput {
  hash(): Promise<string>
  install(dir: BuildDirectory): Promise<void>;
}

