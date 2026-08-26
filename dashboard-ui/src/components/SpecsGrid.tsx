import { cn } from "@/lib/utils";

// Estimación de peso del video final (~48 MB/min medido de renders reales).
function estMb(sec: number, mbPerMin = 48) {
  return Math.max(1, Math.round((sec / 60) * mbPerMin));
}

function formatSize(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface SpecsGridProps {
  durationSec: number;
  clips: number;
  vertical: boolean;
  // Segundos extra de contexto antes de cada clip (se muestra solo si viene).
  leadSeconds?: number;
  mbPerMin?: number;
  className?: string;
}

// Panel de specs del export/reel: etiqueta chica muted + valor en mono,
// consistente entre el player de previews y la barra de export.
export function SpecsGrid({
  durationSec,
  clips,
  vertical,
  leadSeconds,
  mbPerMin = 48,
  className,
}: SpecsGridProps) {
  const specs: { label: string; value: string }[] = [
    { label: "Duración", value: formatDuration(durationSec) },
    { label: "Peso est.", value: `~${formatSize(estMb(durationSec, mbPerMin))}` },
    {
      label: "Formato",
      value: vertical ? "Vertical 1080×1920 · Shorts" : "Horizontal 4:3",
    },
    { label: "Clips", value: String(clips) },
  ];
  if (leadSeconds != null) {
    specs.push({ label: "Contexto", value: `+${leadSeconds}s` });
  }
  return (
    <div className={cn("grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4", className)}>
      {specs.map((s) => (
        <div key={s.label} className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {s.label}
          </div>
          <div className="truncate font-mono text-xs">{s.value}</div>
        </div>
      ))}
    </div>
  );
}
