import { motion } from "framer-motion";
import { CarState } from "@/lib/types";

interface TelemetryVisualProps {
  car: CarState;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad)
  };
}

function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  endDeg: number,
  sweepFlag: 0 | 1
): string {
  const start = polarToCartesian(cx, cy, radius, startDeg);
  const end = polarToCartesian(cx, cy, radius, endDeg);
  const delta =
    sweepFlag === 1
      ? (endDeg - startDeg + 360) % 360
      : (startDeg - endDeg + 360) % 360;
  const largeArc = delta > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} ${sweepFlag} ${end.x} ${end.y}`;
}

export default function TelemetryVisual({ car }: TelemetryVisualProps) {
  const throttle = clampPercent(car.telemetry.throttlePct);
  const brake = clampPercent(car.telemetry.brakePct);

  const cx = 160;
  const cy = 160;
  const arcRadius = 110;
  const arcWidth = 28;
  const brakeTrackArc = describeArc(cx, cy, arcRadius, 204, 336, 1);
  const throttleTrackArc = describeArc(cx, cy, arcRadius, 156, 24, 0);

  return (
    <motion.article
      key={`telemetry-${car.slot}-${car.driverNumber ?? "na"}`}
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.98 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="panel-shell relative flex h-full min-h-0 items-center justify-center overflow-hidden rounded-[1rem] p-3"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_34%,rgba(42,184,255,0.14),transparent_64%)]" />

      <svg viewBox="0 0 320 320" className="relative h-full max-h-[340px] w-full max-w-[340px]">
        <circle cx="160" cy="160" r="146" fill="rgba(2,6,14,0.9)" stroke="rgba(160,192,232,0.2)" strokeWidth="1.2" />

        <path d={brakeTrackArc} fill="none" stroke="rgba(255,98,98,0.2)" strokeWidth={arcWidth} strokeLinecap="round" />
        <motion.path
          d={brakeTrackArc}
          fill="none"
          stroke="#ff6a6a"
          strokeWidth={arcWidth}
          strokeLinecap="round"
          initial={false}
          animate={{ pathLength: brake / 100 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        />

        <path d={throttleTrackArc} fill="none" stroke="rgba(96,172,255,0.2)" strokeWidth={arcWidth} strokeLinecap="round" />
        <motion.path
          d={throttleTrackArc}
          fill="none"
          stroke="#65a6ff"
          strokeWidth={arcWidth}
          strokeLinecap="round"
          initial={false}
          animate={{ pathLength: throttle / 100 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        />

        <text
          x="79"
          y="160"
          textAnchor="middle"
          fill="rgba(244,247,255,0.95)"
          fontSize="11"
          fontWeight="700"
          letterSpacing="0.06em"
          transform="rotate(-90 79 160)"
          paintOrder="stroke"
          stroke="rgba(10,16,32,0.86)"
          strokeWidth="2"
        >
          <tspan x="79" dy="-6">
            BRAKE
          </tspan>
          <tspan x="79" dy="15">
            {Math.round(brake)}%
          </tspan>
        </text>

        <text
          x="241"
          y="160"
          textAnchor="middle"
          fill="rgba(244,247,255,0.95)"
          fontSize="11"
          fontWeight="700"
          letterSpacing="0.06em"
          transform="rotate(90 241 160)"
          paintOrder="stroke"
          stroke="rgba(10,16,32,0.86)"
          strokeWidth="2"
        >
          <tspan x="241" dy="-6">
            THROTTLE
          </tspan>
          <tspan x="241" dy="15">
            {Math.round(throttle)}%
          </tspan>
        </text>

        <text x="160" y="106" textAnchor="middle" fill="#f4f7ff" fontSize="58" fontWeight="700" fontFamily="var(--font-display)">
          {Math.round(car.telemetry.speedKph)}
        </text>
        <text x="160" y="128" textAnchor="middle" fill="rgba(226,236,255,0.84)" fontSize="16" fontWeight="700" letterSpacing="0.09em">
          KMH
        </text>

        <text x="160" y="167" textAnchor="middle" fill="#ecf2ff" fontSize="36" fontWeight="700" fontFamily="var(--font-display)">
          {Math.round(car.telemetry.rpm)}
        </text>
        <text x="160" y="186" textAnchor="middle" fill="rgba(208,222,246,0.8)" fontSize="13" fontWeight="600" letterSpacing="0.08em">
          RPM
        </text>

        <rect
          x="121"
          y="194"
          width="78"
          height="30"
          rx="8"
          fill={car.telemetry.drs ? "rgba(104,255,154,0.16)" : "rgba(140,154,180,0.12)"}
          stroke={car.telemetry.drs ? "rgba(112,255,176,0.85)" : "rgba(178,192,220,0.35)"}
          strokeWidth="2"
        />
        <text x="160" y="214" textAnchor="middle" fill={car.telemetry.drs ? "#86ffbc" : "#c7d7f3"} fontSize="18" fontWeight="700">
          DRS
        </text>

        <text x="160" y="260" textAnchor="middle" fill="#f4f7ff" fontSize="42" fontWeight="700" fontFamily="var(--font-display)">
          {Math.max(0, car.telemetry.gear)}
        </text>
        <text x="160" y="280" textAnchor="middle" fill="rgba(198,212,238,0.78)" fontSize="15" letterSpacing="0.08em">
          GEAR
        </text>
      </svg>
    </motion.article>
  );
}
