import { BuildDepSpec, InternalNpmDepSpec } from '../nozem-schema';
import { IBuildDependency, IUnboundBuildDependency } from './dependency';
import { ExternalNpmDependency } from './external-npm-dependency';
import { InternalNpmDependency } from './internal-npm-dependency';
import { OsDependency } from './os-dependency';
import { CopyFilesDependency } from './copy-files-dependency';
import { BuildGraph } from '../build-graph';

export * from './dependency';
export * from './copy-files-dependency';
export * from './external-npm-dependency';
export * from './internal-npm-dependency';
export * from './os-dependency';

export function createDependency(rootDirectory: string, dep: BuildDepSpec): IUnboundBuildDependency {
  switch (dep.type) {
    case 'link-npm': return new UnboundDependency(g => new InternalNpmDependency(dep, g.lookup(dep.node)));
    case 'npm': return new ExternalNpmDependency(rootDirectory, dep);
    case 'os': return new OsDependency(dep);
    case 'copy': return new UnboundDependency(g => new CopyFilesDependency(dep, g.lookup(dep.node)));
  }
}

class UnboundDependency<A> implements IUnboundBuildDependency {
  private _boundDependency?: IBuildDependency;

  constructor(private readonly ctor: (g: BuildGraph) => IBuildDependency) {
  }

  public bind(graph: BuildGraph): void {
    this._boundDependency = this.ctor(graph);
  }

  public get boundDependency(): IBuildDependency {
    if (this._boundDependency === undefined) {
      throw new Error('Call bind() first');
    }
    return this._boundDependency;
  }
}
