import * as child_process from 'child_process';
import * as util from 'util';

const cpExec = util.promisify(child_process.exec);

export async function gitHeadRevision(workspaceRoot: string) {
  const { stdout, stderr } = await cpExec('git rev-parse HEAD', { cwd: workspaceRoot });
  return stdout.trim();
}