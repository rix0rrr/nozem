import * as path from 'https://deno.land/std@0.56.0/path/mod.ts';
import * as fs from 'https://deno.land/std@0.56.0/fs/mod.ts';
import * as log from 'https://deno.land/std@0.56.0/log/mod.ts';
import { Sha1 as Digest } from 'https://deno.land/std/hash/sha1.ts';
import { PackageJson, TsconfigJson } from './file-schemas.ts';
import { FileSet, walkFiles, FileMatcher, FilePatterns } from './files.ts';
import { Graph } from './graph.ts';

export interface NazelJson {
  units: UnitDefinition[];
}

/**
 * A single buildable unit
 */
export type UnitDefinition = BuildDefinition | ExtractDefinition;


type DefinitionCommon = {
  /**
   * A unique identifier for this build unit
   */
  readonly identifier: string;

  /**
   * Dependencies for this build unit
   */
  readonly dependencies?: BuildDependency[];
}

export interface BuildDefinition extends DefinitionCommon {
  type: 'build';

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

  /**
   * Should we patch tsconfig before the build for this package
   *
   * @default false
   */
  readonly patchTsconfig?: boolean;
}

export interface ExtractDefinition extends DefinitionCommon {
  type: 'extract';
  extractPatterns: string[];
}


export class BuildGraph {
  private readonly graph = new Graph<IGraphNode>();
  private readonly ids = new Map<string, IGraphNode>();
  private readonly depCache = new Map<string, IDependency>();

  constructor(private readonly units: UnitDefinition[]) {
  }

  public async build() {
    for (const unit of this.units) {
      const node = await createNode(unit);
      this.graph.addNode(node);
      this.ids.set(unit.identifier, node);
    }
    for (const unit of this.units) {
      const node = this.ids.get(unit.identifier);
      if (!node) { throw new Error('Huh!'); }

      const deps = (unit.dependencies ?? []).map(d => this.makeDependency(d));
      node.setDependencies(deps);
      for (const dep of deps) {
        for (const depNode of dep.graphNodes) {
          this.graph.addEdge(depNode, node);
        }
      }
    }
  }

  public lookup(id: string) {
    const ret = this.ids.get(id);
    if (!ret) { throw new Error(`No node with id: ${id}`); }
    return ret;
  }

  public sorted() {
    return this.graph.sorted();
  }

  public queueFor(targets: string[]) {
    const nodes = targets.map(t => this.lookup(t));
    const incomingClosure = this.graph.feedsInto(...nodes);
    return new BuildQueue(this.graph.subgraph(incomingClosure));
  }

  public queue() {
    return new BuildQueue(this.graph);
  }

  private makeDependency(dep: BuildDependency): IDependency {
    const produce = (): IDependency => {
      switch (dep.type) {
        case 'link-npm': return new NpmLinkNodeDependency(dep, this.lookup(dep.node));
        case 'npm': return new NpmDependencyNode(dep);
        case 'os': return new OsDependencyNode(dep);
        case 'copy': return new CopyDependencyNode(dep, this.lookup(dep.node));
      }
    }

    const key = buildDependencyId(dep);
    if (!this.depCache.has(key)) {
      this.depCache.set(key, produce());
    }
    return this.depCache.get(key)!;
  }
}

export class BuildQueue {
  private enqueued = new Set<IGraphNode>();
  private buildable = new Array<IGraphNode>();
  private _finished = 0;
  private _active = 0;

  constructor(private readonly graph: Graph<IGraphNode>) {
    for (const node of graph.nodes()) {
      this.maybeEnqueue(node);
    }
    if (this.buildable.length === 0) {
      throw new Error('No nodes are buildable');
    }
  }

  public get size() { return this.graph.nodes().length; }
  public get finished() { return this._finished; }
  public get active() { return this._active; }

