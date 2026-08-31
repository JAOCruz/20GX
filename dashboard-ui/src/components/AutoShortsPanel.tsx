import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Save, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StockIcon } from "@/components/StockIcon";
import { CHAR_NAMES } from "@/lib/stockIcons";
import { generateAutoShort, getAutoShorts, saveAutoShorts } from "@/lib/api";
import type { AutoShortStatus } from "@/types";

const STATUS_LABELS: Record<AutoShortStatus, string> = {
  queued: "en cola",
  pending: "en cola",
  running: "renderizando",
  rendered: "renderizado",
  "approval-pending": "pendiente aprobación",
  uploaded: "subido",
  discarded: "descartado",
  cancelled: "cancelado",
  error: "error",
};

// "Captain Falcon" / "CAPTAIN_FALCON" / 2 → characterId (null si no matchea)
function parseCharacters(text: string): number[] {
  const byName = new Map(
    Object.entries(CHAR_NAMES).map(([id, name]) => [name.toLowerCase().replace(/[_\s]+/g, " "), Number(id)])
  );
  return text
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/[_\s]+/g, " "))
    .filter(Boolean)
    .map((s) => byName.get(s))
    .filter((n): n is number => n != null);
}

function charactersToText(ids: number[]): string {
  return ids.map((id) => CHAR_NAMES[id] ?? String(id)).join(", ");
}

