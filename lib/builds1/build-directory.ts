import * as child_process from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { copy, ensureSymlink, FileMatcher, FileSet, rimraf } from '../util/files';
import { SimpleError } from '../util/flow';
import * as log from '../util/log';
import * as util from 'util';

const cpExec = util.promisify(child_process.exec);

export class BuildDirectory {
  public static async make(): Promise<BuildDirectory> {
    const tmpDir = await fs.mkdtemp(os.tmpdir());
    return new BuildDirectory(tmpDir);
  }

  public static async with<A>(fn: (x: BuildDirectory) => A|Promise<A>): Promise<A> {
    const be = await BuildDirectory.make();
    try {
      return await fn(be);
    } finally {
      await be.cleanup();
    }
  }

  public readonly binDir: string;
  public srcDir: string;

  constructor(
    public readonly directory: string,
    ) {
    this.binDir = path.join(directory, 'bin');
    this.srcDir = path.join(directory, 'src');
  }

  public async cleanup() {
    await rimraf(this.directory);
  }

  /**
   * Add a subdirectory to the srcDir and move the srcDir there
   */
  public async moveSrcDir(relativePath: string) {
    const newSrcDir = path.join(this.srcDir, relativePath);
    await fs.mkdir(newSrcDir, { recursive: true });
    this.srcDir = newSrcDir;
  }

  public async touchFile(relativePath: string) {
    const ts = new Date();
    const absPath = path.join(this.srcDir, relativePath);
    try {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.utimes(absPath, ts, ts);
    } catch (e) {
      if (e.code !== 'ENOENT') { throw e; }

      await fs.writeFile(absPath, '');
    }
  }

  public async installExecutable(absTarget: string, binName?: string, overwrite?: boolean) {
    const targetPath = path.join(this.binDir, binName ?? path.basename(absTarget));
    try {
      await ensureSymlink(
        absTarget,
        targetPath,
        overwrite);
    } catch (e) {
      throw new Error(`Error symlinking ${absTarget} -> ${targetPath}: ${e.message}`);
    }
  }

  public async installSymlink(relSource: string, absTarget: string) {
    try {
      await ensureSymlink(
        absTarget,
        path.join(this.directory, relSource),
        );
    } catch (e) {
      throw new Error(`Error symlinking ${absTarget} -> ${path.join(this.directory, relSource)}: ${e.message}`);
    }
  }

  public async addFiles(files: FileSet, subdir: string) {
    return files.copyTo(path.join(this.directory, subdir));
  }

  public async addSrcFiles(files: FileSet, subdir: string = '.') {
    return files.copyTo(path.join(this.srcDir, subdir));
  }

  public async addSrcFile(absSource: string, relTarget: string) {
    const absTarget = path.join(this.srcDir, relTarget);
    await copy(absSource, absTarget);
  }

  /**
   * Grab artifacts out of an in-source build
   */
  public async inSourceArtifacts(matcher: FileMatcher) {
    return await FileSet.fromMatcher(this.srcDir, matcher);
  }

  public async execute(command: string, baseEnv: Record<string, string>, logDir: string) {
    log.debug(`[${this.srcDir}] ${command}`);

    const env = {
      PATH: this.binDir,
      ...baseEnv
    };

    try {
      const { stdout, stderr } = await cpExec(command, {
        cwd: this.srcDir,
        env,
      });

      await fs.writeFile(path.join(logDir, 'stdout.log'), stdout, { encoding: 'utf-8' });
      await fs.writeFile(path.join(logDir, 'stderr.log'), stderr, { encoding: 'utf-8' });
    } catch (e) {
      await flush(process.stdout);
      process.stderr.write(`cmd:  ${command}\n`);
      process.stderr.write(`cwd:  ${this.srcDir}\n`);
      process.stderr.write(`env:  ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);
      process.stderr.write(`exit: ${e.code}\n`);
      if (e.stdout) { process.stderr.write(e.stdout); }
      if (e.stderr) { process.stderr.write(e.stderr); }
      await flush(process.stderr);

      // The default error, when printed, will contain all stdout/stderr again. Replace it
      // with an Error that's easier on the eyes.
      throw new SimpleError(e.message.split('\n')[0]);
    }
  }

  public relativePath(p: string) {
    return path.relative(this.directory, p);
  }
}

async function flush(s: NodeJS.WriteStream) {
  const flushed = s.write('');
  if (!flushed) {
    return new Promise(ok => s.once('drain', ok));
  }
}