  public parallel(n: number, cb: (node: IGraphNode) => Promise<void>): Promise<void> {
    return new Promise((ok, ko) => {
      const launchMore = () => {
        if (this.buildable.length === 0 && this._active === 0) {
          if (this.enqueued.size !== this.graph.nodes().length) {
            log.warning(`Finished ${this.enqueued.size} out of ${this.graph.nodes().length} jobs`);

            for (const node of this.graph.nodes()) {
              if (this.enqueued.has(node)) { continue; }
              log.warning(`- ${node.identifier}: waiting for ${node.dependencies.filter(d => !d.isAvailable).map(d => d.description)}`);
            }
          }

          ok(); // We're done
        }

        // Launch as many parallel "threads" as we can
        while (this._active < n && this.buildable.length > 0) {
          const node = this.buildable.splice(0, 1)[0];
          this._active++;
          cb(node).then(_ => finished(node)).catch(ko);
        }
      }

      const finished = (node: IGraphNode) => {
        this._active--;
        this._finished += 1;
        // Add everything that's now newly buildable
        this.enqueueBuildableSuccessors(node);
        launchMore();
      };

      launchMore();
    });
  }

  public async writeGraphViz(filename: string) {
    await this.graph.writeGraphViz(filename);
  }

  private enqueueBuildableSuccessors(node: IGraphNode) {
    for (const successor of this.graph.successors(node)) {
      this.maybeEnqueue(successor);
    }
  }

  private maybeEnqueue(node: IGraphNode) {
    if (node.isBuildable && !this.enqueued.has(node)) {
      this.enqueued.add(node);
      this.buildable.push(node);
    }
  }
}

export type BuildScope = 'build' | 'run';

/**
 * Description of a dependency
 */
export type BuildDependency = NpmDependency | LinkNpmDependency | OsDependency | CopyDependency;

export type NpmDependency = { type: 'npm'; name: string; versionRange: string; resolvedLocation: string };
export type LinkNpmDependency = { type: 'link-npm'; node: string; executables: boolean };
export type CopyDependency = { type: 'copy'; node: string; subdir?: string };
export type OsDependency = { type: 'os'; executable: string };

export function buildDependencyId(dep: BuildDependency): string {
  switch (dep.type) {
    case 'npm': return `npm:${dep.name}:${dep.resolvedLocation}`;
    case 'os': return `os:${dep.executable}`;
    case 'link-npm': return `link-npm:${dep.node}:${dep.executables}`;
    case 'copy': return `copy:${dep.node}:${dep.subdir ?? ''}`;
  }
}

export function isLinkDependency(x: BuildDependency): x is LinkNpmDependency {
  return x.type === 'link-npm';
}

export interface IDependency {
  installInto(env: BuildEnvironment): Promise<void>;
  readonly description: string;
  readonly isAvailable: boolean;
  outHash(): Promise<string>;

  /**
   * Graph nodes required by this dependency
   */
  readonly graphNodes: IGraphNode[];
}

export interface IGraphNode {
  readonly identifier: string;
  readonly slug: string;
  readonly isBuildable: boolean;
  readonly isBuilt: boolean;
  readonly output: BuildEnvironment;
  readonly description: string;
  readonly dependencies: IDependency[];

  sourceHash(): Promise<string>;
  build(env: BuildEnvironment): Promise<void>;
  rememberOutput(env: BuildEnvironment): Promise<void>;
  setDependencies(deps: IDependency[]): void;
}

export abstract class NodeBase implements IGraphNode {
  public readonly identifier: string;
  public readonly slug: string;
  public readonly description: string;
  protected _dependencies?: IDependency[];
  private outputEnv?: BuildEnvironment;

  constructor(def: UnitDefinition) {
    this.identifier = def.identifier;
    this.slug = this.identifier.replace(/[^a-zA-Z0-9_.-]/g, '-');
    this.description = def.identifier;
  }

  public setDependencies(deps: IDependency[]) {
    this._dependencies = [...deps];
  }

  public get isBuilt() {
    return this.outputEnv !== undefined;
  }

  public get output() {
    if (!this.outputEnv) {
      throw new Error(`Not built yet (${this.identifier})`);
    }
    return this.outputEnv;
  }