// Panel "AUTO-SHORTS": configura la generación automática de reels verticales
// (cada N días, top combos por reglas + ELO, aprobación por Telegram).
export function AutoShortsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["auto-shorts"],
    queryFn: getAutoShorts,
    refetchInterval: 15_000,
  });

  const [enabled, setEnabled] = useState(true);
  const [frequencyDays, setFrequencyDays] = useState("3");
  const [targetDurationSec, setTargetDurationSec] = useState("40");
  const [maxClips, setMaxClips] = useState("6");
  const [connectCodes, setConnectCodes] = useState("");
  const [characters, setCharacters] = useState("");
  const [dirty, setDirty] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  useEffect(() => {
    const cfg = query.data?.config;
    if (!cfg || dirty) return;
    setEnabled(cfg.enabled);
    setFrequencyDays(String(cfg.frequencyDays));
    setTargetDurationSec(String(cfg.targetDurationSec));
    setMaxClips(String(cfg.maxClips));
    setConnectCodes(cfg.playerFilter.connectCodes.join(", "));
    setCharacters(charactersToText(cfg.playerFilter.characterIds));
  }, [query.data, dirty]);

  const markDirty = () => {
    setDirty(true);
    setActionOk(null);
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      saveAutoShorts({
        enabled,
        frequencyDays: Number(frequencyDays),
        targetDurationSec: Number(targetDurationSec),
        maxClips: Number(maxClips),
        playerFilter: {
          connectCodes: connectCodes.split(",").map((s) => s.trim()).filter(Boolean),
          characterIds: parseCharacters(characters),
        },
      }),
    onSuccess: () => {
      setDirty(false);
      setActionError(null);
      setActionOk("Config guardada");
      queryClient.invalidateQueries({ queryKey: ["auto-shorts"] });
    },
    onError: (e) => {
      setActionOk(null);
      setActionError(String(e));
    },
  });

  const generateMutation = useMutation({
    mutationFn: generateAutoShort,
    onSuccess: (data) => {
      setActionError(null);
      setActionOk(`Encolado: ${data.title} (${data.clipCount} clips)`);
      queryClient.invalidateQueries({ queryKey: ["auto-shorts"] });
    },
    onError: (e) => {
      setActionOk(null);
      setActionError(String(e));
    },
  });

  const data = query.data;
  const activeJob = data?.activeJobId != null;

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Zap className="h-5 w-5 text-melee-gold" />
            AUTO-SHORTS
            {activeJob && (
              <Badge variant="secondary" className="text-[10px]">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                renderizando
              </Badge>
            )}
          </CardTitle>
          <Button
            variant={enabled ? "default" : "secondary"}
            size="sm"
            className="h-7 px-2 text-xs"
            title={enabled ? "Auto-shorts activado — click para pausar" : "Auto-shorts pausado — click para activar"}
            onClick={() => {
              setEnabled((v) => !v);
              markDirty();
            }}
          >
            {enabled ? "ON" : "OFF"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Cada {frequencyDays || "?"} días genera un reel vertical con los mejores combos recientes
          (reglas + ELO Slippi). Se manda por Telegram y solo sube si lo aprobás.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {query.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando config...
          </p>
        ) : query.isError ? (
          <p className="text-sm text-destructive">Error: {String(query.error)}</p>
        ) : data ? (
          <>
            <div className="grid grid-cols-3 gap-1.5">
              <label className="space-y-0.5">
                <span className="text-[10px] text-muted-foreground">Cada (días)</span>
                <Input
                  value={frequencyDays}
                  onChange={(e) => { setFrequencyDays(e.target.value); markDirty(); }}
                  className="h-7 text-xs"
                  inputMode="numeric"
                />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-muted-foreground">Duración (s)</span>
                <Input
                  value={targetDurationSec}
                  onChange={(e) => { setTargetDurationSec(e.target.value); markDirty(); }}
                  className="h-7 text-xs"
                  inputMode="numeric"
                />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-muted-foreground">Máx. clips</span>
                <Input
                  value={maxClips}
                  onChange={(e) => { setMaxClips(e.target.value); markDirty(); }}
                  className="h-7 text-xs"
                  inputMode="numeric"
                />
              </label>
            </div>
            <label className="block space-y-0.5">
              <span className="text-[10px] text-muted-foreground">
                Connect codes (separados por coma; vacío = todos)
              </span>
              <Input
                value={connectCodes}
                onChange={(e) => { setConnectCodes(e.target.value); markDirty(); }}
                placeholder="NOTME#882, JIMY#831"
                className="h-7 text-xs"
              />
            </label>
            <label className="block space-y-0.5">
              <span className="text-[10px] text-muted-foreground">
                Personajes (nombres separados por coma; vacío = todos)
              </span>
              <Input
                value={characters}
                onChange={(e) => { setCharacters(e.target.value); markDirty(); }}
                placeholder="Captain Falcon, Fox"
                className="h-7 text-xs"
              />
            </label>

            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!dirty || saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Guardar
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={activeJob || generateMutation.isPending}
                title={activeJob ? "Ya hay un auto-short en cola/renderizando" : "Genera un auto-short ahora con la config guardada"}
                onClick={() => generateMutation.mutate()}
              >
                {generateMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                Generar ahora
              </Button>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {data.candidateCount} candidatos en ventana
              </span>
            </div>
            {actionError && <p className="text-xs text-destructive">{actionError}</p>}
            {actionOk && <p className="text-xs text-green-400">{actionOk}</p>}

            {data.candidates.length > 0 && (
              <div className="space-y-1">
                <p className="text-[10px] font-semibold text-muted-foreground">
                  PRÓXIMOS CANDIDATOS (top {data.candidates.length})
                </p>
                {data.candidates.map((c) => (
                  <div
                    key={`${c.gamePath}:${c.stockId}`}
                    className="flex items-center gap-2 rounded-md border border-border/50 bg-black/20 px-2 py-1 text-xs"
                  >
                    <StockIcon characterId={c.player?.characterId} size={16} />
                    <span className="truncate font-semibold">{c.player?.connectCode ?? "?"}</span>
                    <span className="font-bold text-melee-gold">{c.comboLength} hits</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      {c.finalScore.toFixed(1)}
                      {c.rating != null && ` · ELO ${Math.round(c.rating)}`}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {data.history.length > 0 && (
              <div className="space-y-1">
                <p className="text-[10px] font-semibold text-muted-foreground">HISTORIAL</p>
                {data.history.slice(0, 8).map((h) => (
                  <div
                    key={h.id}
                    className="flex items-center gap-2 rounded-md border border-border/50 bg-black/20 px-2 py-1 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{h.title}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {new Date(h.createdAt).toLocaleDateString()} · {h.trigger} · {h.clips.length} clips
                        {h.error && <span className="text-destructive"> · {h.error}</span>}
                      </div>
                    </div>
                    <Badge
                      variant={h.status === "uploaded" ? "default" : h.status === "error" || h.status === "discarded" ? "destructive" : "secondary"}
                      className="shrink-0 text-[10px]"
                    >
                      {STATUS_LABELS[h.status] ?? h.status}
                    </Badge>
                    {h.youtubeUrl && (
                      <a
                        href={h.youtubeUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-melee-gold hover:text-melee-gold/80"
                        title="Ver en YouTube"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
