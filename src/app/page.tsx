"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import CarCard from "@/app/components/CarCard";
import ChatPanel from "@/app/components/ChatPanel";
import CommentaryFeed from "@/app/components/CommentaryFeed";
import Panel from "@/app/components/Panel";
import QuizPanel from "@/app/components/QuizPanel";
import TelemetryVisual from "@/app/components/TelemetryVisual";
import Timeline from "@/app/components/Timeline";
import ToastBanner from "@/app/components/ToastBanner";
import TopBar from "@/app/components/TopBar";
import TrackMap from "@/app/components/TrackMap";
import { formatClock } from "@/lib/format";
import { streamEngine } from "@/lib/streamEngine";
import { useSessionStore } from "@/lib/store";
import { FocusMode, KnowledgeLevel, StreamEvent } from "@/lib/types";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Williams Session Intel";
const WELCOME_COMPLETE_STORAGE_KEY = "wsi-welcome-complete";
const KNOWLEDGE_LEVEL_STORAGE_KEY = "wsi-knowledge-level";
const COMMENTARY_SPEECH_STORAGE_KEY = "wsi-commentary-speech-enabled";
const KNOWLEDGE_LEVEL_OPTIONS: Array<{
  value: KnowledgeLevel;
  label: string;
  description: string;
}> = [
  {
    value: "beginner",
    label: "Beginner",
    description: "New to motorsport and learning the basics"
  },
  {
    value: "intermediate",
    label: "Intermediate",
    description: "Follows races and understands key strategy calls"
  },
  {
    value: "expert",
    label: "Expert",
    description: "Comfortable with advanced racecraft and telemetry details"
  }
];

function deriveRaceState(events: StreamEvent[]): {
  label: string;
  className: string;
} {
  const control = [...events].reverse().find((event) => event.type === "race_control");
  if (!control) {
    return {
      label: "GREEN",
      className: "border-emerald-300/45 bg-emerald-500/15 text-emerald-100"
    };
  }

  const text = control.message.toUpperCase();
  if (text.includes("VIRTUAL SAFETY CAR")) {
    return {
      label: "VSC",
      className: "border-amber-300/45 bg-amber-500/18 text-amber-100"
    };
  }
  if (text.includes("SAFETY CAR")) {
    return {
      label: "SAFETY CAR",
      className: "border-amber-300/45 bg-amber-500/18 text-amber-100"
    };
  }
  if (text.includes("RED")) {
    return {
      label: "RED FLAG",
      className: "border-rose-300/45 bg-rose-500/18 text-rose-100"
    };
  }
  if (text.includes("YELLOW")) {
    return {
      label: "YELLOW",
      className: "border-yellow-300/45 bg-yellow-500/18 text-yellow-100"
    };
  }

  return {
    label: "GREEN",
    className: "border-emerald-300/45 bg-emerald-500/15 text-emerald-100"
  };
}

function deriveFlashClass(message: string): string | null {
  const text = message.toUpperCase();
  if (text.includes("BLUE")) return null;
  if (text.includes("RED")) return "flag-flash-red";
  if (text.includes("VIRTUAL SAFETY CAR") || text.includes("SAFETY CAR")) return "flag-flash-amber";
  if (text.includes("DOUBLE YELLOW") || text.includes("YELLOW")) return "flag-flash-yellow";
  if (text.includes("GREEN")) return "flag-flash-green";
  return null;
}

function isHazardRaceState(label: string): boolean {
  return label === "YELLOW" || label === "SAFETY CAR" || label === "RED FLAG" || label === "VSC";
}

function shortDriverLabel(name: string | null, number: number | null): string {
  if (!name) return "Driver";
  const parts = name.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? name;
  if (number === null) return last;
  return `${last} #${number}`;
}

function formatNumber(value: number | null, suffix = ""): string {
  if (value === null) return "--";
  return `${value.toFixed(1)}${suffix}`;
}

