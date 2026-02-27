import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_KEYS = [9693, 9912, 9939];
const OPENF1_BASE_URL = process.env.OPENF1_BASE_URL || 'https://api.openf1.org/v1';
const REQUEST_GAP_MS = 550;
const MAX_RETRIES = 6;

const LAP_EMIT_STRIDE = 5;
const INTERVAL_DELTA_THRESHOLD_SEC = 0.8;
const PERIODIC_INTERVAL_MINUTES = 4;
const PERIODIC_WEATHER_MINUTES = 6;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(repoRoot, 'public', 'demo-packs');

let nextRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRequestSlot() {
  const now = Date.now();
  if (now < nextRequestAt) {
    await sleep(nextRequestAt - now);
  }
  nextRequestAt = Date.now() + REQUEST_GAP_MS;
}

function parseRetryAfterMs(value) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return null;
}

function ensureNoLimitParam(params) {
  if (Object.prototype.hasOwnProperty.call(params, 'limit')) {
    throw new Error('The query parameter "limit" is not allowed for demo-pack export.');
  }
}

function buildUrl(endpoint, params) {
  ensureNoLimitParam(params);
  const url = new URL(`${OPENF1_BASE_URL.replace(/\/$/, '')}/${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.append(key, String(value));
  }

  return url;
}

async function fetchJson(endpoint, params, options = {}, attempt = 0) {
  const url = buildUrl(endpoint, params);
  const allow404Empty = options.allow404Empty === true;

  await waitForRequestSlot();
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (res.status === 429) {
    if (attempt >= MAX_RETRIES) {
      const body = await res.text().catch(() => '');
      throw new Error(`429 after ${MAX_RETRIES + 1} attempts for ${url.toString()} ${body}`);
    }

    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    const fallbackBackoffMs = Math.min(1200 * (2 ** attempt), 20000);
    const jitterMs = Math.floor(Math.random() * 250);
    await sleep((retryAfterMs ?? fallbackBackoffMs) + jitterMs);
    return fetchJson(endpoint, params, options, attempt + 1);
  }

  if (res.status >= 500 && attempt < MAX_RETRIES) {
    const backoffMs = Math.min(700 * (2 ** attempt), 12000);
    await sleep(backoffMs);
    return fetchJson(endpoint, params, options, attempt + 1);
  }

  if (allow404Empty && res.status === 404) {
    const bodyText = await res.text().catch(() => '');
    if (bodyText.toLowerCase().includes('no results found')) {
      return [];
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Request failed ${res.status} for ${url.toString()} ${body}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected payload for ${url.toString()} - expected array.`);
  }

  return data;
}

function parseDateMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function getIsoFromRow(row) {
  if (typeof row?.date === 'string') return row.date;
  if (typeof row?.date_start === 'string') return row.date_start;
  if (typeof row?.date_end === 'string') return row.date_end;
  return null;
}

function sortRowsByDate(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const aMs = parseDateMs(a.row?.date);
      const bMs = parseDateMs(b.row?.date);

      if (aMs === null && bMs === null) return a.index - b.index;
      if (aMs === null) return 1;
      if (bMs === null) return -1;
      if (aMs !== bMs) return aMs - bMs;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

async function writeJson(filePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, content, 'utf8');
}

async function writeJsonl(filePath, rows) {
  const lines = rows.map((row) => JSON.stringify(row)).join('\n');
  const content = lines.length > 0 ? `${lines}\n` : '\n';
  await writeFile(filePath, content, 'utf8');
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value);
  if (typeof value !== 'string') return null;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}

