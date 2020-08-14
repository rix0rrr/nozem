import { BuildEnvironment, BuildOutput, PackageVersion } from "./build-tools";
import { IBuildDependency, IUnboundBuildDependency } from "./deps";
import { FileSet, standardHash } from "./util/files";
import { BuildGraph } from "./build-graph";
import { IBuildStrategy } from "./builds/build-strategy";
import { flatMap, cachedPromise } from "./util/runtime";
import * as log from './util/log';

const inHashSym = Symbol();

export class BuildNode {
  private _output: BuildOutput | undefined;

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
    return cachedPromise(this, inHashSym, async() => {
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
      return d.digest('hex');
    });
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

  public async packageVersion(): Promise<PackageVersion> {
    return { packageName: this.identifier, inHash: await this.inHash() };
  }

  public async build(env: BuildEnvironment): Promise<void> {
    log.info(`Build  ${this.identifier}`);
    try {
      const start = Date.now();
      await this.installDependencies(env);

      const pv = await this.packageVersion();
      const output = await env.makeTemporaryOutput();

      let verb = 'Finish';
      if (await env.workspace.remoteCache?.contains(pv)) {
        await env.workspace.remoteCache?.fetch(pv, output.mainWritingDirectory);
        this._output = await output.finalize();
        verb = 'Fetched';
      } else {
        await this.strategy.build(this, env, output);
        this._output = await output.finalize();
        env.workspace.remoteCache?.queueForStoring(pv, this._output.mainDirectory);
      }

      const delta = (Date.now() - start) / 1000;
      log.info(`${verb} ${this.identifier} (${delta.toFixed(1)}s)`);
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