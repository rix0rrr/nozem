import * as path from 'path';
import { BuildDirectory } from '../build-tools/build-directory';
import { exists } from '../util/files';
import { cachedPromise } from '../util/runtime';
import { IBuildInput } from './build-input';

const cachedLocations: any = {};

export class OsToolInput implements IBuildInput {
  public static async fromExecutable(name: string, queryVersion: boolean = false) {
    if (queryVersion) { throw new Error('Not supported net'); }

    const found = await this.findExecutable(name);
    return new OsToolInput(name, found, 'any');
  }

  private static async findExecutable(name: string) {
    return cachedPromise(cachedLocations, name, async() => {
      for (const p of process.env.PATH?.split(':') ?? []) {
        const fullPath = path.resolve(p, name);
        if (await exists(fullPath)) {
          return fullPath;
        }
      }
      throw new Error(`Build needs command '${name}', but not found`);
    });
  }

  constructor(public readonly name: string, private readonly location: string, private readonly version: string) {
  }

  public hash(): Promise<string> {
    return Promise.resolve(this.version);
  }

  public async install(dir: BuildDirectory): Promise<void> {
    await dir.installExecutable(this.location, this.name);
  }
}