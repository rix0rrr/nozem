import { FileSet } from '../util/files';
import { CacheLocator, IArtifactCache, ICachedArtifacts } from './icache';

export class NullCache implements IArtifactCache {
  public lookup(pv: CacheLocator): Promise<ICachedArtifacts | undefined> {
    return Promise.resolve(undefined);
  }

  public queueForStoring(pv: CacheLocator, files: FileSet): void {
  }
}