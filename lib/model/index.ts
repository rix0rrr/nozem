import * as path from 'path';
import { promises as fs } from 'fs';
import { FilePatterns, FileSet, readJson } from '../util/files';
import { CertifyForMarketplace } from 'aws-sdk/clients/sagemaker';
import { combinedGitIgnores } from '../util/ignorefiles';

export class Workspace {
  constructor(private readonly directory: string) {
  }
}


export interface NpmPackageBuilderOptions {
  readonly inputs: IInput[];

  readonly relativeWorkspaceLocation: string;
}

export class NpmPackageBuilder {
  public static async fromDirectory(directory: string) {
    const pj = path.resolve(directory, 'package.json');
    const pjson = await readJson(pj);
  }

  constructor(private readonly id: string, options: NpmPackageBuilderOptions) {
  }
}

interface IInput {
}

export class SourceFilesInput implements IInput {
  public static async fromGitignore(dir: string) {
    return new SourceFilesInput(await FileSet.fromDirectoryWithIgnores(dir, await combinedGitIgnores(dir)));
  }

  constructor(private readonly files: FileSet) {
  }
}

export class ShellCommand implements IInput {
  public static s(...names: string[]) {
    return names.map(x => new ShellCommand(x));
  }

  constructor(private readonly command: string) {
  }
}

export class NpmDependency implements IInput {
  public async fromNpmLookup(name: string, searchDir: string) {
  }

  public async fromFileSets(name: string, searchDir: string) {
  }
}

/*
"@types/fs-extra": "^8.1.1",
"cdk-build-tools": "0.0.0",
"fs-extra": "^9.0.1",
"pkglint": "0.0.0"
*/