import { IBuildStrategy, IDigestLike } from './build-strategy';
import { ExtractDefinition } from '../nozem-schema';
import { FilePatterns } from '../util/files';
import { BuildNode } from '../build-node';
import { BuildEnvironment, TemporaryBuildOutput } from '../build-tools';

export class ExtractNode implements IBuildStrategy {
  private _hash?: string;
  private pattern: FilePatterns;

  public readonly identifier: string = 'extract-build';
  public readonly version: string = '1';

  constructor(private readonly def: ExtractDefinition) {
    this.pattern = new FilePatterns(def.extractPatterns);
  }

  public async updateInhash(d: IDigestLike) {
    d.update('pattern:');
    d.update(this.pattern.patternHash());
  }

  public async addDerivations(output: TemporaryBuildOutput) {
  }

  public async build(node: BuildNode, env: BuildEnvironment, target: TemporaryBuildOutput): Promise<void> {
    await node.installDependencies(env);
    await (await env.inSourceArtifacts(this.pattern.toIncludeMatcher())).copyTo(target.mainWritingDirectory);
  }
}
