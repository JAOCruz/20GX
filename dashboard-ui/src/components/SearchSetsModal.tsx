import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { StockIcon } from "@/components/StockIcon";
import { CharacterSelect } from "@/components/CharacterSelect";
import { createSet, getGames } from "@/lib/api";
import type { PlayerInfo } from "@/types";

interface SideFilter {
  text: string;
  char: number | null;
}

interface SearchSetsModalProps {
  onClose: () => void;
  onCreated: (setId: string) => void;
}

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

// Un lado matchea un jugador si: (sin texto o el code/nombre contiene todas
// las palabras) Y (sin personaje o el jugador usa ese personaje).
function sideMatchesPlayer(side: SideFilter, p: PlayerInfo | null): boolean {
  if (!p) return false;
  const words = side.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const hay = `${p.connectCode ?? ""} ${p.displayName ?? ""}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return false;
  }
  if (side.char != null && p.characterId !== side.char) return false;
  return true;
}

function sideIsEmpty(side: SideFilter): boolean {
  return side.text.trim() === "" && side.char == null;
}

// Modal estándar "buscar juegos → crear set": dos lados (jugador/personaje),
// resultados con checkbox, crear set con la selección en orden cronológico.
export function SearchSetsModal({ onClose, onCreated }: SearchSetsModalProps) {
  const [sideA, setSideA] = useState<SideFilter>({ text: "", char: null });
  const [sideB, setSideB] = useState<SideFilter>({ text: "", char: null });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gamesQuery = useQuery({ queryKey: ["games"], queryFn: getGames });
  const allGames = gamesQuery.data?.games ?? [];

  const results = useMemo(() => {
    if (sideIsEmpty(sideA) && sideIsEmpty(sideB)) return [];
    const matches = allGames.filter((g) => {
      const aMain = sideMatchesPlayer(sideA, g.mainPlayer);
      const aOpp = sideMatchesPlayer(sideA, g.opponent);
      const bMain = sideMatchesPlayer(sideB, g.mainPlayer);
      const bOpp = sideMatchesPlayer(sideB, g.opponent);
      if (sideIsEmpty(sideB)) return aMain || aOpp;
      if (sideIsEmpty(sideA)) return bMain || bOpp;
      // Ambos lados llenos: A y B en lados opuestos (cualquier orden).
      return (aMain && bOpp) || (aOpp && bMain);
    });
    return matches.sort((x, y) =>
      String(x.startAt ?? x.date).localeCompare(String(y.startAt ?? y.date))
    );
  }, [allGames, sideA, sideB]);

  const toggle = (filePath: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(filePath);
      else next.delete(filePath);
      return next;
    });
  };

  const autoName = () => {
    const a = sideA.text.trim().toUpperCase() || (sideA.char != null ? "?" : "?");
    const b = sideB.text.trim().toUpperCase() || "?";
    const date = results[0] ? fmtDate(results[0].startAt ?? results[0].date) : "";
    return `${a} vs ${b}${date ? ` — ${date}` : ""}`;
  };

  const handleCreate = async () => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const gamePaths = results
        .filter((g) => selected.has(g.filePath))
        .map((g) => g.filePath);
      const res = await createSet({ name: name.trim() || autoName(), gamePaths });
      onCreated(res.set.id);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col space-y-3 rounded-lg border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Search className="h-5 w-5 text-melee-gold" />
            Buscar juegos → crear set
          </h2>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Filtros: dos lados, cada uno con texto (code/nombre) + personaje */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(
            [
              ["A", sideA, setSideA],
              ["B", sideB, setSideB],
            ] as const
          ).map(([label, side, setSide]) => (
            <div key={label} className="space-y-1 rounded-md border border-border/50 p-2">
              <span className="text-[10px] font-semibold tracking-wider text-muted-foreground">
                JUGADOR {label}
              </span>
              <Input
                value={side.text}
                onChange={(e) => setSide({ ...side, text: e.target.value })}
                placeholder="Connect code o nombre (ej: ears)"
                className="h-8 text-xs"
              />
              <CharacterSelect
                value={side.char}
                onChange={(char) => setSide({ ...side, char })}
              />
            </div>
          ))}
        </div>

        {gamesQuery.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando juegos...
          </p>
        ) : results.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {sideIsEmpty(sideA) && sideIsEmpty(sideB)
              ? "Escribí un code/nombre o elegí un personaje para buscar."
              : "Ningún juego matchea esos filtros."}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {results.length} juegos · {selected.size} seleccionados
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() =>
                  setSelected(
                    selected.size === results.length
                      ? new Set()
                      : new Set(results.map((g) => g.filePath))
                  )
                }
              >
                {selected.size === results.length ? "Quitar todos" : "Seleccionar todos"}
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {results.map((g) => (
                <label
                  key={g.filePath}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border/50 bg-black/20 px-2 py-1.5 text-xs hover:border-melee-gold/40"
                >
                  <Checkbox
                    checked={selected.has(g.filePath)}
                    onCheckedChange={(c) => toggle(g.filePath, c === true)}
                  />
                  <span className="w-16 shrink-0 text-muted-foreground">
                    {fmtDate(g.startAt ?? g.date)}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    {[g.mainPlayer, g.opponent].map((p, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && <span className="text-muted-foreground">vs</span>}
                        <StockIcon characterId={p?.characterId} size={16} />
                        <span className="truncate">{p?.connectCode ?? "?"}</span>
                      </span>
                    ))}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{g.stage}</span>
                </label>
              ))}
            </div>
          </>
        )}

        {selected.size > 0 && (
          <div className="flex items-center gap-2 border-t border-border/50 pt-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={autoName()}
              className="h-8 flex-1 text-xs"
            />
            <Button size="sm" className="h-8" disabled={busy} onClick={handleCreate}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Crear set ({selected.size})
            </Button>
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
