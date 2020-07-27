import { UnitDefinition } from "../nozem-schema";
import { IBuildStrategy } from "./build-strategy";
import { CommandBuildStrategy } from "./command-build";
import { ExtractNode } from "./extract-strategy";
import { TypeScriptBuildStrategy } from "./typescript-build";

export async function createStrategy(def: UnitDefinition): Promise<IBuildStrategy> {
  switch (def.type) {
    case 'command': return CommandBuildStrategy.fromDefinition(def);
    case 'typescript-build': return TypeScriptBuildStrategy.fromTsDefinition(def);
    case 'extract': return new ExtractNode(def);
  }
}