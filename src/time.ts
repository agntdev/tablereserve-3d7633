// Injectable clock — every time-based decision routes through this seam.
// Tests override `now` to drive schedule/cutoff/expiry logic deterministically.

export type Clock = () => Date;

let currentClock: Clock = () => new Date();

/** Get the current time (overrideable in tests via setNow/resetNow). */
export function now(): Date {
  return currentClock();
}

/** Override the clock in a test. */
export function setNow(fn: Clock): void {
  currentClock = fn;
}

/** Reset to the real system clock. */
export function resetNow(): void {
  currentClock = () => new Date();
}

/** Return today's date as YYYY-MM-DD in local timezone. */
export function todayString(): string {
  const d = now();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Return the date N days from now as YYYY-MM-DD. */
export function daysFromNow(n: number): string {
  const d = now();
  d.setDate(d.getDate() + n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Generate a short, human-readable booking code from a counter value. */
export function bookingCodeFromCounter(counter: number): string {
  const ts = now().getTime().toString(36).toUpperCase().slice(-4);
  const seq = counter.toString(36).toUpperCase().padStart(3, "0").slice(-3);
  return `BK-${ts}${seq}`;
}
