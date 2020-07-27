import * as path from 'path';
import { IBuildDependency } from ".";
import * as log from '../util/log';
import { CopyDepSpec } from "../nozem-schema";
import { BuildNode } from "../build-node";
import { BuildEnvironment } from "../build-tools";

export class CopyFilesDependency implements IBuildDependency {
  public readonly name = this.node.identifier;
  public readonly buildNodes = [this.node];

  private _outHashCache?: Promise<string>;

  constructor(private readonly def: CopyDepSpec, private readonly node: BuildNode) {
  }

  public get isAvailable() {
    return this.node.isBuilt;
  }

  public async installInto(env: BuildEnvironment) {
    log.debug(`Copy ${this.node.output.mainDirectory} -> ${path.join(env.srcDir, this.def.subdir ?? '.')}`);
    await env.addSrcFiles(await this.node.output.outFiles(), this.def.subdir ?? '.');
  }

  public outHash(): Promise<string> {
    if (this._outHashCache === undefined) {
      this._outHashCache = this.node.output.outHash();
    }
    return this._outHashCache;
  }
}
