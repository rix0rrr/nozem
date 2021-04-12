#!/usr/bin/env node
import * as path from 'path';
import { NpmPackageBuild } from '../lib/builds1/npm-package-build';
import { Workspace } from '../lib/builds1/workspace';
import { findFileUp } from '../lib/util/files';
import { SimpleError } from '../lib/util/flow';
import { debug, error, setVerbose } from '../lib/util/log';

async function main() {
  const curDir = process.cwd();

  setVerbose(true);
  const gitDir = await findFileUp('.git', curDir);
  if (!gitDir) {
    throw new SimpleError(`Could not find workspace root (.git directory) from ${curDir}`);
  }
  const workspaceRoot = path.dirname(gitDir);

  debug(`Monorepo root: ${workspaceRoot}`);

  if (curDir === workspaceRoot) {
    throw new SimpleError('Cowardly refusing to build workspace root: run this from a package directory');
  }

  const ws = new Workspace(workspaceRoot);
  const build = await ws.npmPackageBuild(curDir);
  await build.build();
}

main().catch(e => {
  if (e instanceof SimpleError) {
    error(e.message);
  } else {
    console.error(e);
  }
  process.exitCode = 1;
});