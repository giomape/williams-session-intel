import { DEMO_SESSION_KEY } from "@/lib/demoConfig";

export const OPENF1_ALLOWED_PATHS = [
  "sessions",
  "drivers",
  "position",
  "location",
  "pit",
  "team_radio",
  "race_control",
  "weather",
  "laps",
  "intervals",
  "stints",
  "overtakes",
  "car_data"
] as const;

export type OpenF1Path = (typeof OPENF1_ALLOWED_PATHS)[number];

type QueryValue = string | number | boolean | null | undefined;
type ReplayRow = Record<string, unknown>;
type DemoPackRows = Record<OpenF1Path, ReplayRow[]>;

interface DateIndex {
  rows: ReplayRow[];
  timestamps: number[];
}

interface DemoPackCache {
  rows: DemoPackRows;
  dateIndex: Partial<Record<OpenF1Path, DateIndex>>;
}

const DEMO_ROOT = `/demo-packs/${DEMO_SESSION_KEY}`;
const PRE_RACE_OFFSET_MS = 5 * 60 * 1000;

let demoPackPromise: Promise<DemoPackCache> | null = null;

export class OpenF1ClientError extends Error {
  readonly status: number;
  readonly retryAfterSec: number | null;

  constructor(message: string, status: number, retryAfterSec: number | null = null) {
    super(message);
    this.name = "OpenF1ClientError";
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

function readDateField(row: ReplayRow): string | null {
  const date = row.date;
  if (typeof date === "string" && date.trim().length > 0) return date;

  const dateStart = row.date_start;
  if (typeof dateStart === "string" && dateStart.trim().length > 0) return dateStart;

  const dateEnd = row.date_end;
  if (typeof dateEnd === "string" && dateEnd.trim().length > 0) return dateEnd;

  return null;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim().length) return null;
  const trimmed = value.trim();
  const withTimezone =
    /[zZ]|[+-]\d{2}:\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`;
  const ms = Date.parse(withTimezone);
  return Number.isFinite(ms) ? ms : null;
}

function parseJsonl(text: string): ReplayRow[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as ReplayRow;
        return parsed && typeof parsed === "object" ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function sortByDate(rows: ReplayRow[]): ReplayRow[] {
  return [...rows].sort((a, b) => {
    const aIso = readDateField(a) ?? "";
    const bIso = readDateField(b) ?? "";
    return aIso.localeCompare(bIso);
  });
}

function mergeByDate(...groups: ReplayRow[][]): ReplayRow[] {
  return sortByDate(groups.flat());
}

function asArrayRows(value: ReplayRow[] | ReplayRow | null): ReplayRow[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [];
}

async function fetchJsonFile(url: string): Promise<ReplayRow[] | ReplayRow | null> {
  const response = await fetch(url, {
    method: "GET",
    cache: "force-cache",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new OpenF1ClientError(`Missing local file: ${url}`, response.status);
  }

  return (await response.json()) as ReplayRow[] | ReplayRow;
}

async function fetchJsonlFile(url: string): Promise<ReplayRow[]> {
  const response = await fetch(url, {
    method: "GET",
    cache: "force-cache",
    headers: { Accept: "text/plain" }
  });

  if (!response.ok) {
    if (response.status === 404) return [];
    throw new OpenF1ClientError(`Missing local file: ${url}`, response.status);
  }

  return parseJsonl(await response.text());
}

function withSessionKey(rows: ReplayRow[]): ReplayRow[] {
  return rows.filter((row) => {
    const raw = row.session_key;
    if (raw === undefined || raw === null) return true;
    return String(raw) === DEMO_SESSION_KEY;
  });
}

function createDateIndex(rows: ReplayRow[]): DateIndex | null {
  const sorted = sortByDate(rows);
  const timestamps = sorted.map((row) => parseIsoMs(readDateField(row)) ?? Number.NEGATIVE_INFINITY);
  const hasDate = timestamps.some((value) => Number.isFinite(value));
  if (!hasDate) return null;
  return { rows: sorted, timestamps };
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function sliceByDateRange(index: DateIndex, gtValue?: QueryValue, ltValue?: QueryValue): ReplayRow[] {
  const gtMs = parseIsoMs(gtValue);
  const ltMs = parseIsoMs(ltValue);

  const start = gtMs === null ? 0 : upperBound(index.timestamps, gtMs);
  const end = ltMs === null ? index.rows.length : lowerBound(index.timestamps, ltMs);

  if (start >= end) return [];
  return index.rows.slice(start, end);
}

function compareDate(value: string, rowDate: string | null): number {
  if (!rowDate) return 0;
  const rowMs = parseIsoMs(rowDate);
  const valueMs = parseIsoMs(value);
  if (rowMs === null || valueMs === null) return rowDate.localeCompare(value);
  return rowMs - valueMs;
}

function matchesFilter(row: ReplayRow, key: string, value: QueryValue): boolean {
  if (value === undefined || value === null || value === "") return true;

  if (key === "date>") {
    return compareDate(String(value), readDateField(row)) > 0;
  }

  if (key === "date<") {
    return compareDate(String(value), readDateField(row)) < 0;
  }

  const field = row[key];
  if (field === undefined || field === null) return false;
  return String(field) === String(value);
}

function applyFilters(rows: ReplayRow[], params: Record<string, QueryValue>): ReplayRow[] {
  return rows.filter((row) =>
    Object.entries(params).every(([key, value]) => matchesFilter(row, key, value))
  );
}

async function loadDemoPack(): Promise<DemoPackCache> {
  if (demoPackPromise) return demoPackPromise;

  demoPackPromise = (async () => {
    const [
      metaJson,
      driversJson,
      positionA,
      positionB,
      locationAll,
      pitA,
      pitB,
      teamRadio,
      raceControl,
      weather,
      lapsA,
      lapsB,
      intervals,
      stints23,
      stints55,
      overtakes23,
      overtakes55,
      carData23,
      carData55
    ] = await Promise.all([
      fetchJsonFile(`${DEMO_ROOT}/meta.json`),
      fetchJsonFile(`${DEMO_ROOT}/drivers.json`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/position_A.jsonl`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/position_B.jsonl`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/location_all.jsonl`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/pit_A.jsonl`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/pit_B.jsonl`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/team_radio.jsonl`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/race_control.jsonl`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/weather.jsonl`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/laps_A.jsonl`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/laps_B.jsonl`),
      fetchJsonlFile(`${DEMO_ROOT}/replay/intervals.jsonl`),
      fetchJsonFile(`${DEMO_ROOT}/replay/stints_23.json`),
      fetchJsonFile(`${DEMO_ROOT}/replay/stints_55.json`),
      fetchJsonFile(`${DEMO_ROOT}/replay/overtakes_23.json`),
      fetchJsonFile(`${DEMO_ROOT}/replay/overtakes_55.json`),
      fetchJsonFile(`${DEMO_ROOT}/replay/car_data_23.json`),
      fetchJsonFile(`${DEMO_ROOT}/replay/car_data_55.json`)
    ]);

    const session =
      metaJson && !Array.isArray(metaJson) && typeof metaJson.session === "object" && metaJson.session
        ? [metaJson.session as ReplayRow]
        : [];

    const rows: DemoPackRows = {
      sessions: withSessionKey(session),
      drivers: withSessionKey(Array.isArray(driversJson) ? driversJson : []),
      position: withSessionKey(mergeByDate(positionA, positionB)),
      location: withSessionKey(sortByDate(locationAll)),
      pit: withSessionKey(mergeByDate(pitA, pitB)),
      team_radio: withSessionKey(sortByDate(teamRadio)),
      race_control: withSessionKey(sortByDate(raceControl)),
      weather: withSessionKey(sortByDate(weather)),
      laps: withSessionKey(mergeByDate(lapsA, lapsB)),
      intervals: withSessionKey(sortByDate(intervals)),
      stints: withSessionKey(mergeByDate(asArrayRows(stints23), asArrayRows(stints55))),
      overtakes: withSessionKey(mergeByDate(asArrayRows(overtakes23), asArrayRows(overtakes55))),
      car_data: withSessionKey(mergeByDate(asArrayRows(carData23), asArrayRows(carData55)))
    };

    const dateIndex: Partial<Record<OpenF1Path, DateIndex>> = {};
    for (const path of OPENF1_ALLOWED_PATHS) {
      const index = createDateIndex(rows[path]);
      if (index) dateIndex[path] = index;
    }

    return { rows, dateIndex };
  })();

  return demoPackPromise;
}

export async function fetchOpenF1<T>(
  path: OpenF1Path,
  params: Record<string, QueryValue>,
  signal?: AbortSignal
): Promise<T[]> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const pack = await loadDemoPack();
  const index = pack.dateIndex[path];
  const dateGt = params["date>"];
  const dateLt = params["date<"];

  const source =
    index && (dateGt !== undefined || dateLt !== undefined)
      ? sliceByDateRange(index, dateGt, dateLt)
      : pack.rows[path] ?? [];

  return applyFilters(source, params) as T[];
}

export async function detectStreamStartIso(
  sessionKey: string,
  driverNumber: number,
  fallbackStartIso: string,
  fallbackEndIso?: string
): Promise<string> {
  const raceStartMs = parseIsoMs(fallbackStartIso);
  if (raceStartMs === null) return fallbackStartIso;

  let targetMs = raceStartMs - PRE_RACE_OFFSET_MS;
  const endMs = fallbackEndIso ? parseIsoMs(fallbackEndIso) : null;
  if (endMs !== null) targetMs = Math.min(targetMs, endMs);

  return new Date(targetMs).toISOString();
}
