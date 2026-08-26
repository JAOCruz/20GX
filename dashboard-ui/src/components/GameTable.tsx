import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type FilterFn,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Crown, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GameInfo } from "@/types";
import { useDashboardStore } from "@/hooks/useDashboardStore";
import { StockPanel } from "./StockPanel";
import { StockIcon } from "./StockIcon";

function formatDuration(seconds?: number | null) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const gameSearchFilter: FilterFn<GameInfo> = (row, _columnId, filterValue) => {
  if (!filterValue) return true;
  const terms = String(filterValue)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return true;

  const g = row.original;
  const haystack = [
    g.fileName,
    g.stage,
    g.date,
    g.mainPlayer?.connectCode,
    g.mainPlayer?.displayName,
    g.mainPlayer?.characterName,
    g.opponent?.connectCode,
    g.opponent?.displayName,
    g.opponent?.characterName,
  ]
    .map((f) => String(f ?? "").toLowerCase())
    .join(" ");

  return terms.every((term) => haystack.includes(term));
};

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

export function GameTable({ games }: { games: GameInfo[] }) {
  const [globalFilter, setGlobalFilter] = useState("");
  const navigate = useNavigate();
  const { selectedGames, toggleGame, expandedGame, setExpandedGame } = useDashboardStore();

  const columns = useMemo<ColumnDef<GameInfo>[]>(
    () => [
      {
        id: "select",
        header: "Sel",
        cell: ({ row }) => (
          <Checkbox
            checked={selectedGames.has(row.original.filePath)}
            onCheckedChange={() => toggleGame(row.original.filePath)}
            aria-label="Select row"
          />
        ),
      },
      {
        accessorKey: "mainPlayer",
        header: "Jugador principal",
        cell: ({ row, getValue }) => {
          const p = getValue() as GameInfo["mainPlayer"];
          const isWinner = row.original.winnerPlayerIndex != null && p?.playerIndex === row.original.winnerPlayerIndex;
          if (!p?.connectCode) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex items-center gap-2">
              <StockIcon characterId={p?.characterId} costumeId={p?.costumeId} size={24} />
              <div>
                <div className="flex items-center gap-1">
                  <span className="font-semibold">{p?.connectCode}</span>
                  {isWinner && (
                    <Crown className="h-3.5 w-3.5 fill-melee-gold text-melee-gold" />
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{p?.characterName}</div>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "opponent",
        header: "Oponente",
        cell: ({ row, getValue }) => {
          const p = getValue() as GameInfo["opponent"];
          const isWinner = row.original.winnerPlayerIndex != null && p?.playerIndex === row.original.winnerPlayerIndex;
          if (!p?.connectCode) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex items-center gap-2">
              <StockIcon characterId={p?.characterId} costumeId={p?.costumeId} size={24} />
              <div>
                <div className="flex items-center gap-1">
                  <span className="font-semibold">{p?.connectCode}</span>
                  {isWinner && (
                    <Crown className="h-3.5 w-3.5 fill-melee-gold text-melee-gold" />
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{p?.characterName}</div>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "stage",
        header: "Escenario",
      },
      {
        accessorKey: "date",
        header: "Fecha",
        cell: ({ getValue }) => formatDate(getValue() as string),
      },
      {
        accessorKey: "duration",
        header: "Duración",
        cell: ({ getValue }) => formatDuration(getValue() as number | null | undefined),
      },
      {
        id: "recording",
        header: "Audio",
        cell: ({ row }) => {
          if (!row.original.hasRecording) return null;
          return (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-melee-gold"
              title="Este juego tiene audio grabado"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/recordings?game=${encodeURIComponent(row.original.filePath)}`);
              }}
            >
              <Mic className="h-4 w-4" />
            </Button>
          );
        },
      },
      {
        id: "expand",
        header: "",
        cell: ({ row }) => {
          const isExpanded = expandedGame === row.original.filePath;
          return (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpandedGame(isExpanded ? null : row.original.filePath)}
            >
              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              Stocks
            </Button>
          );
        },
      },
    ],
    [selectedGames, toggleGame, expandedGame, setExpandedGame]
  );

  const table = useReactTable({
    data: games,
    columns,
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: gameSearchFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="space-y-2">
      <div className="relative max-w-md">
        <Input
          placeholder="Buscar: DOLF JIMY dreamland falcon..."
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="pr-8"
        />
        {globalFilter && (
          <button
            type="button"
            onClick={() => setGlobalFilter("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        )}
      </div>
      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => {
                const isExpanded = expandedGame === row.original.filePath;
                return (
                  <>
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                    {isExpanded && (
                      <TableRow>
                        <TableCell colSpan={columns.length} className="bg-muted/20 p-0">
                          <StockPanel game={row.original} />
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  {globalFilter ? (
                    <>
                      No hay juegos que coincidan con "<span className="text-foreground">{globalFilter}</span>".
                      <br />
                      Probá con otros términos o hacé un escaneo.
                    </>
                  ) : (
                    <>No hay juegos cargados. Hacé click en "Escanear rápido".</>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
