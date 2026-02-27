import { NextRequest, NextResponse } from "next/server";

const ALLOWED_PATHS = new Set([
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
  "overtakes",
  "stints",
  "car_data"
]);

const OPEN_BASE = process.env.OPENF1_BASE_URL ?? "https://api.openf1.org/v1";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path");

  if (!path || !ALLOWED_PATHS.has(path)) {
    return NextResponse.json(
      {
        error:
          "Invalid path. Allowed paths: sessions, drivers, position, location, pit, team_radio, race_control, weather, laps, intervals, overtakes, stints, car_data."
      },
      { status: 400 }
    );
  }

  const upstream = new URL(`${OPEN_BASE.replace(/\/$/, "")}/${path}`);

  for (const [key, value] of searchParams.entries()) {
    if (key === "path") continue;
    upstream.searchParams.append(key, value);
  }

  try {
    const response = await fetch(upstream.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    const text = await response.text();
    const retryAfter = response.headers.get("retry-after");

    const headers = new Headers({
      "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
      "Cache-Control": "public, s-maxage=2, stale-while-revalidate=8"
    });

    if (retryAfter) {
      headers.set("Retry-After", retryAfter);
    }

    return new NextResponse(text, {
      status: response.status,
      headers
    });
  } catch {
    return NextResponse.json(
      { error: "Upstream data source unavailable" },
      { status: 502 }
    );
  }
}
