#!/usr/bin/env node
import * as path from 'path';
import * as yargs from 'yargs';
import { Workspace } from '../lib/build-tools/workspace';
import { BUILD_TIMER, INSTALL_TIMER, TEST_TIMER } from '../lib/builds/npm-package-build';
import { LernaJson } from '../lib/file-schemas';
import { FilePatterns, FileSet, findFileUp, isProperChildOf, readJson } from '../lib/util/files';
import { SimpleError } from '../lib/util/flow';
import * as log from '../lib/util/log';
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
    .option('root', {
      alias: 'r',
      type: 'string',
      desc: 'Workspace root (determined from .git directory)',
      requiresArg: true,
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
  debug(`Monorepo root: ${workspaceRoot}`);

  let dirs: string[];
  if (argv._.length > 0) {
    dirs = argv._;
  } else {
    dirs = [process.cwd()];
  }

  if (dirs.length === 1 && path.resolve(dirs[0]) === workspaceRoot) {
    const packageDirs = await findPackageDirectories(workspaceRoot);
    log.debug(`Found ${packageDirs.length} packages`);
    // FIXME: toposort
    dirs = packageDirs;
  }

  const ws = await Workspace.fromDirectory(workspaceRoot);

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

async function findPackageDirectories(root: string) {
  const lernaJson: LernaJson = await readJson(path.join(root, 'lerna.json'));
  const packageJsonGlobs = lernaJson.packages.map(s => `./${s}/package.json`);
  const pjs = await FileSet.fromMatcher(root, new FilePatterns({
    directory: root,
    patterns: ['*/', '!node_modules', ...packageJsonGlobs],
  }).toIncludeMatcher());

  return pjs.fullPaths.map(path.dirname);
}

main().catch(e => {
  if (e instanceof SimpleError) {
    error(e.message);
  } else {
    console.error(e);
  }
  process.exitCode = 1;
});