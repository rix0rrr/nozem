import * as log from './util/log';
import { BuildNode } from "./build-node";
import { Graph } from "./util/graph";

export interface QueueOptions {
  readonly concurrency?: number;
  readonly bail?: boolean;
}

export class BuildQueue {
  private readonly concurrency: number;
  private readonly bail: boolean;

  /**
   * Nodes that have already been enqueued and don't have to be enqueued again
   */
  private readonly enqueued = new Set<BuildNode>();

  /**
   * Nodes ready to be built
   */
  private readonly buildable = new Array<BuildNode>();

  /**
   * Nodes that we've decided not to build
   */
  private readonly failed = new Set<BuildNode>();

  private _finished = 0;
  private _active = 0;
  private _pruned = 0;
  private _failed = false;

  constructor(private readonly graph: Graph<BuildNode>, options: QueueOptions = {}) {
    this.concurrency = options.concurrency ?? 1;
    this.bail = options.bail ?? true;

    for (const node of graph.nodes()) {
      this.maybeEnqueue(node);
    }
    if (this.buildable.length === 0) {
      throw new Error('No nodes are buildable');
    }
  }

  public get size() { return this.graph.nodes().length; }
  public get finished() { return this._finished; }
  public get active() { return this._active; }

  public execute(cb: (node: BuildNode) => Promise<void>): Promise<void> {
    log.debug(`Building with concurrency ${this.concurrency}`);
    return new Promise((ok, ko) => {
      const launchMore = () => {
        if (this._failed) { return; }

        if (this.buildable.length === 0 && this._active === 0) {
          allFinished();
        }

        // Launch as many parallel "threads" as we can
        while (this._active < this.concurrency && this.buildable.length > 0) {
          const node = this.buildable.splice(0, 1)[0];
          this._active++;
          cb(node).then(_ => finishedNode(node)).catch(e => handleFailure(node, e));
        }
      }

      const handleFailure = (node: BuildNode, e: Error) => {
        if (this.bail) {
          this._failed = true;
          ko(e);
          return;
        }

        this.failed.add(node);

        const prunables = this.graph.reachableFrom(node).filter(n => !this.enqueued.has(n));
        this._pruned += prunables.length;
        for (const p of prunables) {
          this.enqueued.add(p);
        }

        log.warning(`Continuing after failure, ${prunables.length} nodes pruned (${describeNodes(prunables)})`);
        finishedNode(node);
      };

      const finishedNode = (node: BuildNode) => {
        this._active--;
        this._finished += 1;
        // Add everything that's now newly buildable
        this.enqueueBuildableSuccessors(node);
        launchMore();
      };

      const allFinished = () => {
        if (this._failed) { return; }

        if (this.enqueued.size !== this.graph.nodes().length) {
          log.warning(`Finished ${this.enqueued.size} out of ${this.graph.nodes().length} jobs`);

          for (const node of this.graph.nodes()) {
            if (this.enqueued.has(node)) { continue; }
            log.warning(`- ${node.identifier}: waiting for ${node.dependencies.filter(d => !d.isAvailable).map(d => d.name)}`);
          }
        }

        if (this.failed.size > 0) {
          log.warning(`${this.failed.size} nodes failed to build, ${this._pruned} nodes pruned.`);
        }

        ok(); // We're done
      };

      launchMore();
    });
  }

  public async writeGraphViz(filename: string) {
    await this.graph.writeGraphViz(filename);
  }

  private enqueueBuildableSuccessors(node: BuildNode) {
    for (const successor of this.graph.successors(node)) {
      this.maybeEnqueue(successor);
    }
  }

  private maybeEnqueue(node: BuildNode) {
    if (node.isBuildable && !this.enqueued.has(node)) {
      this.enqueued.add(node);
      this.buildable.push(node);
    }
  }
}


function describeNodes(nodes: BuildNode[]) {
  const names = nodes.map(n => n.identifier);
  if (names.length > 7) {
    names.splice(3, names.length - 6, '...');
  }
  return names.join(', ');
}