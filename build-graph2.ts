import { FileSet } from './files.ts';

export interface IBuildGraphNode {
}

export interface IBuildStep {
  execute(): Promise<void>;
}

export interface IBuildArtifact {
  isAvailable(): Promise<boolean>;
  fileSet(): Promise<FileSet>;
}

class Build implements IBuildStep {
  public readonly tsApi = new BuildArtifact(`${this.id}:tsapi`);
  public readonly implementation = new BuildArtifact(`${this.id}:impl`);

  constructor(public readonly id: string) {
  }

  public async execute(): Promise<void> {
  }
}

class ProduceTsApi {
}

class ProduceJsApi {
}

class NpmPackageDependency {
}

class CopyToCurrentDirectoryDependency {
}

class BuildArtifact {
  constructor(public readonly id: string) {
  }

  public fulfill(files: FileSet) {
  }
}