import chalk = require('chalk');

let verbose = false;

export function setVerbose(v: boolean) {
  verbose = v;
}

export function debug(s: string) {
  if (verbose) {
    console.debug(chalk.gray(s));
  }
}

export function info(s: string) {
  console.log(chalk.blue(s));
}

export function warning(s: string) {
  console.warn(chalk.yellow(s));
}

export function error(s: string) {
  console.error(chalk.red(s));
}