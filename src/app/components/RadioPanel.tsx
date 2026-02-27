import { AnimatePresence, motion } from "framer-motion";
import EmptyState from "@/app/components/EmptyState";
import { carLabel, formatClock } from "@/lib/format";
import { RadioEvent } from "@/lib/types";

interface RadioPanelProps {
  radios: RadioEvent[];
}

export default function RadioPanel({ radios }: RadioPanelProps) {
  const rows = radios.slice(-12).reverse();

  if (!rows.length) {
    return <EmptyState title="Radio archive empty" hint="Published team radio clips appear here." />;
  }

  return (
    <div className="scroll-thin h-full space-y-2.5 overflow-auto pr-1">
      <AnimatePresence initial={false}>
        {rows.map((radio, index) => (
          <motion.article
            key={radio.id}
            initial={{ opacity: 0, y: 12, scale: 0.992 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: index * 0.02 }}
            className="rounded-2xl border border-white/10 bg-slate-950/55 p-3"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="rounded-full border border-blue-300/35 bg-blue-500/14 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-100">
                {carLabel(radio.carSlot)}
              </span>
              <span className="text-xs text-slate-300">{formatClock(radio.iso)}</span>
            </div>

            <p className="mb-2 text-xs text-slate-400">
              Driver #{radio.driverNumber}
              {typeof radio.lapNumber === "number" ? ` · Lap ${radio.lapNumber}` : ""}
            </p>

            <div className="rounded-lg border border-white/10 bg-slate-900/70 px-2.5 py-2 text-[11px] text-slate-300">
              Offline mode: radio metadata loaded from demo pack. External audio playback disabled.
            </div>
          </motion.article>
        ))}
      </AnimatePresence>
    </div>
  );
}
