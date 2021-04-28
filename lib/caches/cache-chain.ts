import { FileSet } from "../util/files";
import { CacheLocator, IArtifactCache, ICachedArtifacts } from "./icache";

export class CacheChain implements IArtifactCache {
  private readonly caches: IArtifactCache[];
  constructor(...caches: IArtifactCache[]) {
    this.caches = caches;
  }

  public async lookup(pv: CacheLocator): Promise<ICachedArtifacts | undefined> {
    // Lookup from first
    for (const cache of this.caches) {
      const r = await cache.lookup(pv);
      if (r) { return r; }
    }
    return undefined;
  }

  public queueForStoring(pv: CacheLocator, files: FileSet): void {
    // Store in all
    for (const cache of this.caches) {
      cache.queueForStoring(pv, files);
    }
  }
}