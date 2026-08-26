import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Crown,
  Download,
  Film,
  ListVideo,
  Loader2,
  MonitorPlay,
  Pencil,
  Radar,
  Scissors,
  Search,
  Smartphone,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StockIcon } from "@/components/StockIcon";
import { ExportThumbnail } from "@/components/ExportThumbnail";
import { ImportDropzone } from "@/components/ImportDropzone";
import { SearchSetsModal } from "@/components/SearchSetsModal";
import { deleteSet, detectSets, getExports, getSets, updateSet } from "@/lib/api";
import type { ExportRecord, SetSummary } from "@/types";

function formatDuration(seconds?: number | null) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatSize(bytes?: number | null) {
  if (bytes == null || !isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function ExportRow({ record: e }: { record: ExportRecord }) {
  const discarded = e.approvalStatus === "discarded";
  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-black/20 p-2 text-sm ${
        discarded ? "opacity-50" : ""
      }`}
    >
      {e.type === "reel" ? (
        <Scissors className="h-4 w-4 text-melee-gold" />
      ) : (
        <Film className="h-4 w-4 text-melee-gold" />
      )}
      <span
        className={`font-semibold ${discarded ? "line-through" : ""}`}
        title={e.title ?? undefined}
      >
        {e.name}
      </span>
      <Badge variant="outline" className="text-xs">
        {e.type === "reel" ? "Reel" : "Set"}
      </Badge>
      {e.vertical && (
        <Badge variant="outline" className="text-xs" title="Vertical (Shorts)">
          <Smartphone className="h-3 w-3" />
        </Badge>
      )}
      <span className="text-xs text-muted-foreground">{formatDate(e.completedAt)}</span>
      <span className="text-xs text-muted-foreground">{formatSize(e.sizeBytes)}</span>
      <span className="text-xs text-muted-foreground">{e.clipCount} clips</span>
      <ExportThumbnail record={e} />
      {e.scheduled && (
        <Badge variant="outline" className="border-blue-500/50 text-xs text-blue-400">
          programado
        </Badge>
      )}
      {e.youtubeUrl ? (
        <a
          href={e.youtubeUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-xs text-melee-gold hover:underline"
        >
          <MonitorPlay className="h-3.5 w-3.5" />
          YouTube
        </a>
      ) : e.approvalStatus === "pending" ? (
        <Badge variant="outline" className="border-amber-400/50 text-amber-400">
          pendiente de aprobación
        </Badge>
      ) : e.approvalStatus === "uploaded" ? (
        <Badge variant="outline" className="border-green-500/50 text-green-400">
          subido
        </Badge>
      ) : discarded ? (
        <Badge variant="outline" className="text-muted-foreground">
          descartado
        </Badge>
      ) : null}
      {e.exists ? (
        <a
          href={e.url}
          target="_blank"
          rel="noreferrer"
          title="Descargar/ver video"
          className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-melee-gold/40 hover:text-melee-gold"
        >
          <Download className="h-3.5 w-3.5" />
          Ver
        </a>
      ) : (
        <span className="ml-auto text-xs text-muted-foreground">archivo eliminado</span>
      )}
    </div>
  );
}

function SetCard({
  set,
  editing,
  editName,
  onEditName,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onOpen,
  onDelete,
}: {
  set: SetSummary;
  editing: boolean;
  editName: string;
  onEditName: (v: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const winnerSide =
    set.wins[0] > set.wins[1] ? 0 : set.wins[1] > set.wins[0] ? 1 : null;

  return (
    <Card
      className="cursor-pointer border-border bg-card transition-colors hover:border-melee-gold/50"
      onClick={onOpen}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          {editing ? (
            <div
              className="flex flex-1 items-center gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              <Input
                value={editName}
                onChange={(e) => onEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveEdit();
                  if (e.key === "Escape") onCancelEdit();
                }}
                autoFocus
                className="h-8"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-melee-gold"
                title="Guardar nombre"
                onClick={onSaveEdit}
              >
                <Check className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                title="Cancelar"
                onClick={onCancelEdit}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <>
              <CardTitle className="flex items-center gap-2 text-base">
                <ListVideo className="h-4 w-4 text-melee-red" />
                {set.name}
                {set.storyNotes?.trim() && (
                  <span title="Tiene notas de historia">
                    <StickyNote className="h-3.5 w-3.5 text-melee-gold" />
                  </span>
                )}
              </CardTitle>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground"
                  title="Renombrar set"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartEdit();
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
                  title="Eliminar set"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="space-y-1">
          {set.players.map((p, i) => (
            <div key={`${p.connectCode}-${i}`} className="flex items-center gap-2">
              <StockIcon characterId={p.characterId} size={20} />
              <span className="font-semibold">{p.connectCode}</span>
              {winnerSide === i && (
                <Crown className="h-3.5 w-3.5 fill-melee-gold text-melee-gold" />
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 text-lg font-bold">
          {winnerSide === 0 && (
            <Crown className="h-4 w-4 fill-melee-gold text-melee-gold" />
          )}
          <span className={winnerSide === 0 ? "text-melee-gold" : ""}>
            {set.wins[0]}
          </span>
          <span className="text-muted-foreground">—</span>
          <span className={winnerSide === 1 ? "text-melee-gold" : ""}>
            {set.wins[1]}
          </span>
          {winnerSide === 1 && (
            <Crown className="h-4 w-4 fill-melee-gold text-melee-gold" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {set.format && (
            <Badge variant="outline" className="border-melee-gold/50 text-melee-gold">
              {set.format}
            </Badge>
          )}
          <Badge variant={set.source === "auto" ? "secondary" : "default"}>
            {set.source === "auto" ? "auto" : "manual"}
          </Badge>
          <span>{formatDate(set.date)}</span>
          <span>{set.gameCount ?? set.gamePaths.length} juegos</span>
          {set.durationSec != null && <span>{formatDuration(set.durationSec)}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

export function SetsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["sets"],
    queryFn: getSets,
  });

  const exportsQuery = useQuery({ queryKey: ["exports"], queryFn: getExports });

  const detectMutation = useMutation({
    mutationFn: detectSets,
    onSuccess: (res) => {
      setDetectMsg(`${res.added} sets nuevos detectados`);
      queryClient.invalidateQueries({ queryKey: ["sets"] });
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      updateSet(id, { name }),
    onSuccess: () => {
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["sets"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSet,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sets"] });
    },
  });

  useEffect(() => {
    if (!detectMsg) return;
    const t = setTimeout(() => setDetectMsg(null), 5000);
    return () => clearTimeout(t);
  }, [detectMsg]);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListVideo className="h-6 w-6 text-melee-red" />
          <h1 className="text-2xl font-bold text-foreground">Sets</h1>
        </div>
        <div className="flex items-center gap-2">
          {detectMsg && (
            <Badge variant="outline" className="border-melee-gold/50 text-melee-gold">
              {detectMsg}
            </Badge>
          )}
          {detectMutation.isError && (
            <Badge variant="destructive">{String(detectMutation.error)}</Badge>
          )}
          <Button
            variant="secondary"
            onClick={() => setShowSearch(true)}
            title="Buscar juegos por jugador/personaje y crear un set con los resultados"
          >
            <Search className="h-4 w-4" />
            Buscar y crear
          </Button>
          <Button
            onClick={() => detectMutation.mutate()}
            disabled={detectMutation.isPending}
          >
            {detectMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Radar className="h-4 w-4" />
            )}
            Detectar sets
          </Button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Cargando sets...</p>
      ) : error ? (
        <p className="text-destructive">Error: {String(error)}</p>
      ) : !data || data.sets.length === 0 ? (
        <Card className="border-border bg-card">
          <CardContent className="p-6 text-sm text-muted-foreground">
            No hay sets todavía. Usá <span className="text-foreground">"Detectar sets"</span>{" "}
            para encontrarlos automáticamente, o creá uno desde la página de{" "}
            <span className="text-foreground">Juegos</span> seleccionando replays.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.sets.map((set) => (
            <SetCard
              key={set.id}
              set={set}
              editing={editingId === set.id}
              editName={editName}
              onEditName={setEditName}
              onStartEdit={() => {
                setEditingId(set.id);
                setEditName(set.name);
              }}
              onSaveEdit={() => {
                const name = editName.trim();
                if (name && name !== set.name) {
                  renameMutation.mutate({ id: set.id, name });
                } else {
                  setEditingId(null);
                }
              }}
              onCancelEdit={() => setEditingId(null)}
              onOpen={() => navigate(`/sets/${set.id}`)}
              onDelete={() => {
                if (window.confirm(`¿Eliminar el set "${set.name}"?`)) {
                  deleteMutation.mutate(set.id);
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Historial de exports */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Film className="h-5 w-5 text-melee-red" />
            Exports
          </CardTitle>
        </CardHeader>
        <CardContent>
          {exportsQuery.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Cargando exports...
            </p>
          ) : exportsQuery.isError ? (
            <p className="text-sm text-destructive">
              Error cargando exports: {String(exportsQuery.error)}
            </p>
          ) : !exportsQuery.data || exportsQuery.data.exports.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no hay exports.</p>
          ) : (
            <div className="space-y-1.5">
              {exportsQuery.data.exports.map((e) => (
                <ExportRow key={e.jobId} record={e} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ImportDropzone />

      {showSearch && (
        <SearchSetsModal
          onClose={() => setShowSearch(false)}
          onCreated={(setId) => {
            setShowSearch(false);
            queryClient.invalidateQueries({ queryKey: ["sets"] });
            navigate(`/sets/${setId}`);
          }}
        />
      )}
    </div>
  );
}
