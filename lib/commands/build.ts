import * as log from '../util/log';
import { BuildGraph } from "../build-graph";
import { NozemJson } from '../nozem-schema';
import { BuildWorkspace } from '../build-tools';
import { readJson } from '../util/files';
import { BuildQueue } from '../build-queue';

export interface BuildOptions {
  readonly concurrency?: number;
  readonly targets?: string[];
  readonly bail?: boolean;
}

export async function build(options: BuildOptions = {}) {
  const nozemJson: NozemJson = await readJson('nozem.json');

  const buildGraph = new BuildGraph(nozemJson.units);
  await buildGraph.build();

  const workspace = BuildWorkspace.defaultWorkspace();

  const targetGraph = (options.targets ?? []).length > 0 ? buildGraph.incomingClosure(options.targets!) : buildGraph.graph;
  const queue = new BuildQueue(targetGraph, {
    concurrency: options.concurrency || 4,
    bail: options.bail,
  });
  await queue.writeGraphViz('build.dot');
  log.info(`${queue.size} nodes to build`);

  await queue.execute(async (node) => {
    const hash = await node.inHash();

    let built = await workspace.fromCache(node.identifier, hash);
    if (built) {
      log.debug(`From cache: ${node.identifier} (${built.root})`);
      node.useOutput(built);
    } else {
      const env = await workspace.makeBuildEnvironment(node.identifier, hash);
      await node.build(env);
    }
  });
}