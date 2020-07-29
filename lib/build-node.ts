import { BuildEnvironment, BuildOutput } from "./build-tools";
import { IBuildDependency, IUnboundBuildDependency } from "./deps";
import { FileSet, standardHash } from "./util/files";
import { BuildGraph } from "./build-graph";
import { IBuildStrategy } from "./builds/build-strategy";
import { flatMap } from "./util/runtime";
import * as log from './util/log';

export class BuildNode {
  private _output: BuildOutput | undefined;
  private _hash?: string;

  constructor(public readonly identifier: string, private readonly strategy: IBuildStrategy, private readonly unboundDependencies: IUnboundBuildDependency[]) {
  }

  /**
   * Array of dependency nodes
   */
  public get dependencies(): IBuildDependency[] {
    return this.unboundDependencies.map(d => d.boundDependency);
  }

  /**
   * Whether the node is ready to be built
   *
   * True if all dependencies are available
   */
  public get isBuildable(): boolean {
    return this.dependencies.every(d => d.isAvailable);
  }

  public async inHash(): Promise<string> {
    if (this._hash === undefined) {
      const d = standardHash();
      d.update('identifier:');
      d.update(this.identifier);
      d.update('deps:');
      for (const dep of this.dependencies) {
        d.update(dep.name);
        d.update('=');
        d.update(await dep.outHash());
      }
      d.update('def:');
      await this.strategy.updateInhash(d);
      this._hash = d.digest('hex');
    }
    return this._hash;
  }

  public get isBuilt() {
    return this._output !== undefined;
  }

  public get output() {
    if (this._output === undefined) {
      throw new Error(`Not built yet: ${this.identifier}`);
    }
    return this._output;
  }

  public async build(env: BuildEnvironment): Promise<void> {
    log.info(`Build  ${this.identifier}`);
    try {
      const start = Date.now();

      const output = await env.makeTemporaryOutput();
      await this.strategy.build(this, env, output);
      this._output = await output.finalize();

      const delta = (Date.now() - start) / 1000;
      log.info(`Finish ${this.identifier} (${delta.toFixed(1)}s)`);
    } catch (e) {
      log.error(`Failed ${this.identifier}: ${e.message}`);
      throw e;
    }
  }

  public useOutput(output: BuildOutput) {
    this._output = output;
  }

  public async installDependencies(env: BuildEnvironment) {
    for (const dep of this.dependencies) {
      await dep.installInto(env);
    }
  }

  /**
   * Look up the dependency nodes in the actual build graph and establish edges
   */
  public reifyDependencies(graph: BuildGraph): void {
    for (const d of this.unboundDependencies) {
      d.bind(graph);
    }

    graph.addIncomingEdges(flatMap(this.dependencies, d => d.buildNodes), this);
  }

  public toString() {
    return this.identifier;
  }
}