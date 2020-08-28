import * as path from 'path';
import * as log from '../util/log';
import { BuildGraph } from "../build-graph";
import { NozemJson } from '../nozem-schema';
import { BuildWorkspace } from '../build-tools';
import { readJson, findFileUp } from '../util/files';
import { BuildQueue } from '../build-queue';
import { S3Cache } from '../aws/s3cache';
import { SimpleError } from '../util/flow';

export interface BuildOptions {
  readonly concurrency?: number;
  readonly targets: string[];
  readonly bail?: boolean;
  readonly downstream?: boolean;
}

export async function build(options: BuildOptions) {
  const nozemJsonFile = await findFileUp('nozem.json', process.cwd());
  if (nozemJsonFile === undefined) {
    throw new SimpleError(`'nozem.json' not found upwards from '${process.cwd()}'`);
  }

  const nozemJsonDir = path.dirname(path.resolve(nozemJsonFile));
  const nozemJson: NozemJson = await readJson(nozemJsonFile);

  const buildGraph = new BuildGraph(nozemJsonDir, nozemJson.units);
  await buildGraph.build();

  const workspace = await BuildWorkspace.detectConfiguration(nozemJsonDir);

  let targetGraph;
  if (options.targets.length === 0 && process.cwd() === nozemJsonDir) {
    // Build everything, even targets that may not have an associated directory
    targetGraph = buildGraph.graph;
  } else {
    targetGraph = await buildGraph.selectTargets(options.targets.length > 0 ? options.targets : ['.'], !!options.downstream)
  }

  const queue = new BuildQueue(targetGraph, {
    concurrency: options.concurrency || 4,
    bail: options.bail,
  });
  // await queue.writeGraphViz(path.join(nozemJsonDir, 'build.dot'));
  log.info(`${queue.size} nodes to build`);

  await queue.execute(async (node) => {
    const pv = await node.packageVersion();

    let built = await workspace.fromCache(pv);
    if (built) {
      log.debug(`From cache: ${node.identifier} (${built.root})`);
      node.useOutput(built);
    } else {
      const env = await workspace.makeBuildEnvironment(pv);
      await node.build(env);
    }
  });
}