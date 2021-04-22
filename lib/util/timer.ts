/**
 * A single timer
 */
 export class Timer {
  public timeMs?: number;
  private startTime: number;
  private running = true;

  constructor(public readonly label: string, private readonly onStop?: (t: Timer) => void) {
    this.startTime = Date.now();
  }

  public start() {
    this.startTime = Date.now();
  }

  public stop() {
    if (!this.running) { return; }
    this.running = false;

    this.timeMs = (Date.now() - this.startTime) / 1000;
    this.onStop?.(this);
  }

  public isSet() {
    return this.timeMs !== undefined;
  }

  public humanTime() {
    if (!this.timeMs) { return '???'; }
    return humanTime(this.timeMs);
  }
}

export class CumulativeTimer {
  public totalTime = 0;
  public invocations = 0;

  constructor(public readonly label: string) {
  }

  public start() {
    return new Timer(this.label, t => {
      this.totalTime += t.timeMs ?? 0;
      this.invocations += 1;
    });
  }

  public humanTime() {
    return humanTime(this.totalTime);
  }
}

function humanTime(time: number) {
    const parts = [];

    if (time > 60) {
      const mins = Math.floor(time / 60);
      parts.push(mins + 'm');
      time -= mins * 60;
    }
    parts.push(time.toFixed(1) + 's');

    return parts.join('');
}
