import * as log from '../util/log';
import * as path from 'path';
import * as os from 'os';
import { BuildGraph } from "../build-graph";
import { NazelJson } from '../nozem-schema';
import { BuildWorkspace } from '../build-tools';
import { readJson } from '../util/files';

export interface BuildOptions {
  readonly concurrency?: number;
  readonly targets?: string[];
}

export async function build(options: BuildOptions = {}) {
  const nazelJson: NazelJson = await readJson('nozem.json');

  const graph = new BuildGraph(nazelJson.units);

  await graph.build();
  const workspace = new BuildWorkspace(path.resolve(os.userInfo().homedir ?? '.', '.nazel-build'));

  const queue = (options.targets ?? []).length > 0 ? graph.queueFor(options.targets!) : graph.queue();
  await queue.writeGraphViz('build.dot');
  log.info(`${queue.size} nodes to build`);

  await queue.parallel(options.concurrency || 4, async (node) => {
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