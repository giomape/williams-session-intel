export type KnowledgeLevel = "beginner" | "intermediate" | "expert";
export type FocusMode = "carA" | "carB" | "both";
export type AiMode = "airia";
export type CarSlot = "A" | "B";
export type QuizAnswerKey = "A" | "B" | "C" | "D";

export type EventType =
  | "position_change"
  | "overtake"
  | "pit"
  | "radio"
  | "race_control"
  | "heartbeat";

export interface TelemetrySample {
  speedKph: number;
  throttlePct: number;
  brakePct: number;
  rpm: number;
  gear: number;
  drs: boolean;
}

export interface WeatherState {
  airTemperatureC: number | null;
  trackTemperatureC: number | null;
  humidityPct: number | null;
  rainfall: number | null;
}

export interface UserPreferences {
  sessionKey: string;
  knowledgeLevel: KnowledgeLevel;
  focusMode: FocusMode;
  speed: number;
  pollMs: number;
  aiMode: AiMode;
}

export interface SessionDriver {
  driverNumber: number;
  fullName: string;
  shortName: string;
  teamName: string;
}

export interface SessionWindow {
  startIso: string;
  endIso: string;
}

export interface TrackPoint {
  iso: string;
  x: number;
  y: number;
}

export interface CarState {
  slot: CarSlot;
  driverNumber: number | null;
  driverName: string | null;
  position: number | null;
  delta: number | null;
  gapToLeader: number | null;
  intervalToMate: number | null;
  intervalDirection: "AHEAD" | "BEHIND" | "UNKNOWN";
  tyreCompound: "SOFT" | "MEDIUM" | "HARD" | "INTERMEDIATE" | "WET";
  state: "ON TRACK" | "PIT" | "OUT";
  x: number | null;
  y: number | null;
  pit: boolean;
  pitStartIso: string | null;
  pitLaneDurationSec: number | null;
  pitStopDurationSec: number | null;
  pitRecapUntilIso: string | null;
  telemetry: TelemetrySample;
  updatedIso: string | null;
  trail: TrackPoint[];
}

export interface Snapshot {
  sessionKey: string;
  nowDataIso: string;
  sessionWindow: SessionWindow | null;
  lapNumber: number | null;
  totalLaps: number | null;
  weather: WeatherState;
  trackOutline: TrackPoint[];
  cars: {
    A: CarState;
    B: CarState;
  };
  otherCars: Array<{
    driverNumber: number;
    abbr: string;
    x: number;
    y: number;
    updatedIso: string | null;
  }>;
}

export interface StreamEvent {
  id: string;
  type: EventType;
  iso: string;
  importance: number;
  message: string;
  carSlot?: CarSlot;
  driverNumber?: number;
  positionDelta?: number;
  raw?: unknown;
}

export interface RadioEvent {
  id: string;
  iso: string;
  carSlot: CarSlot;
  driverNumber: number;
  recordingUrl: string;
  lapNumber?: number;
  raw?: unknown;
}

export interface CommentaryMessage {
  id: string;
  iso: string;
  text: string;
  confidence: number;
  source: "airia";
  triggerEventId?: string;
}

export interface QuizCard {
  id: string;
  triggerEventId: string;
  question: string;
  answers: string[];
  correctAnswer: QuizAnswerKey;
  createdIso: string;
  expiresIso: string;
  selectedAnswer: QuizAnswerKey | null;
  answeredIso: string | null;
}

export interface QuizStats {
  correct: number;
  wrong: number;
}

export interface StreamDiagnostics {
  dataDelayMode: boolean;
  failureStreak: number;
  invalidConfig: boolean;
  aiFallbackWarning: boolean;
  driverSelectionError: string | null;
}

export interface OpenF1BaseRow {
  date?: string;
  driver_number?: number;
  [key: string]: unknown;
}

export interface OpenF1SessionRow {
  session_key?: number;
  date_start?: string;
  date_end?: string;
  session_name?: string;
  [key: string]: unknown;
}

export interface OpenF1DriverRow extends OpenF1BaseRow {
  full_name?: string;
  name_acronym?: string;
  team_name?: string;
}

export interface OpenF1PositionRow extends OpenF1BaseRow {
  position?: number;
}

export interface OpenF1LocationRow extends OpenF1BaseRow {
  x?: number;
  y?: number;
}

export interface OpenF1PitRow extends OpenF1BaseRow {
  lap_number?: number;
  lane_duration?: number;
  stop_duration?: number;
  pit_duration?: number;
}

export interface OpenF1IntervalRow extends OpenF1BaseRow {
  gap_to_leader?: number;
  interval?: number | null;
}

export interface OpenF1LapRow extends OpenF1BaseRow {
  lap_number?: number;
  date_start?: string;
  lap_duration?: number;
  is_pit_out_lap?: boolean;
}

export interface OpenF1WeatherRow extends OpenF1BaseRow {
  air_temperature?: number;
  track_temperature?: number;
  humidity?: number;
  rainfall?: number;
}

export interface OpenF1StintRow extends OpenF1BaseRow {
  stint_number?: number;
  lap_start?: number;
  lap_end?: number;
  compound?: string;
  tyre_age_at_start?: number;
}

export interface OpenF1OvertakeRow extends OpenF1BaseRow {
  overtaking_driver_number?: number;
  overtaken_driver_number?: number;
  position?: number;
}

export interface OpenF1CarDataRow extends OpenF1BaseRow {
  speed?: number;
  throttle?: number;
  brake?: number;
  rpm?: number;
  n_gear?: number;
  drs?: number;
}

export interface OpenF1TeamRadioRow extends OpenF1BaseRow {
  lap_number?: number;
  recording_url?: string;
}

export interface OpenF1RaceControlRow extends OpenF1BaseRow {
  lap_number?: number;
  category?: string;
  flag?: string;
  message?: string;
  scope?: string;
}

export interface TickPayload {
  snapshot: Snapshot;
  events: StreamEvent[];
  radios: RadioEvent[];
  dataDelayMode: boolean;
  failureStreak: number;
}
