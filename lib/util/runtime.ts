export function flatMap<A, B>(xs: A[], fn: (x: A) => B[]): B[] {
  return Array.prototype.concat.apply([], xs.map(fn));
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