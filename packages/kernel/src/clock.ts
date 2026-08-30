/** Injected time. Keeps expiry logic deterministic and unit-testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const fixedClock = (at: Date): Clock => ({ now: () => new Date(at.getTime()) });
