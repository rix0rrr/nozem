#!/usr/bin/env node
import { NpmPackageBuild } from '../lib/builds1/npm-package-build';
import { SimpleError } from '../lib/util/flow';
import { setVerbose } from '../lib/util/log';

async function main() {
  setVerbose(true);
  const build = await NpmPackageBuild.fromCache(process.cwd());
  await build.build();
}

main().catch(e => {
  if (e instanceof SimpleError) {
    console.error(e.message);
  } else {
    console.error(e);
  }
  process.exitCode = 1;
});