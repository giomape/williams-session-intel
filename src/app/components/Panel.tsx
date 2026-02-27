import { ReactNode } from "react";
import { motion } from "framer-motion";

interface PanelProps {
  title: string;
  right?: ReactNode;
  className?: string;
  hideHeader?: boolean;
  children: ReactNode;
}

export default function Panel({
  title,
  right,
  className = "",
  hideHeader = false,
  children
}: PanelProps) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 14, scale: 0.992 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
      className={`panel-shell flex h-auto min-h-[220px] flex-col rounded-[1rem] px-2.5 pb-2.5 pt-2 sm:px-3 sm:pb-3 sm:pt-2.5 xl:h-full xl:min-h-0 ${className}`}
    >
      {hideHeader ? null : (
        <header className="relative mb-2.5 flex items-end justify-between gap-2 border-b border-white/10 pb-2">
          <div className="min-w-0">
            <p className="section-kicker">Telemetry Module</p>
            <h2 className="truncate text-lg leading-none text-slate-50 sm:text-xl">{title}</h2>
          </div>
          {right ? <div className="shrink-0 text-[11px] text-slate-300 sm:text-xs">{right}</div> : null}
        </header>
      )}
      <div className="relative min-h-0 flex-1">{children}</div>
    </motion.section>
  );
}
