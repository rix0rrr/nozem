import * as log from 'https://deno.land/std@0.56.0/log/mod.ts';
import * as path from 'https://deno.land/std@0.56.0/path/mod.ts';
import { NazelJson, BuildWorkspace, BuildGraph } from "./build-graph.ts";

export interface BuildOptions {
  readonly concurrency?: number;
  readonly targets?: string[];
}

export async function build(options: BuildOptions = {}) {
  const nazelJson: NazelJson = JSON.parse(await Deno.readTextFile('nazel.json'));

  const graph = new BuildGraph(nazelJson.units);

  await graph.build();
  const workspace = new BuildWorkspace(path.resolve(Deno.dir('home') ?? '.', '.nazel-build'));

  const queue = (options.targets ?? []).length > 0 ? graph.queueFor(options.targets!) : graph.queue();
  await queue.writeGraphViz('build.dot');
  log.info(`${queue.size} nodes to build`);

  await queue.parallel(options.concurrency || 4, async (node) => {
    const hash = `${node.slug}-${await node.sourceHash()}`;

    let built = await workspace.fromCache(hash);
    if (built) {
      log.debug(`From cache: ${node.identifier} (${built.root})`);
    } else {
      const env = await workspace.makeBuildEnvironment(node.slug);
      await node.build(env);
      built = await workspace.store(env, hash);
    }

    // Need to load this for outHashes
    await node.rememberOutput(built);
  });
}