import * as path from 'path';
import { promises as fs } from 'fs';
import * as log from './util/log';
import { TsconfigJson } from './file-schemas';
import { FileSet, FilePatterns, standardHash, readJson, writeJson } from './util/files';
import { Graph } from './util/graph';
import { IBuildDependency, IUnboundBuildDependency, createDependency } from './deps';
import { UnitDefinition, BuildDepSpec, depSpecRepr } from './nozem-schema';
import { BuildNode } from './build-node';
import { BuildQueue } from './build-queue';
import { createStrategy } from './builds';

export class BuildGraph {
  public readonly graph = new Graph<BuildNode>();
  private readonly ids = new Map<string, BuildNode>();
  private readonly depCache = new Map<string, IUnboundBuildDependency>();

  constructor(private readonly units: UnitDefinition[]) {
  }

  public async build() {
    for (const unit of this.units) {
      const node = new BuildNode(
        unit.identifier,
        await createStrategy(unit),
        (unit.dependencies ?? []).map(d => this.makeDependency(d))
        );
      this.graph.addNode(node);
      this.ids.set(unit.identifier, node);
    }
    for (const unit of this.graph.nodes()) {
      unit.reifyDependencies(this);
    }
  }

  public addIncomingEdges(dependencies: BuildNode[], target: BuildNode) {
    for (const depNode of dependencies) {
      this.graph.addEdge(depNode, target);
    }
  }

  public lookup(id: string) {
    const ret = this.ids.get(id);
    if (!ret) { throw new Error(`No node with id: ${id}`); }
    return ret;
  }

  public sorted() {
    return this.graph.sorted();
  }

  public incomingClosure(targets: string[]) {
    const nodes = targets.map(t => this.lookup(t));
    const incomingClosure = this.graph.feedsInto(...nodes);
    return this.graph.subgraph(incomingClosure);
  }

  private makeDependency(dep: BuildDepSpec): IUnboundBuildDependency {
    const key = depSpecRepr(dep);
    if (!this.depCache.has(key)) {
      this.depCache.set(key, createDependency(dep));
    }
    return this.depCache.get(key)!;
  }
}
