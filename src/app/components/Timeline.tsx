import { AnimatePresence, motion } from "framer-motion";
import { formatClock } from "@/lib/format";
import { StreamEvent } from "@/lib/types";

interface TimelineProps {
  events: StreamEvent[];
}

const TYPE_LABEL: Record<StreamEvent["type"], string> = {
  position_change: "Position",
  overtake: "Overtake",
  pit: "Pit",
  radio: "Radio",
  race_control: "Control",
  heartbeat: "Heartbeat"
};

function tone(type: StreamEvent["type"]): string {
  if (type === "overtake") return "border-blue-300/45 bg-blue-500/16";
  if (type === "pit") return "border-amber-300/35 bg-amber-500/10";
  if (type === "race_control") return "border-rose-300/35 bg-rose-500/10";
  if (type === "radio") return "border-blue-300/35 bg-blue-500/10";
  return "border-white/10 bg-slate-900/45";
}

export default function Timeline({ events }: TimelineProps) {
  const rows = events.filter((event) => event.type !== "heartbeat").reverse();

  if (!rows.length) {
    return <div className="h-full" />;
  }

  return (
    <div className="scroll-thin h-full space-y-2 overflow-auto pr-1">
      <AnimatePresence initial={false}>
        {rows.map((event, index) => (
          <motion.article
            key={event.id}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: "easeInOut", delay: index * 0.02 }}
            className={`rounded-2xl border p-3 ${tone(event.type)}`}
          >
            <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-slate-400">
              <span>{TYPE_LABEL[event.type]}</span>
              <span>{formatClock(event.iso)}</span>
            </div>
            <p className="text-sm leading-relaxed text-slate-100">{event.message}</p>
          </motion.article>
        ))}
      </AnimatePresence>
    </div>
  );
}