  public async rememberOutput(outputEnv: BuildEnvironment) {
    log.debug(`[${this.identifier}] Output at ${outputEnv.outDir}`);
    this.outputEnv = outputEnv;
  }

  public get dependencies() {
    if (!this._dependencies) {
      throw new Error(`Must set dependencies first`);
    }
    return this._dependencies;
  }

  public get isBuildable() {
    return this.dependencies.every(d => d.isAvailable);
  }

  public toString() {
    return this.identifier;
  }

  public abstract sourceHash(): Promise<string>;
  public abstract build(env: BuildEnvironment): Promise<void>;
}

export async function createNode(def: UnitDefinition): Promise<IGraphNode> {
  switch (def.type) {
    case 'build': return BuildNode.fromDefinition(def);
    case 'extract': return new ExtractNode(def);
  }
}

export class ExtractNode extends NodeBase {
  private _hash?: string;
  private pattern: FilePatterns;

  constructor(private readonly def: ExtractDefinition) {
    super(def);
    this.pattern = new FilePatterns(def.extractPatterns);
  }

  public async sourceHash(): Promise<string> {
    if (this._hash === undefined) {
      const d = new Digest();
      d.update('identifier:');
      d.update(this.identifier);
      d.update('pattern:');
      d.update(this.pattern.patternHash());
      d.update('deps:');
      for (const dep of this.dependencies) {
        d.update(dep.description);
        d.update('=');
        d.update(await dep.outHash());
      }
      this._hash = d.hex();
    }
    return this._hash;
  }

  public async build(env: BuildEnvironment): Promise<void> {
    log.info(`Extract ${this.identifier}`);

    for (const dep of this.dependencies) {
      await dep.installInto(env);
    }

    await env.copySrcToOut(this.pattern.toIncludeMatcher());
  }
}

export class BuildNode extends NodeBase {

  public static async fromDefinition(def: BuildDefinition) {
    const artifactPattern = new FilePatterns(def.nonSources);
    const files = await FileSet.fromFileSystem(def.root, artifactPattern.toIgnoreMatcher());
    return new BuildNode(def, artifactPattern, files);
  }

  private _hash?: string;

  private constructor(
    private readonly def: BuildDefinition,
    private readonly artifactPattern: FilePatterns,
    private readonly files: FileSet,
    ) {
    super(def);
  }

  public async build(env: BuildEnvironment) {
    log.info(`Build  ${this.identifier}`);
    const start = Date.now();

    await env.addSrcFiles(this.files);

    for (const dep of this.dependencies) {
      await dep.installInto(env);
    }

    if (this.def.patchTsconfig) {
      await this.patchTsConfig(path.join(env.srcDir, 'tsconfig.json'));
    }

    const startExecute = Date.now();
    if (this.def.buildCommand) {
      try {
        await env.execute(this.def.buildCommand, {
          NZL_PACKAGE_SOURCE: path.resolve(this.def.root),
        });
      } catch (e) {
        log.error(`${this.identifier} failed`);
        throw e;
      }
    }

    // We did an in-source build. Copy everything except the non-artifact
    // files to the output directory.
    const artifactMatcher = new FilePatterns(this.def.nonArtifacts).toIgnoreMatcher();
    await env.copySrcToOut(artifactMatcher);

    const delta = (Date.now() - start) / 1000;
    const executeDelta = (Date.now() - startExecute) / 1000;
    log.info(`Finish ${this.identifier} (${delta.toFixed(1)}s, execute ${executeDelta.toFixed(1)}s)`);
  }

  /**
   * Copy back from the given BUILT environment into the source directory
   */
  public async copyBack(env: BuildEnvironment) {
    await walkFiles(this.def.root, this.artifactPattern.toIncludeMatcher(), async (f) => {
      await Deno.remove(path.join(this.def.root, f));
    });

    await walkFiles(env.srcDir, this.artifactPattern.toIncludeMatcher(), async(f) => {
      await fs.copy(path.join(env.srcDir, f), path.join(this.def.root, f), {
        preserveTimestamps: true
      });
    });
  }

