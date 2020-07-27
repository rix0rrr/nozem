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
    const location = await this.findExecutable();
    await env.installExecutable(location, this.def.rename);
  }

  private async findExecutable() {
    try {
      const { stdout } = await cpExecFile('which', [this.def.executable], {});
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
