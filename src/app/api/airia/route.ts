import { NextRequest, NextResponse } from "next/server";

type JsonRecord = Record<string, unknown>;
type KnowledgeLevel = "beginner" | "intermediate" | "expert";

function resolveMode(): "airia" {
  return "airia";
}

function resolveApiUrl(): string {
  return (process.env.AIRIA_API_URL ?? "").trim();
}

function isConfigured(): boolean {
  return Boolean(resolveApiUrl() && process.env.AIRIA_API_KEY);
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function normalizeLevel(value: unknown): KnowledgeLevel {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "intermediate") return "intermediate";
  if (normalized === "expert") return "expert";
  return "beginner";
}

function extractPacketMessage(value: unknown): { iso: string | null; message: string | null } {
  if (typeof value === "string") {
    const message = value.trim();
    return { iso: null, message: message.length ? message : null };
  }

  const record = asRecord(value);
  if (!record) return { iso: null, message: null };

  const iso = typeof record.iso === "string" ? record.iso.trim() : null;
  const messageCandidates = [record.message, record.text, record.content];
  for (const candidate of messageCandidates) {
    if (typeof candidate === "string" && candidate.trim().length) {
      return { iso, message: candidate.trim() };
    }
  }

  return { iso, message: null };
}

function buildVariablePayload(payload: unknown): { level: KnowledgeLevel; packets: string[] } {
  const root = asRecord(payload);
  const levelFromRoot = root?.level;
  const bundle = asRecord(root?.bundle);
  const prefs = asRecord(bundle?.prefs);
  const level = normalizeLevel(levelFromRoot ?? prefs?.knowledgeLevel);

  const packetSource = Array.isArray(root?.packets)
    ? root.packets
    : Array.isArray(bundle?.recentEvents)
      ? bundle.recentEvents
      : [];

  const packets = packetSource
    .map((item, idx) => {
      const extracted = extractPacketMessage(item);
      return {
        order: idx,
        iso: extracted.iso,
        message: extracted.message
      };
    })
    .filter((item): item is { order: number; iso: string | null; message: string } => Boolean(item.message))
    .sort((a, b) => {
      if (a.iso && b.iso) {
        const byIso = a.iso.localeCompare(b.iso);
        if (byIso !== 0) return byIso;
      } else if (a.iso && !b.iso) {
        return -1;
      } else if (!a.iso && b.iso) {
        return 1;
      }
      return a.order - b.order;
    })
    .map((item) => item.message);

  return { level, packets };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function collectTextCandidates(
  value: unknown,
  path: string[],
  out: Array<{ text: string; path: string[] }>,
  depth = 0
): void {
  if (depth > 7 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length) out.push({ text, path });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, idx) => collectTextCandidates(item, [...path, String(idx)], out, depth + 1));
    return;
  }

  const record = asRecord(value);
  if (!record) return;
  Object.entries(record).forEach(([key, nested]) => {
    collectTextCandidates(nested, [...path, key], out, depth + 1);
  });
}

function collectNamedValueCandidates(
  value: unknown,
  out: Array<{ text: string; path: string[] }>,
  path: string[] = []
): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, idx) => collectNamedValueCandidates(item, out, [...path, String(idx)]));
    return;
  }

  const record = value as JsonRecord;
  const entries = Object.entries(record);
  for (const [key, nested] of entries) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "outputs" ||
      lowerKey === "outputvariables" ||
      lowerKey === "variables" ||
      lowerKey === "resultvariables"
    ) {
      const bucket = record[key];
      if (Array.isArray(bucket)) {
        bucket.forEach((item, idx) => {
          const itemRecord = asRecord(item);
          if (!itemRecord) return;
          const nameRaw = itemRecord.name ?? itemRecord.key ?? itemRecord.variable ?? itemRecord.id;
          const name = typeof nameRaw === "string" ? nameRaw.trim().toLowerCase() : "";
          if (name === "level" || name === "packets" || name === "userinput") return;
          const valueRaw = itemRecord.value ?? itemRecord.text ?? itemRecord.content ?? itemRecord.output;
          if (typeof valueRaw === "string" && valueRaw.trim().length) {
            out.push({
              text: valueRaw.trim(),
              path: [...path, key, String(idx), "value"]
            });
          }
        });
      } else if (asRecord(bucket)) {
        const mapRecord = bucket as JsonRecord;
        Object.entries(mapRecord).forEach(([mapKey, mapValue]) => {
          if (["level", "packets", "userinput"].includes(mapKey.toLowerCase())) return;
          if (typeof mapValue === "string" && mapValue.trim().length) {
            out.push({
              text: mapValue.trim(),
              path: [...path, key, mapKey]
            });
          }
        });
      }
    }

    collectNamedValueCandidates(nested, out, [...path, key]);
  }
}

