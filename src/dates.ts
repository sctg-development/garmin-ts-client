/** Calendar-date helpers on `YYYY-MM-DD` strings. Arithmetic is done in UTC so DST never shifts a day. */
import { GarminError } from "./errors.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(value: string): Date {
  if (!DATE.test(value)) throw new GarminError("error", `Invalid date format: ${value}. Use YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new GarminError("error", `Invalid date: ${value}.`);
  return date;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(value: string, days: number): string {
  return formatDate(new Date(parseDate(value).getTime() + days * 86_400_000));
}

export function daysBetween(start: string, end: string): number {
  return Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / 86_400_000);
}

export function dateRange(start: string, end: string): string[] {
  const count = daysBetween(start, end) + 1;
  return Array.from({ length: Math.max(count, 0) }, (_, index) => addDays(start, index));
}

/** Today's calendar date in the machine's local time zone. */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** `today`, `yesterday`, `week`, `month` or a date, as gc understands them: [start, end | null]. */
export function resolveShortcut(value: string, now: Date = new Date()): [string, string | null] {
  const today = localToday(now);
  switch (value) {
    case "today":
      return [today, null];
    case "yesterday":
      return [addDays(today, -1), null];
    case "week":
      return [addDays(today, -7), today];
    case "month":
      return [addDays(today, -30), today];
    default:
      parseDate(value);
      return [value, null];
  }
}
