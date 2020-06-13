/**
 * A build tool inspired by Bazel, but written for piecemeal migration.
 *
 * We can't afford to rewrite to Bazel wholesale. We have some conventions in
 * our existing build that we can exploit to achieve similar benefits of
 * hermeticity and reusability (thereby leading to speeeeeed!).
 *
 * The most important part first is to model the build and the build graph/
 * dependencies involved and get it into an automated tool. Afterwards we can
 * change this tool to mold the build into whatever shape we need.
 *
 * CONSTRAINTS
 *
 * - While we are bootstrapping this, can coexist with our existing lerna/package.json-driven
 *   build.
 * - Can deal with undermodeled dependencies/codegen steps.
 * - Can deal with in-source builds.
 *     => Use .gitignore to distinguish source files from artifacts.
 * - (Mostly) only needs to deal with NPM package dependencies.
 * - Only needs to deal with Yarn as an actual version fetcher.
 */
import { parse } from 'https://deno.land/std@0.56.0/flags/mod.ts';

import { fromLerna } from './from-lerna.ts';
import { build } from './build.ts';

async function main() {
  const args = parse(Deno.args);

  switch (args._[0]) {
    case 'from-lerna':
      return await fromLerna();

    case 'build':
      return await build();

    default:
      throw new Error(`Unknown command: ${args._}`);
  }
}

await main();