/** Injectable time source so that trading, the simulator and tests share one notion of "now". */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Deterministic clock for tests: time only moves when told to. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }

  advanceMs(ms: number): Date {
    this.current += ms;
    return this.now();
  }

  advanceSeconds(seconds: number): Date {
    return this.advanceMs(seconds * 1000);
  }
}
