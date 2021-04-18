export interface IRemoteCache {
  contains(pv: PackageVersion): Promise<boolean>;
  fetch(pv: PackageVersion, targetDir: string): Promise<void>;
  queueForStoring(pv: PackageVersion, sourceDir: string): void;
}

export interface PackageVersion {
  readonly relativePath: string;
  readonly inputHash: string;
}
