import { IBuildDependency, IUnboundBuildDependency } from ".";
import { InternalNpmDepSpec } from "../nozem-schema";
import { BuildNode } from "../build-node";
import { BuildEnvironment } from "../build-tools";
import { installNpmPackage } from "./_npm";
import { BuildGraph } from "../build-graph";

export class InternalNpmDependency implements IBuildDependency {
  public readonly name = this.def.node;
  public readonly buildNodes = [this.node];

  private _outHashCache?: Promise<string>;

  constructor(private readonly def: InternalNpmDepSpec, private readonly node: BuildNode) {
  }

  public get isAvailable() {
    return this.node.isBuilt;
  }

  public async installInto(env: BuildEnvironment) {
    const builtDir = this.node.output.mainDirectory;
    await installNpmPackage(builtDir, env, this.def.executables);
  }

  public outHash() {
    if (this._outHashCache === undefined) {
      this._outHashCache = (async () => (await this.node.output.outHash()) + (this.def.executables ? '1' : '0'))();
    }
    return this._outHashCache;
  }
}

