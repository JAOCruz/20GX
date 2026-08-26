import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useDashboardStore } from "@/hooks/useDashboardStore";
import { useJobPoll } from "@/hooks/useJobPoll";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

function formatDuration(seconds?: number | null) {
  if (seconds == null || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function JobPanel() {
  const currentJob = useJobPoll();
  const { jobLogs } = useDashboardStore();

  if (!currentJob) return null;

  const progress = currentJob.progress;
  const overall = Math.min(
    100,
    Math.max(0, progress?.overallProgress ?? (currentJob.done / currentJob.total) * 100)
  );
  const stockProgress = Math.min(100, Math.max(0, progress?.stockProgress ?? 0));
  const isRunning = currentJob.status === "running";

  return (
    <Card className="border-melee-red/30 bg-melee-blue/80">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isRunning ? (
              <Loader2 className="h-5 w-5 animate-spin text-melee-gold" />
            ) : currentJob.status === "completed" ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <XCircle className="h-5 w-5 text-destructive" />
            )}
            <CardTitle className="text-lg">Job: {currentJob.id}</CardTitle>
          </div>
          <Badge
            variant={
              currentJob.status === "running"
                ? "default"
                : currentJob.status === "completed"
                ? "secondary"
                : "destructive"
            }
          >
            {currentJob.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Overall progress */}
        <div className="space-y-1">
          <div className="flex items-end justify-between">
            <span className="text-sm font-medium text-foreground">Progreso general</span>
            <span className="text-2xl font-bold text-melee-gold">{overall.toFixed(1)}%</span>
          </div>
          <Progress value={overall} className="h-3" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              {currentJob.done}/{currentJob.total} juegos
            </span>
            {progress && (
              <span>
                Stock {progress.currentStock}/{progress.totalStocks}
              </span>
            )}
          </div>
        </div>

        {/* Stock progress */}
        {progress && progress.totalStocks > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Stock actual</span>
              <span className="font-mono text-xs text-melee-gold">{stockProgress.toFixed(1)}%</span>
            </div>
            <Progress value={stockProgress} className="h-2 bg-secondary/50" />
          </div>
        )}

        {/* ETA / timing */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {currentJob.estimatedSeconds != null && isRunning && (
            <span>Estimado total: ~{formatDuration(currentJob.estimatedSeconds)}</span>
          )}
          {progress?.etaSeconds != null && (
            <span>ETA: ~{formatDuration(progress.etaSeconds)}</span>
          )}
          {progress?.phase && (
            <Badge variant="outline" className="text-[10px]">
              {progress.phase}
            </Badge>
          )}
        </div>

        {/* Last progress line */}
        {progress?.lastProgressLine && (
          <div className="rounded-md border border-melee-gold/30 bg-black/60 p-2">
            <div className="font-mono text-xs text-melee-gold">
              {progress.lastProgressLine}
            </div>
          </div>
        )}

        {/* Logs */}
        <div className="rounded-md border border-border bg-black/40 p-2">
          <div className="max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap">
            {jobLogs || "Esperando logs..."}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
