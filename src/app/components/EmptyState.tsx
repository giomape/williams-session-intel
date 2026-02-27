interface EmptyStateProps {
  title: string;
  hint?: string;
}

export default function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 bg-slate-950/45 p-4">
      <div className="flash-line mb-3 h-1.5 w-24 rounded bg-white/20" />
      <p className="text-base font-semibold text-slate-100">{title}</p>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}
