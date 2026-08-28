import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getComboRanking, getMoves, saveComboRanking } from "@/lib/api";
import { CHAR_NAMES } from "@/lib/stockIcons";
import type { ComboRule, ComboRuleType } from "@/types";

const RULE_TYPE_LABELS: Record<ComboRuleType, string> = {
  containsMove: "Contiene el golpe",
  startsWithMove: "Empieza con el golpe",
  endsWithMove: "Termina con el golpe",
  minHits: "Mínimo de golpes",
  maxKillPercent: "Kill a ≤ %",
};

// Presets de reglas comunes (moveIds genéricos de slippi-js + characterId).
const PRESETS: { label: string; rule: ComboRule }[] = [
  { label: "Falcon Punch", rule: { type: "containsMove", moveId: 18, characterId: 0 } },
  { label: "Knee (Falcon)", rule: { type: "containsMove", moveId: 13, characterId: 0 } },
  { label: "Rest (Puff)", rule: { type: "containsMove", moveId: 21, characterId: 15 } },
];

function isMoveRule(type: ComboRuleType) {
  return type === "containsMove" || type === "startsWithMove" || type === "endsWithMove";
}

// Editor de reglas de ranking personalizado. El orden de la lista ES la
// prioridad: un combo que matchea la regla 1 va antes que cualquiera que
// solo matchee la regla 2, sin importar la cantidad de golpes.
export function ComboRankingEditor({ onSaved }: { onSaved?: () => void }) {
  const queryClient = useQueryClient();
  const rankingQuery = useQuery({ queryKey: ["combo-ranking"], queryFn: getComboRanking });
  const movesQuery = useQuery({ queryKey: ["moves"], queryFn: getMoves, staleTime: Infinity });

  const [rules, setRules] = useState<ComboRule[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (rankingQuery.data && !dirty) setRules(rankingQuery.data.rules);
  }, [rankingQuery.data, dirty]);

  const saveMutation = useMutation({
    mutationFn: saveComboRanking,
    onSuccess: (data) => {
      setRules(data.rules);
      setDirty(false);
      queryClient.setQueryData(["combo-ranking"], { rules: data.rules });
      queryClient.invalidateQueries({ queryKey: ["top-combos"] });
      onSaved?.();
    },
  });

  const update = (i: number, patch: Partial<ComboRule>) => {
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const move = (i: number, dir: -1 | 1) => {
    setRules((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setDirty(true);
  };

  const remove = (i: number) => {
    setRules((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  };

  const add = (rule: ComboRule) => {
    setRules((prev) => [...prev, rule]);
    setDirty(true);
  };

  const moves = movesQuery.data?.moves ?? [];

  return (
    <div className="space-y-2 rounded-md border border-border/50 bg-black/20 p-2">
      <p className="text-[10px] text-muted-foreground">
        Las reglas se aplican en orden: la 1 tiene prioridad absoluta. Ej: "Contiene Neutral B +
        Captain Falcon" arriba → cualquier combo con Falcon Punch sale primero, aunque sea de 1
        golpe.
      </p>

      {rules.map((rule, i) => (
        <div
          key={i}
          className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/40 bg-black/30 px-1.5 py-1"
        >
          <span className="w-4 shrink-0 text-center font-mono text-[10px] font-bold text-melee-gold">
            {i + 1}
          </span>
          <Select
            value={rule.type}
            onValueChange={(v) => update(i, { type: v as ComboRuleType })}
          >
            <SelectTrigger className="h-6 w-[130px] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(RULE_TYPE_LABELS) as ComboRuleType[]).map((t) => (
                <SelectItem key={t} value={t} className="text-xs">
                  {RULE_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {isMoveRule(rule.type) && (
            <Select
              value={rule.moveId != null ? String(rule.moveId) : ""}
              onValueChange={(v) => update(i, { moveId: Number(v) })}
            >
              <SelectTrigger className="h-6 w-[120px] text-[11px]">
                <SelectValue placeholder="Golpe..." />
              </SelectTrigger>
              <SelectContent>
                {moves.map((m) => (
                  <SelectItem key={m.id} value={String(m.id)} className="text-xs">
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {(rule.type === "minHits" || rule.type === "maxKillPercent") && (
            <Input
              type="number"
              min={0}
              value={rule.value ?? ""}
              onChange={(e) => update(i, { value: Number(e.target.value) })}
              className="h-6 w-16 text-[11px]"
              placeholder={rule.type === "minHits" ? "hits" : "%"}
            />
          )}

          <Select
            value={rule.characterId != null ? String(rule.characterId) : "any"}
            onValueChange={(v) =>
              update(i, { characterId: v === "any" ? null : Number(v) })
            }
          >
            <SelectTrigger className="h-6 w-[130px] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any" className="text-xs">
                Cualquier personaje
              </SelectItem>
              {Object.entries(CHAR_NAMES).map(([id, name]) => (
                <SelectItem key={id} value={id} className="text-xs">
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            title="Subir prioridad"
            disabled={i === 0}
            onClick={() => move(i, -1)}
          >
            <ArrowUp className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            title="Bajar prioridad"
            disabled={i === rules.length - 1}
            onClick={() => move(i, 1)}
          >
            <ArrowDown className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-destructive"
            title="Eliminar regla"
            onClick={() => remove(i)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => add({ type: "containsMove", moveId: 18, characterId: null })}
        >
          <Plus className="mr-1 h-3 w-3" />
          Regla
        </Button>
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            title={`Agregar regla: contiene ${p.label}`}
            onClick={() => add({ ...p.rule })}
          >
            <Plus className="mr-1 h-3 w-3" />
            {p.label}
          </Button>
        ))}
        <span className="flex-1" />
        <Button
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate(rules)}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Save className="mr-1 h-3 w-3" />
          )}
          Guardar reglas
        </Button>
      </div>
      {rules.length === 0 && (
        <p className="text-[10px] text-muted-foreground">
          Sin reglas: el ranking es el de siempre (más golpes primero).
        </p>
      )}
    </div>
  );
}
