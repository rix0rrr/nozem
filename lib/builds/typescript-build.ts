import * as path from 'path';
import { TsconfigJson } from '../file-schemas';
import { CommandBuildStrategy } from "./command-build";
import { TypescriptBuildDefinition } from "../nozem-schema";
import { FilePatterns, FileSet, readJson, writeJson } from "../util/files";
import { BuildNode } from '../build-node';
import { BuildEnvironment, TemporaryBuildOutput } from '../build-tools';
import { IDigestLike } from './build-strategy';

export class TypeScriptBuildStrategy extends CommandBuildStrategy {
  public static async fromTsDefinition(def: TypescriptBuildDefinition): Promise<CommandBuildStrategy> {
    const gitignorePattern = new FilePatterns(def.nonSources);
    const files = await FileSet.fromMatcher(def.root, gitignorePattern.toComplementaryMatcher());
    return new TypeScriptBuildStrategy(def, files);
  }

  public readonly identifier: string = 'typescript-build';
  public readonly version: string = '1';

  private constructor(
    private readonly tsDef: TypescriptBuildDefinition,
    sourceFiles: FileSet) {
    super(tsDef, sourceFiles);
  }

  public async build(node: BuildNode, env: BuildEnvironment, target: TemporaryBuildOutput) {
    await env.addSrcFiles(this.sourceFiles);

    if (this.tsDef.patchTsconfig) {
      await this.patchTsConfig(path.join(env.srcDir, 'tsconfig.json'));
    }

    await this.runBuildCommand(env);
    await this.copyOutBuildArtifacts(env, target);
  }

  public async updateInhash(d: IDigestLike) {
    await super.updateInhash(d);
    d.update('patch:');
    d.update(`${!!this.tsDef.patchTsconfig}`);
  }

  private async patchTsConfig(filename: string) {
    try {
      const tsconfig: TsconfigJson = await readJson(filename);
      delete tsconfig.references;
      delete tsconfig.compilerOptions.composite;
      delete tsconfig.compilerOptions.inlineSourceMap;
      delete tsconfig.compilerOptions.inlineSources;
      await writeJson(filename, tsconfig);
    } catch (e) {
      if (e.code !== 'ENOENT') { throw e; }
    }
  }
}