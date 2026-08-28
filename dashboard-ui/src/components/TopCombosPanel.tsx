import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, Radar, Search, Trophy, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { StockIcon } from "@/components/StockIcon";
import { CHAR_NAMES } from "@/lib/stockIcons";
import {
  createPreview,
  getPreview,
  getSetTopCombos,
  getTopCombos,
  getTopCombosScanStatus,
  startTopCombosScan,
} from "@/lib/api";
import type { TopCombo } from "@/types";

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface TopCombosPanelProps {
  scope: "global" | "set";
  setId?: string;
  // Si se provee, el click reproduce con el player del padre (SetDetailPage)
  // en vez del reproductor embebido del panel.
  onPlay?: (combo: TopCombo) => void;
}

// Estado de un preview encolado desde el panel (modo embebido).
interface PreviewEntry {
  id?: string;
  status: "pending" | "rendering" | "done" | "error";
  url?: string;
  etaSec?: number | null;
  error?: string;
}

// Panel "Top Combos": ranking de los combos más largos (global o del set).
// Cada item pide un preview con la ventana exacta (comboStartFrame - 4s de
// contexto → kill + 2s) calculada en el backend.
export function TopCombosPanel({ scope, setId, onPlay }: TopCombosPanelProps) {
  // Pedimos el máximo que sirve el backend (50) para que el filtro de
  // jugador/personaje NO quede limitado al top 10 global: primero se filtra,
  // después se muestra el top N elegido (10/20/30/50).
  const FETCH_LIMIT = 50;
  const queryClient = useQueryClient();
  const combosQuery = useQuery({
    queryKey:
      scope === "set" ? ["top-combos", "set", setId] : ["top-combos", "global"],
    queryFn: () =>
      scope === "set" && setId
        ? getSetTopCombos(setId, FETCH_LIMIT)
        : getTopCombos(FETCH_LIMIT),
  });

  // --- Scan global de stocks (solo scope global) ---
  const [scanRequested, setScanRequested] = useState(false);
  const scanQuery = useQuery({
    queryKey: ["top-combos-scan"],
    queryFn: getTopCombosScanStatus,
    enabled: scope === "global",
    refetchInterval: scanRequested ? 2000 : false,
  });
  const scanStatus = scanQuery.data?.status;
  const scanRunning = scanStatus === "running" || scanStatus === "pending";
  const scanProgress = scanQuery.data?.progress;

  // Seguir polleando si el scan ya corría al montar; frenar al terminar y
  // recargar el ranking con la data nueva.
  useEffect(() => {
    if (scope !== "global") return;
    if (scanRunning) setScanRequested(true);
    if (scanRequested && scanStatus && !scanRunning) {
      setScanRequested(false);
      queryClient.invalidateQueries({ queryKey: ["top-combos"] });
    }
  }, [scope, scanRunning, scanRequested, scanStatus, queryClient]);

  // --- Reproductor embebido (solo si el padre no provee onPlay) ---
  // Multi-preview: cada combo puede encolar su render independientemente.
  // `previews` lleva el estado de cada uno; `selectedKey` es el que se ve
  // en el player de abajo. Los renders corren en la cola del server.
  const [previews, setPreviews] = useState<Record<string, PreviewEntry>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const patchPreview = (key: string, patch: Partial<PreviewEntry>) =>
    setPreviews((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? { status: "pending" as const }), ...patch },
    }));

  const stopEmbedded = () => setSelectedKey(null);

  const playCombo = async (combo: TopCombo) => {
    if (onPlay) {
      onPlay(combo);
      return;
    }
    const key = `${combo.gamePath}:${combo.stockId}`;
    setSelectedKey(key);
    const existing = previews[key];
    // Ya listo o en cola: solo lo seleccionamos (el poll sigue corriendo).
    if (existing && existing.status !== "error") return;
    patchPreview(key, { status: "pending", error: undefined, url: undefined });
    try {
      const created = await createPreview({
        gamePath: combo.gamePath,
        startFrame: combo.startFrame,
        endFrame: combo.endFrame,
      });
      patchPreview(key, { id: created.id, etaSec: created.etaSec });
      const poll = async () => {
        try {
          const info = await getPreview(created.id);
          if (info.status === "done" && info.url) {
            patchPreview(key, { status: "done", url: info.url, etaSec: 0 });
            return;
          }
          if (info.status === "error") {
            patchPreview(key, { status: "error", error: info.error || "Error renderizando preview" });
            return;
          }
          patchPreview(key, {
            status: info.status === "rendering" ? "rendering" : "pending",
            etaSec: info.etaSec,
          });
        } catch (e) {
          patchPreview(key, { status: "error", error: String(e) });
          return;
        }
        pollTimers.current.set(key, setTimeout(poll, 2000));
      };
      await poll();
    } catch (e) {
      patchPreview(key, { status: "error", error: String(e) });
    }
  };

  const items = combosQuery.data?.items ?? [];
  const coverage = combosQuery.data?.coverage;

  // Filtro por jugador/personaje.
  // - Texto libre: multi-palabra (AND), case-insensitive, matchea connectCode
  //   y personaje de AMBOS lados ("cuenti fox", "lein sheik").
  // - Personaje elegido del dropdown: solo combos HECHOS por ese personaje
  //   (combo.player), no los combos donde es la víctima.
  const [query, setQuery] = useState("");
  const [selectedChar, setSelectedChar] = useState<number | null>(null);
  const [charListOpen, setCharListOpen] = useState(false);
  // Cuántos combos mostrar del ranking (después del filtro).
  const [displayLimit, setDisplayLimit] = useState(10);

  // Lista de personajes filtrada por lo que se escribe ("capit" → Captain Falcon).
  const charOptions = useMemo(() => {
    const entries = Object.entries(CHAR_NAMES).map(([charId, name]) => ({
      id: Number(charId),
      name,
    }));
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((c) => c.name.toLowerCase().includes(q));
  }, [query]);

  const filteredItems = useMemo(() => {
    if (selectedChar != null) {
      return items.filter((c) => c.player?.characterId === selectedChar);
    }
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return items;
    return items.filter((combo) => {
      const haystack = [
        combo.player?.connectCode,
        combo.opponent?.connectCode,
        combo.player ? CHAR_NAMES[combo.player.characterId] : null,
        combo.opponent ? CHAR_NAMES[combo.opponent.characterId] : null,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [items, query, selectedChar]);

  const displayedItems = useMemo(
    () => filteredItems.slice(0, displayLimit),
    [filteredItems, displayLimit]
  );

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Trophy className="h-5 w-5 text-melee-gold" />
            TOP COMBOS
            {Object.values(previews).filter(
              (p) => p.status === "pending" || p.status === "rendering"
            ).length > 0 && (
              <Badge variant="secondary" className="text-[10px]">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                renderizando{" "}
                {Object.values(previews).filter(
                  (p) => p.status === "pending" || p.status === "rendering"
                ).length}
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Select
              value={String(displayLimit)}
              onValueChange={(v) => setDisplayLimit(Number(v))}
            >
              <SelectTrigger className="h-7 w-[86px] text-xs" title="Cuántos combos mostrar">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 20, 30, 50].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    Top {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {scope === "global" && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={scanRunning}
              onClick={() => {
                setScanRequested(true);
                startTopCombosScan().catch(() => {});
              }}
              title="Computa los stocks de todos los juegos escaneados (salta los que ya están en cache)"
            >
              {scanRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Radar className="h-3.5 w-3.5" />
              )}
              Analizar todos
            </Button>
          )}
          </div>
        </div>
        {scope === "global" && coverage && (
          <p className="text-xs text-muted-foreground">
            Analizados {coverage.analyzed}/{coverage.total} juegos
          </p>
        )}
        {scope === "global" && scanRunning && scanProgress && (
          <div className="space-y-1 pt-1">
            <Progress
              value={
                scanProgress.total > 0
                  ? (scanProgress.current / scanProgress.total) * 100
                  : 0
              }
              className="h-1.5"
            />
            <p className="text-[10px] text-muted-foreground">
              Analizando {scanProgress.current}/{scanProgress.total}
              {scanProgress.failed ? ` · ${scanProgress.failed} con error` : ""}
            </p>
          </div>
        )}
        {items.length > 0 && (
          <div className="relative pt-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // Editar el texto después de elegir un personaje suelta la
                // selección y vuelve a búsqueda libre.
                if (selectedChar != null) setSelectedChar(null);
                setCharListOpen(true);
              }}
              onFocus={() => setCharListOpen(true)}
              onBlur={() => setTimeout(() => setCharListOpen(false), 150)}
              placeholder="Filtrar por jugador o personaje (ej: cuenti, capit...)"
              className={`h-7 pl-7 text-xs ${selectedChar != null ? "pr-14" : ""}`}
            />
            {selectedChar != null && (
              <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                <StockIcon characterId={selectedChar} size={16} />
                <button
                  type="button"
                  className="text-muted-foreground hover:text-melee-gold"
                  title="Quitar filtro de personaje"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSelectedChar(null);
                    setQuery("");
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
            {charListOpen && (
              <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
                {charOptions.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    Ningún personaje matchea "{query}".
                  </p>
                ) : (
                  charOptions.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-melee-gold/10"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSelectedChar(c.id);
                        setQuery(c.name);
                        setCharListOpen(false);
                      }}
                    >
                      <StockIcon characterId={c.id} size={18} />
                      {c.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-1.5">
        {combosQuery.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando combos...
          </p>
        ) : combosQuery.isError ? (
          <p className="text-sm text-destructive">
            Error: {String(combosQuery.error)}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {scope === "global"
              ? "Todavía no hay juegos analizados. Usá \"Analizar todos\" para computar los stocks."
              : "No hay combos de 3+ hits en este set."}
          </p>
        ) : filteredItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ningún combo matchea "{query}".
          </p>
        ) : (
          <>
            {(query.trim() || filteredItems.length > displayLimit) && (
              <p className="text-[10px] text-muted-foreground">
                mostrando {displayedItems.length} de {filteredItems.length}
                {query.trim() ? ` (filtro: ${query.trim()})` : ""}
              </p>
            )}
            {displayedItems.map((combo, i) => {
            const key = `${combo.gamePath}:${combo.stockId}`;
            const pv = previews[key];
            const pvBusy = pv?.status === "pending" || pv?.status === "rendering";
            const pvDone = pv?.status === "done";
            const pvError = pv?.status === "error";
            const isSelected = selectedKey === key;
            return (
              <div
                key={key}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${
                  isSelected
                    ? "border-melee-gold/60 bg-melee-gold/5"
                    : "border-border/50 bg-black/20 hover:border-melee-gold/40"
                }`}
              >
                <span className="w-5 shrink-0 text-center font-mono text-xs font-bold text-melee-gold">
                  {i + 1}
                </span>
                <StockIcon characterId={combo.player?.characterId} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-xs font-semibold">
                      {combo.player?.connectCode ?? "?"}
                    </span>
                    <span className="text-base font-bold text-melee-gold">
                      {combo.comboLength} hits
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                    {combo.gameIndex != null && (
                      <span className="font-bold text-melee-gold">
                        G{combo.gameIndex + 1}
                      </span>
                    )}
                    {combo.killMove && (
                      <span className="text-melee-gold">
                        {combo.killMove}
                        {combo.killPercent != null && ` · ${combo.killPercent}%`}
                      </span>
                    )}
                    <span>
                      {formatTime(combo.timeSeconds)} · {combo.stage}
                    </span>
                    <span>score {combo.score.toFixed(1)}</span>
                  </div>
                </div>
                {pvBusy && pv?.etaSec != null && (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    ~{Math.max(1, Math.round(pv.etaSec))}s
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 w-7 shrink-0 p-0 ${
                    pvError ? "text-destructive" : pvDone ? "text-green-400" : "text-melee-gold"
                  }`}
                  title={
                    pvError
                      ? `Error: ${pv.error || "desconocido"} — click para reintentar`
                      : pvBusy
                        ? `Renderizando... falta ~${Math.max(1, Math.round(pv?.etaSec ?? 0))}s`
                        : pvDone
                          ? "Ver el combo (ya renderizado)"
                          : "Ver el combo (renderiza un preview con contexto)"
                  }
                  disabled={pvBusy && isSelected}
                  onClick={() => playCombo(combo)}
                >
                  {pvBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : pvError ? (
                    <X className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            );
          })}
          </>
        )}

        {/* Reproductor embebido: solo cuando el padre no maneja el play */}
        {!onPlay && selectedKey && (
          <div className="space-y-1 rounded-md border border-border/50 bg-black/30 p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">
                Preview
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground"
                title="Cerrar preview"
                onClick={stopEmbedded}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            {previews[selectedKey]?.status === "done" && previews[selectedKey]?.url ? (
              <video
                key={previews[selectedKey]!.url}
                src={previews[selectedKey]!.url}
                controls
                autoPlay
                playsInline
                // Previews 4:3 (Melee nativo): ratio intrínseco, sin barras negras.
                className="mx-auto max-h-[55vh] w-auto max-w-full rounded-md border border-border bg-black"
              />
            ) : previews[selectedKey]?.status === "error" ? (
              <Badge variant="destructive">
                {previews[selectedKey]?.error || "Error renderizando preview"}
              </Badge>
            ) : (
              <div className="mx-auto flex aspect-[4/3] max-h-[55vh] w-full max-w-[min(100%,73vh)] flex-col items-center justify-center gap-2 rounded-md border border-border bg-black/40 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-melee-gold" />
                  Renderizando preview...
                </div>
                {previews[selectedKey]?.etaSec != null && (
                  <span className="font-mono text-[10px]">
                    falta ~{Math.max(1, Math.round(previews[selectedKey]!.etaSec!))}s
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