function weatherLabel(rainfall: number | null): string {
  if (rainfall === null) return "Unknown";
  return Number(rainfall) === 1 ? "Rain" : "Dry";
}

export default function HomePage() {
  const {
    prefs,
    isStreaming,
    snapshot,
    events,
    commentary,
    activeQuiz,
    quizStats,
    diagnostics,
    setPrefs,
    answerActiveQuiz,
    clearActiveQuiz
  } =
    useSessionStore();

  const [showSimulationControls, setShowSimulationControls] = useState(true);
  const [isMapFullscreen, setIsMapFullscreen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [appearance, setAppearance] = useState<"dark" | "light">("dark");
  const [isCommentarySpeechEnabled, setIsCommentarySpeechEnabled] = useState(true);
  const [showWelcomeOverlay, setShowWelcomeOverlay] = useState(false);
  const [pendingKnowledgeLevel, setPendingKnowledgeLevel] = useState<KnowledgeLevel | null>(null);
  const [flagFlash, setFlagFlash] = useState<{ className: string; key: number } | null>(null);
  const [overtakeSignal, setOvertakeSignal] = useState({ A: 0, B: 0 });

  const hazardBeepRef = useRef<HTMLAudioElement | null>(null);
  const raceControlSeenIdsRef = useRef(new Set<string>());
  const raceControlBootstrappedRef = useRef(false);
  const audioUnlockedRef = useRef(false);
  const lastRaceStateLabelRef = useRef<string | null>(null);
  const overtakeSeenIds = useRef(new Set<string>());
  const overtakeBootstrapped = useRef(false);
  const commentarySeenIdsRef = useRef(new Set<string>());
  const commentarySpeechBootstrappedRef = useRef(false);
  const commentarySpeechQueueRef = useRef<string[]>([]);
  const commentarySpeechBusyRef = useRef(false);
  const commentarySpeechEnabledRef = useRef(true);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashKeyRef = useRef(0);

  const speakNextCommentary = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!commentarySpeechEnabledRef.current) return;
    if (commentarySpeechBusyRef.current) return;

    const nextMessage = commentarySpeechQueueRef.current.shift();
    if (!nextMessage) return;

    const utterance = new SpeechSynthesisUtterance(nextMessage);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => {
      commentarySpeechBusyRef.current = false;
      speakNextCommentary();
    };
    utterance.onerror = () => {
      commentarySpeechBusyRef.current = false;
      speakNextCommentary();
    };

    commentarySpeechBusyRef.current = true;
    window.speechSynthesis.speak(utterance);
  }, []);

  const playHazardBeep = useCallback(() => {
    const beep = hazardBeepRef.current;
    if (!beep) return;

    beep.currentTime = 0;
    void beep.play().catch(() => {
      const fallback = new Audio("/beep.mp3");
      fallback.preload = "auto";
      void fallback.play().catch(() => {
        // Browser autoplay policy may block sound before first interaction.
      });
    });
  }, []);

  useEffect(() => {
    void streamEngine.start();
    return () => {
      streamEngine.stop();
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const savedAppearance = window.localStorage.getItem("appearance-mode");
    if (savedAppearance === "light" || savedAppearance === "dark") {
      setAppearance(savedAppearance);
    }

    const savedCommentarySpeech = window.localStorage.getItem(COMMENTARY_SPEECH_STORAGE_KEY);
    if (savedCommentarySpeech === "true" || savedCommentarySpeech === "false") {
      setIsCommentarySpeechEnabled(savedCommentarySpeech === "true");
    }
  }, []);

  useEffect(() => {
    const savedLevel = window.localStorage.getItem(KNOWLEDGE_LEVEL_STORAGE_KEY);
    const normalizedLevel =
      savedLevel === "beginner" || savedLevel === "intermediate" || savedLevel === "expert"
        ? (savedLevel as KnowledgeLevel)
        : null;

    if (normalizedLevel) {
      setPrefs({ knowledgeLevel: normalizedLevel });
      setPendingKnowledgeLevel(normalizedLevel);
    }

    const isWelcomeComplete = window.localStorage.getItem(WELCOME_COMPLETE_STORAGE_KEY) === "true";
    setShowWelcomeOverlay(!isWelcomeComplete);
  }, [setPrefs]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", appearance);
  }, [appearance]);

  useEffect(() => {
    const beep = new Audio("/beep.mp3");
    beep.preload = "auto";
    hazardBeepRef.current = beep;

    return () => {
      hazardBeepRef.current = null;
    };
  }, []);

  useEffect(() => {
    const unlockAudio = () => {
      if (audioUnlockedRef.current) return;
      const beep = hazardBeepRef.current;
      if (!beep) return;

      const originalMuted = beep.muted;
      beep.muted = true;

      void beep.play()
        .then(() => {
          beep.pause();
          beep.currentTime = 0;
          beep.muted = originalMuted;
          audioUnlockedRef.current = true;
        })
        .catch(() => {
          beep.muted = originalMuted;
        });
    };

    window.addEventListener("pointerdown", unlockAudio, { passive: true });
    window.addEventListener("keydown", unlockAudio);

    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  useEffect(() => {
    commentarySpeechEnabledRef.current = isCommentarySpeechEnabled;

    if (!isCommentarySpeechEnabled && typeof window !== "undefined") {
      commentarySpeechQueueRef.current = [];
      commentarySpeechBusyRef.current = false;
      window.speechSynthesis.cancel();
    }
  }, [isCommentarySpeechEnabled]);

  useEffect(() => {
    if (!commentarySpeechBootstrappedRef.current) {
      commentary.forEach((item) => commentarySeenIdsRef.current.add(item.id));
      commentarySpeechBootstrappedRef.current = true;
      return;
    }

    const newMessages = commentary.filter((item) => !commentarySeenIdsRef.current.has(item.id));
    if (!newMessages.length) return;

    newMessages.forEach((item) => commentarySeenIdsRef.current.add(item.id));
    if (!commentarySpeechEnabledRef.current) return;

    newMessages.forEach((item) => commentarySpeechQueueRef.current.push(item.text));
    speakNextCommentary();
  }, [commentary, speakNextCommentary]);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined") {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    const controls = events.filter((event) => event.type === "race_control");
    if (!raceControlBootstrappedRef.current) {
      controls.forEach((event) => raceControlSeenIdsRef.current.add(event.id));
      lastRaceStateLabelRef.current = deriveRaceState(events).label;
      raceControlBootstrappedRef.current = true;
      return;
    }

    if (!controls.length) return;

    const newControls = controls.filter((event) => !raceControlSeenIdsRef.current.has(event.id));
    if (!newControls.length) return;
    newControls.forEach((event) => raceControlSeenIdsRef.current.add(event.id));

    let currentLabel = lastRaceStateLabelRef.current ?? "GREEN";
    for (const event of newControls) {
      const nextLabel = deriveRaceState([event]).label;
      if (nextLabel !== currentLabel && isHazardRaceState(nextLabel)) {
        playHazardBeep();
      }
      currentLabel = nextLabel;
    }
    lastRaceStateLabelRef.current = currentLabel;

    const latestForFlash = [...newControls]
      .reverse()
      .find((event) => deriveFlashClass(event.message) !== null);
    if (!latestForFlash) return;

    const className = deriveFlashClass(latestForFlash.message);
    if (!className) return;

    flashKeyRef.current += 1;
    setFlagFlash({ className, key: flashKeyRef.current });

    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
    }

    flashTimerRef.current = setTimeout(() => {
      setFlagFlash(null);
      flashTimerRef.current = null;
    }, 16500);
  }, [events, playHazardBeep]);

  useEffect(() => {
    const overtakeEvents = events.filter((event) => event.type === "overtake");
    if (!overtakeBootstrapped.current) {
      overtakeEvents.forEach((event) => overtakeSeenIds.current.add(event.id));
      overtakeBootstrapped.current = true;
      return;
    }

    let addA = 0;
    let addB = 0;

    for (const event of overtakeEvents) {
      if (overtakeSeenIds.current.has(event.id)) continue;
      overtakeSeenIds.current.add(event.id);

      if (!event.carSlot || (event.positionDelta ?? 0) <= 0) continue;
      if (event.carSlot === "A") addA += 1;
      if (event.carSlot === "B") addB += 1;
    }

    if (addA || addB) {
      setOvertakeSignal((current) => ({
        A: current.A + addA,
        B: current.B + addB
      }));
    }
  }, [events]);

  const banners: Array<{ text: string; tone: "info" | "warning" | "error" }> = [];

  if (diagnostics.invalidConfig && !diagnostics.driverSelectionError) {
    banners.push({
      text: "Replay source invalid. Session key has been reset to the local demo pack.",
      tone: "error"
    });
  }

  if (diagnostics.driverSelectionError) {
    banners.push({
      text: diagnostics.driverSelectionError,
      tone: "error"
    });
  }

  if (diagnostics.dataDelayMode) {
    banners.push({
      text: "Replay cadence smoothing is active.",
      tone: "warning"
    });
  }

  if (diagnostics.aiFallbackWarning) {
    banners.push({
      text: "Airia is unreachable. Using local fallback commentary.",
      tone: "warning"
    });
  }

  const driverSummaryA =
    snapshot.cars.A.driverName && snapshot.cars.A.driverNumber
      ? `${snapshot.cars.A.driverName} (#${snapshot.cars.A.driverNumber})`
      : "Auto-detected from local pack";

  const driverSummaryB =
    snapshot.cars.B.driverName && snapshot.cars.B.driverNumber
      ? `${snapshot.cars.B.driverName} (#${snapshot.cars.B.driverNumber})`
      : "Auto-detected from local pack";

  const raceState = deriveRaceState(events);
  const visibleEvents = events.filter((event) => event.type !== "heartbeat");
  const focusMode = prefs.focusMode;

  const focusedCar =
    focusMode === "carA" ? snapshot.cars.A : focusMode === "carB" ? snapshot.cars.B : null;
  const focusedOvertake = focusMode === "carA" ? overtakeSignal.A : focusMode === "carB" ? overtakeSignal.B : 0;

  const focusOptions: Array<{ value: FocusMode; label: string }> = [
    { value: "both", label: "Both" },
    {
      value: "carA",
      label: shortDriverLabel(snapshot.cars.A.driverName, snapshot.cars.A.driverNumber)
    },
    {
      value: "carB",
      label: shortDriverLabel(snapshot.cars.B.driverName, snapshot.cars.B.driverNumber)
    }
  ];

  const onConfirmKnowledgeLevel = () => {
    if (!pendingKnowledgeLevel) return;

    setPrefs({ knowledgeLevel: pendingKnowledgeLevel });
    window.localStorage.setItem(KNOWLEDGE_LEVEL_STORAGE_KEY, pendingKnowledgeLevel);
    window.localStorage.setItem(WELCOME_COMPLETE_STORAGE_KEY, "true");
    setShowWelcomeOverlay(false);
  };

  const toggleCommentarySpeech = () => {
    setIsCommentarySpeechEnabled((current) => {
      const next = !current;
      window.localStorage.setItem(COMMENTARY_SPEECH_STORAGE_KEY, String(next));
      return next;
    });
  };

  return (
    <main className="dashboard-shell mx-auto flex min-h-screen w-full max-w-[1880px] flex-col gap-2 overflow-x-hidden overflow-y-auto px-2 py-2 sm:px-3 sm:py-3 md:px-4 lg:h-[100dvh] lg:overflow-hidden">
      {flagFlash ? (
        <motion.div
          key={flagFlash.key}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.9, 0.52, 0.52, 0] }}
          transition={{ duration: 16, ease: [0.22, 1, 0.36, 1] }}
          className={`flag-flash-layer ${flagFlash.className}`}
        />
      ) : null}

      <div className="relative shrink-0">
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="cockpit-hero rounded-[1rem] px-3 py-2 sm:rounded-[1.2rem] sm:px-4 sm:py-1.5"
        >
          <div className="relative grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(860px,1fr)] lg:items-stretch">
          <div className="hero-intro flex flex-col lg:h-full">
            <p className="section-kicker">Session Intelligence</p>
            <div className="mt-0.5 flex flex-wrap items-end gap-2">
              <Image
                src="/williams_logo.png"
                alt="Williams"
                width={420}
                height={138}
                className="h-[2.35rem] w-auto object-contain sm:h-[2.95rem] md:h-[3.35rem]"
                priority
              />
              <h1 className="text-[1.95rem] leading-[0.9] text-white sm:text-[2.45rem] md:text-[2.85rem]">{APP_NAME}</h1>
            </div>
            <div className="mt-1.5 lg:mt-auto lg:pt-3">
              <button
                type="button"
                onClick={() => setShowSimulationControls((current) => !current)}
                className="status-pill rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-blue-100 sm:text-[11px]"
              >
                {showSimulationControls ? "Hide Simulation Controls" : "Show Simulation Controls"}
              </button>
            </div>
          </div>

          <div className="grid gap-2 lg:grid-cols-[minmax(340px,1fr)_minmax(520px,auto)]">
            <div className="panel-shell flex h-[152px] flex-col rounded-xl p-2">
              <div className="mb-1 flex items-center justify-between">
                <p className="section-kicker">Session Timeline</p>
              </div>
              <div className="min-h-0 flex-1">
                <Timeline events={events} />
              </div>
            </div>

            <div className="relative">
              <div className="grid gap-2 md:grid-cols-2 md:pr-14">
                <div className="panel-shell flex h-[152px] flex-col rounded-xl p-2">
                  <p className="section-kicker">Weather</p>
                  <div className="mt-1 grid grid-cols-2 gap-1 text-xs">
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-950/45 px-2 py-1">
                      <span className="text-slate-400">Air</span>
                      <span className="text-slate-100">{formatNumber(snapshot.weather.airTemperatureC, "°C")}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-950/45 px-2 py-1">
                      <span className="text-slate-400">Track</span>
                      <span className="text-slate-100">{formatNumber(snapshot.weather.trackTemperatureC, "°C")}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-950/45 px-2 py-1">
                      <span className="text-slate-400">Humidity</span>
                      <span className="text-slate-100">{formatNumber(snapshot.weather.humidityPct, "%")}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-950/45 px-2 py-1">
                      <span className="text-slate-400">Condition</span>
                      <span className="text-slate-100">{weatherLabel(snapshot.weather.rainfall)}</span>
                    </div>
                  </div>
                </div>

                <div className="panel-shell flex h-[152px] flex-col rounded-xl p-2">
                  <p className="section-kicker">Live Ledger</p>
                  <div className="mt-1 grid grid-cols-2 gap-1 text-xs">
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-950/45 px-2 py-1">
                      <span className="text-slate-400">Stream State</span>
                      <span className={`flex items-center gap-2 ${isStreaming ? "text-blue-100" : "text-slate-300"}`}>
                        {isStreaming ? <span className="status-dot" /> : null}
                        {isStreaming ? "Live" : "Ready"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-950/45 px-2 py-1">
                      <span className="text-slate-400">Data Time</span>
                      <span className="text-slate-100">{formatClock(snapshot.nowDataIso)}</span>
                    </div>
                    <div className="col-span-2 flex items-center justify-between rounded-lg border border-white/10 bg-slate-950/45 px-2 py-1">
                      <span className="text-slate-400">Lap</span>
                      <span className="text-slate-100">
                        {snapshot.lapNumber ?? "--"} / {snapshot.totalLaps ?? "--"}
                      </span>
                    </div>
                    <div className={`col-span-2 flex items-center justify-between rounded-lg border px-2 py-1 ${raceState.className}`}>
                      <span className="font-semibold uppercase tracking-[0.14em]">Track State</span>
                      <span className="font-semibold uppercase tracking-[0.14em]">{raceState.label}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
        </motion.section>

        <button
          type="button"
          onClick={() => setIsSettingsOpen(true)}
          aria-label="Open settings"
          className="settings-orb absolute right-2 top-2 z-20 flex h-11 w-11 items-center justify-center rounded-full border border-blue-300/55 bg-gradient-to-br from-white to-blue-100 text-slate-700 shadow-[0_10px_24px_rgba(0,57,153,0.25)] transition hover:scale-[1.03] hover:shadow-[0_12px_30px_rgba(0,57,153,0.3)] sm:right-3 sm:top-3"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden="true">
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96c-.5-.38-1.05-.69-1.66-.94L14.46 2.78a.5.5 0 0 0-.49-.41h-3.94a.5.5 0 0 0-.49.41l-.36 2.54c-.61.25-1.17.57-1.67.94l-2.39-.96a.5.5 0 0 0-.6.22L2.6 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.65-.06.94s.02.63.06.94L2.72 14.52a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.06.7 1.67.94l.36 2.54a.5.5 0 0 0 .49.41h3.94a.5.5 0 0 0 .49-.41l.36-2.54c.61-.25 1.16-.56 1.66-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z" />
          </svg>
        </button>
      </div>

      {showSimulationControls ? (
        <TopBar
          prefs={prefs}
          isStreaming={isStreaming}
          driverSummaryA={driverSummaryA}
          driverSummaryB={driverSummaryB}
          onPrefsChange={setPrefs}
          onStart={() => {
            void streamEngine.start();
          }}
          onStop={() => {
            streamEngine.stop();
          }}
        />
      ) : null}

      {banners.length ? (
        <div className="shrink-0 space-y-1">
          {banners.map((banner) => (
            <ToastBanner key={banner.text} text={banner.text} tone={banner.tone} />
          ))}
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-2 pb-2 xl:min-h-0 xl:flex-1 xl:grid-cols-12 xl:grid-rows-[minmax(0,1.08fr)_minmax(0,0.92fr)] xl:overflow-hidden xl:pb-0">
        <div className="flex flex-col gap-2 xl:col-span-3 xl:row-span-2 xl:min-h-0">
          <div className="panel-shell shrink-0 rounded-[1rem] px-2.5 py-2">
            <p className="section-kicker">Focus</p>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {focusOptions.map((option) => {
                const active = focusMode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setPrefs({ focusMode: option.value })}
                    className={`rounded-md border px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] transition ${
                      active
                        ? "border-blue-300/55 bg-blue-500/20 text-blue-100"
                        : "border-white/10 bg-slate-950/45 text-slate-300 hover:border-blue-300/25 hover:text-blue-100"
                    }`}
                  >
                    <span className="block truncate">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2 xl:min-h-0 xl:flex-1">
            {focusMode === "both" ? (
              <>
                <div className="min-h-[260px] sm:min-h-[300px] xl:min-h-0 xl:flex-1">
                  <CarCard
                    car={snapshot.cars.A}
                    overtakeSignal={overtakeSignal.A}
                    nowDataIso={snapshot.nowDataIso}
                  />
                </div>
                <div className="min-h-[260px] sm:min-h-[300px] xl:min-h-0 xl:flex-1">
                  <CarCard
                    car={snapshot.cars.B}
                    overtakeSignal={overtakeSignal.B}
                    nowDataIso={snapshot.nowDataIso}
                  />
                </div>
              </>
            ) : focusedCar ? (
              <>
                <div className="min-h-[260px] sm:min-h-[300px] xl:min-h-0 xl:flex-1">
                  <CarCard
                    car={focusedCar}
                    overtakeSignal={focusedOvertake}
                    nowDataIso={snapshot.nowDataIso}
                  />
                </div>
                <div className="min-h-[300px] sm:min-h-[340px] xl:min-h-0 xl:flex-1">
                  <AnimatePresence mode="wait" initial={false}>
                    <TelemetryVisual key={`telemetry-${focusMode}`} car={focusedCar} />
                  </AnimatePresence>
                </div>
              </>
            ) : null}
          </div>
        </div>

        <Panel hideHeader title="" className="min-h-[300px] sm:min-h-[360px] xl:col-span-5 xl:col-start-4 xl:row-start-1 xl:h-full xl:min-h-0">
          <div className="relative h-full">
            <button
              type="button"
              onClick={() => setIsMapFullscreen(true)}
              className="absolute right-2 top-2 z-10 rounded-md border border-blue-300/30 bg-blue-500/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-100"
            >
              Fullscreen
            </button>
            <TrackMap snapshot={snapshot} focusMode={focusMode} />
          </div>
        </Panel>

        <Panel
          title="Race Quiz"
          className="min-h-[280px] sm:min-h-[320px] xl:col-span-5 xl:col-start-4 xl:row-start-2 xl:h-full xl:min-h-0"
        >
          <QuizPanel
            quiz={activeQuiz}
            stats={quizStats}
            nowDataIso={snapshot.nowDataIso}
            onAnswer={answerActiveQuiz}
            onClear={clearActiveQuiz}
          />
        </Panel>

        <Panel
          title="AI Commentary"
          right={
            <button
              type="button"
              onClick={toggleCommentarySpeech}
              className="rounded-md border border-blue-300/35 bg-slate-900/65 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-100"
            >
              {isCommentarySpeechEnabled ? "Mute Voice" : "Unmute Voice"}
            </button>
          }
          className="min-h-[280px] sm:min-h-[320px] xl:col-span-4 xl:col-start-9 xl:row-start-1 xl:h-full xl:min-h-0"
        >
          <CommentaryFeed messages={commentary} />
        </Panel>

        <Panel
          title="Race Chat"
          className="min-h-[280px] sm:min-h-[320px] xl:col-span-4 xl:col-start-9 xl:row-start-2 xl:h-full xl:min-h-0"
        >
          <ChatPanel level={prefs.knowledgeLevel} />
        </Panel>
      </section>

      {isSettingsOpen ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-3 py-4">
          <div className="panel-shell w-full max-w-md rounded-2xl p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between border-b border-white/15 pb-2">
              <h2 className="text-2xl text-white">Settings</h2>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="rounded-lg border border-blue-300/35 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-white"
              >
                Close
              </button>
            </div>

            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-[11px] uppercase tracking-[0.2em] text-slate-300">F1 Knowledge</span>
                <select
                  value={prefs.knowledgeLevel}
                  onChange={(event) => {
                    const level = event.target.value as typeof prefs.knowledgeLevel;
                    setPrefs({ knowledgeLevel: level });
                    setPendingKnowledgeLevel(level);
                    window.localStorage.setItem(KNOWLEDGE_LEVEL_STORAGE_KEY, level);
                  }}
                  className="control-field h-10 text-sm"
                >
                  <option value="beginner">Beginner</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="expert">Expert</option>
                </select>
              </label>

              <div className="space-y-1">
                <span className="text-[11px] uppercase tracking-[0.2em] text-slate-300">Appearance</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAppearance("dark");
                      window.localStorage.setItem("appearance-mode", "dark");
                    }}
                    className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] ${
                      appearance === "dark"
                        ? "border-blue-300/60 bg-blue-600/28 text-white"
                        : "border-white/20 bg-white/8 text-slate-200"
                    }`}
                  >
                    Dark
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAppearance("light");
                      window.localStorage.setItem("appearance-mode", "light");
                    }}
                    className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] ${
                      appearance === "light"
                        ? "border-blue-500/60 bg-blue-500/18 text-blue-950"
                        : "border-blue-300/30 bg-white/70 text-blue-800"
                    }`}
                  >
                    Light
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] uppercase tracking-[0.2em] text-slate-300">Commentary Voice</span>
                <button
                  type="button"
                  onClick={toggleCommentarySpeech}
                  className={`w-full rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] ${
                    isCommentarySpeechEnabled
                      ? "border-blue-300/60 bg-blue-600/28 text-white"
                      : "border-white/20 bg-white/8 text-slate-200"
                  }`}
                >
                  {isCommentarySpeechEnabled ? "On" : "Off"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <AnimatePresence>
        {showWelcomeOverlay ? (
          <motion.div
            key="welcome-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
            className="welcome-overlay-backdrop fixed inset-0 z-[95] flex items-center justify-center px-4 py-6"
          >
            <motion.div
              initial={{ opacity: 0, y: 22, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              className="welcome-overlay-panel relative w-full max-w-[1500px] overflow-hidden rounded-[1.4rem] p-4 sm:p-6 md:p-7"
            >
              <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-[220px] lg:block xl:w-[260px]">
                <Image
                  src="/albon.png"
                  alt="Alexander Albon"
                  fill
                  className="object-contain object-left-bottom"
                  priority
                />
              </div>

              <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[220px] lg:block xl:w-[260px]">
                <Image
                  src="/sainz.png"
                  alt="Carlos Sainz"
                  fill
                  className="object-contain object-right-bottom"
                  priority
                />
              </div>

              <div className="relative z-10 lg:px-[220px] xl:px-[260px]">
                <div className="text-center">
                  <p className="section-kicker">Welcome</p>
                  <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
                    <Image
                      src="/williams_logo.png"
                      alt="Williams"
                      width={420}
                      height={138}
                      className="h-[2.7rem] w-auto object-contain sm:h-[3.1rem]"
                      priority
                    />
                    <h2 className="text-[1.95rem] leading-[0.94] text-white sm:text-[2.45rem]">Williams Session Intel</h2>
                  </div>
                  <p className="mx-auto mt-3 max-w-2xl text-sm text-slate-200 sm:text-[0.98rem]">
                    Welcome aboard! Pick your motorsport knowledge level so commentary, explanations and chat depth fit
                    your pace from lap one
                  </p>
                  <p className="mt-4 text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-blue-100">
                    What is your motorsport knowledge?
                  </p>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2.5 sm:gap-3">
                  {KNOWLEDGE_LEVEL_OPTIONS.map((option) => {
                    const isActive = pendingKnowledgeLevel === option.value;

                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setPendingKnowledgeLevel(option.value)}
                        className={`welcome-level-card rounded-xl px-2.5 py-3 text-left transition sm:px-3.5 sm:py-4 ${
                          isActive ? "is-active" : ""
                        }`}
                      >
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] sm:text-[0.8rem]">{option.label}</p>
                        <p className="mt-1 text-[11px] leading-5 text-slate-300 sm:text-xs">{option.description}</p>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-5 flex justify-center">
                  <button
                    type="button"
                    onClick={onConfirmKnowledgeLevel}
                    disabled={!pendingKnowledgeLevel}
                    className="welcome-confirm rounded-lg px-7 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Confirm
                  </button>
                </div>

                <p className="mt-3 text-center text-[11px] text-slate-300">
                  You can change this anytime from Settings
                </p>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {isMapFullscreen ? (
        <div className="fixed inset-2 z-50">
          <div className="panel-shell flex h-full min-h-0 flex-col rounded-[1.2rem] p-3">
            <div className="mb-2 flex items-center justify-between border-b border-white/10 pb-2">
              <h2 className="text-2xl text-slate-100">Track Map</h2>
              <button
                type="button"
                onClick={() => setIsMapFullscreen(false)}
                className="rounded-lg border border-white/20 bg-slate-900/70 px-3 py-1.5 text-xs uppercase tracking-[0.12em] text-slate-100"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <TrackMap snapshot={snapshot} focusMode={focusMode} />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