function isLikelyMetaText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized.length) return true;
  if (["success", "succeeded", "completed", "true", "false", "ok", "beginner", "intermediate", "expert"].includes(normalized)) {
    return true;
  }
  return false;
}

function scoreCandidate(text: string, path: string[], sentPackets: string[]): number {
  let score = 0;
  const pathJoined = path.join(".").toLowerCase();
  const normalized = normalizeText(text);

  if (/(^|\.)(output|outputs?|result|response|answer|commentary|assistant|completion|text|content|message)\b/.test(pathJoined)) {
    score += 70;
  }
  if (/(^|\.)(input|packets|level|prompt|request|instruction|query|userinput)\b/.test(pathJoined)) {
    score -= 130;
  }
  if (sentPackets.some((packet) => normalizeText(packet) === normalized)) {
    score -= 260;
  }
  if (isLikelyMetaText(normalized)) {
    score -= 80;
  }
  if (normalized.length >= 24) {
    score += 20;
  } else if (normalized.length <= 8) {
    score -= 20;
  }

  return score;
}

function extractText(value: unknown, sentPackets: string[]): string | null {
  const candidates: Array<{ text: string; path: string[] }> = [];
  collectNamedValueCandidates(value, candidates);
  collectTextCandidates(value, [], candidates);
  if (!candidates.length) return null;

  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate.text, candidate.path, sentPackets)
    }))
    .sort((a, b) => b.score - a.score);

  const winner = ranked.find((candidate) => candidate.score >= -20);
  return winner ? winner.text : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractConfidence(payload: unknown): number {
  const record = asRecord(payload);
  if (!record) return 0.62;

  const candidates = [record.confidence, record.score, record.probability];
  for (const candidate of candidates) {
    const n = asNumber(candidate);
    if (n !== null) {
      if (n >= 0 && n <= 1) return n;
      if (n > 1 && n <= 100) return n / 100;
    }
  }

  return 0.62;
}

export async function GET(): Promise<NextResponse> {
  const mode = resolveMode();
  return NextResponse.json(
    {
      configured: mode === "airia" && isConfigured(),
      mode
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const mode = resolveMode();

  if (mode !== "airia" || !isConfigured()) {
    return NextResponse.json({ error: "Airia not configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload) {
    return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
  }

  try {
    const apiUrl = resolveApiUrl();
    const apiKey = process.env.AIRIA_API_KEY as string;
    const root = asRecord(payload);
    const kind =
      typeof root?.kind === "string" && root.kind.trim().toLowerCase() === "quiz"
        ? "quiz"
        : "commentary";
    const variables = buildVariablePayload(payload);

    if (!variables.packets.length) {
      return NextResponse.json({ error: "No packet content provided" }, { status: 400 });
    }

    const upstreamRes = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Key": apiKey
      },
      cache: "no-store",
      body: JSON.stringify({
        userInput: variables.packets.join("\n\n"),
        asyncOutput: false,
        variables: { level: variables.level }
      })
    });

    const upstreamJson = await upstreamRes.json().catch(() => null);

    if (!upstreamRes.ok) {
      return NextResponse.json(
        {
          error: "Airia upstream error",
          fallback: {
            text: "Agent unavailable. Local commentary fallback is available.",
            confidence: 0.25
          },
          status: upstreamRes.status
        },
        { status: 502 }
      );
    }

    const text = extractText(upstreamJson, variables.packets);
    if (text) {
      return NextResponse.json({
        text,
        confidence: extractConfidence(upstreamJson)
      });
    }

    if (kind === "quiz") {
      return NextResponse.json({
        text: JSON.stringify(upstreamJson ?? {})
      });
    }

    return NextResponse.json({
      text: "Agent response format not mapped yet. Local commentary fallback can be used.",
      confidence: 0.3,
      todo: "Map provider-specific response format for production routing."
    });
  } catch {
    return NextResponse.json(
      {
        error: "Airia request failed",
        fallback: {
          text: "Agent unavailable. Local commentary fallback is available.",
          confidence: 0.25
        }
      },
      { status: 502 }
    );
  }
}
