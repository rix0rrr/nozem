import * as crypto from 'crypto';
import { hasUncaughtExceptionCaptureCallback, setMaxListeners } from 'process';
import { mkdict } from './runtime';


export type IDirectlyHashable = { hash(): Promise<string> };
export type IHashableElements = { readonly hashableElements: Record<string, IHashable> | Promise<Record<string, IHashable>>; }

/**
 * A hashable element
 */
export type IHashable = IDirectlyHashable | IHashableElements;

export function isDirectlyHashable(h: IHashable): h is IDirectlyHashable {
  return 'hash' in h;
}

export function isMerkleTree(h: IHashable): h is IHashableElements {
  return 'elements' in h;
}

export function hashOf(x: IHashable) {
  return MerkleTree.hashTree(x);
}

const HASH_CACHE = new WeakMap<IHashableElements, string>();

export class MerkleTree<A extends IHashable> implements IHashableElements {
  /**
   * Do a standard hash of a merkle tree structure
   */
  public static async hashTree(tree: IHashable) {
    if (isDirectlyHashable(tree)) { return tree.hash(); }

    const previous = HASH_CACHE.get(tree);
    if (previous) { return previous; }

    const elements = await tree.hashableElements;
    const keys = Object.keys(elements).sort();
    const h = standardHash();
    for (const [k, v] of await Promise.all(keys.map(async (key) => [key, (elements)[key]] as const))) {
      h.update(`${k}=${await MerkleTree.hashTree(v)}\n`);
    }
    const ret = h.digest('hex');
    HASH_CACHE.set(tree, ret);
    return ret;
  }

  /**
   * Compare two merkle trees, returning the differences
   */
  public static async compare(a: IHashable, b: IHashable): Promise<MerkleComparison> {
    const differences = new Array<MerkleDifference>();
    await recurse(a, b, []);
    return differences.length > 0 ? { result: 'different', differences } : { result: 'same' };

    async function recurse(x: IHashable, y: IHashable, path: string[]) {
      if (isDirectlyHashable(x) && isDirectlyHashable(y)) {
        const oldHash = await MerkleTree.hashTree(x);
        const newHash = await MerkleTree.hashTree(y);
        if (oldHash !== newHash) {
          differences.push({ type: 'change', path, oldHash, newHash });
          return;
        }
      }

      const xs = isMerkleTree(x) ? await x.hashableElements : {};
      const ys = isMerkleTree(y) ? await y.hashableElements : {};

      for (const key of Object.keys(xs)) {
        const xc = xs[key];
        const xHash = await MerkleTree.hashTree(xc);
        if (!(key in ys)) {
          differences.push({
            type: 'remove',
            path: [...path, key],
            oldHash: xHash,
          });
          continue;
        }

        const yc = ys[key];
        const yHash = await MerkleTree.hashTree(yc);

        if (xHash !== yHash) {
          if (isMerkleTree(xc) && isMerkleTree(yc)) {
            // Mutate 'keys' in place for efficiency!
            path.push(key);
            await recurse(xc, yc, path);
            path.pop();
          } else {
            differences.push({
              type: 'change',
              path: [...path, key],
              oldHash: xHash,
              newHash: yHash,
            });
          }
        }
      }
      for (const key of Object.keys(ys)) {
        if (!(key in xs)) {
          differences.push({
            type: 'add',
            path: [...path, key],
            newHash: await MerkleTree.hashTree(ys[key]),
          });
        }
      }
    }
  }

  /**
   * Serialize an arbitrary merkle tree
   */
  public static async serialize(x: IHashable, maxDepth?: number): Promise<SerializedMerkleTree> {
    if (isDirectlyHashable(x) || (maxDepth !== undefined && maxDepth <= 0)) {
      return MerkleTree.hashTree(x);
    }

    const nextDepth = maxDepth !== undefined ? maxDepth - 1 : undefined;

    return {
      hash: await MerkleTree.hashTree(x),
      elements: mkdict(await Promise.all(Object.entries(await x.hashableElements).map(async ([k, v]) =>
        [k, await MerkleTree.serialize(v, nextDepth)] as const))),
    };
  }

  /**
   * Deserialize a serialized MerkleTree structure
   *
   * The hashes will be the only information retained.
   */
  public static async deserialize(x: SerializedMerkleTree): Promise<IHashable> {
    if (typeof x === 'string') { return constantHashable(x); }

    const ret = new MerkleTree(await Promise.all(Object.entries(x.elements).map(async ([key, value]) =>
      [key, await MerkleTree.deserialize(value)] as const
    )));

    // Just some validation. That hash doesn't actually need to be in there if we can trust the rest.
    if (await MerkleTree.hashTree(ret) !== x.hash) {
      throw new Error(`Something is wrong, hashes do not match: ${await MerkleTree.hashTree(ret)} != ${x.hash}`);
    }
    return ret;
  }

  public static fromDict(d: Record<string, string>) {
    return new MerkleTree(Object.entries(d).map(([k, v]) => [k, constantHashable(v)] as const));
  }

  public readonly hashableElements: Record<string, A> = {};

  constructor(elements?: Record<string, A> | Iterable<readonly [string, A]>) {
    if (isIterable(elements)) {
      this.hashableElements = mkdict(elements);
    } else {
      this.hashableElements = { ...elements };
    }
  }

  public get values(): A[] {
    return Object.values(this.hashableElements);
  }

  public add<B extends IHashable>(elements?: Record<string, B> | Iterable<readonly [string, B]>): MerkleTree<A | B> {
    return new MerkleTree({
      ...this.hashableElements,
      ...isIterable(elements) ? mkdict(elements) : elements,
    });
  }
}

export function constantHashable(hash: string | Promise<string>): IHashable {
  return {
    hash: () => Promise.resolve(hash),
  };
}

export type MerkleComparison = { readonly result: 'same' } | { readonly result: 'different', readonly differences: MerkleDifference[]; };

export type MerkleDifference = { readonly path: string[]; } & (
  { readonly type: 'add', readonly newHash: string }
  | { readonly type: 'remove', readonly oldHash: string }
  | { readonly type: 'change', readonly oldHash: string, readonly newHash: string });

export function standardHash() {
  return crypto.createHash('sha1');
}

export type SerializedMerkleTree = string | {
  readonly hash: string;
  readonly elements: Record<string, SerializedMerkleTree>;
}

function isIterable(x: unknown): x is Iterable<any> {
  if (x == null || typeof x !== 'object') { return false; }
  return typeof (x as any)[Symbol.iterator] === 'function';
}

export function renderComparison(comp: MerkleComparison, maxDetail?: number): string {
  if (comp.result === 'same' || comp.differences.length === 0) { return 'no difference'; }

  if (maxDetail) {
    return [
      comp.differences.slice(0, maxDetail).map(renderDifference).join(', '),
      comp.differences.length > 1 ? ` and ${comp.differences.length - 1} more` : '',
    ].join('');
  } else {
    return comp.differences.map(renderDifference).join(', ');
  }
}

function renderDifference(difference: MerkleDifference): string {
  return [
    difference.type === 'add' ? '+' : (difference.type === 'remove' ? '-' : ''),
    difference.path.join(':'),
    difference.type === 'change' ? ` ${difference.oldHash.substr(0, 8)} -> ${difference.newHash.substr(0, 8)}` : '',
  ].join('');
}