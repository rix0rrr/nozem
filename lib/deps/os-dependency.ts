import * as child_process from 'child_process';
import * as util from 'util';
import { OsDepSpec } from '../nozem-schema';
import { IBuildDependency, IUnboundBuildDependency } from './dependency';
import { BuildEnvironment } from '../build-tools';
import { BuildGraph } from '../build-graph';

const cpExecFile = util.promisify(child_process.execFile);

export class OsDependency implements IUnboundBuildDependency, IBuildDependency {
  public readonly boundDependency = this;
  public readonly name = this.def.executable;
  public readonly buildNodes = [];
  public readonly isAvailable = true;

  constructor(private readonly def: OsDepSpec) {
  }

  public bind(graph: BuildGraph): void {
  }

  public async outHash() {
    // FIXME: Should get tool version or summin'
    return '';
  }

  public async installInto(env: BuildEnvironment) {
    await this.findAndInstall(env, this.def.executable, this.def.rename);

    if (this.def.executable === 'yarn' && process.platform === 'linux') {
      // On Linux, the yarn executable is a shim that needs a couple of other
      // binaries installed as well.
      //
      // FIXME: This should probably impact the hash in some way...
      await this.findAndInstall(env, 'sed');
      await this.findAndInstall(env, 'readlink');
      await this.findAndInstall(env, 'dirname');
      await this.findAndInstall(env, 'uname');
    }
    if (this.def.executable === 'tar' && process.platform === 'linux') {
      await this.findAndInstall(env, 'gzip');
    }
  }

  private async findAndInstall(env: BuildEnvironment, executable: string, rename?: string) {
    const location = await this.findExecutable(executable);
    await env.installExecutable(location, rename);
  }

  private async findExecutable(executable: string) {
    try {
      const { stdout } = await cpExecFile('which', [executable], {});
      return stdout.trim();
    } catch (e) {
      if (e.code && e.code !== 0) {
        throw new Error(`Build needs command '${this.def.executable}', but not found`);
      }

      if (e.stdout) { process.stderr.write(e.stdout); }
      if (e.stderr) { process.stderr.write(e.stderr); }
      throw e;
    }
  }
}
