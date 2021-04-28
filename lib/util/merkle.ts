import * as crypto from 'crypto';
import { setMaxListeners } from 'process';
import { mkdict } from './runtime';

/**
 * A hashable element
 */
export interface IHashable {
  hash():  Promise<string>;
}

export interface IMerkleTree extends IHashable {
  readonly elements: Record<string, IHashable> | Promise<Record<string, IHashable>>;
}

export function isMerkleTree(h: IHashable): h is IMerkleTree {
  return 'elements' in h;
}

export class MerkleTree<A extends IHashable> implements IMerkleTree {
  /**
   * Do a standard hash of a merkle tree structure
   */
  public static async hashTree(tree: IMerkleTree) {
    const elements = await tree.elements;
    const keys = Object.keys(elements).sort();
    const h = standardHash();
    for (const [k, v] of await Promise.all(keys.map(async (key) => [key, (elements)[key]] as const))) {
      h.update(`${k}=${await v.hash()}\n`);
    }
    return h.digest('hex');
  }

  /**
   * Compare two merkle trees, returning the differences
   */
  public static async compare(a: IMerkleTree, b: IMerkleTree): Promise<MerkleComparison> {
    const differences = new Array<MerkleDifference>();
    await recurse(a, b, []);
    return differences.length > 0 ? { result: 'different', differences } : { result: 'same' };

    async function recurse(x: IMerkleTree, y: IMerkleTree, keys: string[]) {
      const xs = await x.elements;
      const ys = await y.elements;

      for (const key of Object.keys(xs)) {
        const xc = xs[key];
        const xHash = await xc.hash();
        if (!(key in ys)) {
          differences.push({
            type: 'remove',
            path: [...keys, key],
            oldHash: xHash,
          });
          continue;
        }

        const yc = ys[key];
        const yHash = await yc.hash();

        if (xHash !== yHash) {
          if (isMerkleTree(xc) && isMerkleTree(yc)) {
            // Mutate 'keys' in place for efficiency!
            keys.push(key);
            await recurse(xc, yc, keys);
            keys.pop();
          } else {
            differences.push({
              type: 'change',
              path: [...keys, key],
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
            path: [...keys, key],
            newHash: await ys[key].hash(),
          });
        }
      }
    }
  }

  /**
   * Serialize an arbitrary merkle tree
   */
  public static async serialize(x: IMerkleTree, limit?: number): Promise<SerializedMerkleTree> {
    const nextLimit = limit !== undefined ? limit - 1 : undefined;

    return {
      hash: await x.hash(),
      elements: mkdict(await Promise.all(Object.entries(await x.elements).map(async ([k, v]) =>
        [k, isMerkleTree(v) && limit !== 1 ? await MerkleTree.serialize(v, nextLimit) : await v.hash()] as const
      ))),
    };
  }

  /**
   * Deserialize a serialized MerkleTree structure
   *
   * The hashes will be the only information retained.
   */
  public static async deserialize(x: SerializedMerkleTree): Promise<IMerkleTree> {
    const tree = new MerkleTree();
    for (const [key, value] of Object.entries(x.elements)) {
      if (typeof value === 'string') {
        tree.add(key, constantHashable(value));
      } else {
        tree.add(key, await MerkleTree.deserialize(value));
      }
    }

    // Just some validation. That hash doesn't actually need to be in there if we can trust the rest.
    if (await tree.hash() !== x.hash) {
      throw new Error(`Something is wrong, hashes do not match: ${await tree.hash()} != ${x.hash}`);
    }
    return tree;
  }

  public static fromDict(d: Record<string, string>) {
    return new MerkleTree(Object.entries(d).map(([k, v]) => [k, constantHashable(v)] as const));
  }

  public readonly elements: Record<string, A> = {};
  private _hashCache: Promise<string> | undefined;

  constructor(elements?: Record<string, A> | Iterable<readonly [string, A]>) {
    if (isIterable(elements)) {
      this.elements = mkdict(elements);
    } else {
      this.elements = { ...elements };
    }
  }

  public get values(): A[] {
    return Object.values(this.elements);
  }

  public add(key: string, value: A) {
    if (this.elements[key]) { throw new Error(`Already has key: ${key}`); }
    this.elements[key] = value;
    this._hashCache = undefined;
  }

  public async hash(): Promise<string> {
    if (this._hashCache) { return this._hashCache; }
    return this._hashCache = MerkleTree.hashTree(this);
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

export interface SerializedMerkleTree {
  readonly hash: string;
  readonly elements: Record<string, SerializedMerkleTree | string>;
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
    difference.path.join('/'),
    difference.type === 'change' ? ` ${difference.oldHash.substr(0, 8)} -> ${difference.newHash.substr(0, 8)}` : '',
  ].join('');
}