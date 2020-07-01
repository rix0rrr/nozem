export interface LernaJson {
  readonly packages: string[];
}

export interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly bin?: Record<string, string> | string;
  readonly main?: string;
  readonly jsii?: any;
  readonly scripts?: Record<string, string>;
  readonly ostools?: string[];
  readonly nzl$copyAllSourcesForTest?: boolean;
  readonly nzl$skipTsApiOptimization?: boolean;
}

export interface TsconfigJson {
  compilerOptions: {
    composite?: boolean;
    inlineSourceMap?: boolean;
    inlineSources?: boolean;
    [key: string]: any;
  };
  include?: string[];
  exclude?: string[];
  references?: any[];
}