import { PackageJson } from "../file-schemas";
import { IBuildInput } from "../inputs/build-input";
import { SourceInput } from "../inputs/input-source";
import { NpmDependencyInput } from "../inputs/npm-dependency";
import { FileSet, standardHash } from "../util/files";
import { findNpmPackage, npmDependencies, readPackageJson } from "../util/npm";
import { cachedPromise } from "../util/runtime";
import { BuildDirectory } from "./build-directory";

const buildCache = new Map<string, NpmPackageBuild>();

const artifactsCacheSymbol = Symbol();
const inputHashCacheSymbol = Symbol();

export class NpmPackageBuild {
  public static async fromCache(dir: string): Promise<NpmPackageBuild> {
    // Builds are memoized because there is a lot of package reuse in the tree.
    const existing = buildCache.get(dir);
    if (existing) { return existing; }

    const build = await NpmPackageBuild.fromDirectory(dir);
    buildCache.set(dir, build);
    return build;
  }

  public static async fromDirectory(dir: string): Promise<NpmPackageBuild> {
    const pj = await readPackageJson(dir);

    const inputs: Record<string, IBuildInput> = {};
    const sources = await FileSet.fromGitignored(dir);
    inputs.source = new SourceInput(sources);

    for (const dep of npmDependencies(pj)) {
      const found = await findNpmPackage(dep, dir);
      inputs[`dep_${dep}`] = await NpmDependencyInput.fromDirectory(found);
    }

    return new NpmPackageBuild(dir, pj, sources, inputs);
  }

  constructor(public readonly directory: string, public readonly packageJson: PackageJson, private readonly sources: FileSet, private readonly inputs: Record<string, IBuildInput>) {
  }

  public async inputHash() {
    return cachedPromise(this, inputHashCacheSymbol, async () => {
      const inputHash = standardHash();
      for (const [k, v] of Object.entries(this.inputs)) {
        inputHash.update(`${k}:${await v.hash()}\n`);
      }
      return inputHash.digest('hex');
    });
  }

  public async build(): Promise<FileSet> {
    return cachedPromise(this, artifactsCacheSymbol, async () => {
      const inputHash = this.inputHash();
      // FIXME: read from cache

      console.log('building', this.directory);
      return BuildDirectory.with(async (buildDir) => {
        for (const v of Object.values(this.inputs)) {
          await v.install(buildDir);
        }

        const buildCommand = this.packageJson.scripts?.['build+test'] ?? this.packageJson.scripts?.build;
        if (buildCommand) {
          await buildDir.execute(buildCommand, {}, buildDir.directory);
        }

        // Everything that's new in the srcDir is an artifact
        // Copy back to source directory and return as artifacts.
        const artifacts = (await FileSet.fromDirectory(buildDir.srcDir)).except(this.sources);
        return artifacts.copyTo(this.directory);
      });
    });
  }
}