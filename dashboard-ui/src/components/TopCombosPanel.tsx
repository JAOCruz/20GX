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
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [playingBusy, setPlayingBusy] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const stopEmbedded = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    setPlayingKey(null);
    setPlayingUrl(null);
    setPlayingBusy(false);
  };

  const playCombo = async (combo: TopCombo) => {
    if (onPlay) {
      onPlay(combo);
      return;
    }
    const key = `${combo.gamePath}:${combo.stockId}`;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setPlayingKey(key);
    setPlayingUrl(null);
    setPlayingBusy(true);
    setPlayError(null);
    try {
      const created = await createPreview({
        gamePath: combo.gamePath,
        startFrame: combo.startFrame,
        endFrame: combo.endFrame,
      });
      const poll = async () => {
        try {
          const info = await getPreview(created.id);
          if (info.status === "done" && info.url) {
            setPlayingUrl(info.url);
            setPlayingBusy(false);
            return;
          }
          if (info.status === "error") {
            setPlayError(info.error || "Error renderizando preview");
            setPlayingBusy(false);
            return;
          }
        } catch (e) {
          setPlayError(String(e));
          setPlayingBusy(false);
          return;
        }
        pollTimer.current = setTimeout(poll, 2000);
      };
      await poll();
    } catch (e) {
      setPlayError(String(e));
      setPlayingBusy(false);
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
            const isPlaying = playingKey === key;
            return (
              <div
                key={key}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${
                  isPlaying
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
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 shrink-0 p-0 text-melee-gold"
                  title="Ver el combo (renderiza un preview con contexto)"
                  disabled={isPlaying && playingBusy}
                  onClick={() => playCombo(combo)}
                >
                  {isPlaying && playingBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
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
        {!onPlay && playingKey && (
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
            {playingUrl ? (
              <video
                key={playingUrl}
                src={playingUrl}
                controls
                autoPlay
                playsInline
                // Previews 4:3 (Melee nativo): ratio intrínseco, sin barras negras.
                className="mx-auto max-h-[55vh] w-auto max-w-full rounded-md border border-border bg-black"
              />
            ) : (
              <div className="mx-auto flex aspect-[4/3] max-h-[55vh] w-full max-w-[min(100%,73vh)] items-center justify-center gap-2 rounded-md border border-border bg-black/40 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-melee-gold" />
                Renderizando preview...
              </div>
            )}
            {playError && <Badge variant="destructive">{playError}</Badge>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
