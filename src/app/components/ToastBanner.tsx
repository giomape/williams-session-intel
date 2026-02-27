import { motion } from "framer-motion";

interface ToastBannerProps {
  text: string;
  tone?: "info" | "warning" | "error";
}

const toneClass: Record<NonNullable<ToastBannerProps["tone"]>, string> = {
  info: "border-blue-300/35 bg-blue-500/15 text-blue-100",
  warning: "border-amber-300/45 bg-amber-500/18 text-amber-100",
  error: "border-rose-300/45 bg-rose-500/18 text-rose-100"
};

export default function ToastBanner({ text, tone = "info" }: ToastBannerProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: "easeInOut" }}
      className={`rounded-xl border px-4 py-2 text-sm font-medium ${toneClass[tone]}`}
      role="status"
    >
      {text}
    </motion.div>
  );
}
