import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mic, Clock, Users, Gamepad2, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDiscordRecordings, deleteDiscordRecording } from "@/lib/api";
import { StockIcon } from "@/components/StockIcon";
import { StockPanel } from "@/components/StockPanel";
import type { GameInfo, Recording } from "@/types";

function formatDuration(seconds?: number | null) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDateTime(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function GameMiniCard({
  game,
  highlighted,
  expanded,
  onToggle,
}: {
  game: GameInfo;
  highlighted?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  return (
    <div
      ref={ref}
      className={`rounded-md border p-3 text-sm ${
        highlighted ? "border-melee-gold bg-melee-gold/10" : "border-border bg-card"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Gamepad2 className="h-4 w-4 text-melee-gold" />
          <span className="font-medium">{game.fileName}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {game.stage}
          </Badge>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onToggle}>
            {expanded ? <ChevronUp className="mr-1 h-3 w-3" /> : <ChevronDown className="mr-1 h-3 w-3" />}
            {expanded ? "Ocultar stocks" : "Ver stocks"}
          </Button>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
        <span className="flex items-center gap-1">
          <StockIcon characterId={game.mainPlayer?.characterId} costumeId={game.mainPlayer?.costumeId} size={18} />
          {game.mainPlayer?.connectCode || "—"} ({game.mainPlayer?.characterName})
        </span>
        <span className="flex items-center gap-1">
          <StockIcon characterId={game.opponent?.characterId} costumeId={game.opponent?.costumeId} size={18} />
          {game.opponent?.connectCode || "—"} ({game.opponent?.characterName})
        </span>
        <span>Duración: {formatDuration(game.duration)}</span>
        <span>{formatDateTime(game.startAt)}</span>
      </div>
      {expanded && (
        <div className="mt-3">
          <StockPanel game={game} />
        </div>
      )}
    </div>
  );
}

function RecordingCard({
  recording,
  highlightedGame,
  expandedGame,
  onToggleGame,
  onDelete,
}: {
  recording: Recording;
  highlightedGame?: string | null;
  expandedGame?: string | null;
  onToggleGame?: (filePath: string) => void;
  onDelete?: (id: string) => void;
}) {
  const games = recording.overlappingGames ?? [];
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              <Mic className="h-4 w-4 text-melee-red" />
              {recording.channelName || "Grabación Discord"}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{formatDateTime(recording.startedAt)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-mono">
              {formatDuration(recording.durationSeconds)}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
              title="Eliminar grabación"
              onClick={() => onDelete?.(recording.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Fin: {formatDateTime(recording.stoppedAt)}
          </span>
          {recording.userIds && recording.userIds.length > 0 && (
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {recording.userIds.length} usuario(s)
            </span>
          )}
        </div>

        {recording.path && (
          <audio controls src={`/recordings/${encodeURIComponent(recording.id)}`} className="w-full" />
        )}

        <hr className="border-border" />

        <div>
          <h4 className="mb-2 text-sm font-semibold flex items-center gap-2">
            <Gamepad2 className="h-4 w-4 text-melee-gold" />
            Juegos que se solapan ({games.length})
          </h4>
          {games.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No se encontraron juegos en el rango de tiempo de esta grabación.
            </p>
          ) : (
            <div className="space-y-2">
              {games.map((game) => (
                <GameMiniCard
                  key={game.filePath}
                  game={game}
                  highlighted={highlightedGame === game.filePath}
                  expanded={expandedGame === game.filePath}
                  onToggle={() => onToggleGame?.(game.filePath)}
                />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function RecordingsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightGame = searchParams.get("game");
  const [expandedGame, setExpandedGame] = useState<string | null>(highlightGame);
  const { data, isLoading, error } = useQuery({
    queryKey: ["recordings"],
    queryFn: getDiscordRecordings,
    refetchInterval: 5000,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDiscordRecording,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });

  const handleToggleGame = (filePath: string) => {
    setExpandedGame((prev) => (prev === filePath ? null : filePath));
    // Limpiar el query param después de expandir/resaltar
    if (highlightGame) {
      setSearchParams({}, { replace: true });
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Mic className="h-6 w-6 text-melee-red" />
        <h1 className="text-2xl font-bold text-foreground">Grabaciones de Discord</h1>
      </div>

      {data?.active && <Badge className="bg-melee-gold text-melee-blue">Grabación activa</Badge>}

      {isLoading ? (
        <p className="text-muted-foreground">Cargando grabaciones...</p>
      ) : error ? (
        <p className="text-destructive">Error: {String(error)}</p>
      ) : data?.recordings.length === 0 ? (
        <p className="text-muted-foreground">No hay grabaciones guardadas todavía.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data?.recordings.map((recording) => (
            <RecordingCard
              key={recording.id}
              recording={recording}
              highlightedGame={highlightGame}
              expandedGame={expandedGame}
              onToggleGame={handleToggleGame}
              onDelete={(id) => deleteMutation.mutate(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
