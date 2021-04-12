import * as path from 'path';
import { NpmPackageBuild } from './npm-package-build';

export class Workspace {
  private packageBuildCache = new Map<string, NpmPackageBuild>();

  constructor(public readonly root: string) {
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

}