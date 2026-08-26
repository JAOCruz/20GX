import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Headphones, Play, Video, Loader2 } from "lucide-react";
import { getStocks, processStocks, getJob, getAudioPreviewUrl, getVideoPreviewUrl } from "@/lib/api";
import { StockIcon } from "./StockIcon";
import { GameInfo, StockItem } from "@/types";
import { useDashboardStore } from "@/hooks/useDashboardStore";

export function StockPanel({ game }: { game: GameInfo }) {
  const { options, selectedStocks, toggleStock, currentJob, setCurrentJob } = useDashboardStore();
  const isRendering = currentJob?.status === "running";
  const [playingAudio, setPlayingAudio] = useState<Set<string>>(new Set());
  const [audioLoading, setAudioLoading] = useState<Set<string>>(new Set());
  const [audioErrors, setAudioErrors] = useState<Record<string, string>>({});
  const [videoPreview, setVideoPreview] = useState<{
    key: string;
    url: string;
    offset: number;
    loading: boolean;
    error?: string;
  } | null>(null);

  if (!game.mainPlayer || !game.opponent) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No se pudo identificar jugador principal / oponente en este replay.
      </div>
    );
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ["stocks", game.filePath],
    queryFn: () => getStocks(game),
    enabled: true,
  });

  const stocksForGame = selectedStocks.get(game.filePath) ?? [];

  const isSelected = (index: number, direction: "main" | "opponent") => {
    return stocksForGame.some((s) => s.index === index && s.direction === direction);
  };

  const handleRenderGameStocks = async () => {
    if (stocksForGame.length === 0) return;
    if (!game.mainPlayer || !game.opponent) return;
    const res = await processStocks(
      [
        {
          filePath: game.filePath,
          mainPlayer: { playerIndex: game.mainPlayer.playerIndex },
          opponent: { playerIndex: game.opponent.playerIndex },
          selectedStocks: stocksForGame,
        },
      ],
      options
    );
    const job = await getJob(res.jobId);
    setCurrentJob(job);
  };

  const renderStock = (stock: StockItem, direction: "main" | "opponent", label: string) => {
    const minutes = Math.floor(stock.timeSeconds / 60);
    const seconds = (stock.timeSeconds % 60).toString().padStart(2, "0");
    const audioKey = `${direction}-${stock.index}`;
    const showAudio = playingAudio.has(audioKey);
    const audioUrl = getAudioPreviewUrl(game, stock.index, direction, options.paddingBefore, options.paddingAfter);

    return (
      <div
        key={audioKey}
        className="flex flex-col gap-2 rounded-md border border-border/50 bg-black/20 p-2"
      >
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${game.filePath}-${direction}-${stock.index}`}
            checked={isSelected(stock.index, direction)}
            onCheckedChange={() => toggleStock(game.filePath, { index: stock.index, direction })}
          />
          <Label
            htmlFor={`${game.filePath}-${direction}-${stock.index}`}
            className="flex-1 cursor-pointer text-sm"
          >
            <div className="flex items-center gap-2">
              <span className="font-semibold">#{stock.index}</span>{" "}
              <span className="text-muted-foreground">{minutes}:{seconds}</span>
            </div>
            {stock.killMove && (
              <div className="text-xs text-melee-gold">
                {stock.killMove}
                {stock.killPercent != null && ` · ${stock.killPercent}%`}
              </div>
            )}
          </Label>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-melee-gold"
            title="Escuchar audio de Discord de este stock"
            disabled={!audioUrl || audioLoading.has(audioKey)}
            onClick={async () => {
              if (playingAudio.has(audioKey)) {
                setPlayingAudio((prev) => {
                  const next = new Set(prev);
                  next.delete(audioKey);
                  return next;
                });
                return;
              }
              setAudioErrors((prev) => {
                const next = { ...prev };
                delete next[audioKey];
                return next;
              });
              setAudioLoading((prev) => new Set(prev).add(audioKey));
              try {
                const res = await fetch(audioUrl, { method: "GET" });
                if (!res.ok) {
                  let msg = `Error ${res.status}: no se pudo cargar el audio`;
                  try {
                    const data = await res.json();
                    if (data.error) msg = data.error;
                  } catch {}
                  setAudioErrors((prev) => ({ ...prev, [audioKey]: msg }));
                  return;
                }
                setPlayingAudio((prev) => new Set(prev).add(audioKey));
              } finally {
                setAudioLoading((prev) => {
                  const next = new Set(prev);
                  next.delete(audioKey);
                  return next;
                });
              }
            }}
          >
            {audioLoading.has(audioKey) ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Headphones className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-melee-red"
            title="Previsualizar video con audio de Discord"
            disabled={videoPreview?.loading}
            onClick={() => {
              const offset = options.discordAudioOffset ?? 0;
              const url = getVideoPreviewUrl(game, stock.index, direction, {
                paddingBefore: options.paddingBefore,
                paddingAfter: options.paddingAfter,
                mixDiscord: options.mixDiscord,
                discordAudioOffset: offset,
                resolution: "480p",
                bitrate: 8000,
              });
              setVideoPreview({ key: audioKey, url, offset, loading: true });
              // Precargar el video para detectar cuando está listo o si hay error.
              const video = document.createElement("video");
              video.preload = "metadata";
              video.src = url;
              video.onloadeddata = () => {
                setVideoPreview((prev) =>
                  prev?.key === audioKey ? { ...prev, loading: false } : prev
                );
              };
              video.onerror = () => {
                setVideoPreview((prev) =>
                  prev?.key === audioKey
                    ? { ...prev, loading: false, error: "No se pudo cargar el preview" }
                    : prev
                );
              };
              // Timeout de seguridad: si nunca carga, al menos quitar el spinner.
              setTimeout(() => {
                setVideoPreview((prev) =>
                  prev?.key === audioKey ? { ...prev, loading: false } : prev
                );
              }, 30000);
            }}
          >
            {videoPreview?.loading && videoPreview?.key === audioKey ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
          <Badge variant="outline" className="text-xs">
            {label}
          </Badge>
        </div>
        {showAudio && audioUrl && (
          <audio controls src={audioUrl} className="w-full" />
        )}
        {audioErrors[audioKey] && (
          <div className="text-xs text-destructive">{audioErrors[audioKey]}</div>
        )}
        {videoPreview?.key === audioKey && (
          <div className="space-y-2 rounded-md border border-melee-red/30 bg-black/60 p-2">
            <div className="flex items-center gap-2">
              <Video className="h-4 w-4 text-melee-red" />
              <span className="text-xs font-semibold">Preview de video (480p)</span>
            </div>
            {videoPreview.loading ? (
              <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Generando preview... esto puede tardar unos segundos.
              </div>
            ) : videoPreview.error ? (
              <div className="py-2 text-xs text-destructive">{videoPreview.error}</div>
            ) : (
              <video
                key={videoPreview.url}
                controls
                src={videoPreview.url}
                className="w-full rounded-md"
                style={{ maxHeight: 240 }}
              />
            )}
            <div className="flex items-center gap-2">
              <Label htmlFor={`offset-${audioKey}`} className="text-xs whitespace-nowrap">
                Offset audio Discord (s)
              </Label>
              <Input
                id={`offset-${audioKey}`}
                type="number"
                step={0.5}
                className="h-7 text-xs"
                value={videoPreview.offset}
                onChange={(e) =>
                  setVideoPreview((prev) =>
                    prev ? { ...prev, offset: Number(e.target.value) } : null
                  )
                }
              />
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-xs"
                disabled={videoPreview.loading}
                onClick={() => {
                  setVideoPreview((prev) => (prev ? { ...prev, loading: true, error: undefined } : null));
                  const newUrl = getVideoPreviewUrl(game, stock.index, direction, {
                    paddingBefore: options.paddingBefore,
                    paddingAfter: options.paddingAfter,
                    mixDiscord: options.mixDiscord,
                    discordAudioOffset: videoPreview.offset,
                    resolution: "480p",
                    bitrate: 8000,
                  });
                  setVideoPreview((prev) => (prev ? { ...prev, url: newUrl } : null));
                  const video = document.createElement("video");
                  video.preload = "metadata";
                  video.src = newUrl;
                  video.onloadeddata = () => {
                    setVideoPreview((prev) =>
                      prev?.key === audioKey ? { ...prev, loading: false } : prev
                    );
                  };
                  video.onerror = () => {
                    setVideoPreview((prev) =>
                      prev?.key === audioKey
                        ? { ...prev, loading: false, error: "No se pudo cargar el preview" }
                        : prev
                    );
                  };
                  setTimeout(() => {
                    setVideoPreview((prev) =>
                      prev?.key === audioKey ? { ...prev, loading: false } : prev
                    );
                  }, 30000);
                }}
              >
                Re-preview
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Cargando stocks...</div>;
  if (error)
    return <div className="p-4 text-sm text-destructive">Error cargando stocks: {String(error)}</div>;

  return (
    <div className="p-4">
      <div className="mb-3 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-melee-gold flex items-center gap-2">
            <StockIcon characterId={game.mainPlayer?.characterId} costumeId={game.mainPlayer?.costumeId} size={20} />
            Kills de {game.mainPlayer?.connectCode} ({game.mainPlayer?.characterName})
          </h4>
          <div className="space-y-2">
            {data?.stocksAtoB?.length ? (
              data.stocksAtoB.map((stock) => renderStock(stock, "main", "main"))
            ) : (
              <p className="text-xs text-muted-foreground">Sin kills</p>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-melee-red flex items-center gap-2">
            <StockIcon characterId={game.opponent?.characterId} costumeId={game.opponent?.costumeId} size={20} />
            Kills de {game.opponent?.connectCode} ({game.opponent?.characterName})
          </h4>
          <div className="space-y-2">
            {data?.stocksBtoA?.length ? (
              data.stocksBtoA.map((stock) => renderStock(stock, "opponent", "opponent"))
            ) : (
              <p className="text-xs text-muted-foreground">Sin kills</p>
            )}
          </div>
        </div>
      </div>
      <Button
        size="sm"
        onClick={handleRenderGameStocks}
        disabled={stocksForGame.length === 0 || isRendering}
      >
        {isRendering ? "Renderizando..." : `Render selected stocks (${stocksForGame.length})`}
      </Button>
    </div>
  );
}
