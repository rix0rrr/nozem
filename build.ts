import { NazelJson, isRepoDependency, BuildNode, BuildDependency, IDependency, NpmDependencyNode } from "./build-graph.ts";
import { topologicalSort } from "./toposort.ts";

export async function build() {
  const nazelJson: NazelJson = JSON.parse(await Deno.readTextFile('nazel.json'));

  const unitDefinitions = new Map(nazelJson.units.map(unit => [unit.identifier, unit]));
  const orderedDefinitions = topologicalSort(unitDefinitions.values(),
    u => u.identifier,
    u => u.dependencies?.filter(isRepoDependency).map(d => d.identifier) ?? []);

  const nodeMap = new Map<string, BuildNode>();
  const nodes = new Array<BuildNode>();
  for (const def of orderedDefinitions) {
    const node = await BuildNode.fromDefinition(def, def.dependencies?.map(dependencyObject) ?? []);
    nodes.push(node);
    nodeMap.set(node.identifier, node);
  }

  const root = Deno.cwd();

  for (const node of nodes) {
    await node.build(root);
  }

  function dependencyObject(dep: BuildDependency): IDependency {
    switch (dep.type) {
      case 'repo':
        const x = nodeMap.get(dep.identifier);
        if (x === undefined) { throw new Error(`Dependency problem with ${dep.identifier}`); }
        return x;

      case 'npm':
        return new NpmDependencyNode(dep);

      default:
        throw new Error(`Unknown dependency type: ${JSON.stringify(dep)}`);
    }
  }
}