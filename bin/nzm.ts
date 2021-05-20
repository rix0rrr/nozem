#!/usr/bin/env node
import * as path from 'path';
import * as yargs from 'yargs';
import { shellExecute } from '../lib/build-tools';
import { Workspace } from '../lib/build-tools/workspace';
import { BUILD_TIMER, INSTALL_TIMER, TEST_TIMER } from '../lib/builds/npm-package-build';
import { YarnInstall } from '../lib/builds/yarn-install';
import { LernaJson } from '../lib/file-schemas';
import { exists, FilePatterns, FileSet, findFileUp, isProperChildOf, readJson } from '../lib/util/files';
import { SimpleError } from '../lib/util/flow';
import { gitHeadRevision } from '../lib/util/git';
import * as log from '../lib/util/log';
import { debug, error, setVerbose } from '../lib/util/log';
import { findMonoRepoPackages } from '../lib/util/monorepo';

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
    .option('root', {
      alias: 'r',
      type: 'string',
      desc: 'Workspace root (determined from .git directory)',
      requiresArg: true,
    })
    .option('test', {
      type: 'boolean',
      desc: 'Run tests as part of build',
      default: false,
    })
    .option('cache', {
      type: 'boolean',
      desc: 'Whether to use machine/s3 caches',
      default: true,
    })
    .help()
    .strict()
    .showHelpOnFail(false)
    .argv;

  setVerbose(argv.verbose > 0);

  let workspaceRoot: string | undefined = argv.root;
  if (!workspaceRoot) {
    const gitDir = await findFileUp('.git', process.cwd());
    if (!gitDir) {
      throw new SimpleError(`Could not find workspace root (.git directory) from ${process.cwd()}`);
    }

    workspaceRoot = path.dirname(gitDir);
  }
  workspaceRoot = path.resolve(workspaceRoot);

  /*
  if (await exists(path.join(workspaceRoot, '.git'))) {
    // $CODEBUILD_RESOLVED_SOURCE_VERSION may be used by scripts, set it here
    process.env.CODEBUILD_RESOLVED_SOURCE_VERSION = await gitHeadRevision(workspaceRoot);
  }
  */
  // Well shit. In CDK's build, `aws-cdk` (the CLI) depends on the git commit hash. `aws-cdk` in turn
  // is used by `cdk-integ-tools`, which in turn is used by EVERY OTHER PACKAGE.
  // This means that the mere changing of the commit hash invalidates the build cache for nearly every
  // package, regardless of its source. This is obvioulsy No Good. For now, hard-code the commit
  // hash to a constant string--we're not using `nzm` to build for release right now so it doesn't
  // matter much, and this improves cache efficiency by a lot.
  process.env.CODEBUILD_RESOLVED_SOURCE_VERSION = 'built.by.nzm';

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  debug(`[nozem v${require('../../package.json').version}] Workspace root: ${workspaceRoot}`);

  let dirs: string[];
  if (argv._.length > 0) {
    dirs = argv._;
  } else {
    dirs = [process.cwd()];
  }

  const packages = await findMonoRepoPackages(workspaceRoot);

  if (dirs.length === 1 && path.resolve(dirs[0]) === workspaceRoot) {
    // FIXME: toposort
    log.debug(`Building ${packages.length} packages`);
    dirs = packages.map(p => p.fullPath);
  }

  const ws = await Workspace.fromDirectory(workspaceRoot, {
    test: argv.test,
    cache: argv.cache,
  });

  await new YarnInstall(workspaceRoot, packages).install();

  for (const dir of dirs) {
    if (!isProperChildOf(dir, workspaceRoot)) {
      throw new Error(`${dir} is not in root: ${workspaceRoot}`);
    }

    const curDir = path.resolve(dir);

    const build = await ws.npmPackageBuild(curDir);
    await build.build();
  }

  log.debug(`Build time: ${BUILD_TIMER.humanTime()}, test: ${TEST_TIMER.humanTime()}, hermetic install overhead: ${INSTALL_TIMER.humanTime()} (across ${BUILD_TIMER.invocations} invocations)`);
}

// We cache promises, so errors in cached promises are sometimes only handled asynchronously
// (taking longer than an event loop tick to attach a .catch() handler to a promise--or to be await'ed).
// By default, Node will complain about them. Silence that behavior:
// only complain about the error if it takes longer than 100ms to attach a handler
(() => {
  const WARNING_TIMERS = new Map<Promise<any>, NodeJS.Timeout>();
  process.on('unhandledRejection', (e, promise) => {
    const handle = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('Unhandled promise rejection', e);
    }, 100);
    WARNING_TIMERS.set(promise, handle);
  });
  process.on('rejectionHandled', (promise) => {
    const handle = WARNING_TIMERS.get(promise);
    if (handle) { window.clearTimeout(handle); }
    WARNING_TIMERS.delete(promise);
  });
})();


main().catch(e => {
  if (e instanceof SimpleError) {
    error(e.message);
  } else {
    // eslint-disable-next-line no-console
    console.error(e);
  }
  process.exitCode = 1;
});