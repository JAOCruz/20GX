import { useMemo, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StockIcon } from "@/components/StockIcon";
import { CHAR_NAMES } from "@/lib/stockIcons";

interface CharacterSelectProps {
  value: number | null;
  onChange: (characterId: number | null) => void;
  className?: string;
}

// Selector de personaje estándar del dashboard: botón con stock icon que abre
// la lista de los 26 personajes, filtrable escribiendo ("capit" → Captain
// Falcon). Reutilizable en cualquier formulario de búsqueda.
export function CharacterSelect({ value, onChange, className = "" }: CharacterSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    const entries = Object.entries(CHAR_NAMES).map(([id, name]) => ({
      id: Number(id),
      name,
    }));
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((c) => c.name.toLowerCase().includes(q));
  }, [query]);

  return (
    <div className={`relative ${className}`}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-8 w-full justify-between px-2 text-xs"
        onClick={() => {
          setOpen((o) => !o);
          setQuery("");
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {value != null ? (
            <>
              <StockIcon characterId={value} size={16} />
              <span className="truncate">{CHAR_NAMES[value]}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Cualquier personaje</span>
          )}
        </span>
        <span className="flex items-center gap-0.5">
          {value != null && (
            <span
              role="button"
              title="Quitar personaje"
              className="text-muted-foreground hover:text-melee-gold"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            >
              <X className="h-3 w-3" />
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      </Button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-border bg-card shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar personaje..."
            className="h-7 w-full border-b border-border bg-transparent px-2 text-xs outline-none"
          />
          <div className="max-h-52 overflow-y-auto">
            {options.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                Ningún personaje matchea "{query}".
              </p>
            ) : (
              options.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-melee-gold/10 ${
                    value === c.id ? "bg-melee-gold/15 text-melee-gold" : ""
                  }`}
                  onClick={() => {
                    onChange(c.id);
                    setOpen(false);
                  }}
                >
                  <StockIcon characterId={c.id} size={18} />
                  {c.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