  public async sourceHash() {
    if (this._hash === undefined) {
      const d = new Digest();
      d.update('identifier:');
      d.update(this.identifier);
      d.update('command:');
      d.update(this.def.buildCommand ?? '');
      d.update('files:');
      d.update(await this.files.hash());
      d.update('deps:');
      for (const dep of this.dependencies) {
        d.update(dep.description);
        d.update('=');
        d.update(await dep.outHash());
      }

      // So -- we have to hash the artifact ignore pattern in here.
      // That's because we have to know our hash BEFORE we do the actual build,
      // so before we know what files actually get produced.
      //
      // We have to pessimistically assume that every change to the ignore
      // pattern is going to lead to a different build output.
      //
      // The good news is that if the build outputs didn't actually change,
      // downstream builds can be skipped again.
      d.update('ignoreArtifacts:');
      for (const pat of this.def.nonArtifacts) {
        d.update(pat + '\n');
      }

      this._hash = d.hex();
    }
    return this._hash;
  }

  private async patchTsConfig(filename: string) {
    try {
      const tsconfig: TsconfigJson = JSON.parse(await Deno.readTextFile(filename));
      delete tsconfig.references;
      delete tsconfig.compilerOptions.composite;
      delete tsconfig.compilerOptions.inlineSourceMap;
      delete tsconfig.compilerOptions.inlineSources;
      await Deno.writeTextFile(filename, JSON.stringify(tsconfig, undefined, 2));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) { throw e; }
    }
  }
}

export class NpmLinkNodeDependency implements IDependency {
  public readonly description = this.node.description;
  public readonly graphNodes = [this.node];

  private _outHashCache?: Promise<string>;

  constructor(private readonly def: LinkNpmDependency, private readonly node: IGraphNode) {
  }

  public get isAvailable() {
    return this.node.isBuilt;
  }

  public async installInto(env: BuildEnvironment) {
    const builtDir = this.node.output.outDir;
    await installNpmPackage(builtDir, env, this.def.executables);
  }

  public outHash() {
    if (this._outHashCache === undefined) {
      this._outHashCache = (async () => (await this.node.output.outHash()) + (this.def.executables ? '1' : '0'))();
    }
    return this._outHashCache;
  }
}

export class CopyDependencyNode implements IDependency {
  public readonly description = this.node.description;
  public readonly graphNodes = [this.node];

  private _outHashCache?: Promise<string>;

  constructor(private readonly def: CopyDependency, private readonly node: IGraphNode) {
  }

  public get isAvailable() {
    return this.node.isBuilt;
  }

  public async installInto(env: BuildEnvironment) {
    log.debug(`Copy ${this.node.output.outDir} -> ${path.join(env.srcDir, this.def.subdir ?? '.')}`);
    await env.addSrcFiles(await this.node.output.outFiles(), this.def.subdir ?? '.');
  }

  public outHash() {
    if (this._outHashCache === undefined) {
      this._outHashCache = this.node.output.outHash();
    }
    return this._outHashCache;
  }
}

export class NpmDependencyNode implements IDependency {
  public readonly description: string;
  public readonly isAvailable = true;
  public readonly graphNodes = [];

  private _version?: string;

  constructor(private readonly def: NpmDependency) {
    this.description = def.name;
  }

  public async outHash() {
    // FIXME: Should get package hash from Yarn, going to
    // go with the version number from 'package.json' for now.
    if (this._version === undefined) {
      const pj: PackageJson = await readJson(path.join(this.def.resolvedLocation, 'package.json'));
      this._version = pj.version;
    }
    return this._version;
  }

  public async installInto(env: BuildEnvironment) {
    await installNpmPackage(this.def.resolvedLocation, env, true);
  }
}

async function installNpmPackage(dir: string, env: BuildEnvironment, includeDependencies: boolean) {
  const pj: PackageJson = await readJson(path.join(dir, 'package.json'));

  await env.installSymlink(
    path.join('node_modules', pj.name),
    path.resolve(dir),
  );

  if (includeDependencies) {
    if (typeof pj.bin === 'string') {
      await env.installExecutable(path.resolve(dir, pj.bin), pj.name);
    }
    if (typeof pj.bin === 'object') {
      for (const [name, target] of Object.entries(pj.bin ?? {})) {
        await env.installExecutable(path.resolve(dir, target), name);
      }
    }
  }
}

