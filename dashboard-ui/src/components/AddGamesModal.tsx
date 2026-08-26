import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { StockIcon } from "@/components/StockIcon";
import { getGames, updateSet } from "@/lib/api";
import type { GameInfo } from "@/types";

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtDuration(sec?: number | null) {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Modal para agregar juegos ya escaneados (librería) a un set existente.
// Filtra los que ya están en el set y permite buscar por jugador, stage o fecha.
export function AddGamesModal({
  setId,
  existingPaths,
  onClose,
}: {
  setId: string;
  existingPaths: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const gamesQuery = useQuery({ queryKey: ["games"], queryFn: getGames });

  const existing = useMemo(() => new Set(existingPaths), [existingPaths]);

  const candidates = useMemo(() => {
    const all = (gamesQuery.data?.games ?? []).filter((g) => !existing.has(g.filePath));
    const q = search.trim().toLowerCase();
    const filtered = q
      ? all.filter((g) => {
          const hay = [
            g.fileName,
            g.stage,
            g.date,
            g.mainPlayer?.connectCode,
            g.opponent?.connectCode,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          // Cada palabra del search debe matchear (AND), para buscar
          // cosas como "dreamland dolf".
          return q.split(/\s+/).every((word) => hay.includes(word));
        })
      : all;
    // Más recientes primero.
    return [...filtered].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }, [gamesQuery.data, existing, search]);

  const addMutation = useMutation({
    mutationFn: (paths: string[]) =>
      updateSet(setId, { gamePaths: [...existingPaths, ...paths] }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sets"] });
      queryClient.invalidateQueries({ queryKey: ["set-stocks", setId] });
      onClose();
    },
    onError: (err) => setError(String(err)),
  });

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Agrega en orden cronológico (el set se juega en orden).
  const confirm = () => {
    const chosen = candidates
      .filter((g) => selected.has(g.filePath))
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .map((g) => g.filePath);
    if (chosen.length === 0) return;
    addMutation.mutate(chosen);
  };

  const renderRow = (g: GameInfo) => (
    <label
      key={g.filePath}
      className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors ${
        selected.has(g.filePath)
          ? "border-melee-gold/60 bg-melee-gold/10"
          : "border-border bg-black/20 hover:border-melee-gold/30"
      }`}
    >
      <Checkbox
        checked={selected.has(g.filePath)}
        onCheckedChange={() => toggle(g.filePath)}
      />
      <span className="w-32 shrink-0 truncate text-muted-foreground">
        {fmtDate(g.date)}
      </span>
      <span className="w-24 shrink-0 truncate">{g.stage}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {g.mainPlayer && (
          <>
            <StockIcon characterId={g.mainPlayer.characterId} size={16} />
            <span className="truncate">{g.mainPlayer.connectCode}</span>
          </>
        )}
        <span className="text-muted-foreground">vs</span>
        {g.opponent && (
          <>
            <StockIcon characterId={g.opponent.characterId} size={16} />
            <span className="truncate">{g.opponent.connectCode}</span>
          </>
        )}
      </span>
      <span className="shrink-0 text-muted-foreground">{fmtDuration(g.duration)}</span>
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Search className="h-4 w-4 text-melee-gold" />
            Agregar juegos de la librería
          </h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground"
            onClick={onClose}
            title="Cerrar"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <Input
          autoFocus
          placeholder="Buscar por jugador, stage o fecha... (ej: dreamland dolf)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-sm"
        />

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {gamesQuery.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando librería...
            </div>
          ) : gamesQuery.isError ? (
            <p className="p-2 text-sm text-destructive">
              Error cargando juegos: {String(gamesQuery.error)}
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              No hay juegos que coincidan (los que ya están en el set no se muestran).
            </p>
          ) : (
            candidates.slice(0, 200).map(renderRow)
          )}
          {candidates.length > 200 && (
            <p className="p-1 text-[10px] text-muted-foreground">
              Mostrando 200 de {candidates.length} — refiná la búsqueda.
            </p>
          )}
        </div>

        {error && <Badge variant="destructive">Error: {error}</Badge>}

        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            {selected.size} seleccionado{selected.size === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              size="sm"
              onClick={confirm}
              disabled={selected.size === 0 || addMutation.isPending}
            >
              {addMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Agregar al set
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
