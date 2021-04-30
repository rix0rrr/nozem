import * as path from 'path';
import { BuildDirectory } from '../build-tools/build-directory';
import { exists } from '../util/files';
import * as log from '../util/log';
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

    // Make an exception for Docker Desktop. It seems 'com.docker.cli' and other tools are also necessary
    // for some versions of Docker to work properly. This used to be disablable by turning off "Cloud Experience"
    // in Docker Desktop 2, but they removed it in 3.
    // let's just go with it.
    if (this.name === 'docker') {
      for (const alsoInstall of ['com.docker.cli', 'docker-credential-desktop', 'docker-credential-osxkeychain']) {
        try {
          await dir.installExecutable(await OsToolInput.findExecutable(alsoInstall), alsoInstall);
        } catch (e) {
          log.debug(`${e}`);
        }
      }
    }
  }
}