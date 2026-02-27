import { motion } from "framer-motion";
import { DEMO_SESSION_KEY } from "@/lib/demoConfig";
import { UserPreferences } from "@/lib/types";

interface TopBarProps {
  prefs: UserPreferences;
  isStreaming: boolean;
  driverSummaryA: string;
  driverSummaryB: string;
  onPrefsChange: (patch: Partial<UserPreferences>) => void;
  onStart: () => void;
  onStop: () => void;
}

const controlClass = "control-field h-9 py-1.5 text-xs";

function DriverBrief({ slot, summary }: { slot: "A" | "B"; summary: string }) {
  return (
    <div className="telemetry-cell rounded-xl px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Driver {slot}</p>
      <p className="mt-1 break-words text-xs font-semibold text-slate-100">{summary}</p>
    </div>
  );
}

export default function TopBar({
  prefs,
  isStreaming,
  driverSummaryA,
  driverSummaryB,
  onPrefsChange,
  onStart,
  onStop
}: TopBarProps) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
      className="panel-shell rounded-[1.1rem] px-2.5 py-2.5 sm:px-3"
    >
      <div className="relative grid gap-2 xl:grid-cols-[minmax(300px,1.1fr)_minmax(420px,1.4fr)_minmax(280px,1fr)] xl:items-end">
        <div>
          <p className="section-kicker">Airia Pipeline Source</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-slate-200 sm:gap-2 sm:text-xs">
            <span className="status-pill rounded-full px-2 py-1">Session {DEMO_SESSION_KEY}</span>
            <span className="status-pill rounded-full px-2 py-1">Local Demo Packs</span>
            <span className="status-pill rounded-full px-2 py-1">Airia API Calls</span>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <DriverBrief slot="A" summary={driverSummaryA} />
          <DriverBrief slot="B" summary={driverSummaryB} />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Speed</span>
            <select
              value={String(prefs.speed)}
              onChange={(event) => onPrefsChange({ speed: Number(event.target.value) })}
              className={controlClass}
            >
              <option value="1">x1</option>
              <option value="2">x2</option>
              <option value="5">x5</option>
              <option value="10">x10</option>
              <option value="20">x20</option>
              <option value="50">x50</option>
            </select>
          </label>

          <div className="flex items-end gap-1.5 sm:col-span-1">
            <motion.button
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.98 }}
              animate={{ opacity: isStreaming ? 0.45 : 1 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              type="button"
              onClick={onStart}
              disabled={isStreaming}
              className="h-9 flex-1 rounded-lg bg-gradient-to-r from-[#004ecf] to-[#0e70ff] px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white disabled:cursor-not-allowed"
            >
              Start
            </motion.button>
            <motion.button
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.98 }}
              animate={{ opacity: isStreaming ? 1 : 0.45 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              type="button"
              onClick={onStop}
              disabled={!isStreaming}
              className="h-9 flex-1 rounded-lg border border-blue-300/35 bg-slate-900/65 px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-100 disabled:cursor-not-allowed"
            >
              Stop
            </motion.button>
          </div>
        </div>
      </div>
    </motion.section>
  );
}
