"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { sendToAiriaAgent } from "@/lib/airia";
import { formatClock } from "@/lib/format";
import { KnowledgeLevel } from "@/lib/types";

interface ChatPanelProps {
  level: KnowledgeLevel;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  iso: string;
  pending?: boolean;
  error?: boolean;
}

function makeMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function ChatPanel({ level }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const hasMessages = messages.length > 0;
  const placeholder = "Ask a question about the race...";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const question = input.trim();
    if (!question.length || sending) return;

    const userMessage: ChatMessage = {
      id: makeMessageId("user"),
      role: "user",
      text: question,
      iso: new Date().toISOString()
    };
    const pendingId = makeMessageId("assistant");
    const pendingMessage: ChatMessage = {
      id: pendingId,
      role: "assistant",
      text: "Thinking...",
      iso: new Date().toISOString(),
      pending: true
    };

    setInput("");
    setSending(true);
    setMessages((current) => [...current, userMessage, pendingMessage]);

    try {
      const response = await sendToAiriaAgent({
        level,
        packets: [question]
      });

      setMessages((current) =>
        current.map((row) =>
          row.id === pendingId
            ? {
                ...row,
                text: response.text,
                pending: false,
                error: false,
                iso: new Date().toISOString()
              }
            : row
        )
      );
    } catch {
      setMessages((current) =>
        current.map((row) =>
          row.id === pendingId
            ? {
                ...row,
                text: "I could not reach Airia right now. Please try again.",
                pending: false,
                error: true,
                iso: new Date().toISOString()
              }
            : row
        )
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-auto pr-1">
        {!hasMessages ? (
          <div className="h-full" />
        ) : (
          <AnimatePresence initial={false}>
            {messages.map((message) => {
              const isUser = message.role === "user";
              return (
                <motion.article
                  key={message.id}
                  initial={{ opacity: 0, y: 10, scale: 0.992 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className={`rounded-2xl border p-3 ${
                    isUser
                      ? "border-blue-300/35 bg-blue-500/12"
                      : message.error
                        ? "border-rose-300/35 bg-rose-500/10"
                        : "border-white/10 bg-slate-900/45"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-300">
                    <span>{isUser ? "You" : "Airia"}</span>
                    <span>{formatClock(message.iso)}</span>
                  </div>
                  <p className={`text-sm leading-relaxed ${message.pending ? "text-slate-300" : "text-slate-100"}`}>
                    {message.text}
                  </p>
                </motion.article>
              );
            })}
          </AnimatePresence>
        )}
        <div ref={endRef} />
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-white/10 pt-2">
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={placeholder}
          className="control-field h-10 flex-1 text-sm"
          disabled={sending}
        />
        <button
          type="submit"
          disabled={sending || !input.trim().length}
          className="h-10 rounded-lg bg-gradient-to-r from-[#004ecf] to-[#0e70ff] px-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? "Sending" : "Send"}
        </button>
      </form>
    </div>
  );
}
