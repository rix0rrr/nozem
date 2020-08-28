import * as path from 'path';
import * as log from './util/log';
import { Graph } from './util/graph';
import { IUnboundBuildDependency, createDependency } from './deps';
import { UnitDefinition, BuildDepSpec, depSpecRepr } from './nozem-schema';
import { BuildNode } from './build-node';
import { createStrategy } from './builds';
import { exists } from './util/files';
import { SimpleError } from './util/flow';

export class BuildGraph {
  public readonly graph = new Graph<BuildNode>();
  private readonly ids = new Map<string, BuildNode>();
  private readonly depCache = new Map<string, IUnboundBuildDependency>();

  constructor(private readonly rootDirectory: string, private readonly units: UnitDefinition[]) {
  }

  public async build() {
    for (const unit of this.units) {
      const node = new BuildNode(
        unit.identifier,
        await createStrategy(this.rootDirectory, unit),
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
    if (!ret) { throw new SimpleError(`No node with id: ${id}`); }
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

  public async selectTargets(targets: string[], downstream: boolean) {
    const nodes = new Array<BuildNode>();
    const msg = [];
    for (const target of targets) {
      if (await exists(target, s => s.isDirectory())) {
        const fullDir = path.resolve(target);
        const relDir = path.relative(this.rootDirectory, fullDir);
        msg.push(`nodes under '${fullDir}'`);
        nodes.push(...this.nodesUnderDir(relDir));
      } else {
        msg.push(target);
        nodes.push(this.lookup(target));
      }
    }
    if (downstream) {
      msg.push('and downstream dependencies');
    }

    log.info(`Selecting ${msg.join(', ')}.`);
    return this.graph.subgraph([
      ...this.graph.feedsInto(...nodes),
      ...(downstream ? this.graph.reachableFrom(...nodes) : []),
    ]);
  }

  private nodesUnderDir(dir: string) {
    const units = this.units.filter(unit => (unit.type === 'command' || unit.type === 'typescript-build') && isUnder(unit.root, dir));
    return units.map(u => this.lookup(u.identifier));
  }

  private makeDependency(dep: BuildDepSpec): IUnboundBuildDependency {
    const key = depSpecRepr(dep);
    if (!this.depCache.has(key)) {
      this.depCache.set(key, createDependency(this.rootDirectory, dep));
    }
    return this.depCache.get(key)!;
  }
}

function isUnder(dir: string, root: string) {
  return dir === root || dir.startsWith(`${root}/`) || dir.startsWith(`${root}\\`);
}