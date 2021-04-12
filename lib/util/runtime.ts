export function flatMap<A, B>(xs: A[], fn: (x: A) => B[]): B[] {
  return Array.prototype.concat.apply([], xs.map(fn));
}

export function partition<A, B extends A>(xs: A[], pred: (x: A) => x is B): [B[], A[]] {
  const yes = new Array<B>();
  const no = new Array<A>();
  for (const x of xs) {
    (pred(x) ? yes : no).push(x);
  }
  return [yes, no];
}

/**
 * Cache the promise, not the value, so that we don't start the computation twice.
 */
export function cachedPromise<A>(obj: any, key: symbol | string, fn: () => Promise<A>): Promise<A> {
  if (!(key in obj)) {
    obj[key] = fn();
  }
  return obj[key];
}

export function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

export function starWildcard(s: string): RegExp {
  return new RegExp('^' + s.split('*').map(escapeRegExp).join('.*') + '$');
}