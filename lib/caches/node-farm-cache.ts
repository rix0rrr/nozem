import * as path from 'path';
import { promises as fs } from 'fs';
import { exists, TEST_clearFileHashCache } from "../util/files";

export class NodeFarmCache {
  private existingPromises = new Map<string, Promise<string>>();
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  public async obtain(name: string, filler: (dir: string) => Promise<void>): Promise<string> {
    const fullDir = path.join(this.directory, name);
    if (await exists(fullDir)) { return fullDir; }

    const existing = this.existingPromises.get(name);
    if (existing) { return existing; }

    const promise = (async () => {
      const tmpDir = `${fullDir}.tmp`;
      await fs.mkdir(tmpDir, { recursive: true });
      await filler(tmpDir);

      await fs.rename(tmpDir, fullDir);
      return fullDir;
    })();
    this.existingPromises.set(name, promise);
    return promise;
  }
}