export interface NazelJson {
  units: UnitDefinition[];
}

/**
 * A single buildable unit
 */
export type UnitDefinition =
  ({ type: 'command' } & CommandBuildDefinition)
  | ({ type: 'typescript-build' } & TypescriptBuildDefinition)
  | ({ type: 'extract' } & ExtractDefinition);

type DefinitionCommon = {
  /**
   * A unique identifier for this build unit
   */
  readonly identifier: string;

  /**
   * Dependencies for this build unit
   */
  readonly dependencies?: BuildDepSpec[];
}

export interface CommandBuildDefinition extends DefinitionCommon {
  /**
   * (Relative) root of the build unit
   */
  readonly root: string;

  /**
   * Files that are not sources.
   *
   * Determined from .gitignore
   */
  readonly nonSources: string[];

  /**
   * Files that are not build artifacts.
   *
   * Determined from .npmignore
   */
  readonly nonArtifacts: string[];

  /**
   * Build command
   */
  readonly buildCommand?: string;
}

export interface TypescriptBuildDefinition extends CommandBuildDefinition {
  /**
   * Should we patch tsconfig before the build for this package
   *
   * @default false
   */
  readonly patchTsconfig?: boolean;
}

export interface ExtractDefinition extends DefinitionCommon {
  extractPatterns: string[];
}

export type BuildScope = 'build' | 'run';

/**
 * Description of a dependency
 */
export type BuildDepSpec = NpmDepSpec | InternalNpmDepSpec | OsDepSpec | CopyDepSpec;

export type NpmDepSpec = { type: 'npm'; name: string; versionRange: string; version: string; resolvedLocation: string };
export type InternalNpmDepSpec = { type: 'link-npm'; node: string; executables: boolean };
export type CopyDepSpec = { type: 'copy'; node: string; subdir?: string };
export type OsDepSpec = { type: 'os'; executable: string; rename?: string };

export function depSpecRepr(dep: BuildDepSpec): string {
  switch (dep.type) {
    case 'npm': return `npm:${dep.name}:${dep.version}`;
    case 'os': return `os:${dep.executable}` + (dep.rename ? `:${dep.rename}` : '');
    case 'link-npm': return `link-npm:${dep.node}:${dep.executables}`;
    case 'copy': return `copy:${dep.node}:${dep.subdir ?? ''}`;
  }
}

export function isInternalNpmDep(x: BuildDepSpec): x is InternalNpmDepSpec {
  return x.type === 'link-npm';
}
