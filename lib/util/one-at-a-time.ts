import * as log from '../util/log';

/**
 * Class that manages running at most one instance of an async job
 *
 * If new requests come in while a job is already running, the job
 * will be run again once.
 *
 * Even though the job (callback) shouldn't really change and be encoded into the
 * constructor, we don't actually do that -- the callback is passed to
 * every enqueue request, which makes it more readable but also more
 * ripe for abuse. Don't pass callbacks that depend on arguments, you
 * might not like the results.
 */
export class OneAtATime {
  private _running = false;
  private _queued = false;

  public tryRun(cb: () => Promise<void>) {
    if (this._running) {
      this._queued = true;
      return;
    }

    this._running = true;
    this._queued = true;
    (async () => {
      try {
        while (this._queued) {
          try {
            this._queued = false;
            await cb();
          } catch (e) {
            log.error(`Error in background job: ${e}`);
          }
        }
      } finally {
        this._running = false;
      }
    })();
  }
}