import * as path from 'path';
import { PackageJson } from '../file-schemas';
import { exists } from '../util/files';
import { readPackageJson } from '../util/npm';
import { NpmPackageBuild } from './npm-package-build';

export class Workspace {
  private packageBuildCache = new Map<string, NpmPackageBuild>();

  public static async fromDirectory(root: string) {
    const pj = await exists(path.join(root, 'package.json')) ? await readPackageJson(root) : undefined;
    return new Workspace(root, pj);
  }

  constructor(public readonly root: string, private readonly packageJson: PackageJson | undefined) {
  }

  public relativePath(absPath: string) {
    return path.relative(this.root, path.resolve(absPath));
  }

  public async npmPackageBuild(dir: string): Promise<NpmPackageBuild> {
    // Builds are memoized because there is a lot of package reuse in the tree.
    const existing = this.packageBuildCache.get(dir);
    if (existing) { return existing; }

    const build = await NpmPackageBuild.fromDirectory(dir, this);
    this.packageBuildCache.set(dir, build);
    return build;
  }

  public absoluteGlobalNonPackageFiles(relativeToDir: string): string[] {
    return (this.packageJson?.nozem?.globalNonPackageFiles ?? []).map(p => path.relative(relativeToDir, path.join(this.root, p)));
  }
}