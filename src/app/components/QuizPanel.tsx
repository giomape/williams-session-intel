import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { QuizAnswerKey, QuizCard, QuizStats } from "@/lib/types";

interface QuizPanelProps {
  quiz: QuizCard | null;
  stats: QuizStats;
  nowDataIso: string;
  onAnswer: (answer: QuizAnswerKey) => void;
  onClear: (quizId: string) => void;
}

const ANSWER_KEYS: QuizAnswerKey[] = ["A", "B", "C", "D"];

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso || !iso.trim().length) return null;
  const normalized = /[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function answerTone(quiz: QuizCard, key: QuizAnswerKey): string {
  if (!quiz.selectedAnswer) {
    return "quiz-neon-idle text-slate-100 hover:-translate-y-0.5";
  }

  if (key === quiz.correctAnswer) {
    return "quiz-neon-correct text-emerald-100";
  }

  if (key === quiz.selectedAnswer) {
    return "quiz-neon-wrong text-rose-100";
  }

  return "border-white/10 bg-slate-900/35 text-slate-300 opacity-65";
}

export default function QuizPanel({ quiz, stats, nowDataIso, onAnswer, onClear }: QuizPanelProps) {
  const [showSuccessBurst, setShowSuccessBurst] = useState(false);

  const answered = stats.correct + stats.wrong;
  const accuracy = answered ? (stats.correct / answered) * 100 : 0;

  const nowMs = parseIsoMs(nowDataIso);
  const expiresMs = parseIsoMs(quiz?.expiresIso);
  const remainingMsLive =
    quiz && nowMs !== null && expiresMs !== null ? Math.max(0, expiresMs - nowMs) : null;
  const answeredMs = parseIsoMs(quiz?.answeredIso);
  const remainingMsLocked =
    quiz && answeredMs !== null && expiresMs !== null ? Math.max(0, expiresMs - answeredMs) : null;
  const remainingMs =
    quiz?.selectedAnswer && remainingMsLocked !== null ? remainingMsLocked : remainingMsLive;
  const answeredCorrectly = Boolean(
    quiz?.selectedAnswer && quiz.selectedAnswer === quiz.correctAnswer
  );

  useEffect(() => {
    setShowSuccessBurst(false);
  }, [quiz?.id]);

  useEffect(() => {
    if (!quiz?.selectedAnswer) return;

    const isCorrect = quiz.selectedAnswer === quiz.correctAnswer;
    if (isCorrect) {
      const revealTimer = setTimeout(() => setShowSuccessBurst(true), 420);
      const clearTimer = setTimeout(() => onClear(quiz.id), 1800);
      return () => {
        clearTimeout(revealTimer);
        clearTimeout(clearTimer);
      };
    }

    const clearTimer = setTimeout(() => onClear(quiz.id), 1500);
    return () => {
      clearTimeout(clearTimer);
    };
  }, [onClear, quiz?.correctAnswer, quiz?.id, quiz?.selectedAnswer]);

  if (!quiz) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
        <div className="grid grid-cols-3 gap-1.5 text-[11px] uppercase tracking-[0.14em]">
          <div className="rounded-lg border border-emerald-300/35 bg-emerald-500/10 px-2 py-1 text-emerald-100">
            Correct {stats.correct}
          </div>
          <div className="rounded-lg border border-rose-300/35 bg-rose-500/10 px-2 py-1 text-rose-100">
            Wrong {stats.wrong}
          </div>
          <div className="rounded-lg border border-blue-300/35 bg-blue-500/10 px-2 py-1 text-blue-100">
            Accuracy {accuracy.toFixed(0)}%
          </div>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-dashed border-blue-300/35 bg-slate-900/30 p-4 text-center">
          <p className="text-sm text-slate-300">Next quiz drops here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      <div className="grid grid-cols-3 gap-1.5 text-[11px] uppercase tracking-[0.14em]">
        <div className="rounded-lg border border-emerald-300/35 bg-emerald-500/10 px-2 py-1 text-emerald-100">
          Correct {stats.correct}
        </div>
        <div className="rounded-lg border border-rose-300/35 bg-rose-500/10 px-2 py-1 text-rose-100">
          Wrong {stats.wrong}
        </div>
        <div className="rounded-lg border border-blue-300/35 bg-blue-500/10 px-2 py-1 text-blue-100">
          Accuracy {accuracy.toFixed(0)}%
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-slate-300">
            <span>Live Quiz</span>
            <span>{quiz.selectedAnswer ? "Locked" : remainingMs === null ? "--:--" : formatCountdown(remainingMs)}</span>
          </div>
          <p className="text-base leading-snug text-slate-100 md:text-[1.05rem]">{quiz.question}</p>
        </div>

        <div className="grid min-h-0 grid-cols-2 gap-1.5 sm:gap-2">
          {quiz.answers.slice(0, 4).map((answer, index) => {
            const key = ANSWER_KEYS[index] ?? "A";
            const selectable = !quiz.selectedAnswer;
            return (
              <motion.button
                key={`${quiz.id}-${key}`}
                whileHover={selectable ? { y: -1 } : undefined}
                whileTap={selectable ? { scale: 0.99 } : undefined}
                type="button"
                onClick={() => onAnswer(key)}
                disabled={!selectable}
                className={`quiz-option-shape min-h-[54px] border px-3 py-2 text-left text-sm leading-snug transition md:text-base ${answerTone(quiz, key)} ${
                  selectable ? "" : "cursor-default"
                }`}
              >
                <span className="mr-2 font-semibold">{key}.</span>
                <span className="break-words">{answer}</span>
              </motion.button>
            );
          })}
        </div>
      </div>

      <AnimatePresence>
        {answeredCorrectly && showSuccessBurst ? (
          <motion.div
            key={`${quiz.id}-correct`}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: [0.9, 1.08, 1] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
          >
            <div className="quiz-correct-burst px-8 py-4 text-4xl font-extrabold uppercase tracking-[0.1em]">
              CORRECT!
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
