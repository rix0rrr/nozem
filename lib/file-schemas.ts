/**
 * Interesting fields in lerna.json
 */
export interface LernaJson {
  readonly packages: string[];
}

/**
 * Interesting fields in package.json
 */
export interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly bundledDependencies?: string[];
  readonly bin?: Record<string, string> | string;
  readonly main?: string;
  readonly jsii?: any;
  readonly scripts?: Record<string, string>;
  readonly nozem?: PjNozemOptions;
}

/**
 * Nozem options in package.json
 */
export interface PjNozemOptions {
  readonly ostools?: string[];
  readonly nonPackageFiles?: string[];
  readonly globalNonPackageFiles?: string[];
  readonly copyAllSourcesForTest?: boolean;
  readonly skipTsApiOptimization?: boolean;
  readonly env?: Record<string, string>;
}

/**
 * Interesting fields in tsconfig.json
 */
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