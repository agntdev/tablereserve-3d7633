// Injectable clock seam — route every "now", "today", expiry, and
// late/on-time decision through `now()` so time-based behavior is
// testable. Override with `setClock(fn)` in tests.
// See AGENTS.md "Time — use an injectable clock".

let _now: () => Date = () => new Date();

/** The current datetime. Replace in tests with setClock(). */
export function now(): Date {
  return _now();
}

/** Today's date as YYYY-MM-DD string. */
export function todayString(): string {
  return dateString(_now());
}

/** Format a Date as YYYY-MM-DD. */
export function dateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format a Date as HH:MM. */
export function timeString(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** N days from now as a Date (start of day). Clones the clock's Date before mutating. */
export function daysFromNow(n: number): Date {
  const d = new Date(_now().getTime());
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Override the clock (test hook). Pass `new Date(...)` to restore real clock. */
export function setClock(fn: () => Date): void {
  _now = fn;
}
