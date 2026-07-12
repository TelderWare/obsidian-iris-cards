// Relative datetime formatting. Verbose, pluralized voice.
// Copied identically across iris-* plugins — keep in sync when changing.

function toDate(value: number | string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function calendarDaysDiff(target: Date, ref: Date): number {
  const a = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const b = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

function formatAbsolute(date: Date, ref: Date): string {
  const sameYear = date.getFullYear() === ref.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function renderDayCountdown(days: number, date: Date, ref: Date): string {
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 7) return `in ${days} days`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    const rem = days % 7;
    if (rem === 0) return weeks === 1 ? "in 1 week" : `in ${weeks} weeks`;
    const dayLabel = rem === 1 ? "day" : "days";
    return weeks === 1
      ? `in 1 week and ${rem} ${dayLabel}`
      : `in ${weeks} weeks and ${rem} ${dayLabel}`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    const leftover = days - months * 30;
    const dayLabel = leftover === 1 ? "day" : "days";
    if (months === 1) return leftover ? `in 1 month and ${leftover} ${dayLabel}` : "in 1 month";
    return leftover ? `in ${months} months and ${leftover} ${dayLabel}` : `in ${months} months`;
  }
  return formatAbsolute(date, ref);
}

/**
 * Past-relative, verbose, pluralized.
 * "just now" · "5 minutes ago" · "Yesterday" · "3 days ago" · "2 weeks ago" · "13 Mar"
 *
 * Hours-win: a 6-hour-old timestamp reads "6 hours ago" even if the calendar
 * day has rolled over since.
 */
export function formatAge(value: number | string | Date, refMs: number = Date.now()): string {
  const date = toDate(value);
  if (isNaN(date.getTime())) return "";
  const ref = new Date(refMs);
  const diffMs = refMs - date.getTime();

  // Future input — formatAge is past-only; fall through to absolute.
  if (diffMs < 0) return formatAbsolute(date, ref);

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;

  const days = calendarDaysDiff(ref, date);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  return formatAbsolute(date, ref);
}

/**
 * Future countdown with sub-day precision when within 24 hours.
 * "in less than a minute" · "in 5 minutes" · "in 2 hours" · "Today" · "Tomorrow"
 * · "in 3 days" · "in 2 weeks and 3 days" · "in 1 month and 4 days" · absolute beyond a year.
 */
export function formatCountdown(value: number | string | Date, refMs: number = Date.now()): string {
  const date = toDate(value);
  if (isNaN(date.getTime())) return "";
  const ref = new Date(refMs);
  const diffMs = date.getTime() - refMs;

  if (diffMs <= 0) return "Now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "in less than a minute";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "in 1 hour" : `in ${hours} hours`;

  return renderDayCountdown(calendarDaysDiff(date, ref), date, ref);
}

/**
 * Day-grained future countdown — used when the input is a date with no
 * meaningful time component (e.g. an exam scheduled "for Tuesday" with no
 * start time). Skips sub-day branches: an event "today" reads "Today" even
 * if comparing midnight-vs-now would suggest a sub-day diff.
 */
export function formatDayCountdown(value: number | string | Date, refMs: number = Date.now()): string {
  const date = toDate(value);
  if (isNaN(date.getTime())) return "";
  const ref = new Date(refMs);
  return renderDayCountdown(calendarDaysDiff(date, ref), date, ref);
}
