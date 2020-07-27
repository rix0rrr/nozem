import * as log from './util/log';
import { BuildNode } from "./build-node";
import { Graph } from "./util/graph";

export class BuildQueue {
  private enqueued = new Set<BuildNode>();
  private buildable = new Array<BuildNode>();
  private _finished = 0;
  private _active = 0;

  constructor(private readonly graph: Graph<BuildNode>) {
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

  public parallel(n: number, cb: (node: BuildNode) => Promise<void>): Promise<void> {
    return new Promise((ok, ko) => {
      const launchMore = () => {
        if (this.buildable.length === 0 && this._active === 0) {
          if (this.enqueued.size !== this.graph.nodes().length) {
            log.warning(`Finished ${this.enqueued.size} out of ${this.graph.nodes().length} jobs`);

            for (const node of this.graph.nodes()) {
              if (this.enqueued.has(node)) { continue; }
              log.warning(`- ${node.identifier}: waiting for ${node.dependencies.filter(d => !d.isAvailable).map(d => d.name)}`);
            }
          }

          ok(); // We're done
        }

        // Launch as many parallel "threads" as we can
        while (this._active < n && this.buildable.length > 0) {
          const node = this.buildable.splice(0, 1)[0];
          this._active++;
          cb(node).then(_ => finished(node)).catch(ko);
        }
      }

      const finished = (node: BuildNode) => {
        this._active--;
        this._finished += 1;
        // Add everything that's now newly buildable
        this.enqueueBuildableSuccessors(node);
        launchMore();
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