export class OsDependencyNode implements IDependency {
  public readonly description: string;
  public readonly graphNodes = [];
  public readonly isAvailable = true;

  constructor(private readonly def: OsDependency) {
    this.description = def.executable;
  }

  public async outHash() {
    // FIXME: Should get tool version or summin'
    return '';
  }

  public async installInto(env: BuildEnvironment) {
    const p = Deno.run({
      cmd: ['which', this.def.executable],
      stdout: 'piped'
    });
    const location = new TextDecoder().decode(await p.output()).trim();
    p.close();

    await env.installExecutable(location);
  }
}

export class BuildWorkspace {
  private readonly buildDir: string;
  private readonly cacheDir: string;
  private readonly cached = new Map<string, BuildEnvironment>();

  constructor(private readonly root: string) {
    this.buildDir = path.join(this.root, 'build');
    this.cacheDir = path.join(this.root, 'cache');
  }

  public async fromCache(hash: string) {
    const dir = path.join(this.cacheDir, hash);
    if (!await fs.exists(dir)) { return undefined; }

    if (!this.cached.has(hash)) {
      this.cached.set(hash, new BuildEnvironment(this, dir));
    }
    return this.cached.get(hash)!;
  }

  public async store(env: BuildEnvironment, hash: string) {
    const dir = path.join(this.cacheDir, hash);
    await fs.ensureDir(this.cacheDir);
    await fs.move(env.root, dir);
    return new BuildEnvironment(this, dir);
  }

  public async makeBuildEnvironment(name: string) {
    const dir = path.join(this.buildDir, name);
    if (await fs.exists(dir)) {
      await Deno.remove(dir, { recursive: true });
    }
    await fs.ensureDir(dir);
    return new BuildEnvironment(this, dir);
  }
}

/**
 * Build environment
 *
 * A build environment is structured like:
 *
 * $root/
 *    bin/
 *    src/
 *    node_modules/
 * ...
 */
export class BuildEnvironment {
  public readonly binDir: string;
  public readonly srcDir: string;
  public readonly outDir: string;
  private _outFiles?: FileSet;
  private _outHash?: string;
  private derivationCache = new Map<string, FileSet>();

  constructor(public readonly workspace: BuildWorkspace, public readonly root: string) {
    this.binDir = path.join(root, 'bin');
    this.srcDir = path.join(root, 'src');
    this.outDir = path.join(root, 'out');
  }

  public async outFiles(): Promise<FileSet> {
    if (this._outFiles === undefined) {
      this._outFiles = await FileSet.fromDirectory(this.outDir);
    }
    return this._outFiles;
  }

  public async outHash(): Promise<string> {
    if (this._outHash === undefined) {
      // Cache this in file, saves recalculation
      const cacheFile = path.join(this.root, 'out.hash');
      if (await fs.exists(cacheFile)) {
        this._outHash = await Deno.readTextFile(cacheFile);
      } else {
        this._outHash = await (await this.outFiles()).hash();
        await Deno.writeTextFile(cacheFile, this._outHash);
      }
    }
    return this._outHash;
  }

  public async cleanup() {
    await Deno.remove(this.root, { recursive: true });
  }

  public async installExecutable(absTarget: string, binName?: string) {
    const targetPath = path.join(this.binDir, binName ?? path.basename(absTarget));
    try {
      await fs.ensureSymlink(
        absTarget,
        targetPath);
    } catch (e) {
      throw new Error(`Error symlinking ${absTarget} -> ${targetPath}: ${e.message}`);
    }
  }

  public async installSymlink(relSource: string, absTarget: string) {
    try {
      await fs.ensureSymlink(
        absTarget,
        path.join(this.root, relSource),
        );
    } catch (e) {
      throw new Error(`Error symlinking ${absTarget} -> ${path.join(this.root, relSource)}: ${e.message}`);
    }
  }

