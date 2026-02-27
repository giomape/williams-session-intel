import { DEMO_SESSION_KEY } from "@/lib/demoConfig";
import { carLabel, safeNumber, stableId, toIso } from "@/lib/format";
import { OpenF1ClientError, detectStreamStartIso, fetchOpenF1 } from "@/lib/openf1";
import { useSessionStore } from "@/lib/store";
import { sendQuizToAiriaAgent, sendToAiriaAgent } from "@/lib/airia";
import {
  CarSlot,
  OpenF1CarDataRow,
  OpenF1DriverRow,
  OpenF1IntervalRow,
  OpenF1LapRow,
  OpenF1LocationRow,
  OpenF1OvertakeRow,
  OpenF1PitRow,
  OpenF1PositionRow,
  OpenF1RaceControlRow,
  OpenF1SessionRow,
  OpenF1StintRow,
  OpenF1TeamRadioRow,
  OpenF1WeatherRow,
  RadioEvent,
  SessionDriver,
  SessionWindow,
  Snapshot,
  StreamEvent,
  TrackPoint,
  UserPreferences
} from "@/lib/types";

const PIT_EVENT_BUFFER_MS = 1200;
const MAX_REQS_PER_SEC = 24;
const BASE_COOLDOWN_MS = 1500;
const TRACK_OUTLINE_MAX_POINTS = 1400;
const RETIRE_LAP_DEFICIT_THRESHOLD = 2;
const RETIRE_STALE_MS = 140000;
const OTHER_CAR_STALE_MS = 45000;
const OTHER_CAR_STATIONARY_DISTANCE = 6;
const OTHER_CAR_STATIONARY_MS = 120000;
const PIT_RECAP_VISIBLE_MS = 5000;
const CAR_DATA_SYNC_TOLERANCE_MS = 12000;
const CAR_DATA_FUTURE_TOLERANCE_MS = 750;
const SAFETY_CAR_KEYWORD = "SAFETY CAR";
const VIRTUAL_SAFETY_CAR_KEYWORD = "VIRTUAL SAFETY CAR";
const RED_FLAG_KEYWORD = "RED FLAG";
const FORMATION_LAP_KEYWORD = "FORMATION LAP";
const KEY_RACE_CONTROL_INFO_KEYWORDS = [
  "RACE WILL RESUME",
  "SESSION WILL RESUME",
  "WILL RESUME",
  "DRIVE THROUGH",
  "STOP/GO",
  "PENALTY",
  "DISQUALIFIED",
  "BLACK FLAG",
  "TIME PENALTY"
];

type EndpointName =
  | "location"
  | "position"
  | "intervals"
  | "laps"
  | "overtakes"
  | "car_data"
  | "weather"
  | "pit"
  | "team_radio"
  | "race_control";

type Window = {
  fromIso: string;
  toIso: string;
};

type SessionWindowMs = {
  replayStartMs: number;
  replayStartIso: string;
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
};

type SelectedDrivers = {
  A: SessionDriver;
  B: SessionDriver;
};

type TyreCompound = Snapshot["cars"]["A"]["tyreCompound"];
type IntervalDirection = Snapshot["cars"]["A"]["intervalDirection"];

function isStreamConfigValid(prefs: UserPreferences): boolean {
  return prefs.sessionKey.trim().length > 0;
}

function sortedByDate<T extends { date?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const da = typeof a.date === "string" ? a.date : "";
    const db = typeof b.date === "string" ? b.date : "";
    return da.localeCompare(db);
  });
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso || !iso.trim().length) return null;
  const normalized = /[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function distance(a: TrackPoint, b: TrackPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function createHeartbeat(iso: string): StreamEvent {
  return {
    id: stableId(["heartbeat", iso]),
    type: "heartbeat",
    iso,
    importance: 0.1,
    message: "stream heartbeat"
  };
}

function rowDriverNumber(row: { driver_number?: number | string | null }): number | null {
  return safeNumber(row.driver_number);
}

function splitByDriver<T extends { driver_number?: number | string | null }>(
  rows: T[],
  driverA: number,
  driverB: number
): { A: T[]; B: T[] } {
  const A: T[] = [];
  const B: T[] = [];

  for (const row of rows) {
    const n = rowDriverNumber(row);
    if (n === driverA) A.push(row);
    if (n === driverB) B.push(row);
  }

  return { A, B };
}

function shortName(fullName: string, acronym?: string): string {
  if (typeof acronym === "string" && acronym.trim().length) return acronym.trim();
  const trimmed = fullName.trim();
  if (!trimmed) return "Unknown";
  const parts = trimmed.split(" ");
  return parts[parts.length - 1] ?? trimmed;
}

function clampMs(ms: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, ms));
}

function extractDriverNumbersFromMessage(message: string): number[] {
  const numbers = new Set<number>();

  const singleRegex = /\bCAR\s+(\d{1,3})\b/g;
  for (const match of message.matchAll(singleRegex)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n)) numbers.add(n);
  }

  const multiRegex = /\bCARS\s+([0-9,\sAND]+)/g;
  for (const match of message.matchAll(multiRegex)) {
    const chunk = match[1] ?? "";
    const values = chunk.match(/\d{1,3}/g) ?? [];
    values.forEach((value) => {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) numbers.add(n);
    });
  }

  return Array.from(numbers.values());
}

function isRetirementMessage(message: string): boolean {
  const text = message.toUpperCase();
  return (
    text.includes("RETIRED") ||
    text.includes("RETIRES") ||
    text.includes("OUT OF THE RACE") ||
    text.includes("WILL NOT RESTART") ||
    text.includes("STOPPED ON TRACK") ||
    text.includes("STOPPED AT TURN") ||
    text.includes("STOPPED IN TRACK") ||
    text.includes("DISQUALIFIED")
  );
}

function isSafetyCarMessage(message: string): boolean {
  const text = message.toUpperCase();
  return text.includes(SAFETY_CAR_KEYWORD) && !text.includes(VIRTUAL_SAFETY_CAR_KEYWORD);
}

function isRedFlagMessage(message: string): boolean {
  return message.toUpperCase().includes(RED_FLAG_KEYWORD);
}

function isAbortedStartMessage(message: string): boolean {
  const text = message.toUpperCase();
  return text.includes("ABORTED START") || text.includes("START ABORTED");
}

function stripControlPrefix(message: string): string {
  return message.replace(/^CONTROL UPDATE:\s*/i, "").trim();
}

function isFormationLapRestartMessage(message: string): boolean {
  const text = stripControlPrefix(message).toUpperCase();
  if (!text.includes(FORMATION_LAP_KEYWORD)) return false;
  return (
    text.includes("RESTART") ||
    text.includes("WILL RESTART") ||
    text.includes("ADDITIONAL FORMATION LAP") ||
    text.includes("NEW FORMATION LAP")
  );
}

function isKeyRaceControlInfoMessage(message: string): boolean {
  const text = stripControlPrefix(message).toUpperCase();
  return KEY_RACE_CONTROL_INFO_KEYWORDS.some((keyword) => text.includes(keyword));
}

class HistoricalAsLiveStreamEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedRealMs = 0;
  private startedDataMs = 0;
  private lastDataIso = "";
  private failureStreak = 0;
  private pitUntilMs: Record<CarSlot, number> = { A: 0, B: 0 };
  private lastPitMarkerBySlot: Record<CarSlot, string | null> = { A: null, B: null };
  private stintsByDriver = new Map<number, OpenF1StintRow[]>();
  private lastOvertakePositionByDriver = new Map<number, number>();
  private latestWeather: Snapshot["weather"] = {
    airTemperatureC: null,
    trackTemperatureC: null,
    humidityPct: null,
    rainfall: null
  };
  private latestPositionByDriver = new Map<number, number>();
  private latestGapByDriver = new Map<number, number>();
  private latestTelemetryMsByDriver = new Map<number, number>();
  private lastIntervalDirectionBySlot: Record<CarSlot, IntervalDirection> = {
    A: "UNKNOWN",
    B: "UNKNOWN"
  };
  private latestLapByDriver = new Map<number, number>();
  private latestLapProgressMsByDriver = new Map<number, number>();
  private currentLapNumber: number | null = null;
  private totalLaps: number | null = null;
  private retiredDriverNumbers = new Set<number>();
  private lastPitSummaryBySlot: Record<
    CarSlot,
    { laneDuration: number | null; stopDuration: number | null } | null
  > = {
    A: null,
    B: null
  };
  private otherCarMotionByDriver = new Map<
    number,
    { x: number; y: number; lastMovedMs: number; lastSeenMs: number }
  >();
  private running = false;
  private inFlight = false;
  private tickCount = 0;
  private cooldownUntilMs = 0;
  private requestHistoryMs: number[] = [];
  private playbackSpeed = 1;
  private driverAbbrByNumber = new Map<number, string>();
  private sessionWindow: SessionWindowMs | null = null;
  private selectedDrivers: SelectedDrivers | null = null;
  private lastFetchedTickByEndpoint: Record<EndpointName, number> = {
    location: -1,
    position: -1,
    intervals: -1,
    laps: -1,
    overtakes: -1,
    car_data: -1,
    weather: -1,
    pit: -1,
    team_radio: -1,
    race_control: -1
  };
  private lastFetchedAtMsByEndpoint: Record<EndpointName, number> = {
    location: -1,
    position: -1,
    intervals: -1,
    laps: -1,
    overtakes: -1,
    car_data: -1,
    weather: -1,
    pit: -1,
    team_radio: -1,
    race_control: -1
  };
  private lastWindowByEndpoint: Record<EndpointName, Window | null> = {
    location: null,
    position: null,
    intervals: null,
    laps: null,
    overtakes: null,
    car_data: null,
    weather: null,
    pit: null,
    team_radio: null,
    race_control: null
  };
  private bufferedCommentaryPackets = new Map<string, StreamEvent>();
  private commentaryDispatchQueue: Array<{
    packets: StreamEvent[];
    triggerEvent: StreamEvent;
  }> = [];
  private commentaryDispatchInFlight = false;
  private quizDispatchQueue: Array<{
    packets: StreamEvent[];
    triggerEvent: StreamEvent;
  }> = [];
  private quizDispatchInFlight = false;

  private resetRuntimeState(): void {
    this.failureStreak = 0;
    this.tickCount = 0;
    this.cooldownUntilMs = 0;
    this.requestHistoryMs = [];
    this.playbackSpeed = 1;
    this.driverAbbrByNumber = new Map<number, string>();
    this.pitUntilMs = { A: 0, B: 0 };
    this.lastPitMarkerBySlot = { A: null, B: null };
    this.stintsByDriver = new Map<number, OpenF1StintRow[]>();
    this.lastOvertakePositionByDriver = new Map<number, number>();
    this.latestWeather = {
      airTemperatureC: null,
      trackTemperatureC: null,
      humidityPct: null,
      rainfall: null
    };
    this.latestPositionByDriver = new Map<number, number>();
    this.latestGapByDriver = new Map<number, number>();
    this.latestTelemetryMsByDriver = new Map<number, number>();
    this.lastIntervalDirectionBySlot = { A: "UNKNOWN", B: "UNKNOWN" };
    this.latestLapByDriver = new Map<number, number>();
    this.latestLapProgressMsByDriver = new Map<number, number>();
    this.currentLapNumber = null;
    this.totalLaps = null;
    this.retiredDriverNumbers = new Set<number>();
    this.lastPitSummaryBySlot = { A: null, B: null };
    this.otherCarMotionByDriver = new Map();
    this.sessionWindow = null;
    this.selectedDrivers = null;
    this.lastFetchedTickByEndpoint = {
      location: -1,
      position: -1,
      intervals: -1,
      laps: -1,
      overtakes: -1,
      car_data: -1,
      weather: -1,
      pit: -1,
      team_radio: -1,
      race_control: -1
    };
    this.lastFetchedAtMsByEndpoint = {
      location: -1,
      position: -1,
      intervals: -1,
      laps: -1,
      overtakes: -1,
      car_data: -1,
      weather: -1,
      pit: -1,
      team_radio: -1,
      race_control: -1
    };
    this.lastWindowByEndpoint = {
      location: null,
      position: null,
      intervals: null,
      laps: null,
      overtakes: null,
      car_data: null,
      weather: null,
      pit: null,
      team_radio: null,
      race_control: null
    };
    this.bufferedCommentaryPackets = new Map();
    this.commentaryDispatchQueue = [];
    this.commentaryDispatchInFlight = false;
    this.quizDispatchQueue = [];
    this.quizDispatchInFlight = false;
  }

  private failStart(message: string): void {
    const store = useSessionStore.getState();
    this.running = false;
    store.setStreaming(false);
    store.setInvalidConfig(true);
    store.setDriverSelectionError(message);
  }

  async start(): Promise<void> {
    const store = useSessionStore.getState();
    const normalizedSessionKey = store.prefs.sessionKey.trim() || DEMO_SESSION_KEY;
    if (store.prefs.sessionKey !== normalizedSessionKey) {
      store.setPrefs({ sessionKey: normalizedSessionKey });
    }
    const prefs = { ...store.prefs, sessionKey: normalizedSessionKey };

    const valid = isStreamConfigValid(prefs);
    store.setInvalidConfig(!valid);
    store.setDriverSelectionError(valid ? null : "Session key is required.");
    if (!valid) return;

    this.stop();

    store.resetStreamData();
    store.setInvalidConfig(false);
    store.setDriverSelectionError(null);
    store.setStreaming(true);

    this.resetRuntimeState();
    store.setAiFallbackWarning(false);

    const sessionWindow = await this.fetchSessionWindow(prefs.sessionKey.trim());
    if (!sessionWindow) {
      this.failStart("Selected session is unavailable or missing timing.");
      return;
    }

    const selectedDrivers = await this.fetchWilliamsDrivers(prefs.sessionKey.trim());
    if (!selectedDrivers) {
      this.failStart("Could not find exactly two Williams drivers for this session.");
      return;
    }

    this.sessionWindow = sessionWindow;
    this.selectedDrivers = selectedDrivers;
    this.driverAbbrByNumber = await this.fetchDriverAbbreviations(prefs.sessionKey.trim());
    this.stintsByDriver = await this.fetchDriverStints(prefs.sessionKey.trim(), selectedDrivers);
    if (!this.driverAbbrByNumber.has(selectedDrivers.A.driverNumber)) {
      this.driverAbbrByNumber.set(
        selectedDrivers.A.driverNumber,
        selectedDrivers.A.shortName.slice(0, 3).toUpperCase()
      );
    }
    if (!this.driverAbbrByNumber.has(selectedDrivers.B.driverNumber)) {
      this.driverAbbrByNumber.set(
        selectedDrivers.B.driverNumber,
        selectedDrivers.B.shortName.slice(0, 3).toUpperCase()
      );
    }

    const trackOutline = await this.fetchTrackOutline(
      prefs.sessionKey.trim(),
      selectedDrivers.A.driverNumber
    );
    this.totalLaps = await this.fetchTotalLaps(prefs.sessionKey.trim());

    const startIso = await detectStreamStartIso(
      prefs.sessionKey.trim(),
      selectedDrivers.A.driverNumber,
      sessionWindow.startIso,
      sessionWindow.endIso
    );

    const detectedStartMs = parseIsoMs(startIso);
    const safeStartMs =
      detectedStartMs !== null
        ? clampMs(detectedStartMs, sessionWindow.replayStartMs, sessionWindow.endMs)
        : sessionWindow.replayStartMs;

    this.startedRealMs = Date.now();
    this.startedDataMs = safeStartMs;
    this.playbackSpeed = Math.max(0.1, prefs.speed || 1);
    this.lastDataIso = toIso(this.startedDataMs);
    this.running = true;

    const initialSnapshot = this.buildNextSnapshot(
      store.snapshot,
      prefs.sessionKey,
      this.lastDataIso,
      {
        startIso: sessionWindow.replayStartIso,
        endIso: sessionWindow.endIso
      },
      selectedDrivers,
      trackOutline
    );

    await this.hydrateInitialState(initialSnapshot, prefs.sessionKey, selectedDrivers, this.lastDataIso);

    store.applyTick({
      snapshot: initialSnapshot,
      events: [createHeartbeat(this.lastDataIso)],
      radios: [],
      dataDelayMode: false,
      failureStreak: 0
    });

    await this.tick();

    const pollMs = Math.max(250, prefs.pollMs || 1000);
    this.timer = setInterval(() => {
      void this.tick();
    }, pollMs);
  }

  stop(): void {
    this.running = false;
    this.inFlight = false;
    this.commentaryDispatchQueue = [];
    this.commentaryDispatchInFlight = false;
    this.quizDispatchQueue = [];
    this.quizDispatchInFlight = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sessionWindow = null;
    this.selectedDrivers = null;
    useSessionStore.getState().setStreaming(false);
  }

  private async fetchSessionWindow(sessionKey: string): Promise<SessionWindowMs | null> {
    try {
      const rows = await fetchOpenF1<OpenF1SessionRow>("sessions", {
        session_key: sessionKey
      });

      const validRows = rows
        .filter((row) => typeof row.date_start === "string" && typeof row.date_end === "string")
        .sort((a, b) => String(a.date_start).localeCompare(String(b.date_start)));

      const chosen = validRows[0];
      if (!chosen?.date_start || !chosen.date_end) return null;

      const startMs = parseIsoMs(chosen.date_start);
      const endMs = parseIsoMs(chosen.date_end);
      if (startMs === null || endMs === null || endMs <= startMs) {
        return null;
      }

      const replayStartMs = startMs - 5 * 60 * 1000;

      return {
        replayStartMs,
        replayStartIso: new Date(replayStartMs).toISOString(),
        startMs,
        endMs,
        startIso: chosen.date_start,
        endIso: chosen.date_end
      };
    } catch {
      return null;
    }
  }

  private async fetchWilliamsDrivers(sessionKey: string): Promise<SelectedDrivers | null> {
    try {
      const rows = await fetchOpenF1<OpenF1DriverRow>("drivers", {
        session_key: sessionKey
      });

      const williamsRows = rows.filter((row) => {
        const team = typeof row.team_name === "string" ? row.team_name.toLowerCase() : "";
        return team.includes("williams") && rowDriverNumber(row) !== null;
      });

      const unique = new Map<number, SessionDriver>();
      for (const row of williamsRows) {
        const n = rowDriverNumber(row);
        if (!n) continue;

        const fullName =
          typeof row.full_name === "string" && row.full_name.trim().length
            ? row.full_name.trim()
            : `Driver ${n}`;

        unique.set(n, {
          driverNumber: n,
          fullName,
          shortName: shortName(
            fullName,
            typeof row.name_acronym === "string" ? row.name_acronym : undefined
          ),
          teamName: typeof row.team_name === "string" ? row.team_name : "Williams"
        });
      }

      const drivers = Array.from(unique.values()).sort((a, b) => a.driverNumber - b.driverNumber);
      if (drivers.length !== 2) return null;

      return {
        A: drivers[0],
        B: drivers[1]
      };
    } catch {
      return null;
    }
  }

  private async fetchDriverAbbreviations(sessionKey: string): Promise<Map<number, string>> {
    try {
      const rows = await fetchOpenF1<OpenF1DriverRow>("drivers", {
        session_key: sessionKey
      });

      const map = new Map<number, string>();
      for (const row of rows) {
        const driverNumber = rowDriverNumber(row);
        if (driverNumber === null) continue;

        const acronymRaw =
          typeof row.name_acronym === "string" && row.name_acronym.trim().length
            ? row.name_acronym.trim()
            : shortName(typeof row.full_name === "string" ? row.full_name : `D${driverNumber}`);

        const acronym = acronymRaw.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4);
        map.set(driverNumber, acronym || String(driverNumber));
      }
      return map;
    } catch {
      return new Map<number, string>();
    }
  }

  private async fetchDriverStints(
    sessionKey: string,
    selectedDrivers: SelectedDrivers
  ): Promise<Map<number, OpenF1StintRow[]>> {
    try {
      const rows = await fetchOpenF1<OpenF1StintRow>("stints", {
        session_key: sessionKey
      });

      const byDriver = new Map<number, OpenF1StintRow[]>();
      const driverSet = new Set([
        selectedDrivers.A.driverNumber,
        selectedDrivers.B.driverNumber
      ]);

      for (const row of rows) {
        const driverNumber = rowDriverNumber(row);
        if (driverNumber === null || !driverSet.has(driverNumber)) continue;
        const current = byDriver.get(driverNumber) ?? [];
        current.push(row);
        byDriver.set(driverNumber, current);
      }

      for (const [driverNumber, driverRows] of byDriver.entries()) {
        byDriver.set(
          driverNumber,
          [...driverRows].sort((a, b) => {
            const startA = safeNumber(a.lap_start) ?? Number.POSITIVE_INFINITY;
            const startB = safeNumber(b.lap_start) ?? Number.POSITIVE_INFINITY;
            if (startA !== startB) return startA - startB;
            const stintA = safeNumber(a.stint_number) ?? Number.POSITIVE_INFINITY;
            const stintB = safeNumber(b.stint_number) ?? Number.POSITIVE_INFINITY;
            return stintA - stintB;
          })
        );
      }

      return byDriver;
    } catch {
      return new Map<number, OpenF1StintRow[]>();
    }
  }

  private mapCompound(raw: unknown): TyreCompound {
    const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (value.includes("SOFT")) return "SOFT";
    if (value.includes("HARD")) return "HARD";
    if (value.includes("INTER")) return "INTERMEDIATE";
    if (value.includes("WET")) return "WET";
    return "MEDIUM";
  }

  private normalizePct(value: unknown): number {
    const n = safeNumber(value);
    if (n === null) return 0;
    return Math.max(0, Math.min(100, n));
  }

  private pointsFromLocationRows(rows: OpenF1LocationRow[]): TrackPoint[] {
    return sortedByDate(rows)
      .map((row) => {
        const x = safeNumber(row.x);
        const y = safeNumber(row.y);
        const iso = typeof row.date === "string" ? row.date : null;
        if (x === null || y === null || iso === null) return null;
        if (x === 0 && y === 0) return null;
        return { iso, x, y };
      })
      .filter((point): point is TrackPoint => point !== null);
  }

  private dedupeByDistance(points: TrackPoint[], minDistance = 6): TrackPoint[] {
    if (points.length <= 1) return points;
    const out: TrackPoint[] = [points[0]];
    for (let i = 1; i < points.length; i += 1) {
      if (distance(out[out.length - 1], points[i]) >= minDistance) {
        out.push(points[i]);
      }
    }
    return out;
  }

  private smoothPath(points: TrackPoint[], radius = 2): TrackPoint[] {
    if (points.length <= radius * 2 + 1) return points;
    const smoothed: TrackPoint[] = [];
    for (let i = 0; i < points.length; i += 1) {
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(points.length - 1, i + radius); j += 1) {
        sumX += points[j].x;
        sumY += points[j].y;
        count += 1;
      }
      smoothed.push({
        iso: points[i].iso,
        x: sumX / count,
        y: sumY / count
      });
    }
    return smoothed;
  }

  private downsample(points: TrackPoint[], maxPoints: number): TrackPoint[] {
    if (points.length <= maxPoints) return points;
    const stride = Math.max(1, Math.floor(points.length / maxPoints));
    return points.filter((_, idx) => idx % stride === 0);
  }

  private closePath(points: TrackPoint[]): TrackPoint[] {
    if (points.length < 3) return points;
    const first = points[0];
    const last = points[points.length - 1];
    if (distance(first, last) < 3) return points;
    return [...points, { ...first }];
  }

  private extractSingleLap(points: TrackPoint[]): TrackPoint[] {
    if (points.length < 600) return points;

    const bounds = points.reduce(
      (acc, point) => ({
        minX: Math.min(acc.minX, point.x),
        maxX: Math.max(acc.maxX, point.x),
        minY: Math.min(acc.minY, point.y),
        maxY: Math.max(acc.maxY, point.y)
      }),
      {
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY
      }
    );

    const diag = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    const threshold = Math.max(18, diag * 0.03);

    const anchorIndex = Math.floor(points.length * 0.08);
    const anchor = points[anchorIndex];

    for (let i = anchorIndex + 350; i < points.length; i += 1) {
      if (distance(anchor, points[i]) <= threshold) {
        return points.slice(anchorIndex, i + 1);
      }
    }

    return points.slice(anchorIndex, Math.min(points.length, anchorIndex + 1800));
  }

  private finalizeTrack(points: TrackPoint[]): TrackPoint[] {
    if (points.length < 4) return points;
    const deduped = this.dedupeByDistance(points, 5);
    const smoothed = this.smoothPath(deduped, 2);
    const closed = this.closePath(smoothed);
    return this.downsample(closed, TRACK_OUTLINE_MAX_POINTS);
  }

  private async fetchTrackOutline(sessionKey: string, driverNumber: number): Promise<TrackPoint[]> {
    try {
      const lapRows = await fetchOpenF1<OpenF1LapRow>("laps", {
        session_key: sessionKey,
        driver_number: driverNumber
      });

      const lapCandidates = lapRows
        .filter((row) => {
          const lapDuration = safeNumber(row.lap_duration);
          return (
            typeof row.date_start === "string" &&
            lapDuration !== null &&
            lapDuration >= 70 &&
            lapDuration <= 170 &&
            row.is_pit_out_lap !== true
          );
        })
        .sort((a, b) => String(a.date_start).localeCompare(String(b.date_start)));

      if (lapCandidates.length) {
        const chosen = lapCandidates[Math.min(2, lapCandidates.length - 1)];
        const lapStartMs = parseIsoMs(chosen.date_start ?? null);
        const lapDuration = safeNumber(chosen.lap_duration);
        if (lapStartMs !== null && lapDuration !== null) {
          const lapEndIso = toIso(lapStartMs + lapDuration * 1000);
          const lapLocationRows = await fetchOpenF1<OpenF1LocationRow>("location", {
            session_key: sessionKey,
            driver_number: driverNumber,
            ["date>"]: chosen.date_start ?? "",
            ["date<"]: lapEndIso
          });
          const lapPoints = this.pointsFromLocationRows(lapLocationRows);
          if (lapPoints.length > 180) {
            return this.finalizeTrack(lapPoints);
          }
        }
      }

      const allRows = await fetchOpenF1<OpenF1LocationRow>("location", {
        session_key: sessionKey,
        driver_number: driverNumber
      });

      const allPoints = this.pointsFromLocationRows(allRows);
      const singleLap = this.extractSingleLap(allPoints);
      return this.finalizeTrack(singleLap);
    } catch {
      return [];
    }
  }

  private async fetchTotalLaps(sessionKey: string): Promise<number | null> {
    try {
      const rows = await fetchOpenF1<OpenF1LapRow>("laps", {
        session_key: sessionKey
      });
      const maxLap = rows.reduce((acc, row) => {
        const lap = safeNumber(row.lap_number);
        return lap !== null ? Math.max(acc, lap) : acc;
      }, 0);
      return maxLap > 0 ? maxLap : null;
    } catch {
      return null;
    }
  }

  private inferTyreCompound(slot: CarSlot, driverNumber: number, carLap: number | null): TyreCompound {
    const stints = this.stintsByDriver.get(driverNumber) ?? [];
    if (stints.length) {
      const knownLap = carLap ?? this.currentLapNumber;
      if (knownLap !== null) {
        const active =
          stints.find((row) => {
            const lapStart = safeNumber(row.lap_start);
            const lapEnd = safeNumber(row.lap_end);
            if (lapStart !== null && knownLap < lapStart) return false;
            if (lapEnd !== null && knownLap > lapEnd) return false;
            return true;
          }) ??
          [...stints]
            .reverse()
            .find((row) => {
              const lapStart = safeNumber(row.lap_start);
              return lapStart !== null && lapStart <= knownLap;
            }) ??
          stints[0];

        return this.mapCompound(active.compound);
      }

      return this.mapCompound(stints[0].compound);
    }

    return slot === "A" ? "MEDIUM" : "HARD";
  }

  private hydratePositionForCar(
    car: Snapshot["cars"]["A"],
    rows: OpenF1PositionRow[],
    nowDataIso: string
  ): void {
    const latest = sortedByDate(rows)[rows.length - 1];
    if (!latest) return;
    const position = safeNumber(latest.position);
    if (position === null) return;

    car.position = position;
    car.delta = null;
    car.updatedIso = typeof latest.date === "string" ? latest.date : nowDataIso;
  }

  private applyWeatherRows(rows: OpenF1WeatherRow[]): void {
    if (!rows.length) return;
    const latest = sortedByDate(rows)[rows.length - 1];
    const rainfall = safeNumber(latest?.rainfall);
    const airTemperatureC = safeNumber(latest?.air_temperature);
    const trackTemperatureC = safeNumber(latest?.track_temperature);
    const humidityPct = safeNumber(latest?.humidity);

    this.latestWeather = {
      airTemperatureC: airTemperatureC ?? this.latestWeather.airTemperatureC,
      trackTemperatureC: trackTemperatureC ?? this.latestWeather.trackTemperatureC,
      humidityPct: humidityPct ?? this.latestWeather.humidityPct,
      rainfall: rainfall ?? this.latestWeather.rainfall
    };
  }

  private refreshPositionCache(rows: OpenF1PositionRow[]): void {
    for (const row of sortedByDate(rows)) {
      const driverNumber = rowDriverNumber(row);
      const position = safeNumber(row.position);
      if (driverNumber === null || position === null) continue;
      this.latestPositionByDriver.set(driverNumber, position);

      const rowMs = parseIsoMs(typeof row.date === "string" ? row.date : null);
      if (rowMs !== null) {
        this.latestTelemetryMsByDriver.set(driverNumber, rowMs);
      }
    }
  }

  private refreshLapCache(rows: OpenF1LapRow[], nowDataIso: string): void {
    for (const row of sortedByDate(rows)) {
      const lap = safeNumber(row.lap_number);
      if (lap === null) continue;

      const driverNumber = rowDriverNumber(row);
      if (driverNumber !== null) {
        this.latestLapByDriver.set(driverNumber, lap);
        const progressIso =
          (typeof row.date_start === "string" && row.date_start) ||
          (typeof row.date === "string" && row.date) ||
          nowDataIso;
        const progressMs = parseIsoMs(progressIso);
        if (progressMs !== null) {
          this.latestLapProgressMsByDriver.set(driverNumber, progressMs);
        }
      }
      this.currentLapNumber =
        this.currentLapNumber === null ? lap : Math.max(this.currentLapNumber, lap);
      this.totalLaps = this.totalLaps === null ? lap : Math.max(this.totalLaps, lap);
    }
  }

  private updateRaceControlState(rows: OpenF1RaceControlRow[]): void {
    for (const row of sortedByDate(rows)) {
      const lap = safeNumber(row.lap_number);
      if (lap !== null) {
        this.currentLapNumber =
          this.currentLapNumber === null ? lap : Math.max(this.currentLapNumber, lap);
        this.totalLaps = this.totalLaps === null ? lap : Math.max(this.totalLaps, lap);
      }

      const rawMessage =
        typeof row.message === "string" && row.message.trim().length
          ? row.message.trim()
          : [row.category, row.flag, row.scope]
              .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
              .join(" / ");

      if (!rawMessage || !isRetirementMessage(rawMessage)) continue;

      const retired = new Set<number>();
      const directDriverNumber = rowDriverNumber(row);
      if (directDriverNumber !== null) retired.add(directDriverNumber);
      extractDriverNumbersFromMessage(rawMessage).forEach((n) => retired.add(n));
      retired.forEach((n) => this.retiredDriverNumbers.add(n));
    }
  }

  private syncLapSnapshot(snapshot: Snapshot, selectedDrivers: SelectedDrivers): void {
    const lapCandidates = [
      this.currentLapNumber,
      this.latestLapByDriver.get(selectedDrivers.A.driverNumber) ?? null,
      this.latestLapByDriver.get(selectedDrivers.B.driverNumber) ?? null
    ].filter((value): value is number => value !== null && Number.isFinite(value));

    snapshot.lapNumber = lapCandidates.length ? Math.max(...lapCandidates) : snapshot.lapNumber;
    snapshot.totalLaps = this.totalLaps ?? snapshot.totalLaps;
  }

  private isOutByLapStaleness(driverNumber: number, nowDataMs: number): boolean {
    const driverLap = this.latestLapByDriver.get(driverNumber);
    const raceLap = this.currentLapNumber;
    if (driverLap === undefined || raceLap === null) return false;
    if (raceLap - driverLap < RETIRE_LAP_DEFICIT_THRESHOLD) return false;

    const lastProgressMs = this.latestLapProgressMsByDriver.get(driverNumber);
    if (lastProgressMs === undefined) return false;
    if (nowDataMs - lastProgressMs < RETIRE_STALE_MS) return false;

    return true;
  }

  private isOutByTelemetryStaleness(driverNumber: number, nowDataMs: number): boolean {
    const lastTelemetryMs = this.latestTelemetryMsByDriver.get(driverNumber);
    if (lastTelemetryMs === undefined) return false;
    return nowDataMs - lastTelemetryMs > RETIRE_STALE_MS;
  }

  private isOtherCarInactive(driverNumber: number, nowDataMs: number): boolean {
    if (this.retiredDriverNumbers.has(driverNumber)) return true;

    const raceLap = this.currentLapNumber;
    const driverLap = this.latestLapByDriver.get(driverNumber);
    if (raceLap !== null && driverLap !== undefined && raceLap - driverLap >= 1) {
      const lastProgressMs = this.latestLapProgressMsByDriver.get(driverNumber) ?? 0;
      if (nowDataMs - lastProgressMs > 120000) return true;
    }

    const lastTelemetryMs = this.latestTelemetryMsByDriver.get(driverNumber);
    if (lastTelemetryMs !== undefined && nowDataMs - lastTelemetryMs > 120000) {
      return true;
    }

    const motion = this.otherCarMotionByDriver.get(driverNumber);
    if (motion && nowDataMs - motion.lastMovedMs > OTHER_CAR_STATIONARY_MS) {
      return true;
    }

    return false;
  }

  private applyRaceControlRows(
    rows: OpenF1RaceControlRow[],
    nowDataIso: string,
    events: StreamEvent[]
  ): void {
    const sorted = sortedByDate(rows);

    sorted.forEach((row) => {
      const iso = typeof row.date === "string" ? row.date : nowDataIso;
      const rawMessage =
        typeof row.message === "string" && row.message.trim().length
          ? row.message.trim()
          : [row.category, row.flag, row.scope]
              .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
              .join(" / ") || "control update";

      events.push({
        id: stableId(["rc", iso, rawMessage]),
        type: "race_control",
        iso,
        importance: 0.88,
        message: `Control update: ${rawMessage}`,
        raw: row
      });
    });
  }

  private pickClosestInterval(
    driverNumber: number
  ): {
    value: number | null;
    direction: "AHEAD" | "BEHIND" | "UNKNOWN";
    aheadGap: number | null;
    behindGap: number | null;
  } {
    const selfPosition = this.latestPositionByDriver.get(driverNumber);
    const selfGap = this.latestGapByDriver.get(driverNumber);
    if (selfPosition === undefined || selfGap === undefined) {
      return { value: null, direction: "UNKNOWN", aheadGap: null, behindGap: null };
    }

    let aheadGap: number | null = null;
    let behindGap: number | null = null;

    for (const [otherDriver, position] of this.latestPositionByDriver.entries()) {
      const gap = this.latestGapByDriver.get(otherDriver);
      if (gap === undefined) continue;
      if (position === selfPosition - 1) {
        const delta = selfGap - gap;
        if (delta > 0) aheadGap = delta;
      }
      if (position === selfPosition + 1) {
        const delta = gap - selfGap;
        if (delta > 0) behindGap = delta;
      }
    }

    if (aheadGap === null && behindGap === null) {
      return { value: null, direction: "UNKNOWN", aheadGap, behindGap };
    }

    if (aheadGap !== null && behindGap !== null) {
      if (aheadGap <= behindGap) {
        return { value: aheadGap, direction: "AHEAD", aheadGap, behindGap };
      }
      return { value: behindGap, direction: "BEHIND", aheadGap, behindGap };
    }

    if (aheadGap !== null) return { value: aheadGap, direction: "AHEAD", aheadGap, behindGap };
    return { value: behindGap, direction: "BEHIND", aheadGap, behindGap };
  }

  private applyIntervalRows(
    snapshot: Snapshot,
    rows: OpenF1IntervalRow[],
    selectedDrivers: SelectedDrivers,
    nowDataIso: string
  ): void {
    const sortedRows = rows.length ? sortedByDate(rows) : [];
    if (rows.length) {
      const latestByDriver = new Map<number, OpenF1IntervalRow>();
      for (const row of sortedRows) {
        const driverNumber = rowDriverNumber(row);
        const gap = safeNumber(row.gap_to_leader);
        const rowIso = typeof row.date === "string" ? row.date : nowDataIso;
        const rowMs = parseIsoMs(rowIso);
        if (driverNumber === null) continue;
        latestByDriver.set(driverNumber, row);
        if (rowMs !== null) {
          this.latestTelemetryMsByDriver.set(driverNumber, rowMs);
        }
        if (gap !== null) {
          this.latestGapByDriver.set(driverNumber, gap);
        }
      }

      const latestA = latestByDriver.get(selectedDrivers.A.driverNumber);
      const latestB = latestByDriver.get(selectedDrivers.B.driverNumber);

      if (latestA) {
        const gap = safeNumber(latestA.gap_to_leader);
        if (gap !== null) {
          snapshot.cars.A.gapToLeader = gap;
          snapshot.cars.A.updatedIso =
            typeof latestA.date === "string" ? latestA.date : snapshot.cars.A.updatedIso ?? nowDataIso;
        }
      }

      if (latestB) {
        const gap = safeNumber(latestB.gap_to_leader);
        if (gap !== null) {
          snapshot.cars.B.gapToLeader = gap;
          snapshot.cars.B.updatedIso =
            typeof latestB.date === "string" ? latestB.date : snapshot.cars.B.updatedIso ?? nowDataIso;
        }
      }
    }

    const intervalA = this.pickClosestInterval(selectedDrivers.A.driverNumber);
    const intervalB = this.pickClosestInterval(selectedDrivers.B.driverNumber);
    const latestAOwnInterval = safeNumber(
      sortedRows.filter((row) => rowDriverNumber(row) === selectedDrivers.A.driverNumber).slice(-1)[0]?.interval
    );
    const latestBOwnInterval = safeNumber(
      sortedRows.filter((row) => rowDriverNumber(row) === selectedDrivers.B.driverNumber).slice(-1)[0]?.interval
    );

    const resolveForSlot = (
      slot: CarSlot,
      current: {
        value: number | null;
        direction: IntervalDirection;
        aheadGap: number | null;
        behindGap: number | null;
      },
      ownInterval: number | null
    ): { value: number | null; direction: IntervalDirection } => {
      const previousDirection = this.lastIntervalDirectionBySlot[slot];
      const previousValue = snapshot.cars[slot].intervalToMate;

      if (current.aheadGap !== null && current.behindGap !== null && previousDirection !== "UNKNOWN") {
        const ahead = current.aheadGap;
        const behind = current.behindGap;
        const delta = Math.abs(ahead - behind);
        if (delta < 0.35) {
          if (previousDirection === "AHEAD") return { value: ahead, direction: "AHEAD" };
          if (previousDirection === "BEHIND") return { value: behind, direction: "BEHIND" };
        }
      }

      if (current.value !== null && current.direction !== "UNKNOWN") {
        return { value: current.value, direction: current.direction };
      }

      if (ownInterval !== null) {
        const fallbackDirection = previousDirection !== "UNKNOWN" ? previousDirection : "AHEAD";
        return { value: ownInterval, direction: fallbackDirection };
      }

      if (previousValue !== null) {
        const fallbackDirection = previousDirection !== "UNKNOWN" ? previousDirection : "AHEAD";
        return { value: previousValue, direction: fallbackDirection };
      }

      return { value: null, direction: "UNKNOWN" };
    };

    const resolvedA = resolveForSlot("A", intervalA, latestAOwnInterval);
    const resolvedB = resolveForSlot("B", intervalB, latestBOwnInterval);

    if (resolvedA.value !== null) {
      snapshot.cars.A.intervalToMate = resolvedA.value;
      snapshot.cars.A.intervalDirection = resolvedA.direction;
      this.lastIntervalDirectionBySlot.A = resolvedA.direction;
    } else {
      snapshot.cars.A.intervalDirection = "UNKNOWN";
    }

    if (resolvedB.value !== null) {
      snapshot.cars.B.intervalToMate = resolvedB.value;
      snapshot.cars.B.intervalDirection = resolvedB.direction;
      this.lastIntervalDirectionBySlot.B = resolvedB.direction;
    } else {
      snapshot.cars.B.intervalDirection = "UNKNOWN";
    }
  }

  private async hydrateInitialState(
    snapshot: Snapshot,
    sessionKey: string,
    selectedDrivers: SelectedDrivers,
    nowDataIso: string
  ): Promise<void> {
    try {
      const [beforePositions, beforeIntervals, beforeWeather, beforeLaps, beforeRaceControl] =
        await Promise.all([
        fetchOpenF1<OpenF1PositionRow>("position", {
          session_key: sessionKey,
          ["date<"]: nowDataIso
        }),
        fetchOpenF1<OpenF1IntervalRow>("intervals", {
          session_key: sessionKey,
          ["date<"]: nowDataIso
        }),
        fetchOpenF1<OpenF1WeatherRow>("weather", {
          session_key: sessionKey,
          ["date<"]: nowDataIso
        }),
        fetchOpenF1<OpenF1LapRow>("laps", {
          session_key: sessionKey,
          ["date<"]: nowDataIso
        }),
        fetchOpenF1<OpenF1RaceControlRow>("race_control", {
          session_key: sessionKey,
          ["date<"]: nowDataIso
        })
        ]);

      const beforePositionByDriver = splitByDriver(
        beforePositions,
        selectedDrivers.A.driverNumber,
        selectedDrivers.B.driverNumber
      );
      this.refreshPositionCache(beforePositions);

      this.hydratePositionForCar(snapshot.cars.A, beforePositionByDriver.A, nowDataIso);
      this.hydratePositionForCar(snapshot.cars.B, beforePositionByDriver.B, nowDataIso);

      this.applyIntervalRows(snapshot, beforeIntervals, selectedDrivers, nowDataIso);
      this.applyWeatherRows(beforeWeather);
      this.refreshLapCache(beforeLaps, nowDataIso);
      this.updateRaceControlState(beforeRaceControl);

      if (snapshot.cars.A.position === null || snapshot.cars.B.position === null) {
        const forwardPositions = await fetchOpenF1<OpenF1PositionRow>("position", {
          session_key: sessionKey,
          ["date>"]: nowDataIso
        });
        this.refreshPositionCache(forwardPositions);
        const forwardPositionByDriver = splitByDriver(
          forwardPositions,
          selectedDrivers.A.driverNumber,
          selectedDrivers.B.driverNumber
        );

        if (snapshot.cars.A.position === null && forwardPositionByDriver.A.length) {
          this.hydratePositionForCar(
            snapshot.cars.A,
            [sortedByDate(forwardPositionByDriver.A)[0]],
            nowDataIso
          );
        }
        if (snapshot.cars.B.position === null && forwardPositionByDriver.B.length) {
          this.hydratePositionForCar(
            snapshot.cars.B,
            [sortedByDate(forwardPositionByDriver.B)[0]],
            nowDataIso
          );
        }
      }

      if (snapshot.cars.A.gapToLeader === null || snapshot.cars.B.gapToLeader === null) {
        const forwardIntervals = await fetchOpenF1<OpenF1IntervalRow>("intervals", {
          session_key: sessionKey,
          ["date>"]: nowDataIso
        });
        const firstIntervals = sortedByDate(forwardIntervals).slice(0, 200);
        this.applyIntervalRows(snapshot, firstIntervals, selectedDrivers, nowDataIso);
      }
    } catch {
      // Keep stream alive even if initial hydration is partial.
    }

    snapshot.weather = { ...this.latestWeather };
    snapshot.cars.A.tyreCompound = this.inferTyreCompound(
      "A",
      selectedDrivers.A.driverNumber,
      this.latestLapByDriver.get(selectedDrivers.A.driverNumber) ?? snapshot.lapNumber
    );
    snapshot.cars.B.tyreCompound = this.inferTyreCompound(
      "B",
      selectedDrivers.B.driverNumber,
      this.latestLapByDriver.get(selectedDrivers.B.driverNumber) ?? snapshot.lapNumber
    );
    const nowDataMs = parseIsoMs(nowDataIso) ?? Date.now();
    snapshot.cars.A.state =
      this.retiredDriverNumbers.has(selectedDrivers.A.driverNumber) ||
      this.isOutByLapStaleness(selectedDrivers.A.driverNumber, nowDataMs) ||
      this.isOutByTelemetryStaleness(selectedDrivers.A.driverNumber, nowDataMs)
        ? "OUT"
        : snapshot.cars.A.pit
          ? "PIT"
          : "ON TRACK";
    snapshot.cars.B.state =
      this.retiredDriverNumbers.has(selectedDrivers.B.driverNumber) ||
      this.isOutByLapStaleness(selectedDrivers.B.driverNumber, nowDataMs) ||
      this.isOutByTelemetryStaleness(selectedDrivers.B.driverNumber, nowDataMs)
        ? "OUT"
        : snapshot.cars.B.pit
          ? "PIT"
          : "ON TRACK";
    this.syncLapSnapshot(snapshot, selectedDrivers);
    if (snapshot.cars.A.position !== null) {
      this.lastOvertakePositionByDriver.set(selectedDrivers.A.driverNumber, snapshot.cars.A.position);
    }
    if (snapshot.cars.B.position !== null) {
      this.lastOvertakePositionByDriver.set(selectedDrivers.B.driverNumber, snapshot.cars.B.position);
    }
  }

  private pruneRequestHistory(nowMs: number): void {
    this.requestHistoryMs = this.requestHistoryMs.filter((t) => nowMs - t < 1000);
  }

  private remainingBudget(nowMs: number): number {
    this.pruneRequestHistory(nowMs);
    return Math.max(0, MAX_REQS_PER_SEC - this.requestHistoryMs.length);
  }

  private markRequest(nowMs: number): void {
    this.requestHistoryMs.push(nowMs);
    this.pruneRequestHistory(nowMs);
  }

  private endpointIntervalMs(endpoint: EndpointName, pollMs: number): number {
    return Math.max(250, pollMs);
  }

  private endpointTickStep(endpoint: EndpointName): number {
    if (endpoint === "weather" || endpoint === "overtakes") return 2;
    return 1;
  }

  private shouldPollEndpoint(endpoint: EndpointName, nowMs: number, pollMs: number): boolean {
    const step = this.endpointTickStep(endpoint);
    if (this.tickCount % step !== 0) return false;

    const lastTick = this.lastFetchedTickByEndpoint[endpoint];
    if (lastTick >= 0 && this.tickCount - lastTick < step) return false;

    const lastMs = this.lastFetchedAtMsByEndpoint[endpoint];
    if (lastMs < 0) return true;

    return nowMs - lastMs >= this.endpointIntervalMs(endpoint, pollMs);
  }

  private windowUnchanged(endpoint: EndpointName, window: Window): boolean {
    const previous = this.lastWindowByEndpoint[endpoint];
    if (!previous) return false;
    return previous.fromIso === window.fromIso && previous.toIso === window.toIso;
  }

  private async fetchEndpointRows(
    endpoint: EndpointName,
    params: Record<string, string | number>
  ): Promise<{
    endpoint: EndpointName;
    rows:
      | OpenF1LocationRow[]
      | OpenF1PositionRow[]
      | OpenF1IntervalRow[]
      | OpenF1LapRow[]
      | OpenF1OvertakeRow[]
      | OpenF1CarDataRow[]
      | OpenF1WeatherRow[]
      | OpenF1PitRow[]
      | OpenF1TeamRadioRow[]
      | OpenF1RaceControlRow[];
    failed: boolean;
    throttled: boolean;
  }> {
    try {
      if (endpoint === "location") {
        const rows = await fetchOpenF1<OpenF1LocationRow>("location", params);
        return { endpoint, rows, failed: false, throttled: false };
      }
      if (endpoint === "position") {
        const rows = await fetchOpenF1<OpenF1PositionRow>("position", params);
        return { endpoint, rows, failed: false, throttled: false };
      }
      if (endpoint === "intervals") {
        const rows = await fetchOpenF1<OpenF1IntervalRow>("intervals", params);
        return { endpoint, rows, failed: false, throttled: false };
      }
      if (endpoint === "laps") {
        const rows = await fetchOpenF1<OpenF1LapRow>("laps", params);
        return { endpoint, rows, failed: false, throttled: false };
      }
      if (endpoint === "overtakes") {
        const rows = await fetchOpenF1<OpenF1OvertakeRow>("overtakes", params);
        return { endpoint, rows, failed: false, throttled: false };
      }
      if (endpoint === "car_data") {
        const rows = await fetchOpenF1<OpenF1CarDataRow>("car_data", params);
        return { endpoint, rows, failed: false, throttled: false };
      }
      if (endpoint === "weather") {
        const rows = await fetchOpenF1<OpenF1WeatherRow>("weather", params);
        return { endpoint, rows, failed: false, throttled: false };
      }
      if (endpoint === "pit") {
        const rows = await fetchOpenF1<OpenF1PitRow>("pit", params);
        return { endpoint, rows, failed: false, throttled: false };
      }
      if (endpoint === "team_radio") {
        const rows = await fetchOpenF1<OpenF1TeamRadioRow>("team_radio", params);
        return { endpoint, rows, failed: false, throttled: false };
      }

      const rows = await fetchOpenF1<OpenF1RaceControlRow>("race_control", params);
      return { endpoint, rows, failed: false, throttled: false };
    } catch (error) {
      if (error instanceof OpenF1ClientError && error.status === 429) {
        const retryAfterMs =
          typeof error.retryAfterSec === "number" ? Math.max(0, error.retryAfterSec * 1000) : 0;
        this.cooldownUntilMs = Date.now() + Math.max(BASE_COOLDOWN_MS, retryAfterMs);
        return { endpoint, rows: [], failed: true, throttled: true };
      }
      return { endpoint, rows: [], failed: true, throttled: false };
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;

    this.inFlight = true;

    try {
      const state = useSessionStore.getState();
      const { prefs } = state;
      const previousSnapshot = state.snapshot;
      const selectedDrivers = this.selectedDrivers;
      const sessionWindow = this.sessionWindow;
      if (!selectedDrivers || !sessionWindow) return;

      this.tickCount += 1;

      const nowRealMs = Date.now();
      const requestedSpeed = Math.max(0.1, prefs.speed || 1);
      if (requestedSpeed !== this.playbackSpeed) {
        const anchoredDataMs = this.startedDataMs + (nowRealMs - this.startedRealMs) * this.playbackSpeed;
        this.startedDataMs = anchoredDataMs;
        this.startedRealMs = nowRealMs;
        this.playbackSpeed = requestedSpeed;
      }

      const rawNowDataMs = this.startedDataMs + (nowRealMs - this.startedRealMs) * this.playbackSpeed;
      const nowDataMs = clampMs(rawNowDataMs, sessionWindow.replayStartMs, sessionWindow.endMs);
      const nowDataIso = toIso(nowDataMs);
      const fromIso = this.lastDataIso;
      this.lastDataIso = nowDataIso;

      const snapshot = this.buildNextSnapshot(
        previousSnapshot,
        prefs.sessionKey,
        nowDataIso,
        {
          startIso: sessionWindow.replayStartIso,
          endIso: sessionWindow.endIso
        },
        selectedDrivers
      );

      const events: StreamEvent[] = [];
      const radios: RadioEvent[] = [];

      const cooldownActive = nowRealMs < this.cooldownUntilMs;
      const orderedEndpoints: EndpointName[] = [
        "location",
        "position",
        "intervals",
        "laps",
        "overtakes",
        "car_data",
        "weather",
        "race_control",
        "team_radio",
        "pit"
      ];

      const endpointResults: Partial<
        Record<EndpointName, Awaited<ReturnType<HistoricalAsLiveStreamEngine["fetchEndpointRows"]>>>
      > = {};

      let budget = this.remainingBudget(nowRealMs);
      const pollMs = Math.max(250, prefs.pollMs || 1000);

      for (const endpoint of orderedEndpoints) {
        if (budget <= 0) break;
        if (cooldownActive && endpoint !== "location" && endpoint !== "position") continue;
        if (!this.shouldPollEndpoint(endpoint, nowRealMs, pollMs)) continue;

        const previousWindow = this.lastWindowByEndpoint[endpoint];
        const window = {
          fromIso: previousWindow?.toIso ?? fromIso,
          toIso: nowDataIso
        };
        if (window.fromIso === window.toIso) continue;
        if (this.windowUnchanged(endpoint, window)) continue;

        const params: Record<string, string | number> = {
          session_key: prefs.sessionKey,
          ["date>"]: window.fromIso,
          ["date<"]: nowDataIso
        };

        this.markRequest(Date.now());
        budget -= 1;

        const result = await this.fetchEndpointRows(endpoint, params);
        endpointResults[endpoint] = result;
        this.lastWindowByEndpoint[endpoint] = window;
        this.lastFetchedTickByEndpoint[endpoint] = this.tickCount;
        this.lastFetchedAtMsByEndpoint[endpoint] = Date.now();

        if (result.throttled) break;
      }

      let endpointFailures = 0;
      let throttled = false;
      let requestedEndpoints = 0;

      for (const endpoint of orderedEndpoints) {
        const result = endpointResults[endpoint];
        if (!result) continue;
        requestedEndpoints += 1;
        if (result.failed) {
          endpointFailures += 1;
          throttled = throttled || result.throttled;
        }
      }

      const locationRows = (endpointResults.location?.rows ?? []) as OpenF1LocationRow[];
      const positionRows = (endpointResults.position?.rows ?? []) as OpenF1PositionRow[];
      const intervalRows = (endpointResults.intervals?.rows ?? []) as OpenF1IntervalRow[];
      const lapRows = (endpointResults.laps?.rows ?? []) as OpenF1LapRow[];
      const overtakeRows = (endpointResults.overtakes?.rows ?? []) as OpenF1OvertakeRow[];
      const carDataRows = (endpointResults.car_data?.rows ?? []) as OpenF1CarDataRow[];
      const weatherRows = (endpointResults.weather?.rows ?? []) as OpenF1WeatherRow[];
      const pitRows = (endpointResults.pit?.rows ?? []) as OpenF1PitRow[];
      const radioRows = (endpointResults.team_radio?.rows ?? []) as OpenF1TeamRadioRow[];
      const raceControlRows = (endpointResults.race_control?.rows ?? []) as OpenF1RaceControlRow[];
      this.updateRaceControlState(raceControlRows);

      this.refreshPositionCache(positionRows);

      const locationByDriver = splitByDriver(
        locationRows,
        selectedDrivers.A.driverNumber,
        selectedDrivers.B.driverNumber
      );
      const positionByDriver = splitByDriver(
        positionRows,
        selectedDrivers.A.driverNumber,
        selectedDrivers.B.driverNumber
      );
      const pitByDriver = splitByDriver(pitRows, selectedDrivers.A.driverNumber, selectedDrivers.B.driverNumber);
      const radioByDriver = splitByDriver(
        radioRows,
        selectedDrivers.A.driverNumber,
        selectedDrivers.B.driverNumber
      );

      this.applyDriverData("A", selectedDrivers.A.driverNumber, snapshot, {
        positions: positionByDriver.A,
        locations: locationByDriver.A,
        pitRows: pitByDriver.A,
        radioRows: radioByDriver.A,
        nowDataMs,
        nowDataIso,
        events,
        radios
      });

      this.applyDriverData("B", selectedDrivers.B.driverNumber, snapshot, {
        positions: positionByDriver.B,
        locations: locationByDriver.B,
        pitRows: pitByDriver.B,
        radioRows: radioByDriver.B,
        nowDataMs,
        nowDataIso,
        events,
        radios
      });

      this.applyIntervalRows(snapshot, intervalRows, selectedDrivers, nowDataIso);
      this.refreshLapCache(lapRows, nowDataIso);
      this.applyCarDataRows(snapshot, carDataRows, selectedDrivers, nowDataIso);
      this.applyWeatherRows(weatherRows);
      this.applyOvertakeRows(events, overtakeRows, selectedDrivers, nowDataIso);

      snapshot.weather = { ...this.latestWeather };
      snapshot.cars.A.tyreCompound = this.inferTyreCompound(
        "A",
        selectedDrivers.A.driverNumber,
        this.latestLapByDriver.get(selectedDrivers.A.driverNumber) ?? snapshot.lapNumber
      );
      snapshot.cars.B.tyreCompound = this.inferTyreCompound(
        "B",
        selectedDrivers.B.driverNumber,
        this.latestLapByDriver.get(selectedDrivers.B.driverNumber) ?? snapshot.lapNumber
      );

      this.applyOtherCarsData(snapshot, locationRows, selectedDrivers, nowDataIso);
      this.applyRaceControlRows(raceControlRows, nowDataIso, events);
      this.syncLapSnapshot(snapshot, selectedDrivers);
      this.appendWilliamsOutTransitionEvents(previousSnapshot, snapshot, events, nowDataIso);

      if (snapshot.cars.A.position !== null) {
        this.lastOvertakePositionByDriver.set(selectedDrivers.A.driverNumber, snapshot.cars.A.position);
      }
      if (snapshot.cars.B.position !== null) {
        this.lastOvertakePositionByDriver.set(selectedDrivers.B.driverNumber, snapshot.cars.B.position);
      }

      events.push(createHeartbeat(nowDataIso));

      if (endpointFailures > 0) {
        this.failureStreak += endpointFailures;
      } else if (requestedEndpoints > 0) {
        this.failureStreak = Math.max(0, this.failureStreak - 1);
      }

      const dataDelayMode = throttled || this.failureStreak >= 2 || Date.now() < this.cooldownUntilMs;

      const existingEventIds = new Set(useSessionStore.getState().events.map((event) => event.id));
      const newPackets = events.filter(
        (event) => event.type !== "heartbeat" && !existingEventIds.has(event.id)
      );
      this.bufferCommentaryPackets(newPackets);

      useSessionStore.getState().applyTick({
        snapshot,
        events,
        radios,
        dataDelayMode,
        failureStreak: this.failureStreak
      });

      const triggerEvent = this.selectCommentaryTriggerEvent(newPackets, selectedDrivers);
      if (triggerEvent && this.bufferedCommentaryPackets.size > 0) {
        const packetBatch = this.drainCommentaryPackets();
        this.enqueueCommentaryBatch(packetBatch, triggerEvent);
        this.enqueueQuizBatch(packetBatch, triggerEvent);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private buildNextSnapshot(
    previous: Snapshot,
    sessionKey: string,
    nowDataIso: string,
    sessionWindow: SessionWindow,
    drivers: SelectedDrivers,
    trackOutline?: TrackPoint[]
  ): Snapshot {
    return {
      sessionKey,
      nowDataIso,
      sessionWindow,
      lapNumber: previous.lapNumber,
      totalLaps: previous.totalLaps,
      weather: { ...previous.weather },
      trackOutline: trackOutline ?? previous.trackOutline,
      cars: {
        A: {
          ...previous.cars.A,
          slot: "A",
          driverNumber: drivers.A.driverNumber,
          driverName: drivers.A.fullName,
          trail: [...previous.cars.A.trail]
        },
        B: {
          ...previous.cars.B,
          slot: "B",
          driverNumber: drivers.B.driverNumber,
          driverName: drivers.B.fullName,
          trail: [...previous.cars.B.trail]
        }
      },
      otherCars: previous.otherCars.map((car) => ({ ...car }))
    };
  }

  private applyCarDataRows(
    snapshot: Snapshot,
    rows: OpenF1CarDataRow[],
    selectedDrivers: SelectedDrivers,
    nowDataIso: string
  ): void {
    if (!rows.length) return;

    const rowsByDriver = new Map<number, OpenF1CarDataRow[]>();
    for (const row of sortedByDate(rows)) {
      const driverNumber = rowDriverNumber(row);
      if (driverNumber === null) continue;
      const bucket = rowsByDriver.get(driverNumber);
      if (bucket) {
        bucket.push(row);
      } else {
        rowsByDriver.set(driverNumber, [row]);
      }
    }

    const applyForSlot = (slot: CarSlot, driverNumber: number): void => {
      const car = snapshot.cars[slot];
      const targetMs = parseIsoMs(car.updatedIso ?? nowDataIso);
      const row = this.pickSynchronizedCarDataRow(rowsByDriver.get(driverNumber) ?? [], targetMs);
      if (!row) return;

      const iso = typeof row.date === "string" ? row.date : nowDataIso;
      const telemetryMs = parseIsoMs(iso);
      if (
        telemetryMs !== null &&
        targetMs !== null &&
        Math.abs(telemetryMs - targetMs) > CAR_DATA_SYNC_TOLERANCE_MS
      ) {
        return;
      }

      if (telemetryMs !== null) {
        this.latestTelemetryMsByDriver.set(driverNumber, telemetryMs);
      }

      car.telemetry = {
        speedKph: Math.max(0, safeNumber(row.speed) ?? car.telemetry.speedKph),
        throttlePct: this.normalizePct(row.throttle),
        brakePct: this.normalizePct(row.brake),
        rpm: Math.max(0, safeNumber(row.rpm) ?? car.telemetry.rpm),
        gear: Math.max(0, Math.floor(safeNumber(row.n_gear) ?? car.telemetry.gear)),
        drs: safeNumber(row.drs) === 1
      };
    };

    applyForSlot("A", selectedDrivers.A.driverNumber);
    applyForSlot("B", selectedDrivers.B.driverNumber);
  }

  private pickSynchronizedCarDataRow(
    rows: OpenF1CarDataRow[],
    targetMs: number | null
  ): OpenF1CarDataRow | null {
    if (!rows.length) return null;
    if (targetMs === null) return rows[rows.length - 1];

    let latestPast: OpenF1CarDataRow | null = null;
    let latestPastMs: number | null = null;
    let earliestFuture: OpenF1CarDataRow | null = null;
    let earliestFutureMs: number | null = null;

    for (const row of rows) {
      const rowMs = parseIsoMs(typeof row.date === "string" ? row.date : null);
      if (rowMs === null) continue;

      if (rowMs <= targetMs) {
        latestPast = row;
        latestPastMs = rowMs;
      } else {
        earliestFuture = row;
        earliestFutureMs = rowMs;
        break;
      }
    }

    if (latestPastMs !== null && targetMs - latestPastMs <= CAR_DATA_SYNC_TOLERANCE_MS) {
      return latestPast;
    }

    if (earliestFutureMs !== null && earliestFutureMs - targetMs <= CAR_DATA_FUTURE_TOLERANCE_MS) {
      return earliestFuture;
    }

    if (latestPast) return latestPast;
    if (earliestFuture) return earliestFuture;

    return rows[rows.length - 1];
  }

  private applyOvertakeRows(
    events: StreamEvent[],
    rows: OpenF1OvertakeRow[],
    selectedDrivers: SelectedDrivers,
    nowDataIso: string
  ): void {
    if (!rows.length) return;

    const byDriver = new Map<number, CarSlot>([
      [selectedDrivers.A.driverNumber, "A"],
      [selectedDrivers.B.driverNumber, "B"]
    ]);

    for (const row of sortedByDate(rows)) {
      const overtakerNumber = safeNumber(row.overtaking_driver_number);
      if (overtakerNumber === null) continue;
      const slot = byDriver.get(overtakerNumber);
      if (!slot) continue;

      const overtakenNumber = safeNumber(row.overtaken_driver_number);
      const position = safeNumber(row.position);
      const iso = typeof row.date === "string" ? row.date : nowDataIso;

      // Hard gate: only trigger if the resulting position is numerically lower
      // than the last known position for that same driver.
      const lastKnownPosition = this.lastOvertakePositionByDriver.get(overtakerNumber) ?? null;

      if (position !== null && lastKnownPosition !== null && position >= lastKnownPosition) {
        this.lastOvertakePositionByDriver.set(overtakerNumber, position);
        continue;
      }

      if (position !== null) {
        this.lastOvertakePositionByDriver.set(overtakerNumber, position);
      }

      events.push({
        id: stableId(["overtake", slot, iso, overtakerNumber, overtakenNumber, position]),
        type: "overtake",
        iso,
        importance: 0.9,
        carSlot: slot,
        driverNumber: overtakerNumber,
        positionDelta:
          position !== null && lastKnownPosition !== null
            ? Math.max(0, lastKnownPosition - position)
            : 1,
        message:
          overtakenNumber !== null
            ? `${carLabel(slot)} overtake on car #${overtakenNumber}`
            : `${carLabel(slot)} completed an overtake`,
        raw: row
      });
    }
  }

  private applyOtherCarsData(
    snapshot: Snapshot,
    locations: OpenF1LocationRow[],
    selectedDrivers: SelectedDrivers,
    nowDataIso: string
  ): void {
    const nowDataMs = parseIsoMs(nowDataIso) ?? Date.now();

    for (const [driverNumber, motion] of this.otherCarMotionByDriver.entries()) {
      if (nowDataMs - motion.lastSeenMs > OTHER_CAR_STALE_MS * 2) {
        this.otherCarMotionByDriver.delete(driverNumber);
      }
    }

    const existing = new Map(
      snapshot.otherCars
        .filter((car) => !this.isOtherCarInactive(car.driverNumber, nowDataMs))
        .map((car) => [car.driverNumber, car] as const)
    );

    if (!locations.length) {
      snapshot.otherCars = Array.from(existing.values())
        .filter((car) => {
          const updatedMs = parseIsoMs(car.updatedIso);
          if (updatedMs === null) return false;
          return nowDataMs - updatedMs <= OTHER_CAR_STALE_MS * 2.5;
        })
        .sort((a, b) => a.driverNumber - b.driverNumber)
        .slice(0, 22);
      return;
    }

    const latestByDriver = new Map<number, OpenF1LocationRow>();

    for (const row of sortedByDate(locations)) {
      const driverNumber = rowDriverNumber(row);
      if (driverNumber === null) continue;
      if (driverNumber === selectedDrivers.A.driverNumber || driverNumber === selectedDrivers.B.driverNumber) {
        continue;
      }
      if (this.isOtherCarInactive(driverNumber, nowDataMs)) continue;
      latestByDriver.set(driverNumber, row);
    }

    for (const [driverNumber, row] of latestByDriver.entries()) {
      const x = safeNumber(row.x);
      const y = safeNumber(row.y);
      if (x === null || y === null) continue;
      const iso = typeof row.date === "string" ? row.date : nowDataIso;
      const isoMs = parseIsoMs(iso);

      const currentMotion = this.otherCarMotionByDriver.get(driverNumber);
      let shouldRefreshTelemetryRecency = false;
      if (!currentMotion) {
        this.otherCarMotionByDriver.set(driverNumber, {
          x,
          y,
          lastMovedMs: nowDataMs,
          lastSeenMs: nowDataMs
        });
        shouldRefreshTelemetryRecency = true;
      } else {
        const movedDistance = Math.hypot(x - currentMotion.x, y - currentMotion.y);
        const moved = movedDistance >= OTHER_CAR_STATIONARY_DISTANCE;
        this.otherCarMotionByDriver.set(driverNumber, {
          x,
          y,
          lastMovedMs: moved ? nowDataMs : currentMotion.lastMovedMs,
          lastSeenMs: nowDataMs
        });
        shouldRefreshTelemetryRecency = moved;
      }

      if (isoMs !== null && shouldRefreshTelemetryRecency) {
        this.latestTelemetryMsByDriver.set(driverNumber, isoMs);
      }

      existing.set(driverNumber, {
        driverNumber,
        abbr: this.driverAbbrByNumber.get(driverNumber) ?? String(driverNumber),
        x,
        y,
        updatedIso: iso
      });
    }

    snapshot.otherCars = Array.from(existing.values())
      .filter((car) => !this.isOtherCarInactive(car.driverNumber, nowDataMs))
      .filter((car) => {
        const updatedMs = parseIsoMs(car.updatedIso);
        if (updatedMs === null) return false;
        return nowDataMs - updatedMs <= OTHER_CAR_STALE_MS * 2.5;
      })
      .sort((a, b) => a.driverNumber - b.driverNumber)
      .slice(0, 22);
  }

  private applyDriverData(
    slot: CarSlot,
    driverNumber: number,
    snapshot: Snapshot,
    input: {
      positions: OpenF1PositionRow[];
      locations: OpenF1LocationRow[];
      pitRows: OpenF1PitRow[];
      radioRows: OpenF1TeamRadioRow[];
      nowDataMs: number;
      nowDataIso: string;
      events: StreamEvent[];
      radios: RadioEvent[];
    }
  ): void {
    const car = snapshot.cars[slot];
    const recapUntilMs = parseIsoMs(car.pitRecapUntilIso);
    if (recapUntilMs !== null && input.nowDataMs > recapUntilMs) {
      car.pitRecapUntilIso = null;
    }

    sortedByDate(input.positions).forEach((row) => {
      const iso = typeof row.date === "string" ? row.date : input.nowDataIso;
      const newPosition = safeNumber(row.position);
      if (newPosition === null) return;

      if (car.position !== null && car.position !== newPosition) {
        const delta = car.position - newPosition;
        car.delta = delta;
        input.events.push({
          id: stableId(["pos", slot, iso, newPosition]),
          type: "position_change",
          iso,
          carSlot: slot,
          driverNumber,
          positionDelta: delta,
          importance: Math.abs(delta) >= 2 ? 0.85 : 0.76,
          message: `${carLabel(slot)} moved to P${newPosition}`,
          raw: row
        });
      } else if (car.position === null) {
        car.delta = null;
      } else {
        car.delta = 0;
      }

      car.position = newPosition;
      car.updatedIso = iso;
    });

    sortedByDate(input.locations).forEach((row) => {
      const iso = typeof row.date === "string" ? row.date : input.nowDataIso;
      const x = safeNumber(row.x);
      const y = safeNumber(row.y);
      if (x === null || y === null) return;

      car.x = x;
      car.y = y;
      car.updatedIso = iso;
      car.trail = [...car.trail, { iso, x, y }].slice(-400);
    });

    const sortedPitRows = sortedByDate(input.pitRows);
    if (sortedPitRows.length) {
      for (const row of sortedPitRows) {
        const iso = typeof row.date === "string" ? row.date : input.nowDataIso;
        const lap = safeNumber(row.lap_number);
        const marker = `${iso}|${lap ?? "na"}`;

        if (this.lastPitMarkerBySlot[slot] !== marker) {
          this.lastPitMarkerBySlot[slot] = marker;

          const pitMs = parseIsoMs(iso) ?? input.nowDataMs;
          const laneDuration =
            safeNumber(row.lane_duration) ?? safeNumber(row.pit_duration) ?? safeNumber(row.stop_duration);
          const stopDuration = safeNumber(row.stop_duration);
          const holdSec = Math.max(laneDuration ?? 0, stopDuration ?? 0, 0.5);
          this.pitUntilMs[slot] = pitMs + holdSec * 1000 + PIT_EVENT_BUFFER_MS;
          this.lastPitSummaryBySlot[slot] = { laneDuration, stopDuration };

          car.pit = true;
          car.pitStartIso = iso;
          car.pitLaneDurationSec = laneDuration;
          car.pitStopDurationSec = stopDuration;
          car.pitRecapUntilIso = null;
          car.updatedIso = iso;

          input.events.push({
            id: stableId(["pit", slot, iso, lap]),
            type: "pit",
            iso,
            carSlot: slot,
            driverNumber,
            importance: 0.82,
            message: `${carLabel(slot)} pit lane activity`,
            raw: row
          });
        }
      }
    }

    if (car.pit && input.nowDataMs > this.pitUntilMs[slot]) {
      car.pit = false;
      const summary = this.lastPitSummaryBySlot[slot];
      if (summary && summary.stopDuration !== null) {
        car.pitLaneDurationSec = summary.laneDuration;
        car.pitStopDurationSec = summary.stopDuration;
        car.pitRecapUntilIso = toIso(input.nowDataMs + PIT_RECAP_VISIBLE_MS);
      } else {
        car.pitRecapUntilIso = null;
      }
    }
    if (
      this.retiredDriverNumbers.has(driverNumber) ||
      this.isOutByLapStaleness(driverNumber, input.nowDataMs) ||
      this.isOutByTelemetryStaleness(driverNumber, input.nowDataMs)
    ) {
      car.pit = false;
      car.state = "OUT";
    } else {
      car.state = car.pit ? "PIT" : "ON TRACK";
    }

    sortedByDate(input.radioRows).forEach((row) => {
      const iso = typeof row.date === "string" ? row.date : input.nowDataIso;
      const recordingUrl = typeof row.recording_url === "string" ? row.recording_url.trim() : "";
      if (!recordingUrl) return;

      const radioId = stableId(["radio", slot, iso, recordingUrl]);
      input.radios.push({
        id: radioId,
        iso,
        carSlot: slot,
        driverNumber,
        recordingUrl,
        lapNumber: safeNumber(row.lap_number) ?? undefined,
        raw: row
      });

      input.events.push({
        id: stableId(["radio-event", slot, iso, recordingUrl]),
        type: "radio",
        iso,
        carSlot: slot,
        driverNumber,
        importance: 0.9,
        message: `${carLabel(slot)} radio audio available`,
        raw: row
      });
    });
  }

  private bufferCommentaryPackets(events: StreamEvent[]): void {
    for (const event of events) {
      this.bufferedCommentaryPackets.set(event.id, event);
    }
  }

  private appendWilliamsOutTransitionEvents(
    previousSnapshot: Snapshot,
    nextSnapshot: Snapshot,
    events: StreamEvent[],
    nowDataIso: string
  ): void {
    const slots: CarSlot[] = ["A", "B"];

    for (const slot of slots) {
      const before = previousSnapshot.cars[slot];
      const after = nextSnapshot.cars[slot];
      if (before.state === "OUT" || after.state !== "OUT") continue;

      const iso = after.updatedIso ?? nowDataIso;
      events.push({
        id: stableId(["williams-out", slot, iso, after.driverNumber ?? "na"]),
        type: "race_control",
        iso,
        carSlot: slot,
        driverNumber: after.driverNumber ?? undefined,
        importance: 0.98,
        message: `Control update: ${carLabel(slot)} out of the race`
      });
    }
  }

  private isWilliamsOutRaceControlMessage(
    event: StreamEvent,
    selectedDrivers: SelectedDrivers
  ): boolean {
    const normalized = stripControlPrefix(event.message);
    if (!isRetirementMessage(normalized)) return false;
    if (event.carSlot === "A" || event.carSlot === "B") return true;

    const mentionedDriverNumbers = extractDriverNumbersFromMessage(normalized);
    return mentionedDriverNumbers.some(
      (driverNumber) =>
        driverNumber === selectedDrivers.A.driverNumber ||
        driverNumber === selectedDrivers.B.driverNumber
    );
  }

  private isCommentaryTriggerEvent(
    event: StreamEvent,
    selectedDrivers: SelectedDrivers
  ): boolean {
    if (event.type === "pit") {
      return true;
    }

    if (event.type === "overtake") {
      return (event.positionDelta ?? 0) > 0;
    }

    if (event.type === "position_change") {
      return (event.positionDelta ?? 0) < 0;
    }

    if (event.type === "race_control") {
      return (
        isSafetyCarMessage(event.message) ||
        isRedFlagMessage(event.message) ||
        isAbortedStartMessage(event.message) ||
        isFormationLapRestartMessage(event.message) ||
        isKeyRaceControlInfoMessage(event.message) ||
        this.isWilliamsOutRaceControlMessage(event, selectedDrivers)
      );
    }

    return false;
  }

  private selectCommentaryTriggerEvent(
    events: StreamEvent[],
    selectedDrivers: SelectedDrivers
  ): StreamEvent | null {
    const triggers = events.filter((event) => this.isCommentaryTriggerEvent(event, selectedDrivers));
    if (!triggers.length) return null;
    return triggers[triggers.length - 1];
  }

  private drainCommentaryPackets(): StreamEvent[] {
    const packets = Array.from(this.bufferedCommentaryPackets.values()).sort((a, b) => {
      const byIso = a.iso.localeCompare(b.iso);
      if (byIso !== 0) return byIso;
      return a.id.localeCompare(b.id);
    });
    this.bufferedCommentaryPackets.clear();
    return packets;
  }

  private enqueueCommentaryBatch(packets: StreamEvent[], triggerEvent: StreamEvent): void {
    if (!packets.length) return;
    this.commentaryDispatchQueue.push({ packets, triggerEvent });
    void this.processCommentaryDispatchQueue();
  }

  private async processCommentaryDispatchQueue(): Promise<void> {
    if (this.commentaryDispatchInFlight) return;
    this.commentaryDispatchInFlight = true;

    try {
      while (this.commentaryDispatchQueue.length) {
        const next = this.commentaryDispatchQueue.shift();
        if (!next) break;
        await this.pushCommentaryForBatch(next.packets, next.triggerEvent);
      }
    } finally {
      this.commentaryDispatchInFlight = false;
    }
  }

  private async pushCommentaryForBatch(packets: StreamEvent[], triggerEvent: StreamEvent): Promise<void> {
    if (!packets.length) return;

    const state = useSessionStore.getState();
    const { prefs } = state;
    const packetContents = packets
      .map((packet) => (typeof packet.message === "string" ? packet.message.trim() : ""))
      .filter((packet) => packet.length > 0);
    if (!packetContents.length) return;

    try {
      const response = await sendToAiriaAgent({
        level: prefs.knowledgeLevel,
        packets: packetContents
      });

      state.setAiFallbackWarning(false);
      useSessionStore.getState().pushCommentary({
        id: stableId([
          "commentary-batch",
          "airia",
          packets[0].id,
          triggerEvent.id
        ]),
        iso: triggerEvent.iso || new Date().toISOString(),
        text: response.text,
        confidence: response.confidence,
        source: "airia",
        triggerEventId: triggerEvent.id
      });
    } catch {
      state.setAiFallbackWarning(true);
    }
  }

  private enqueueQuizBatch(packets: StreamEvent[], triggerEvent: StreamEvent): void {
    if (!packets.length) return;
    this.quizDispatchQueue.push({ packets, triggerEvent });
    void this.processQuizDispatchQueue();
  }

  private async processQuizDispatchQueue(): Promise<void> {
    if (this.quizDispatchInFlight) return;
    this.quizDispatchInFlight = true;

    try {
      while (this.quizDispatchQueue.length) {
        const next = this.quizDispatchQueue.shift();
        if (!next) break;
        await this.pushQuizForBatch(next.packets, next.triggerEvent);
      }
    } finally {
      this.quizDispatchInFlight = false;
    }
  }

  private async pushQuizForBatch(packets: StreamEvent[], triggerEvent: StreamEvent): Promise<void> {
    if (!packets.length) return;

    const state = useSessionStore.getState();
    const packetContents = packets
      .map((packet) => (typeof packet.message === "string" ? packet.message.trim() : ""))
      .filter((packet) => packet.length > 0);
    if (!packetContents.length) return;

    try {
      const quiz = await sendQuizToAiriaAgent({
        level: state.prefs.knowledgeLevel,
        packets: [
          "Create a quiz (only one) related to this race situation. Return only JSON with question, answers, and correct_answer.",
          ...packetContents
        ]
      });

      const triggerIso = triggerEvent.iso || state.snapshot.nowDataIso || new Date().toISOString();
      state.setActiveQuiz({
        triggerEventId: triggerEvent.id,
        triggerIso,
        question: quiz.question,
        answers: quiz.answers,
        correctAnswer: quiz.correctAnswer
      });
    } catch {
      // Ignore quiz errors to keep the stream pipeline non-blocking.
    }
  }
}

export const streamEngine = new HistoricalAsLiveStreamEngine();
export { isStreamConfigValid };
