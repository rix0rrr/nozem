import { BuildEnvironment } from "../build-tools";
import { BuildNode } from "../build-node";
import { BuildGraph } from "../build-graph";
import { CommandBuildDefinition } from "../nozem-schema";

/**
 * A build dependency, and a matter in which it is consumed.
 *
 * Can represent refer to another build node
 */
export interface IBuildDependency {
  /**
   * Dependency name
   */
  readonly name: string;

  /**
   * Whether the dependency is available
   */
  readonly isAvailable: boolean;

  /**
   * Build nodes required by this dependency
   *
   * May be an empty list if the build dependency does not depend on
   * any other build nodes.
   */
  readonly buildNodes: BuildNode[];

  /**
   * Install the dependency into a build environment
   */
  installInto(env: BuildEnvironment): Promise<void>;

  /**
   * Calculcate the hash of the dependency
   */
  outHash(): Promise<string>;
}

export interface IUnboundBuildDependency {
  /**
   * The build dependency after binding
   */
  boundDependency: IBuildDependency;

  /**
   * Bind to a build graph (look up other nodes from the graph if required)
   */
  bind(graph: BuildGraph): void;
}

