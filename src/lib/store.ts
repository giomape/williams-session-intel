import { create } from "zustand";
import { DEMO_SESSION_KEY } from "@/lib/demoConfig";
import { bounded } from "@/lib/format";
import {
  QuizAnswerKey,
  QuizCard,
  QuizStats,
  CommentaryMessage,
  Snapshot,
  StreamDiagnostics,
  TickPayload,
  UserPreferences
} from "@/lib/types";

const DEFAULT_POLL_MS = Math.max(
  250,
  Number.parseInt(process.env.NEXT_PUBLIC_DEFAULT_POLL_MS ?? "1000", 10) || 1000
);
const DEFAULT_SPEED =
  Number.parseFloat(process.env.NEXT_PUBLIC_DEFAULT_SPEED ?? "1") || 1;
const DEFAULT_AI_MODE: UserPreferences["aiMode"] = "airia";
const QUIZ_DURATION_MS = 2 * 60 * 1000;

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso || !iso.trim().length) return null;
  const normalized = /[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function createSnapshot(prefs: UserPreferences): Snapshot {
  return {
    sessionKey: prefs.sessionKey,
    nowDataIso: "",
    sessionWindow: null,
    lapNumber: null,
    totalLaps: null,
    weather: {
      airTemperatureC: null,
      trackTemperatureC: null,
      humidityPct: null,
      rainfall: null
    },
    trackOutline: [],
    cars: {
      A: {
        slot: "A",
        driverNumber: null,
        driverName: null,
        position: null,
        delta: null,
        gapToLeader: null,
        intervalToMate: null,
        intervalDirection: "UNKNOWN",
        tyreCompound: "MEDIUM",
        state: "ON TRACK",
        x: null,
        y: null,
        pit: false,
        pitStartIso: null,
        pitLaneDurationSec: null,
        pitStopDurationSec: null,
        pitRecapUntilIso: null,
        telemetry: {
          speedKph: 0,
          throttlePct: 0,
          brakePct: 0,
          rpm: 0,
          gear: 0,
          drs: false
        },
        updatedIso: null,
        trail: []
      },
      B: {
        slot: "B",
        driverNumber: null,
        driverName: null,
        position: null,
        delta: null,
        gapToLeader: null,
        intervalToMate: null,
        intervalDirection: "UNKNOWN",
        tyreCompound: "MEDIUM",
        state: "ON TRACK",
        x: null,
        y: null,
        pit: false,
        pitStartIso: null,
        pitLaneDurationSec: null,
        pitStopDurationSec: null,
        pitRecapUntilIso: null,
        telemetry: {
          speedKph: 0,
          throttlePct: 0,
          brakePct: 0,
          rpm: 0,
          gear: 0,
          drs: false
        },
        updatedIso: null,
        trail: []
      }
    },
    otherCars: []
  };
}

function dedupeById<T extends { id: string }>(
  current: T[],
  incoming: T[],
  limit?: number
): T[] {
  if (!incoming.length) return current;
  const map = new Map<string, T>();
  current.forEach((item) => map.set(item.id, item));
  incoming.forEach((item) => map.set(item.id, item));
  const merged = Array.from(map.values());
  return typeof limit === "number" ? bounded(merged, limit) : merged;
}

const initialPrefs: UserPreferences = {
  sessionKey: DEMO_SESSION_KEY,
  knowledgeLevel: "beginner",
  focusMode: "both",
  speed: DEFAULT_SPEED,
  pollMs: DEFAULT_POLL_MS,
  aiMode: DEFAULT_AI_MODE
};

const initialDiagnostics: StreamDiagnostics = {
  dataDelayMode: false,
  failureStreak: 0,
  invalidConfig: false,
  aiFallbackWarning: false,
  driverSelectionError: null
};

const initialQuizStats: QuizStats = {
  correct: 0,
  wrong: 0
};

export interface SessionStoreState {
  prefs: UserPreferences;
  isStreaming: boolean;
  snapshot: Snapshot;
  events: TickPayload["events"];
  radios: TickPayload["radios"];
  commentary: CommentaryMessage[];
  activeQuiz: QuizCard | null;
  quizStats: QuizStats;
  diagnostics: StreamDiagnostics;
  setPrefs: (patch: Partial<UserPreferences>) => void;
  setStreaming: (isStreaming: boolean) => void;
  resetStreamData: () => void;
  applyTick: (payload: TickPayload) => void;
  pushCommentary: (message: CommentaryMessage) => void;
  setActiveQuiz: (payload: {
    triggerEventId: string;
    triggerIso: string;
    question: string;
    answers: string[];
    correctAnswer: QuizAnswerKey;
  }) => void;
  answerActiveQuiz: (answer: QuizAnswerKey) => void;
  clearActiveQuiz: (quizId?: string) => void;
  setInvalidConfig: (invalidConfig: boolean) => void;
  setAiFallbackWarning: (enabled: boolean) => void;
  setDriverSelectionError: (message: string | null) => void;
}

export const useSessionStore = create<SessionStoreState>((set) => ({
  prefs: initialPrefs,
  isStreaming: false,
  snapshot: createSnapshot(initialPrefs),
  events: [],
  radios: [],
  commentary: [],
  activeQuiz: null,
  quizStats: initialQuizStats,
  diagnostics: initialDiagnostics,

  setPrefs: (patch) =>
    set((state) => {
      const nextPrefs = {
        ...state.prefs,
        ...patch,
        sessionKey:
          typeof patch.sessionKey === "string"
            ? patch.sessionKey.trim() || DEMO_SESSION_KEY
            : state.prefs.sessionKey,
        aiMode: "airia" as const
      };
      const sessionChanged =
        typeof patch.sessionKey === "string" && patch.sessionKey !== state.prefs.sessionKey;

      if (!sessionChanged) {
        return {
          prefs: nextPrefs,
          snapshot: {
            ...state.snapshot,
            sessionKey: nextPrefs.sessionKey
          }
        };
      }

      return {
        prefs: nextPrefs,
        snapshot: createSnapshot(nextPrefs),
        events: [],
        radios: [],
        commentary: [],
        activeQuiz: null,
        quizStats: initialQuizStats,
        diagnostics: {
          ...state.diagnostics,
          invalidConfig: false,
          driverSelectionError: null
        }
      };
    }),

  setStreaming: (isStreaming) => set(() => ({ isStreaming })),

  resetStreamData: () =>
    set((state) => ({
      snapshot: createSnapshot(state.prefs),
      events: [],
      radios: [],
      commentary: [],
      activeQuiz: null,
      quizStats: initialQuizStats,
      diagnostics: {
        ...state.diagnostics,
        dataDelayMode: false,
        failureStreak: 0
      }
    })),

  applyTick: (payload) =>
    set((state) => {
      const nowMs = parseIsoMs(payload.snapshot.nowDataIso);
      const expiresMs = parseIsoMs(state.activeQuiz?.expiresIso);
      const shouldExpire =
        Boolean(state.activeQuiz) &&
        !state.activeQuiz?.selectedAnswer &&
        nowMs !== null &&
        expiresMs !== null &&
        nowMs >= expiresMs;

      return {
        snapshot: payload.snapshot,
        events: dedupeById(state.events, payload.events),
        radios: dedupeById(state.radios, payload.radios, 50),
        activeQuiz: shouldExpire ? null : state.activeQuiz,
        diagnostics: {
          ...state.diagnostics,
          dataDelayMode: payload.dataDelayMode,
          failureStreak: payload.failureStreak
        }
      };
    }),

  pushCommentary: (message) =>
    set((state) => ({
      commentary: dedupeById(state.commentary, [message], 200)
    })),

  setActiveQuiz: (payload) =>
    set(() => {
      const triggerMs = parseIsoMs(payload.triggerIso) ?? Date.now();
      return {
        activeQuiz: {
          id: `quiz-${payload.triggerEventId}`,
          triggerEventId: payload.triggerEventId,
          question: payload.question,
          answers: payload.answers.slice(0, 4),
          correctAnswer: payload.correctAnswer,
          createdIso: payload.triggerIso,
          expiresIso: new Date(triggerMs + QUIZ_DURATION_MS).toISOString(),
          selectedAnswer: null,
          answeredIso: null
        }
      };
    }),

  answerActiveQuiz: (answer) =>
    set((state) => {
      const quiz = state.activeQuiz;
      if (!quiz || quiz.selectedAnswer) return {};

      const isCorrect = quiz.correctAnswer === answer;
      const answeredIso = state.snapshot.nowDataIso || quiz.createdIso || new Date().toISOString();
      return {
        activeQuiz: {
          ...quiz,
          selectedAnswer: answer,
          answeredIso
        },
        quizStats: {
          correct: state.quizStats.correct + (isCorrect ? 1 : 0),
          wrong: state.quizStats.wrong + (isCorrect ? 0 : 1)
        }
      };
    }),

  clearActiveQuiz: (quizId) =>
    set((state) => {
      if (!state.activeQuiz) return {};
      if (quizId && state.activeQuiz.id !== quizId) return {};
      return {
        activeQuiz: null
      };
    }),

  setInvalidConfig: (invalidConfig) =>
    set((state) => ({
      diagnostics: { ...state.diagnostics, invalidConfig }
    })),

  setAiFallbackWarning: (enabled) =>
    set((state) => ({
      diagnostics: { ...state.diagnostics, aiFallbackWarning: enabled }
    })),

  setDriverSelectionError: (message) =>
    set((state) => ({
      diagnostics: { ...state.diagnostics, driverSelectionError: message }
    }))
}));