  public async addSrcFiles(files: FileSet, subdir: string = '.') {
    await Promise.all(files.files.map(f => this.addSrcFile(files.absPath(f), path.join(subdir, f))));
  }

  public async addSrcFile(absSource: string, relTarget: string) {
    const absTarget = path.join(this.srcDir, relTarget);
    await this.copy(absSource, absTarget);
  }

  public async copySrcToOut(matcher: FileMatcher) {
    // We did an in-source build. Copy everything except the non-artifact
    // files to the output directory.
    const artifacts = await FileSet.fromFileSystem(this.srcDir, matcher);
    for (const f of artifacts.files) {
      await this.copy(
        path.join(this.srcDir, f),
        path.join(this.outDir, f));
    }
  }

  public async deriveOutput(patterns: FilePatterns) {
    const id = patterns.patternHash();

    const derivationDir = path.join(this.root, `deriv_${id}`);
    if (!await fs.exists(derivationDir)) {
      const tmpDir = await Deno.makeTempDir({ dir: this.root, prefix: 'tmp_deriv' });

      const derivedFiles = await FileSet.fromFileSystem(this.outDir, patterns.toIncludeMatcher());
      for (const f of derivedFiles.files) {
        await this.copy(
          path.join(this.outDir, f),
          path.join(tmpDir, f));
      }

      try {
        await Deno.rename(tmpDir, derivationDir);
      } catch (e) {
        // "Directory not empty"
        if (e.message.indexOf('os error 66')) {
          // Same derivation may be run twice, which may lead to a conflict when trying to 'mv' the
          // working directory into place. Ignore the second one since it will have produced the same output.
          await Deno.remove(tmpDir, { recursive: true });
        } else {
          throw e;
        }
      }
    }
    return this.derivation(id);
  }

  public async derivation(id: string) {
    const derivationDir = path.join(this.root, `deriv_${id}`);
    if (!await fs.exists(derivationDir)) {
      throw new Error(`No such derivation: ${id}`);
    }

    if (!this.derivationCache.has(id)) {
      this.derivationCache.set(id, await FileSet.fromDirectory(derivationDir));
    }
    return this.derivationCache.get(id)!;
  }

  public async execute(command: string, env: Record<string, string>) {
    log.debug(`[${this.srcDir}] ${command}`);
    const p = Deno.run({
      cmd: ['/bin/bash', '-c', command],
      cwd: this.srcDir,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      env: {
        PATH: this.binDir,
        ...env
      }
    });

    // We need to constantly read stdout and stderr otherwise the subprocess
    // is going to hang if it fills up its output buffer.
    const [stdout, stderr, status] = await Promise.all([
      Deno.readAll(p.stdout!),
      Deno.readAll(p.stderr!),
      p.status()
    ]);

    p.stdout!.close();
    p.stderr!.close();
    p.close();

    if (!status.success) {
      await Deno.stdout.write(stdout);
      await Deno.stderr.write(stderr);
      throw new Error('Command failed');
    }
  }

  private async copy(src: string, target: string) {
    await fs.ensureDir(path.dirname(target));
    let errorMessage = `Error copying ${src} -> ${target}`;
    try {
      const stat = await Deno.lstat(src);
      if (stat.isSymlink) {
        const linkTarget = await Deno.readLink(src);
        errorMessage = `Error copying symlink ${src} (${linkTarget}) -> ${target}`;
        if (await fs.exists(target)) {
          await Deno.remove(target);
        }
        await Deno.symlink(linkTarget, target);
      } else {
        await fs.copy(src, target, { preserveTimestamps: true, overwrite: true });
      }
    } catch (e) {
      console.error(errorMessage);
      throw e;
    }
  }
}

async function readJson(filename: string) {
  try {
    return JSON.parse(await Deno.readTextFile(filename));
  } catch (e) {
    throw new Error(`Error reading ${filename}: ${e.message}`);
  }
}