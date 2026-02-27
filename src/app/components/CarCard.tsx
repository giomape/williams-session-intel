import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CarState } from "@/lib/types";

interface CarCardProps {
  car: CarState;
  overtakeSignal: number;
  nowDataIso: string;
}

const OVERTAKE_CENTER_HOLD_MS = 5000;
const OVERTAKE_TRANSITION_MS = 550;
const OVERTAKE_TOTAL_MS = OVERTAKE_CENTER_HOLD_MS + OVERTAKE_TRANSITION_MS * 2;

function formatPosition(position: number | null): string {
  return position === null ? "--" : `P${position}`;
}

function formatGap(gapToLeader: number | null): string {
  if (gapToLeader === null) return "--";
  if (Math.abs(gapToLeader) < 0.001) return "Leader";

  const sign = gapToLeader < 0 ? "-" : "+";
  const absoluteGap = Math.abs(gapToLeader);
  if (absoluteGap >= 60) {
    const minutes = Math.floor(absoluteGap / 60);
    const seconds = absoluteGap - minutes * 60;
    return `${sign}${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
  }

  return `${sign}${absoluteGap.toFixed(3)}s`;
}

function formatInterval(intervalToMate: number | null): string {
  if (intervalToMate === null) return "--";
  const sign = intervalToMate > 0 ? "+" : "";
  return `${sign}${intervalToMate.toFixed(3)}s`;
}

function intervalLabel(direction: CarState["intervalDirection"]): string {
  if (direction === "AHEAD") return "Interval To Car Ahead";
  if (direction === "BEHIND") return "Interval To Car Behind";
  return "Closest Interval";
}

function formatTyre(compound: CarState["tyreCompound"]): string {
  if (compound === "INTERMEDIATE") return "Intermediate";
  if (compound === "WET") return "Wet";
  if (compound === "SOFT") return "Soft";
  if (compound === "HARD") return "Hard";
  return "Medium";
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function formatPitTime(seconds: number | null): string {
  if (seconds === null) return "--";
  return `${Math.max(0, seconds).toFixed(1)}s`;
}

export default function CarCard({ car, overtakeSignal, nowDataIso }: CarCardProps) {
  const [activeOvertake, setActiveOvertake] = useState<number | null>(null);
  const lastConsumedOvertake = useRef(0);
  const overtakeDurationSec = OVERTAKE_TOTAL_MS / 1000;
  const overtakeEntryPhase = OVERTAKE_TRANSITION_MS / OVERTAKE_TOTAL_MS;
  const overtakeHoldEndPhase =
    (OVERTAKE_TRANSITION_MS + OVERTAKE_CENTER_HOLD_MS) / OVERTAKE_TOTAL_MS;

  useEffect(() => {
    if (overtakeSignal <= lastConsumedOvertake.current) return;
    if (activeOvertake !== null) {
      lastConsumedOvertake.current = overtakeSignal;
      return;
    }
    lastConsumedOvertake.current = overtakeSignal;
    setActiveOvertake(overtakeSignal);
    const timer = setTimeout(() => {
      setActiveOvertake((current) => (current === overtakeSignal ? null : current));
    }, OVERTAKE_TOTAL_MS);
    return () => clearTimeout(timer);
  }, [activeOvertake, overtakeSignal]);

  const nowMs = parseIsoMs(nowDataIso);
  const pitRecapUntilMs = parseIsoMs(car.pitRecapUntilIso);
  const showPitRecap =
    car.state !== "OUT" &&
    nowMs !== null &&
    pitRecapUntilMs !== null &&
    nowMs <= pitRecapUntilMs &&
    car.pitStopDurationSec !== null;

  const statePillClass =
    car.state === "PIT"
      ? "border-amber-300/50 bg-amber-500/18 text-amber-100"
      : "border-emerald-300/50 bg-emerald-500/15 text-emerald-100";

  return (
    <motion.article
      whileHover={{ y: -2 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="panel-shell relative flex h-full min-h-0 flex-col overflow-hidden rounded-[1rem] p-3"
    >
      <div className="mb-2 border-b border-white/10 pb-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex min-w-0 items-baseline gap-2 text-slate-100">
            <span className="truncate text-[1.28rem] leading-none">{car.driverName ?? "Awaiting Driver"}</span>
            <span className="shrink-0 text-[1.1rem] leading-none text-slate-300">#{car.driverNumber ?? "--"}</span>
          </h3>
          {car.state !== "OUT" ? (
            <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] ${statePillClass}`}>
              {car.state}
            </span>
          ) : null}
        </div>
      </div>

      {car.state === "OUT" ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-[320px] rounded-2xl border border-rose-300/45 bg-rose-500/12 px-6 py-10 text-center">
            <p className="text-[12px] uppercase tracking-[0.28em] text-rose-200">Car Status</p>
            <p className="mt-2 text-6xl font-semibold leading-none text-rose-100">OUT</p>
          </div>
        </div>
      ) : showPitRecap ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-[360px] rounded-2xl border border-amber-300/45 bg-amber-500/10 px-5 py-4 text-center">
            <p className="text-[11px] uppercase tracking-[0.28em] text-amber-100/90">Pit Recap</p>
            <p className="mt-2 text-[2.35rem] leading-none text-amber-50">
              {formatPitTime(car.pitLaneDurationSec)}
            </p>
            <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-amber-100/75">
              Pit Lane Time
            </p>

            <div className="mx-auto my-3 h-px w-4/5 bg-white/10" />

            <p className="text-[2.05rem] leading-none text-amber-50">
              {formatPitTime(car.pitStopDurationSec)}
            </p>
            <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-amber-100/75">
              Stop Duration
            </p>
          </div>
        </div>
      ) : (
        <div className="grid flex-1 auto-rows-[minmax(0,1fr)] grid-cols-2 gap-1.5">
          <div className="telemetry-cell rounded-lg p-2.5">
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Position</p>
            <p className="mt-1 text-[1.62rem] leading-none text-white">{formatPosition(car.position)}</p>
          </div>

          <div className="telemetry-cell rounded-lg p-2.5">
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Gap To Leader</p>
            <p className="mt-1 text-[1.22rem] leading-none text-white">{formatGap(car.gapToLeader)}</p>
          </div>

          <div className="telemetry-cell rounded-lg p-2.5">
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{intervalLabel(car.intervalDirection)}</p>
            <p className="mt-1 text-[1.22rem] leading-none text-white">{formatInterval(car.intervalToMate)}</p>
          </div>

          <div className="telemetry-cell rounded-lg p-2.5">
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Tyre</p>
            <p className="mt-1 text-[1.22rem] leading-none text-white">{formatTyre(car.tyreCompound)}</p>
          </div>
        </div>
      )}

      <AnimatePresence>
        {activeOvertake !== null && car.state === "ON TRACK" ? (
          <motion.div
            key={`overtake-${activeOvertake}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none absolute inset-0 z-20"
          >
            <motion.div
              initial={{ x: -440, opacity: 0 }}
              animate={{ x: [-440, 0, 0, 440], opacity: [0, 1, 1, 0] }}
              transition={{
                duration: overtakeDurationSec,
                ease: "linear",
                times: [0, overtakeEntryPhase, overtakeHoldEndPhase, 1]
              }}
              className="absolute left-1/2 top-1/2 w-[250px] -translate-x-1/2 -translate-y-1/2"
            >
              <Image
                src="/overtake.png"
                alt="Overtake"
                width={480}
                height={210}
                className="h-auto w-full object-contain"
                priority={false}
              />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.article>
  );
}
