// eslint-disable-next-line @typescript-eslint/no-require-imports
import chalk = require('chalk');

let verbose = false;

let startTime = Date.now();

export function setVerbose(v: boolean) {
  verbose = v;
}

export function debug(s: string) {
  if (verbose) {
    process.stderr.write(chalk.gray(`[${pad(6, elapsedTime(), ' ')}] ${s}`) + '\n');
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

export function markStartTime() {
  startTime = Date.now();
}

function elapsedTime() {
  const elapsedS = (Date.now() - startTime) / 1000.0;
  return elapsedS.toFixed(1);
}

function pad(n: number, x: any, p: string = ' ') {
  const s = `${x}`;
  return p.repeat(Math.max(n - s.length, 0)) + s;
}