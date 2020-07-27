import { BuildNode } from "../build-node";
import { BuildEnvironment, TemporaryBuildOutput } from "../build-tools";
import { BinaryLike } from "crypto";

export interface IBuildStrategy {
  readonly identifier: string;
  readonly version: string;

  build(node: BuildNode, env: BuildEnvironment, target: TemporaryBuildOutput): Promise<void>;
  updateInhash(hash: IDigestLike): Promise<void>;
}

export interface IDigestLike {
  update(d: BinaryLike): void;
}
