#!/usr/bin/env node
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
import * as log from '../lib/util/log';
import * as yargs from 'yargs';

import * as commands from '../lib/commands';
import { SimpleError } from '../lib/util/flow';

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
    .option('concurrency', {
      alias: 'c',
      type: 'number',
      desc: 'How many concurrent jobs to run',
      default: 4,
      requiresArg: true,
    })
    .command('from-lerna', 'Extract a nozem build model from a Lerna monorepo structure')
    .command('build [TARGET..]', 'Build targets', command => command
      .option('bail', { alias: 'b', type: 'boolean', default: true })
      .option('down', { alias: 'd', type: 'boolean', default: false, description: 'Include targets downstream from requested build targets' })
      .positional('TARGET', { type: 'string', array: true, describe: 'Packages or directories to build, default all' })
    )
    .demandCommand()
    .help()
    .strict()
    .showHelpOnFail(false)
    .argv;

  log.setVerbose(argv.verbose > 0);

  switch (argv._[0]) {
    case 'from-lerna':
      return await commands.fromLerna();

    case 'build':
      return await commands.build({
        concurrency: argv.concurrency,
        targets: argv.TARGET ?? [],
        bail: argv.bail,
        downstream: argv.down,
      });
  }
}

main().catch(e => {
  if (e instanceof SimpleError) {
    console.error(e.message);
  } else {
    console.error(e);
  }
  process.exitCode = 1;
});