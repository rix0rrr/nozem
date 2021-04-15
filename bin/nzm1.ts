#!/usr/bin/env node
import * as path from 'path';
import * as yargs from 'yargs';
import { Workspace } from '../lib/builds1/workspace';
import { findFileUp } from '../lib/util/files';
import { SimpleError } from '../lib/util/flow';
import { debug, error, setVerbose } from '../lib/util/log';

async function main() {
  const argv = yargs
    .usage('$0 <cmd> [args]')
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      desc: 'Increase logging verbosity',
      count: true,
      default: 0,
    })
    .help()
    .strict()
    .showHelpOnFail(false)
    .argv;

  setVerbose(argv.verbose > 0);

  const dirs = argv._.length > 0 ? argv._ : [process.cwd()];

  for (const dir of dirs) {
    const curDir = path.resolve(dir);

    const gitDir = await findFileUp('.git', curDir);
    if (!gitDir) {
      throw new SimpleError(`Could not find workspace root (.git directory) from ${curDir}`);
    }
    const workspaceRoot = path.dirname(gitDir);
    debug(`Monorepo root: ${workspaceRoot}`);

    if (curDir === workspaceRoot) {
      throw new SimpleError('Cowardly refusing to build workspace root: run this from a package directory');
    }

    const ws = await Workspace.fromDirectory(workspaceRoot);
    const build = await ws.npmPackageBuild(curDir);
    await build.build();
  }
}

main().catch(e => {
  if (e instanceof SimpleError) {
    error(e.message);
  } else {
    console.error(e);
  }
  process.exitCode = 1;
});