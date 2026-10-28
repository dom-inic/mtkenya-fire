/**
 * Replay time is "minutes since the incident start" (1 Sep 2026 00:00 EAT).
 * Timestamps in the data are local EAT strings without a zone, so they are
 * parsed and formatted as if UTC to keep the browser's time zone out of it.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function toMinutes(iso: string, start: string): number {
  return (Date.parse(`${iso}Z`) - Date.parse(`${start}Z`)) / 60000;
}

export function fromMinutes(minutes: number, start: string): Date {
  return new Date(Date.parse(`${start}Z`) + minutes * 60000);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtTime(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function fmtDay(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function fmtDayTime(d: Date): string {
  return `${fmtDay(d)}, ${fmtTime(d)}`;
}

export function fmtIso(iso: string): string {
  return fmtDayTime(new Date(`${iso}Z`));
}
