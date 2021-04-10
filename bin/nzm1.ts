#!/usr/bin/env node
import * as path from 'path';
import { NpmPackageBuild } from '../lib/builds1/npm-package-build';
import { SourceInput } from '../lib/inputs/input-source';
import { FileSet, readJson, standardHash } from '../lib/util/files';
import { SimpleError } from '../lib/util/flow';
import { findNpmPackage, npmDependencies, readPackageJson } from '../lib/util/npm';
import { cachedPromise } from '../lib/util/runtime';

async function main() {
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