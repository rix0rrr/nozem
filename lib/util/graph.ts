import { topologicalSort } from "./toposort";
import { promises as fs } from 'fs';


/**
 * Directed acylic graph
 */
export class Graph<A> {
  private _nodes = new Set<A>();
  private _outgoing = new Map<A, A[]>();
  private _incoming = new Map<A, A[]>();

  public nodes(): Array<A> {
    return Array.from(this._nodes);
  }

  public hasNode(node: A) {
    return this._nodes.has(node);
  }

  public addNode(...nodes: A[]) {
    for (const node of nodes) {
      this._nodes.add(node);
    }
  }

  public addEdge(from: A, to: A) {
    if (!this._nodes.has(from)) {
      throw new Error(`FROM node is not in Graph`);
    }
    if (!this._nodes.has(to)) {
      throw new Error(`TO node is not in Graph`);
    }

    if (!this._outgoing.has(from)) { this._outgoing.set(from, []); }
    this._outgoing.get(from)!.push(to);

    if (!this._incoming.has(to)) { this._incoming.set(to, []); }
    this._incoming.get(to)!.push(from);
  }

  public successors(x: A) {
    return this._outgoing.get(x) ?? [];
  }

  public* edges(): IterableIterator<[A, A]> {
    for (const [from, tos] of this._outgoing) {
      for (const to of tos) {
        yield [from, to];
      }
    }
  }

  public reverse() {
    const ret = new Graph();
    ret.addNode(...this._nodes);
    for (const [from, to] of this.edges()) {
      ret.addEdge(to, from);
    }
    return ret;
  }

  /**
   * Select only the nodes in the list and any edges touching nodes in the list
   */
  public subgraph(nodes: A[]) {
    const ns = new Set(nodes);
    const ret = new Graph<A>();
    ret.addNode(...nodes);
    for (const [from, to] of this.edges()) {
      if (ns.has(from) && ns.has(to)) {
        ret.addEdge(from, to);
      }
    }
    return ret;
  }

  public reachableFrom(...nodes: A[]) {
    return this.closure(nodes, this._outgoing);
  }

  public feedsInto(...nodes: A[]) {
    return this.closure(nodes, this._incoming);
  }

  public sorted(): A[] {
    return topologicalSort(this._nodes, x => x, x => this._incoming.get(x) ?? []);
  }

  public async writeGraphViz(filename: string) {
    await fs.writeFile(filename, this.toGraphViz(), { encoding: 'utf-8' });
  }

  public toGraphViz(): string {
    const ret = new Array<string>();
    ret.push('digraph G {');
    ret.push('  rankdir=LR;');
    ret.push('  node [shape = rectangle];');
    for (const node of this.nodes()) {
      ret.push(`  "${node}";`);
    }
    for (const [from, too] of this.edges()) {
      ret.push(`  "${from}" -> "${too}";`);
    }
    ret.push('}');
    return ret.join('\n');
  }

  private closure(startingNodes: A[], links: Map<A, A[]>) {
    const ret = new Set<A>();
    const toInspect = [...startingNodes];
    while (toInspect.length > 0) {
      const node = toInspect.splice(0, 1)[0];
      if (!this._nodes.has(node)) {
        throw new Error(`Found a node not in the graph: ${node}`);
      }
      if (ret.has(node)) { continue; } // Already visited
      ret.add(node);
      const ls = links.get(node);
      if (ls) { toInspect.push(...ls); }
    }
    return Array.from(ret);
  }
}