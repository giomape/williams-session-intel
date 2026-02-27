import { CarSlot } from "@/lib/types";

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function toIso(ms: number): string {
  const d = new Date(ms);
  // OpenF1 date-range examples use ISO strings WITHOUT timezone suffix,
  // often with milliseconds, e.g. "2023-09-16T13:03:35.200"
  // Convert "2023-02-23T07:00:06.123Z" -> "2023-02-23T07:00:06.123"
  return d.toISOString().replace(/Z$/, "");
}

export function parseDriverNumber(input: string): number | null {
  const n = Number.parseInt(input, 10);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

export function formatClock(iso: string | null): string {
  if (!iso) return "--:--:--";
  const normalized = /[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], { hour12: false, timeZone: "UTC" });
}

export function formatAgo(iso: string | null): string {
  if (!iso) return "no updates";
  const now = Date.now();
  const normalized = /[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const then = new Date(normalized).getTime();
  if (Number.isNaN(then)) return "no updates";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function carLabel(slot: CarSlot): string {
  return slot === "A" ? "Car A" : "Car B";
}

export function bounded<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return items.slice(items.length - limit);
}

export function stableId(parts: Array<string | number | undefined | null>): string {
  return parts
    .map((part) => (part === undefined || part === null ? "na" : String(part)))
    .join("|");
}

export function safeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
