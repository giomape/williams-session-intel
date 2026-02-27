import {
  CommentaryMessage,
  KnowledgeLevel,
  QuizAnswerKey,
  RadioEvent,
  Snapshot,
  StreamEvent,
  UserPreferences
} from "@/lib/types";

export interface AiriaContextBundle {
  prefs: UserPreferences;
  snapshot: Snapshot;
  recentEvents: StreamEvent[];
  recentRadios: RadioEvent[];
  generatedAtIso: string;
}

export interface AiriaCommentaryRequest {
  level: KnowledgeLevel;
  packets: string[];
}

export interface AiriaCommentaryResponse {
  text: string;
  confidence: number;
}

export interface AiriaQuizResponse {
  question: string;
  answers: string[];
  correctAnswer: QuizAnswerKey;
}

export interface AiriaGatewayStatus {
  configured: boolean;
  mode: string;
}

export class AiriaError extends Error {
  readonly code: "NOT_CONFIGURED" | "GATEWAY_ERROR" | "INVALID_RESPONSE";

  constructor(
    message: string,
    code: "NOT_CONFIGURED" | "GATEWAY_ERROR" | "INVALID_RESPONSE"
  ) {
    super(message);
    this.name = "AiriaError";
    this.code = code;
  }
}

export function buildAiriaContextBundle(state: {
  prefs: UserPreferences;
  snapshot: Snapshot;
  events: StreamEvent[];
  radios: RadioEvent[];
  commentary?: CommentaryMessage[];
}): AiriaContextBundle {
  return {
    prefs: state.prefs,
    snapshot: state.snapshot,
    recentEvents: state.events.slice(-25),
    recentRadios: state.radios.slice(-12),
    generatedAtIso: new Date().toISOString()
  };
}

export async function getAiriaGatewayStatus(): Promise<AiriaGatewayStatus> {
  const response = await fetch("/api/airia", {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    return { configured: false, mode: "unknown" };
  }

  const payload = (await response.json()) as Partial<AiriaGatewayStatus>;
  return {
    configured: Boolean(payload.configured),
    mode: typeof payload.mode === "string" ? payload.mode : "unknown"
  };
}

export async function sendToAiriaAgent(
  request: AiriaCommentaryRequest
): Promise<AiriaCommentaryResponse> {
  const response = await fetch("/api/airia", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    cache: "no-store",
    body: JSON.stringify(request)
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    text?: string;
    confidence?: number;
  };

  if (!response.ok) {
    if (response.status === 501) {
      throw new AiriaError(payload.error ?? "Airia not configured", "NOT_CONFIGURED");
    }
    throw new AiriaError(payload.error ?? "Airia gateway error", "GATEWAY_ERROR");
  }

  if (typeof payload.text !== "string") {
    throw new AiriaError("Invalid Airia response payload", "INVALID_RESPONSE");
  }

  return {
    text: payload.text,
    confidence:
      typeof payload.confidence === "number" && Number.isFinite(payload.confidence)
        ? payload.confidence
        : 0.5
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stripAnswerPrefix(value: string): string {
  return value.replace(/^[A-D][\.\):]\s*/i, "").trim();
}

function normalizeAnswerKey(value: unknown, answers: string[]): QuizAnswerKey | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 1 && value <= 4) {
      return ["A", "B", "C", "D"][Math.floor(value) - 1] as QuizAnswerKey;
    }
  }

  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (/^[ABCD]$/.test(normalized)) {
    return normalized as QuizAnswerKey;
  }

  const letterMatch = normalized.match(/^([ABCD])[\.\):\s-]/);
  if (letterMatch) {
    return letterMatch[1] as QuizAnswerKey;
  }

  const rawNoPrefix = stripAnswerPrefix(normalized);
  for (let i = 0; i < answers.length; i += 1) {
    const candidateNoPrefix = stripAnswerPrefix(answers[i].toUpperCase());
    if (candidateNoPrefix === rawNoPrefix) {
      return ["A", "B", "C", "D"][i] as QuizAnswerKey;
    }
  }

  return null;
}

function parseQuizText(rawText: string): AiriaQuizResponse | null {
  function resolveQuiz(value: unknown): AiriaQuizResponse | null {
    if (!value || typeof value !== "object") return null;

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = resolveQuiz(item);
        if (nested) return nested;
      }
      return null;
    }

    const record = value as Record<string, unknown>;
    const question = normalizeString(record.question);
    const answersRaw = Array.isArray(record.answers) ? record.answers : [];
    const answers = answersRaw
      .map((answer) => normalizeString(answer))
      .filter((answer) => answer.length > 0)
      .slice(0, 4);
    const correctAnswer = normalizeAnswerKey(
      record.correct_answer ?? record.correctAnswer ?? record.correct,
      answers
    );

    if (question.length && answers.length >= 4 && correctAnswer) {
      return { question, answers, correctAnswer };
    }

    for (const nestedValue of Object.values(record)) {
      const nested = resolveQuiz(nestedValue);
      if (nested) return nested;
    }

    return null;
  }

  const trimmed = rawText.trim();
  if (!trimmed.length) return null;

  const candidates = [trimmed];
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const quiz = resolveQuiz(parsed);
    if (quiz) return quiz;
  }

  return null;
}

export async function sendQuizToAiriaAgent(
  request: AiriaCommentaryRequest
): Promise<AiriaQuizResponse> {
  const response = await fetch("/api/airia", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    cache: "no-store",
    body: JSON.stringify({ ...request, kind: "quiz" })
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    text?: string;
  };

  if (!response.ok) {
    if (response.status === 501) {
      throw new AiriaError(payload.error ?? "Airia not configured", "NOT_CONFIGURED");
    }
    throw new AiriaError(payload.error ?? "Airia gateway error", "GATEWAY_ERROR");
  }

  if (typeof payload.text !== "string") {
    throw new AiriaError("Invalid Airia quiz payload", "INVALID_RESPONSE");
  }

  const parsed = parseQuizText(payload.text);
  if (!parsed) {
    throw new AiriaError("Invalid Airia quiz payload", "INVALID_RESPONSE");
  }
  return parsed;
}
