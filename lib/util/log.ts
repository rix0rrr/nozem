// eslint-disable-next-line @typescript-eslint/no-require-imports
import chalk = require('chalk');

let verbose = false;

export function setVerbose(v: boolean) {
  verbose = v;
}

export function debug(s: string) {
  if (verbose) {
    process.stderr.write(chalk.gray(s) + '\n');
  }
}

export function info(s: string) {
  process.stderr.write(chalk.blue(s) + '\n');
}

export function warning(s: string) {
  process.stderr.write(chalk.yellow(s) + '\n');
}

export function error(s: string) {
  process.stderr.write(chalk.red(s) + '\n');
}