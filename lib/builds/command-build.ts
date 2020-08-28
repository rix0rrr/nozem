import { IBuildStrategy, IDigestLike } from './build-strategy';
import * as path from 'path';
import { CommandBuildDefinition } from '../nozem-schema';
import { FilePatterns, FileSet } from '../util/files';
import { BuildNode } from '../build-node';
import * as log from '../util/log';
import { BuildEnvironment, TemporaryBuildOutput } from '../build-tools';

export class CommandBuildStrategy implements IBuildStrategy {
  public static async fromDefinition(rootDirectory: string, def: CommandBuildDefinition): Promise<CommandBuildStrategy> {
    const gitignorePattern = new FilePatterns(def.nonSources);
    const files = await FileSet.fromMatcher(path.join(rootDirectory, def.root), gitignorePattern.toComplementaryMatcher());
    return new CommandBuildStrategy(rootDirectory, def, files);
  }

  public readonly identifier: string = 'command-build';
  public readonly version: string = '1';

  protected constructor(
    protected readonly root: string,
    protected readonly def: CommandBuildDefinition,
    protected readonly sourceFiles: FileSet) {
  }

  public async build(node: BuildNode, env: BuildEnvironment, target: TemporaryBuildOutput) {
    await env.addSrcFiles(this.sourceFiles);
    await this.runBuildCommand(env);
    await this.copyOutBuildArtifacts(env, target);
  }

  public async updateInhash(d: IDigestLike) {
    d.update('command:');
    d.update(this.def.buildCommand ?? '');
    d.update('files:');
    d.update(await this.sourceFiles.hash());
    d.update('deps:');

    // So -- we have to hash the artifact ignore pattern in here.
    // That's because we have to know our hash BEFORE we do the actual build,
    // so before we know what files actually get produced.
    //
    // We have to pessimistically assume that every change to the ignore
    // pattern is going to lead to a different build output.
    //
    // The good news is that if the build outputs didn't actually change,
    // downstream builds can be skipped again.
    d.update('ignoreArtifacts:');
    for (const pat of this.def.nonArtifacts) {
      d.update(pat + '\n');
    }
  }

  protected async runBuildCommand(env: BuildEnvironment) {
    if (this.def.buildCommand) {
      try {
        await env.execute(this.def.buildCommand, {
          NZM_PACKAGE_SOURCE: path.resolve(this.def.root),
        }, env.root);
      } catch (e) {
        log.error(`${this.def.identifier} failed`);
        throw e;
      }
    }
  }

  protected async copyOutBuildArtifacts(env: BuildEnvironment, target: TemporaryBuildOutput) {
    // We did an in-source build. Copy everything except the non-artifact
    // files to the output directory.
    const artifactMatcher = new FilePatterns(this.def.nonArtifacts).toComplementaryMatcher();
    await (await env.inSourceArtifacts(artifactMatcher)).copyTo(target.mainWritingDirectory);
  }
}