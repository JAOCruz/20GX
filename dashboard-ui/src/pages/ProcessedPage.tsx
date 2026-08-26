import { useQuery } from "@tanstack/react-query";
import { Film, ExternalLink, PlayCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDashboard } from "@/lib/api";
import { DashboardGame } from "@/types";

function clipUrl(path: string) {
  if (path.startsWith("/")) return path;
  return `/clips-auto/${path}`;
}

export function ProcessedPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard"],
    queryFn: getDashboard,
  });

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Film className="h-6 w-6 text-melee-gold" />
        <h1 className="text-2xl font-bold text-foreground">Juegos procesados</h1>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Cargando procesados...</p>
      ) : error ? (
        <p className="text-destructive">Error: {String(error)}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data?.games.map((game) => (
            <ProcessedCard key={game.fileName} game={game} />
          ))}
          {data?.games.length === 0 && (
            <p className="text-muted-foreground">No hay juegos procesados aún.</p>
          )}
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds?: number | null) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ProcessedCard({ game }: { game: DashboardGame }) {
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{game.label || game.fileName}</CardTitle>
        <CardDescription className="text-xs">{game.outputDir}</CardDescription>
        {(game.stage || game.durationSeconds != null) && (
          <div className="flex flex-wrap gap-2 pt-1 text-xs text-muted-foreground">
            {game.stage && <Badge variant="outline">{game.stage}</Badge>}
            {game.durationSeconds != null && (
              <Badge variant="outline">{formatDuration(game.durationSeconds)}</Badge>
            )}
            {game.attacker?.name && game.victim?.name && (
              <Badge variant="outline">
                {game.attacker.name} vs {game.victim.name}
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          {game.stocks.map((stock) => (
            <div key={stock.path} className="flex items-center justify-between gap-2">
              <Badge variant="outline" className="text-xs">
                Stock {stock.index} ({stock.direction})
              </Badge>
              <Button variant="ghost" size="sm" asChild>
                <a href={clipUrl(stock.path)} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-1 h-3 w-3" />
                  Ver
                </a>
              </Button>
            </div>
          ))}
        </div>
        {game.combinedPath && (
          <Button variant="secondary" size="sm" className="w-full" asChild>
            <a href={clipUrl(game.combinedPath)} target="_blank" rel="noreferrer">
              <PlayCircle className="mr-2 h-4 w-4" />
              Ver combinado
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
