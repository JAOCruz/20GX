import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gamepad2, ListVideo, Loader2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GlobalToolbar } from "@/components/GlobalToolbar";
import { JobPanel } from "@/components/JobPanel";
import { GameTable } from "@/components/GameTable";
import { StatsChart } from "@/components/StatsChart";
import { TopCombosPanel } from "@/components/TopCombosPanel";
import { getGames, getConfig, getScanStatus, createSet } from "@/lib/api";
import { useDashboardStore } from "@/hooks/useDashboardStore";

export function GamesPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["games"],
    queryFn: getGames,
  });

  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
  });

  const { data: scanStatus } = useQuery({
    queryKey: ["scan-status"],
    queryFn: getScanStatus,
    refetchInterval: 2000,
  });

  const { setGuildId, setChannelId, selectedGames, setGameSelected } = useDashboardStore();
  const navigate = useNavigate();
  const [createSetError, setCreateSetError] = useState<string | null>(null);

  const createSetMutation = useMutation({
    mutationFn: (gamePaths: string[]) => createSet({ gamePaths }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sets"] });
      selectedGames.forEach((p) => setGameSelected(p, false));
      navigate("/sets");
    },
    onError: (e) => setCreateSetError(String(e)),
  });

  const handleCreateSet = () => {
    setCreateSetError(null);
    // Orden cronológico ascendente según la fecha del replay.
    const ordered = (data?.games ?? [])
      .filter((g) => selectedGames.has(g.filePath))
      .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0))
      .map((g) => g.filePath);
    createSetMutation.mutate(ordered);
  };

  useEffect(() => {
    if (config) {
      if (config.discordGuildId) setGuildId(config.discordGuildId);
      if (config.discordChannelId) setChannelId(config.discordChannelId);
    }
  }, [config, setGuildId, setChannelId]);

  // Cuando termina un scan, refrescar la lista de juegos.
  useEffect(() => {
    if (scanStatus && !scanStatus.running && scanStatus.completedAt) {
      queryClient.invalidateQueries({ queryKey: ["games"] });
    }
  }, [scanStatus, queryClient]);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gamepad2 className="h-6 w-6 text-melee-red" />
          <h1 className="text-2xl font-bold text-foreground">Slippi Pipeline Dashboard</h1>
        </div>
        {config && (
          <Badge variant="outline" className="border-melee-gold/50 text-melee-gold">
            {config.replaysDir}
          </Badge>
        )}
      </div>

      <GlobalToolbar games={data?.games ?? []} />
      <JobPanel />

      <StatsChart games={data?.games ?? []} />

      {/* Replays + Top Combos global: columna lateral derecha en desktop,
          debajo de la tabla en mobile. El panel lleva su propio <video>. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <Card className="min-w-0 flex-1 border-border bg-card">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Replays</CardTitle>
              <div className="flex items-center gap-2">
              {scanStatus?.running && (
                <Badge variant="outline" className="animate-pulse border-melee-gold text-melee-gold">
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Escaneando {scanStatus.count > 0 ? `(${scanStatus.count})` : ""}
                </Badge>
              )}
              {data && (
                <Badge variant="secondary">
                  {data.cached ? `${data.count} juegos` : "Sin caché"}
                </Badge>
              )}
            </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-muted-foreground">Cargando juegos...</p>
            ) : error ? (
              <p className="text-destructive">Error: {String(error)}</p>
            ) : data ? (
              <GameTable games={data.games} />
            ) : null}
          </CardContent>
        </Card>

        <div className="w-full shrink-0 lg:w-96">
          <TopCombosPanel scope="global" />
        </div>
      </div>

      {selectedGames.size >= 2 && (
        <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border border-melee-gold/40 bg-card px-4 py-2 shadow-lg">
          <span className="text-sm text-muted-foreground">
            {selectedGames.size} juegos seleccionados
          </span>
          {createSetError && (
            <span className="text-xs text-destructive">{createSetError}</span>
          )}
          <Button
            size="sm"
            onClick={handleCreateSet}
            disabled={createSetMutation.isPending}
          >
            {createSetMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ListVideo className="h-4 w-4" />
            )}
            Crear set ({selectedGames.size} juegos)
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground"
            title="Limpiar selección"
            onClick={() => selectedGames.forEach((p) => setGameSelected(p, false))}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
