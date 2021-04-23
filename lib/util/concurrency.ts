
/**
 * Controls how many promises are executed at once
 */
export class PromisePool {
  private readonly _queue: Array<Queued<any>> = [];
  private active = 0;

  constructor(private readonly maxN: number) {
    if (maxN < 1) {
      throw new Error('Need a positive number');
    }
  }

  public queue<A>(pThunk: () => Promise<A>): Promise<A> {
    return new Promise((resolve, reject) => {
      this._queue.push({ pThunk: pThunk, resolve, reject });
      this.launchMore();
    });
  }

  public all<A>(thunks: Array<() => Promise<A>>): Promise<Array<A>> {
    return Promise.all(thunks.map(this.queue.bind(this)));
  }

  private launchMore() {
    if (this.active >= this.maxN) { return; }
    const next = this._queue.shift();
    if (!next) { return; }

    this.active += 1;
    next.pThunk().then(next.resolve).catch(next.reject).finally(() => {
      this.active -= 1;
      this.launchMore();
    });
  }
}

export const PROMISE_POOL = new PromisePool(4);

interface Queued<A> {
  readonly resolve: (x: A) => void;
  readonly reject: (err: Error) => void;
  readonly pThunk: () => Promise<A>;
}

