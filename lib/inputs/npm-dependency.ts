import * as path from 'path';
import { BuildDirectory } from '../builds1/build-directory';
import { NpmPackageBuild } from '../builds1/npm-package-build';
import { PackageJson } from '../file-schemas';
import { FileSet, standardHash } from '../util/files';
import { findNpmPackage, npmRuntimeDependencies, readPackageJson } from '../util/npm';
import { cachedPromise } from '../util/runtime';
import { IBuildInput } from './build-input';

const objectCache: any = {};
const hashSym = Symbol();
const sourcesSym = Symbol();

export abstract class NpmDependencyInput implements IBuildInput {
  public static async fromDirectory(packageDirectory: string) {
    return cachedPromise(objectCache, packageDirectory, async () => {
      const packageJson = await readPackageJson(packageDirectory);

      const trans: Record<string, NpmDependencyInput> = {};
      for (const name of npmRuntimeDependencies(packageJson)) {
        const found = await findNpmPackage(name, packageDirectory);
        trans[name] = await NpmDependencyInput.fromDirectory(found);
      }

      return isMonoRepoPackage(packageDirectory)
        ? new MonoRepoBuildDependencyInput(packageDirectory, packageJson, trans, await NpmPackageBuild.fromCache(packageDirectory))
        : new NpmRepoDependencyInput(packageDirectory, packageJson, trans);
    });
  }

  public static fromMonoRepoBuild(npmBuild: NpmPackageBuild) {
  }

  constructor(
    protected readonly packageDirectory: string,
    protected readonly packageJson: PackageJson,
    private readonly transitiveDeps: Record<string, NpmDependencyInput>) {
  }

  public async hash(): Promise<string> {
    return cachedPromise(this, hashSym, async () => {
      const h = standardHash();
      h.update(`files:${await this.filesIdentifier()}\n`);
      for (const [name, pkg] of Object.entries(this.transitiveDeps)) {
        h.update(`${name}:${await pkg.hash()}\n`);
      }
      return h.digest('hex');
    });
  }

  public async install(dir: BuildDirectory): Promise<void> {
    // FIXME: This can be optimized by hoisting dependencies so we only have to
    // copy them once.
    return this.installInto(dir, '.');
  }

  private async installInto(dir: BuildDirectory, subdir: string): Promise<void> {
    const files = await this.files();
    const myPackageDir = path.join(subdir, 'node_modules', this.packageJson.name);
    await dir.addFiles(files, myPackageDir);
    for (const dep of Object.values(this.transitiveDeps)) {
      await dep.installInto(dir, myPackageDir);
    }
  }

  protected abstract files(): Promise<FileSet>;
  protected abstract filesIdentifier(): Promise<string>;
}

class NpmRepoDependencyInput extends NpmDependencyInput {
  public files() {
    return cachedPromise(this, sourcesSym, () => {
      return FileSet.fromDirectoryWithIgnores(this.packageDirectory, ['node_modules']);
    });
  }
  public filesIdentifier() {
    return Promise.resolve(this.packageJson.version);
  }
}

class MonoRepoBuildDependencyInput extends NpmDependencyInput {
  constructor(
    packageDirectory: string,
    packageJson: PackageJson,
    transitiveDeps: Record<string, NpmDependencyInput>,
    private readonly build: NpmPackageBuild) {
      super(packageDirectory, packageJson, transitiveDeps);
  }

  public files() {
    return this.build.build();
  }

  public async filesIdentifier() {
    return (await this.build.build()).hash();
  }
}

function isMonoRepoPackage(packageDirectory: string) {
  // FIXME: This could be implemented better but as of now this is cheap
  return !packageDirectory.includes('node_modules');
}
