import { FileSet } from '../util/files';

export interface IArtifactCache {
  lookup(pv: CacheLocator): Promise<ICachedArtifacts | undefined>;
  queueForStoring(pv: CacheLocator, files: FileSet): void;
}
export interface ICachedArtifacts {
  readonly source: string;
  readonly artifactHash: string;
  fetch(targetDir: string): Promise<FileSet>;
}

export interface CacheLocator {
  readonly displayName?: string;
  readonly inputHash: string;
}
