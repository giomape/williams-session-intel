import { AnimatePresence, motion } from "framer-motion";
import { formatClock } from "@/lib/format";
import { CommentaryMessage } from "@/lib/types";

interface CommentaryFeedProps {
  messages: CommentaryMessage[];
}

function confidenceTone(confidence: number): string {
  if (confidence >= 0.85) return "border-blue-300/40 bg-blue-500/10";
  if (confidence >= 0.7) return "border-blue-300/35 bg-blue-500/10";
  return "border-white/10 bg-slate-900/45";
}

export default function CommentaryFeed({ messages }: CommentaryFeedProps) {
  const rows = messages.slice(-24).reverse();

  if (!rows.length) {
    return <div className="h-full" />;
  }

  return (
    <div className="scroll-thin h-full space-y-2 overflow-auto pr-1">
      <AnimatePresence initial={false}>
        {rows.map((item, index) => (
          <motion.article
            key={item.id}
            initial={{ opacity: 0, y: 14, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: index * 0.025 }}
            className={`rounded-2xl border p-3 ${confidenceTone(item.confidence)}`}
          >
            <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
              <span>{item.source}</span>
              <span>{formatClock(item.iso)}</span>
            </div>
            <p className="text-sm leading-relaxed text-slate-100">{item.text}</p>
          </motion.article>
        ))}
      </AnimatePresence>
    </div>
  );
}
