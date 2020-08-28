import * as path from 'path';
import { IBuildDependency, IUnboundBuildDependency } from ".";
import { NpmDepSpec } from "../nozem-schema";
import { BuildEnvironment } from "../build-tools";
import { installNpmPackage } from "./_npm";
import { readJson } from "../util/files";
import { PackageJson } from '../file-schemas';
import { BuildGraph } from '../build-graph';

export class ExternalNpmDependency implements IUnboundBuildDependency, IBuildDependency {
  public readonly boundDependency = this;
  public readonly name = this.def.name;
  public readonly isAvailable = true;
  public readonly buildNodes = [];

  private _version?: string;

  constructor(private readonly rootDirectory: string, private readonly def: NpmDepSpec) {
  }

  public bind(graph: BuildGraph): void {
  }

  public async outHash() {
    // FIXME: Should get package hash from Yarn, going to
    // go with the version number from 'package.json' for now.
    if (this._version === undefined) {
      const pj: PackageJson = await readJson(path.join(this.absolutePackageDir, 'package.json'));
      this._version = pj.version;
    }
    return this._version;
  }

  public async installInto(env: BuildEnvironment) {
    await installNpmPackage(this.absolutePackageDir, env, true);
  }

  private get absolutePackageDir() {
    return path.join(this.rootDirectory, this.def.resolvedLocation);
  }
}