function cleanLabel(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function stableHash(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  const normalized = hash >>> 0;
  return normalized.toString(16).padStart(8, '0');
}

function createStableId(parts, payload = null) {
  const raw = `${parts.join('|')}|${payload ? JSON.stringify(payload) : ''}`;
  return `${parts[0]}:${stableHash(raw)}`;
}

function buildTagSet(values) {
  const tags = new Set();
  for (const value of values) {
    if (!value) continue;
    const normalized = String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (normalized) tags.add(normalized);
  }
  return [...tags].slice(0, 10);
}

function selectWilliamsDrivers(drivers) {
  const byNumber = new Map();

  for (const driver of drivers) {
    const teamName = String(driver?.team_name ?? '').toLowerCase();
    if (!teamName.includes('williams')) continue;

    const driverNumber = toNumber(driver?.driver_number);
    if (driverNumber === null) continue;

    if (!byNumber.has(driverNumber)) {
      byNumber.set(driverNumber, driver);
    }
  }

  const selected = [...byNumber.values()].sort((a, b) => {
    const aNum = toNumber(a?.driver_number) ?? 0;
    const bNum = toNumber(b?.driver_number) ?? 0;
    return aNum - bNum;
  });

  if (selected.length !== 2) {
    const names = selected.map((d) => cleanLabel(d?.full_name) || `#${d?.driver_number}`).join(', ');
    throw new Error(
      `Expected exactly 2 Williams drivers, found ${selected.length}${names ? ` (${names})` : ''}.`
    );
  }

  return selected;
}

function driverName(driver) {
  const full = cleanLabel(driver?.full_name);
  if (full) return full;
  const first = cleanLabel(driver?.first_name);
  const last = cleanLabel(driver?.last_name);
  const merged = cleanLabel(`${first} ${last}`);
  if (merged) return merged;
  return `Driver ${driver?.driver_number ?? '?'}`;
}

function carFromDriverNumber(driverNumber, map) {
  const num = toNumber(driverNumber);
  if (num === null) return null;
  if (num === map.A) return 'A';
  if (num === map.B) return 'B';
  return null;
}

function makeEventChunk({
  sessionKey,
  iso,
  car,
  type,
  title,
  summaryBeginner,
  summaryIntermediate,
  summaryExpert,
  tags,
  payloadForId
}) {
  const safeIso = iso || null;
  const id = createStableId(
    ['event', String(sessionKey), type, car, safeIso ?? 'no-date', title],
    payloadForId
  );

  return {
    id,
    session_key: sessionKey,
    iso: safeIso,
    car,
    type,
    title,
    summary_beginner: summaryBeginner,
    summary_intermediate: summaryIntermediate,
    summary_expert: summaryExpert,
    tags
  };
}

function buildPositionEvents(sessionKey, positionRows, car, driverNumber) {
  const events = [];
  let previousPosition = null;

  for (const row of positionRows) {
    const current = toNumber(row?.position);
    if (current === null) continue;

    if (previousPosition !== null && current !== previousPosition) {
      const iso = getIsoFromRow(row);
      const delta = previousPosition - current;
      const movement = delta > 0 ? 'gained' : 'lost';
      const places = Math.abs(delta);
      const moveLabel = places === 1 ? '1 place' : `${places} places`;

      events.push(
        makeEventChunk({
          sessionKey,
          iso,
          car,
          type: 'position_change',
          title: `Car ${car} ${movement} ${moveLabel}`,
          summaryBeginner: `Car ${car} moved from P${previousPosition} to P${current}.`,
          summaryIntermediate: `Car ${car} shifted from P${previousPosition} to P${current}, which can affect clean-air opportunities and pit timing decisions.`,
          summaryExpert: `Car ${car} transitioned P${previousPosition}->P${current}; assess whether this was driven by phase changes, stop cycles, or direct pace differential.`,
          tags: buildTagSet([
            'position',
            'overtake',
            `car-${car.toLowerCase()}`,
            `driver-${driverNumber}`,
            `p${current}`
          ]),
          payloadForId: {
            d: driverNumber,
            from: previousPosition,
            to: current,
            date: iso
          }
        })
      );
    }

    previousPosition = current;
  }

  return events;
}

function buildPitEvents(sessionKey, pitRows, car, driverNumber) {
  return pitRows.map((row) => {
    const iso = getIsoFromRow(row);
    const lap = toNumber(row?.lap_number);
    const lane = cleanLabel(row?.pitlane_time ? `pit lane ${row.pitlane_time}s` : 'pit sequence');

    return makeEventChunk({
      sessionKey,
      iso,
      car,
      type: 'pit',
      title: `Car ${car} pit activity${lap ? ` on lap ${lap}` : ''}`,
      summaryBeginner: `Car ${car} entered pit service${lap ? ` around lap ${lap}` : ''}.`,
      summaryIntermediate: `Car ${car} completed a pit sequence${lap ? ` near lap ${lap}` : ''}, which can reshape tyre phase and traffic position.`,
      summaryExpert: `Car ${car} recorded pit activity${lap ? ` on lap ${lap}` : ''}; review lane loss, out-lap execution, and undercut/overcut exposure.`,
      tags: buildTagSet([
        'pit',
        'strategy',
        `car-${car.toLowerCase()}`,
        `driver-${driverNumber}`,
        lap ? `lap-${lap}` : null,
        lane
      ]),
      payloadForId: row
    });
  });
}

function buildRaceControlEvents(sessionKey, raceControlRows) {
  return raceControlRows.map((row) => {
    const iso = getIsoFromRow(row);
    const category = cleanLabel(row?.category) || 'control';
    const scope = cleanLabel(row?.scope) || 'session';
    const flag = cleanLabel(row?.flag);

    return makeEventChunk({
      sessionKey,
      iso,
      car: 'SESSION',
      type: 'race_control',
      title: `Control update: ${category}${flag ? ` (${flag})` : ''}`,
      summaryBeginner: `Control issued a ${category.toLowerCase()} update affecting session flow.`,
      summaryIntermediate: `A ${category.toLowerCase()} control message was posted for ${scope.toLowerCase()} context and may alter on-track priorities.`,
      summaryExpert: `Control channel logged ${category.toLowerCase()}${flag ? ` with ${flag.toLowerCase()} signal` : ''}; integrate this with risk windows and restart planning.`,
      tags: buildTagSet(['race-control', category, scope, flag || null]),
      payloadForId: row
    });
  });
}

function buildLapEvents(sessionKey, lapRows, car, driverNumber) {
  const events = [];
  const emitted = new Set();

  for (const row of lapRows) {
    const lap = toNumber(row?.lap_number);
    if (lap === null || lap < 1) continue;
    if (lap % LAP_EMIT_STRIDE !== 0) continue;
    if (emitted.has(lap)) continue;
    emitted.add(lap);

    const iso = getIsoFromRow(row);
    const lapTime = cleanLabel(row?.lap_duration ? `${row.lap_duration}s` : 'n/a');

    events.push(
      makeEventChunk({
        sessionKey,
        iso,
        car,
        type: 'lap',
        title: `Car ${car} completed lap ${lap}`,
        summaryBeginner: `Car ${car} reached lap ${lap}.`,
        summaryIntermediate: `Car ${car} reached lap ${lap}; compare this phase to tyre life and pit windows.`,
        summaryExpert: `Lap marker ${lap} for car ${car}; use this checkpoint to benchmark degradation curve and pace offset.`,
        tags: buildTagSet([
          'lap',
          `lap-${lap}`,
          `car-${car.toLowerCase()}`,
          `driver-${driverNumber}`,
          `lap-time-${lapTime}`
        ]),
        payloadForId: {
          date: iso,
          lap,
          driver: driverNumber,
          lap_duration: row?.lap_duration ?? null
        }
      })
    );
  }

  return events;
}

function buildIntervalEvents(sessionKey, intervalRows, driverNumberMap) {
  const events = [];
  const state = new Map();

  for (const row of intervalRows) {
    const iso = getIsoFromRow(row);
    if (!iso) continue;
    const isoMs = parseDateMs(iso);
    if (isoMs === null) continue;

    const car = carFromDriverNumber(row?.driver_number, driverNumberMap) ?? 'SESSION';

    const intervalValue =
      parseSeconds(row?.interval) ??
      parseSeconds(row?.gap_to_leader) ??
      parseSeconds(row?.gap_to_car_ahead);

    const key = `${car}:${row?.driver_number ?? 'session'}`;
    const previous = state.get(key) ?? { lastValue: null, lastEmitMs: null };

    const periodic =
      previous.lastEmitMs === null ||
      isoMs - previous.lastEmitMs >= PERIODIC_INTERVAL_MINUTES * 60 * 1000;

    const significant =
      previous.lastValue === null ||
      intervalValue === null ||
      Math.abs(intervalValue - previous.lastValue) > INTERVAL_DELTA_THRESHOLD_SEC;

    if (periodic || significant) {
      const intervalLabel =
        intervalValue === null ? 'interval update' : `interval ${intervalValue.toFixed(3)}s`;

      events.push(
        makeEventChunk({
          sessionKey,
          iso,
          car,
          type: 'interval',
          title: `${car === 'SESSION' ? 'Session' : `Car ${car}`} ${intervalLabel}`,
          summaryBeginner:
            car === 'SESSION'
              ? 'A timing interval update was recorded for the session.'
              : `Car ${car} has a new timing interval reference.`,
          summaryIntermediate:
            car === 'SESSION'
              ? 'A session-level interval update may indicate broader pace phase shifts.'
              : `Car ${car} interval changed, useful for judging pressure windows and pit crossover risk.`,
          summaryExpert:
            car === 'SESSION'
              ? 'Session-level interval signal updated; correlate with sector evolution and traffic compression.'
              : `Car ${car} interval moved; evaluate whether this reflects pure pace, traffic interaction, or tyre delta.`,
          tags: buildTagSet([
            'interval',
            car === 'SESSION' ? 'session' : `car-${car.toLowerCase()}`,
            row?.driver_number ? `driver-${row.driver_number}` : null
          ]),
          payloadForId: {
            date: iso,
            car,
            driver_number: row?.driver_number ?? null,
            interval: row?.interval ?? null,
            gap_to_leader: row?.gap_to_leader ?? null,
            gap_to_car_ahead: row?.gap_to_car_ahead ?? null
          }
        })
      );

      previous.lastEmitMs = isoMs;
    }

    if (intervalValue !== null) {
      previous.lastValue = intervalValue;
    }

    state.set(key, previous);
  }

  return events;
}

function weatherSignature(row) {
  const fields = [
    row?.air_temperature,
    row?.track_temperature,
    row?.humidity,
    row?.rainfall,
    row?.wind_speed,
    row?.wind_direction
  ];
  return JSON.stringify(fields.map((v) => (v === undefined ? null : v)));
}

function buildWeatherEvents(sessionKey, weatherRows) {
  const events = [];
  let previousSignature = null;
  let lastEmitMs = null;

  for (const row of weatherRows) {
    const iso = getIsoFromRow(row);
    if (!iso) continue;
    const isoMs = parseDateMs(iso);
    if (isoMs === null) continue;

    const signature = weatherSignature(row);
    const changed = previousSignature !== signature;
    const periodic =
      lastEmitMs === null || isoMs - lastEmitMs >= PERIODIC_WEATHER_MINUTES * 60 * 1000;

    if (changed || periodic) {
      const air = toNumber(row?.air_temperature);
      const track = toNumber(row?.track_temperature);
      const rain = toNumber(row?.rainfall);

      const titleParts = [];
      if (air !== null) titleParts.push(`air ${air.toFixed(1)}C`);
      if (track !== null) titleParts.push(`track ${track.toFixed(1)}C`);
      if (rain !== null) titleParts.push(`rain ${rain.toFixed(1)}`);

      const title = titleParts.length > 0 ? `Weather ${titleParts.join(', ')}` : 'Weather update';

      events.push(
        makeEventChunk({
          sessionKey,
          iso,
          car: 'SESSION',
          type: 'weather',
          title,
          summaryBeginner: 'Weather conditions changed and may affect grip and consistency.',
          summaryIntermediate:
            'Weather inputs shifted; monitor balance changes and tyre warm-up response in the next laps.',
          summaryExpert:
            'Weather state updated; reassess compound operating window, thermal load, and timing model sensitivity.',
          tags: buildTagSet(['weather', air !== null ? `air-${air}` : null, track !== null ? `track-${track}` : null]),
          payloadForId: row
        })
      );

      lastEmitMs = isoMs;
      previousSignature = signature;
    }
  }

  return events;
}

function sortKnowledgeByIso(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const aMs = parseDateMs(a.row?.iso);
      const bMs = parseDateMs(b.row?.iso);
      if (aMs === null && bMs === null) return a.index - b.index;
      if (aMs === null) return 1;
      if (bMs === null) return -1;
      if (aMs !== bMs) return aMs - bMs;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

function buildKnowledgeEvents(sessionKey, replay, driverNumberMap) {
  const events = [];

  events.push(
    ...buildPositionEvents(sessionKey, replay.positionA, 'A', driverNumberMap.A),
    ...buildPositionEvents(sessionKey, replay.positionB, 'B', driverNumberMap.B),
    ...buildPitEvents(sessionKey, replay.pitA, 'A', driverNumberMap.A),
    ...buildPitEvents(sessionKey, replay.pitB, 'B', driverNumberMap.B),
    ...buildRaceControlEvents(sessionKey, replay.raceControl),
    ...buildLapEvents(sessionKey, replay.lapsA, 'A', driverNumberMap.A),
    ...buildLapEvents(sessionKey, replay.lapsB, 'B', driverNumberMap.B),
    ...buildIntervalEvents(sessionKey, replay.intervals, driverNumberMap),
    ...buildWeatherEvents(sessionKey, replay.weather)
  );

  return sortKnowledgeByIso(events);
}

function buildKnowledgeRadios(sessionKey, radioRows, driverNumberMap) {
  const rows = [];

  for (const row of radioRows) {
    const driverNumber = toNumber(row?.driver_number);
    if (driverNumber === null) continue;

    const car = carFromDriverNumber(driverNumber, driverNumberMap);
    if (!car) continue;

    const iso = getIsoFromRow(row);
    const lap = toNumber(row?.lap_number);

    rows.push({
      id: createStableId(
        ['radio', String(sessionKey), car, iso ?? 'no-date', String(driverNumber), String(lap ?? 'na')],
        row
      ),
      session_key: sessionKey,
      iso: iso || null,
      car,
      driver_number: driverNumber,
      lap_number: lap,
      recording_url: row?.recording_url ?? null,
      title: 'Radio clip available',
      listening_guide_beginner:
        'Listen for short cues about immediate priorities, pace comfort, or timing references.',
      listening_guide_intermediate:
        'Focus on timing, tyre condition language, and whether the call hints at a near-term strategy change.',
      listening_guide_expert:
        'Use tone, cadence, and timing context to infer confidence, execution risk, and planned sequence transitions.',
      tags: buildTagSet([
        'radio',
        `car-${car.toLowerCase()}`,
        `driver-${driverNumber}`,
        lap ? `lap-${lap}` : null
      ])
    });
  }

  return sortKnowledgeByIso(rows);
}

function buildKnowledgeGlossary() {
  const entries = [
    {
      key: 'pit-stop',
      title: 'Pit Stop',
      beginner: 'A planned service break where tyres are changed and quick adjustments can be made.',
      intermediate: 'A pit stop trades track position for fresher tyres or setup tweaks to improve later pace.',
      expert: 'Stop timing balances lane-loss model, tyre offset projection, and local traffic release probability.',
      tags: ['strategy', 'pit', 'tyres']
    },
    {
      key: 'undercut',
      title: 'Undercut',
      beginner: 'Stopping earlier to use fresh tyres and gain time before a rival stops.',
      intermediate: 'An undercut works when tyre warm-up is quick and traffic allows immediate pace extraction.',
      expert: 'Undercut value depends on out-lap delta, tyre prep efficiency, and rival in-lap degradation slope.',
      tags: ['strategy', 'pit', 'track-position']
    },
    {
      key: 'overcut',
      title: 'Overcut',
      beginner: 'Staying out longer to gain time before taking a pit stop.',
      intermediate: 'An overcut is stronger when old tyres remain stable and pit-lane loss is high.',
      expert: 'Overcut success is tied to retained pace on aging tyres and predictable release into clean air.',
      tags: ['strategy', 'pit', 'track-position']
    },
    {
      key: 'drs',
      title: 'DRS',
      beginner: 'A rear-wing aid that can reduce drag in specific zones to support overtaking.',
      intermediate: 'DRS effect depends on gap management, exit speed, and deployment zone characteristics.',
      expert: 'DRS utility is a function of delta-v potential, preceding-corner compromise, and defensive battery state.',
      tags: ['overtake', 'aero', 'speed']
    },
    {
      key: 'tyre-degradation',
      title: 'Tyre Degradation',
      beginner: 'The gradual performance drop of tyres over laps.',
      intermediate: 'Degradation shifts braking stability and traction, often driving strategy decisions.',
      expert: 'Model degradation with thermal cycles, surface energy, and compound-specific wear sensitivity.',
      tags: ['tyres', 'pace', 'strategy']
    },
    {
      key: 'track-position',
      title: 'Track Position',
      beginner: 'Where a car runs in the order on track.',
      intermediate: 'Track position controls clean air access and determines overtaking pressure.',
      expert: 'Track position value is context-dependent on phase, delta trends, and pit-release topology.',
      tags: ['position', 'strategy', 'traffic']
    },
    {
      key: 'delta-time',
      title: 'Delta Time',
      beginner: 'The time difference between two cars or two laps.',
      intermediate: 'Delta indicates whether a car is gaining or losing pace in real time.',
      expert: 'Delta decomposition across sectors isolates entry, apex, and traction contributions.',
      tags: ['timing', 'pace', 'analysis']
    },
    {
      key: 'safety-car',
      title: 'Safety Car Phase',
      beginner: 'A neutralized phase that slows the field for safety reasons.',
      intermediate: 'This phase reshapes pit opportunity and can compress time gaps.',
      expert: 'Safety phase optimization targets stack risk, restart tyre state, and launch positioning.',
      tags: ['control', 'strategy', 'risk']
    },
    {
      key: 'yellow-flag',
      title: 'Yellow Flag',
      beginner: 'A caution signal requiring reduced speed in a specific area.',
      intermediate: 'Yellow zones alter lap rhythm and can invalidate comparison laps.',
      expert: 'Yellow compliance management protects penalty exposure while preserving tyre and thermal targets.',
      tags: ['flags', 'control', 'safety']
    },
    {
      key: 'red-flag',
      title: 'Red Flag',
      beginner: 'A stop signal that pauses the session.',
      intermediate: 'A red phase can reset strategy assumptions and tyre plans.',
      expert: 'Red-phase restarts require recalibrated warm-up protocols and traffic-window forecasts.',
      tags: ['flags', 'control', 'restart']
    },
    {
      key: 'green-flag',
      title: 'Green Flag',
      beginner: 'Signal that normal pace and racing conditions are resumed.',
      intermediate: 'Green conditions restore full attack options and overtaking attempts.',
      expert: 'Green resumption is a high-volatility window with elevated opportunity-cost sensitivity.',
      tags: ['flags', 'restart', 'pace']
    },
    {
      key: 'sector',
      title: 'Sector',
      beginner: 'A lap is split into timed sections called sectors.',
      intermediate: 'Sector comparison reveals where pace is gained or lost.',
      expert: 'Sector vectors support targeted setup feedback and corner-cluster optimization.',
      tags: ['timing', 'analysis', 'pace']
    },
    {
      key: 'in-lap',
      title: 'In-Lap',
      beginner: 'The lap driven immediately before entering the pit lane.',
      intermediate: 'A strong in-lap helps offset the time cost of stopping.',
      expert: 'In-lap execution hinges on thermal preservation and pit-entry precision.',
      tags: ['pit', 'strategy', 'timing']
    },
    {
      key: 'out-lap',
      title: 'Out-Lap',
      beginner: 'The lap driven right after leaving the pit lane.',
      intermediate: 'Out-lap speed determines whether a strategy move gains or loses ground.',
      expert: 'Out-lap quality is governed by tyre prep trajectory and traffic-limited corner phases.',
      tags: ['pit', 'strategy', 'tyres']
    },
    {
      key: 'warmup',
      title: 'Tyre Warm-Up',
      beginner: 'Bringing tyres into an effective grip window after a stop or slow phase.',
      intermediate: 'Warm-up pace varies by compound and track conditions.',
      expert: 'Warm-up control blends slip energy, carcass temperature rise, and surface activation.',
      tags: ['tyres', 'pace', 'thermal']
    },
    {
      key: 'dirty-air',
      title: 'Dirty Air',
      beginner: 'Turbulent air behind another car that can reduce front grip.',
      intermediate: 'Dirty air often increases tyre stress and makes close following difficult.',
      expert: 'Wake turbulence changes aero balance and elevates front thermal loading through medium-speed phases.',
      tags: ['aero', 'traffic', 'tyres']
    },
    {
      key: 'clean-air',
      title: 'Clean Air',
      beginner: 'Running with clear space ahead for more stable grip.',
      intermediate: 'Clean air usually improves consistency and tyre management.',
      expert: 'Clean-air operation improves aero stability and enables higher repeatability of corner targets.',
      tags: ['aero', 'pace', 'strategy']
    },
    {
      key: 'slipstream',
      title: 'Slipstream',
      beginner: 'Using reduced drag behind another car to gain speed on straights.',
      intermediate: 'Slipstream timing is crucial for setting up overtakes in braking zones.',
      expert: 'Slipstream gain depends on closure profile, battery state, and preceding corner compromise.',
      tags: ['overtake', 'aero', 'speed']
    },
    {
      key: 'degradation-cliff',
      title: 'Degradation Cliff',
      beginner: 'A point where tyre performance drops sharply instead of gradually.',
      intermediate: 'Hitting the cliff can force earlier-than-planned strategy changes.',
      expert: 'Cliff onset is non-linear and tied to compound thermal saturation and surface abrasion state.',
      tags: ['tyres', 'strategy', 'pace']
    },
    {
      key: 'stint',
      title: 'Stint',
      beginner: 'A continuous run between pit stops.',
      intermediate: 'Each stint has a pace profile that changes as tyres age.',
      expert: 'Stint modeling combines launch phase, plateau, and end-of-life decay to optimize timing.',
      tags: ['strategy', 'tyres', 'pace']
    },
    {
      key: 'compound',
      title: 'Tyre Compound',
      beginner: 'A tyre type with its own grip and durability characteristics.',
      intermediate: 'Compound choice balances short-term speed versus stint length.',
      expert: 'Compound selection is a constrained optimization across warm-up, degradation, and traffic risk.',
      tags: ['tyres', 'strategy', 'setup']
    },
    {
      key: 'traffic',
      title: 'Traffic Window',
      beginner: 'The on-track gaps where a car may rejoin after a pit stop.',
      intermediate: 'Joining in traffic can erase gains from fresh tyres.',
      expert: 'Traffic-window accuracy requires probabilistic release forecasts and pace-distribution modeling.',
      tags: ['strategy', 'pit', 'traffic']
    },
    {
      key: 'lift-and-coast',
      title: 'Lift and Coast',
      beginner: 'Easing off throttle before braking to save energy and manage temperatures.',
      intermediate: 'Used to control consumption while minimizing lap-time loss.',
      expert: 'Lift-coast scheduling redistributes energy demand and moderates brake thermal spikes.',
      tags: ['energy', 'management', 'brakes']
    },
    {
      key: 'battery-deploy',
      title: 'Energy Deployment',
      beginner: 'Using stored electrical energy to boost speed at key points.',
      intermediate: 'Deployment strategy affects attack and defense phases.',
      expert: 'Energy deployment maps should align with overtaking probability and sector sensitivity.',
      tags: ['energy', 'overtake', 'defense']
    },
    {
      key: 'brake-balance',
      title: 'Brake Balance',
      beginner: 'The front-rear distribution of braking force.',
      intermediate: 'Adjusting balance changes entry stability and lock-up risk.',
      expert: 'Brake balance tuning interacts with fuel load, tyre state, and corner archetype distribution.',
      tags: ['setup', 'braking', 'handling']
    },
    {
      key: 'track-evolution',
      title: 'Track Evolution',
      beginner: 'Grip changes over time as rubber is laid down and conditions shift.',
      intermediate: 'Evolution alters lap references and strategy assumptions.',
      expert: 'Evolution rate should be modeled with temperature trend and session density inputs.',
      tags: ['track', 'grip', 'strategy']
    },
    {
      key: 'formation-lap',
      title: 'Formation Lap',
      beginner: 'The lap before the start used to prepare tyres and systems.',
      intermediate: 'Preparation quality influences launch confidence and first-lap behavior.',
      expert: 'Formation execution targets tyre temperature symmetry and clutch-bite repeatability.',
      tags: ['start', 'preparation', 'tyres']
    },
    {
      key: 'restart',
      title: 'Restart',
      beginner: 'Resumption of full pace after a neutralized phase.',
      intermediate: 'Restarts are high-opportunity moments for position changes.',
      expert: 'Restart success depends on thermal readiness, positioning, and acceleration phase timing.',
      tags: ['control', 'overtake', 'risk']
    },
    {
      key: 'track-limits',
      title: 'Track Limits',
      beginner: 'Rules defining how much of the circuit can be used legally.',
      intermediate: 'Repeated violations can lead to warnings or penalties.',
      expert: 'Limit management is a risk-budget exercise balancing lap-time gain versus sanction probability.',
      tags: ['rules', 'risk', 'consistency']
    },
    {
      key: 'vsc',
      title: 'Virtual Safety Car',
      beginner: 'A controlled slow phase without a physical safety car on track.',
      intermediate: 'This phase compresses strategic options and can reshape pit timing value.',
      expert: 'VSC optimization centers on delta compliance while minimizing thermal and pace disruption.',
      tags: ['control', 'strategy', 'timing']
    }
  ];

  return entries.map((entry) => ({
    id: `glossary:${entry.key}`,
    title: entry.title,
    beginner: entry.beginner,
    intermediate: entry.intermediate,
    expert: entry.expert,
    tags: entry.tags
  }));
}

function filterRowsByDriver(rows, driverNumber) {
  return rows.filter((row) => toNumber(row?.driver_number) === driverNumber);
}

function getAllDriverNumbers(drivers) {
  const numbers = new Set();
  for (const driver of drivers) {
    const driverNumber = toNumber(driver?.driver_number);
    if (driverNumber !== null) {
      numbers.add(driverNumber);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

async function fetchRowsForAllDrivers(endpoint, sessionKey, driverNumbers) {
  const rows = [];
  for (const driverNumber of driverNumbers) {
    const driverRows = await fetchJson(
      endpoint,
      { session_key: sessionKey, driver_number: driverNumber },
      { allow404Empty: true }
    );
    rows.push(...driverRows);
  }
  return rows;
}

async function buildSessionPack(sessionKey) {
  console.log(`\nBuilding session ${sessionKey}...`);

  const sessions = await fetchJson('sessions', { session_key: sessionKey });
  if (sessions.length === 0) {
    throw new Error(`No session found for session_key=${sessionKey}`);
  }

  const drivers = await fetchJson('drivers', { session_key: sessionKey });
  const allDriverNumbers = getAllDriverNumbers(drivers);
  const williamsDrivers = selectWilliamsDrivers(drivers);

  const driverA = williamsDrivers[0];
  const driverB = williamsDrivers[1];
  const driverNumberA = toNumber(driverA.driver_number);
  const driverNumberB = toNumber(driverB.driver_number);

  if (driverNumberA === null || driverNumberB === null) {
    throw new Error(`Invalid driver numbers for session ${sessionKey}.`);
  }

  const driverMap = { A: driverNumberA, B: driverNumberB };

  const positionAll = await fetchRowsForAllDrivers('position', sessionKey, allDriverNumbers);
  const locationAll = await fetchRowsForAllDrivers('location', sessionKey, allDriverNumbers);
  const lapsA = await fetchJson(
    'laps',
    { session_key: sessionKey, driver_number: driverNumberA },
    { allow404Empty: true }
  );
  const lapsB = await fetchJson(
    'laps',
    { session_key: sessionKey, driver_number: driverNumberB },
    { allow404Empty: true }
  );
  const pitA = await fetchJson(
    'pit',
    { session_key: sessionKey, driver_number: driverNumberA },
    { allow404Empty: true }
  );
  const pitB = await fetchJson(
    'pit',
    { session_key: sessionKey, driver_number: driverNumberB },
    { allow404Empty: true }
  );
  const teamRadioA = await fetchJson(
    'team_radio',
    { session_key: sessionKey, driver_number: driverNumberA },
    { allow404Empty: true }
  );
  const teamRadioB = await fetchJson(
    'team_radio',
    { session_key: sessionKey, driver_number: driverNumberB },
    { allow404Empty: true }
  );
  const raceControl = await fetchJson('race_control', { session_key: sessionKey }, { allow404Empty: true });
  const intervals = await fetchJson('intervals', { session_key: sessionKey }, { allow404Empty: true });
  const weather = await fetchJson('weather', { session_key: sessionKey }, { allow404Empty: true });

  const replay = {
    positionAll: sortRowsByDate(positionAll),
    positionA: sortRowsByDate(filterRowsByDriver(positionAll, driverNumberA)),
    positionB: sortRowsByDate(filterRowsByDriver(positionAll, driverNumberB)),
    locationAll: sortRowsByDate(locationAll),
    locationA: sortRowsByDate(filterRowsByDriver(locationAll, driverNumberA)),
    locationB: sortRowsByDate(filterRowsByDriver(locationAll, driverNumberB)),
    lapsA: sortRowsByDate(lapsA),
    lapsB: sortRowsByDate(lapsB),
    pitA: sortRowsByDate(pitA),
    pitB: sortRowsByDate(pitB),
    teamRadio: sortRowsByDate([...teamRadioA, ...teamRadioB]),
    raceControl: sortRowsByDate(raceControl),
    intervals: sortRowsByDate(intervals),
    weather: sortRowsByDate(weather)
  };

  const knowledgeEvents = buildKnowledgeEvents(sessionKey, replay, driverMap);
  const knowledgeRadios = buildKnowledgeRadios(sessionKey, replay.teamRadio, driverMap);
  const knowledgeGlossary = buildKnowledgeGlossary();

  const sessionDir = path.join(outputRoot, String(sessionKey));
  const replayDir = path.join(sessionDir, 'replay');
  const airiaDir = path.join(sessionDir, 'airia');

  await rm(sessionDir, { recursive: true, force: true });
  await mkdir(replayDir, { recursive: true });
  await mkdir(airiaDir, { recursive: true });

  const meta = {
    session_key: sessionKey,
    generated_at: new Date().toISOString(),
    openf1_base_url: OPENF1_BASE_URL,
    session: sessions[0],
    replay_counts: {
      position_all: replay.positionAll.length,
      position_A: replay.positionA.length,
      position_B: replay.positionB.length,
      location_all: replay.locationAll.length,
      location_A: replay.locationA.length,
      location_B: replay.locationB.length,
      laps_A: replay.lapsA.length,
      laps_B: replay.lapsB.length,
      pit_A: replay.pitA.length,
      pit_B: replay.pitB.length,
      team_radio: replay.teamRadio.length,
      race_control: replay.raceControl.length,
      intervals: replay.intervals.length,
      weather: replay.weather.length
    },
    knowledge_counts: {
      events: knowledgeEvents.length,
      radios: knowledgeRadios.length,
      glossary: knowledgeGlossary.length
    }
  };

  const williamsInfo = {
    session_key: sessionKey,
    team_name: 'Williams',
    car_A: {
      driver_number: driverNumberA,
      full_name: driverName(driverA)
    },
    car_B: {
      driver_number: driverNumberB,
      full_name: driverName(driverB)
    }
  };

  await writeJson(path.join(sessionDir, 'meta.json'), meta);
  await writeJson(path.join(sessionDir, 'drivers.json'), drivers);
  await writeJson(path.join(sessionDir, 'williams.json'), williamsInfo);

  await writeJsonl(path.join(replayDir, 'position_A.jsonl'), replay.positionA);
  await writeJsonl(path.join(replayDir, 'position_B.jsonl'), replay.positionB);
  await writeJsonl(path.join(replayDir, 'position_all.jsonl'), replay.positionAll);
  await writeJsonl(path.join(replayDir, 'location_A.jsonl'), replay.locationA);
  await writeJsonl(path.join(replayDir, 'location_B.jsonl'), replay.locationB);
  await writeJsonl(path.join(replayDir, 'location_all.jsonl'), replay.locationAll);
  await writeJsonl(path.join(replayDir, 'laps_A.jsonl'), replay.lapsA);
  await writeJsonl(path.join(replayDir, 'laps_B.jsonl'), replay.lapsB);
  await writeJsonl(path.join(replayDir, 'pit_A.jsonl'), replay.pitA);
  await writeJsonl(path.join(replayDir, 'pit_B.jsonl'), replay.pitB);
  await writeJsonl(path.join(replayDir, 'team_radio.jsonl'), replay.teamRadio);
  await writeJsonl(path.join(replayDir, 'race_control.jsonl'), replay.raceControl);
  await writeJsonl(path.join(replayDir, 'intervals.jsonl'), replay.intervals);
  await writeJsonl(path.join(replayDir, 'weather.jsonl'), replay.weather);

  await writeJsonl(path.join(airiaDir, 'knowledge_events.jsonl'), knowledgeEvents);
  await writeJsonl(path.join(airiaDir, 'knowledge_radios.jsonl'), knowledgeRadios);
  await writeJsonl(path.join(airiaDir, 'knowledge_glossary.jsonl'), knowledgeGlossary);

  console.log(
    `Session ${sessionKey} complete. Drivers: #${driverNumberA} ${driverName(driverA)} | #${driverNumberB} ${driverName(driverB)}`
  );
}

async function main() {
  await mkdir(outputRoot, { recursive: true });

  for (const sessionKey of SESSION_KEYS) {
    await buildSessionPack(sessionKey);
  }

  console.log('\nAll demo packs generated successfully.');
}

main().catch((error) => {
  console.error('\nFailed to build demo packs.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
