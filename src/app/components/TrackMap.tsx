import { useRef } from "react";
import { motion } from "framer-motion";
import EmptyState from "@/app/components/EmptyState";
import { FocusMode, Snapshot, TrackPoint } from "@/lib/types";

interface TrackMapProps {
  snapshot: Snapshot;
  focusMode?: FocusMode;
}

interface SvgPoint {
  x: number;
  y: number;
}

const WIDTH = 860;
const HEIGHT = 430;
const PADDING = 28;

function normalizePoint(
  point: TrackPoint,
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
): SvgPoint {
  const drawW = WIDTH - PADDING * 2;
  const drawH = HEIGHT - PADDING * 2;

  const xSpan = Math.max(1, bounds.maxX - bounds.minX);
  const ySpan = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(drawW / xSpan, drawH / ySpan);

  const usedW = xSpan * scale;
  const usedH = ySpan * scale;
  const offsetX = PADDING + (drawW - usedW) / 2;
  const offsetY = PADDING + (drawH - usedH) / 2;

  const x = offsetX + (point.x - bounds.minX) * scale;
  const y = offsetY + (point.y - bounds.minY) * scale;

  return { x, y: HEIGHT - y };
}

function toPolyline(points: SvgPoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function abbrFromName(name: string | null, fallback: string): string {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? name;
  const token = last.replace(/[^A-Za-z]/g, "").toUpperCase();
  return token.slice(0, 3) || fallback;
}

function hasFiniteCoords(x: number | null | undefined, y: number | null | undefined): boolean {
  return Number.isFinite(x) && Number.isFinite(y);
}

export default function TrackMap({ snapshot, focusMode = "both" }: TrackMapProps) {
  const cacheSessionRef = useRef(snapshot.sessionKey);
  const carPointCacheRef = useRef<{ A: TrackPoint | null; B: TrackPoint | null }>({
    A: null,
    B: null
  });

  if (cacheSessionRef.current !== snapshot.sessionKey) {
    cacheSessionRef.current = snapshot.sessionKey;
    carPointCacheRef.current = { A: null, B: null };
  }

  if (snapshot.cars.A.state === "OUT") {
    carPointCacheRef.current.A = null;
  } else if (snapshot.cars.A.x !== null && snapshot.cars.A.y !== null) {
    carPointCacheRef.current.A = {
      iso: snapshot.nowDataIso,
      x: snapshot.cars.A.x,
      y: snapshot.cars.A.y
    };
  }

  if (snapshot.cars.B.state === "OUT") {
    carPointCacheRef.current.B = null;
  } else if (snapshot.cars.B.x !== null && snapshot.cars.B.y !== null) {
    carPointCacheRef.current.B = {
      iso: snapshot.nowDataIso,
      x: snapshot.cars.B.x,
      y: snapshot.cars.B.y
    };
  }

  const highlightedSlot: "A" | "B" | null =
    focusMode === "carA" ? "A" : focusMode === "carB" ? "B" : null;

  const livePointA = snapshot.cars.A.state === "OUT" ? null : carPointCacheRef.current.A;
  const livePointB = snapshot.cars.B.state === "OUT" ? null : carPointCacheRef.current.B;
  const driverA = snapshot.cars.A.driverNumber;
  const driverB = snapshot.cars.B.driverNumber;

  const fallbackOutline: TrackPoint[] = [...snapshot.cars.A.trail, ...snapshot.cars.B.trail];

  const trackOutline = snapshot.trackOutline.length ? snapshot.trackOutline : fallbackOutline;

  const allPoints = [
    ...trackOutline,
    ...(livePointA ? [livePointA] : []),
    ...(livePointB ? [livePointB] : [])
  ];

  if (!allPoints.length) {
    return <EmptyState title="Vector map idle" hint="Start stream to project live car trajectories." />;
  }

  const boundsSource = trackOutline.length > 1 ? trackOutline : allPoints;
  const bounds = boundsSource.reduce(
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

  const outlinePoints = trackOutline.map((point) => normalizePoint(point, bounds));

  const markerA = livePointA ? normalizePoint(livePointA, bounds) : null;
  const markerB = livePointB ? normalizePoint(livePointB, bounds) : null;
  const otherMarkers = snapshot.otherCars
    .filter((car) => car.driverNumber !== driverA && car.driverNumber !== driverB)
    .filter((car) => hasFiniteCoords(car.x, car.y))
    .map((car) => ({
      driverNumber: car.driverNumber,
      point: normalizePoint(
        { iso: car.updatedIso ?? snapshot.nowDataIso, x: car.x, y: car.y },
        bounds
      )
    }));

  const transition = {
    type: "spring" as const,
    stiffness: 70,
    damping: 22,
    mass: 0.85
  };

  const abbrA = abbrFromName(snapshot.cars.A.driverName, "A");
  const abbrB = abbrFromName(snapshot.cars.B.driverName, "B");
  const isAHighlighted = highlightedSlot === null || highlightedSlot === "A";
  const isBHighlighted = highlightedSlot === null || highlightedSlot === "B";
  const primaryRadius = 5.2;
  const secondaryRadius = 4;

  return (
    <div className="relative flex h-full min-h-[250px] flex-col overflow-hidden rounded-xl border border-white/10 bg-slate-950/92 p-1 sm:min-h-[280px] xl:min-h-[220px]">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="relative h-full min-h-[250px] w-full flex-1 overflow-hidden rounded-lg sm:min-h-[280px] xl:min-h-[220px]"
      >
        <defs>
          <filter id="dotGlow">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {outlinePoints.length > 1 ? (
          <polyline
            fill="none"
            stroke="rgba(148, 204, 255, 0.78)"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={toPolyline(outlinePoints)}
            opacity="0.94"
          />
        ) : null}

        {otherMarkers.map((marker) => (
          <motion.circle
            key={`other-${marker.driverNumber}`}
            r={2.6}
            fill="rgba(186, 214, 255, 0.66)"
            stroke="rgba(214, 233, 255, 0.44)"
            strokeWidth={0.8}
            initial={false}
            animate={{ cx: marker.point.x, cy: marker.point.y }}
            transition={transition}
          />
        ))}

        {markerA ? (
          <g>
            <motion.circle
              r={isAHighlighted ? primaryRadius : secondaryRadius}
              fill={isAHighlighted ? "#5ec6ff" : "rgba(139, 197, 244, 0.72)"}
              stroke={isAHighlighted ? "#ffffff" : "rgba(200, 223, 255, 0.58)"}
              strokeWidth={isAHighlighted ? 1.9 : 1.2}
              filter={isAHighlighted ? "url(#dotGlow)" : undefined}
              initial={false}
              animate={{ cx: markerA.x, cy: markerA.y }}
              transition={transition}
            />
            <motion.text
              fontSize={isAHighlighted ? "10" : "9"}
              fontWeight={isAHighlighted ? "700" : "600"}
              fill={isAHighlighted ? "#ccf1ff" : "rgba(209, 235, 255, 0.72)"}
              textAnchor="middle"
              initial={false}
              animate={{ x: markerA.x, y: markerA.y - (isAHighlighted ? 12 : 10) }}
              transition={transition}
            >
              {abbrA}
            </motion.text>
          </g>
        ) : null}

        {markerB ? (
          <g>
            <motion.circle
              r={isBHighlighted ? primaryRadius : secondaryRadius}
              fill={isBHighlighted ? "#2b92ff" : "rgba(129, 170, 241, 0.7)"}
              stroke={isBHighlighted ? "#ffffff" : "rgba(196, 219, 255, 0.58)"}
              strokeWidth={isBHighlighted ? 1.9 : 1.2}
              filter={isBHighlighted ? "url(#dotGlow)" : undefined}
              initial={false}
              animate={{ cx: markerB.x, cy: markerB.y }}
              transition={transition}
            />
            <motion.text
              fontSize={isBHighlighted ? "10" : "9"}
              fontWeight={isBHighlighted ? "700" : "600"}
              fill={isBHighlighted ? "#d4e7ff" : "rgba(214, 229, 255, 0.72)"}
              textAnchor="middle"
              initial={false}
              animate={{ x: markerB.x, y: markerB.y - (isBHighlighted ? 12 : 10) }}
              transition={transition}
            >
              {abbrB}
            </motion.text>
          </g>
        ) : null}
      </svg>
    </div>
  );
}
