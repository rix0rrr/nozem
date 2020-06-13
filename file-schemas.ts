export interface LernaJson {
  readonly packages: string[];
}

export interface PackageJson {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly bind?: Record<string, string>;
  readonly scripts?: Record<string, string>;
}