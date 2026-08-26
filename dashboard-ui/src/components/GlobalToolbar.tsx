import {
  Scan,
  ScanLine,
  Mic,
  MicOff,
  Play,
  Square,
  Clapperboard,
  History,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboardStore } from "@/hooks/useDashboardStore";
import {
  refreshGames,
  processStocks,
  startDiscordRecording,
  stopDiscordRecording,
  startSession,
  stopSession,
  saveConfig,
  getJob,
  getSession,
  getDiscordRecordings,
  getScanStatus,
  getSystemStatus,
} from "@/lib/api";
import { GameInfo, SelectedStock } from "@/types";

export function GlobalToolbar({ games }: { games: GameInfo[] }) {
  const {
    options,
    setOptions,
    selectedStocks,
    currentJob,
    setCurrentJob,
    guildId,
    setGuildId,
    channelId,
    setChannelId,
    discordHistory,
    setDiscordHistory,
    isRecording,
    setIsRecording,
    isSessionActive,
    setIsSessionActive,
  } = useDashboardStore();

  const isRendering = currentJob?.status === "running";
  const [justStartedScan, setJustStartedScan] = useState(false);

  const { data: scanStatus } = useQuery({
    queryKey: ["scan-status"],
    queryFn: getScanStatus,
    refetchInterval: 1000,
  });

  const { data: systemStatus } = useQuery({
    queryKey: ["system-status"],
    queryFn: getSystemStatus,
    refetchInterval: 5000,
  });

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const [sessionData, recData] = await Promise.all([getSession(), getDiscordRecordings()]);
        setIsSessionActive(!!sessionData.session?.active);
        setIsRecording(recData.active);
      } catch {
        // ignorar
      }
    };
    checkStatus();
    const timer = setInterval(checkStatus, 3000);
    return () => clearInterval(timer);
  }, [setIsRecording, setIsSessionActive]);

  const isScanning = scanStatus?.running;

  useEffect(() => {
    if (!isScanning && justStartedScan) {
      setJustStartedScan(false);
    }
  }, [isScanning, justStartedScan]);

  const scanDisabled = isScanning || justStartedScan;

  const hasSelections = Array.from(selectedStocks.values()).some((list) => list.length > 0);
  const totalSelectedStocks = Array.from(selectedStocks.values()).reduce((sum, list) => sum + list.length, 0);

  function estimateSeconds() {
    const clipDuration = (options.paddingBefore || 7) + (options.paddingAfter || 2) + 5;
    const multiplier: Record<string, number> = {
      "480p": 0.6,
      "720p": 1.0,
      "1080p": 2.0,
      WQHD: 2.5,
      "4K": 4.0,
    };
    return Math.max(5, Math.round(totalSelectedStocks * clipDuration * (multiplier[options.resolution || "720p"] || 1)));
  }

  const handleOptionChange = (key: keyof typeof options, value: unknown) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  const buildStockPayload = () => {
    const payload: {
      filePath: string;
      mainPlayer: { playerIndex: number; connectCode?: string };
      opponent: { playerIndex: number; connectCode?: string };
      selectedStocks: SelectedStock[];
    }[] = [];

    selectedStocks.forEach((stocks, filePath) => {
      if (stocks.length === 0) return;
      const game = games.find((g) => g.filePath === filePath);
      if (!game || !game.mainPlayer || !game.opponent) return;
      payload.push({
        filePath,
        mainPlayer: {
          playerIndex: game.mainPlayer.playerIndex,
          connectCode: game.mainPlayer.connectCode,
        },
        opponent: {
          playerIndex: game.opponent.playerIndex,
          connectCode: game.opponent.connectCode,
        },
        selectedStocks: stocks,
      });
    });

    return payload;
  };

  const handleRenderSelected = async () => {
    const gamesPayload = buildStockPayload();
    if (gamesPayload.length === 0) return;
    const res = await processStocks(gamesPayload, options);
    const job = await getJob(res.jobId);
    setCurrentJob(job);
  };

  const handleQuickScan = async () => {
    if (isScanning || justStartedScan) return;
    setJustStartedScan(true);
    try {
      await refreshGames(false, 60);
    } catch (err) {
      console.warn("[quick scan]", err);
    }
  };
  const handleFullScan = async () => {
    if (isScanning || justStartedScan) return;
    setJustStartedScan(true);
    try {
      await refreshGames(true);
    } catch (err) {
      console.warn("[full scan]", err);
    }
  };

  const saveDiscordConfig = async (gId: string, cId: string) => {
    try {
      const config = await saveConfig({ discordGuildId: gId, discordChannelId: cId });
      setDiscordHistory(config.history || []);
    } catch {
      // Ignorar errores de guardado
    }
  };

  const handleStartRecording = () => {
    if (!guildId || !channelId) return;
    saveDiscordConfig(guildId, channelId);
    setIsRecording(true);
    startDiscordRecording(guildId, channelId);
  };

  const handleStopRecording = () => {
    setIsRecording(false);
    stopDiscordRecording();
  };

  const handleStartSession = () => {
    if (!guildId || !channelId) return;
    saveDiscordConfig(guildId, channelId);
    setIsSessionActive(true);
    startSession(guildId, channelId, options);
  };

  const handleStopSession = () => {
    setIsSessionActive(false);
    stopSession();
  };

  return (
    <Card className="border-melee-gold/30 bg-melee-blue/80">
      <CardContent className="p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id="sendTelegram"
                checked={options.sendTelegram}
                onCheckedChange={(v) => handleOptionChange("sendTelegram", Boolean(v))}
              />
              <Label htmlFor="sendTelegram" className="text-foreground">
                Telegram
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="copyToMac"
                checked={options.copyToMac}
                onCheckedChange={(v) => handleOptionChange("copyToMac", Boolean(v))}
              />
              <Label htmlFor="copyToMac" className="text-foreground">
                Copy to Mac
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="mixDiscord"
                checked={options.mixDiscord}
                onCheckedChange={(v) => handleOptionChange("mixDiscord", Boolean(v))}
              />
              <Label htmlFor="mixDiscord" className="text-foreground">
                Mix Discord
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="widescreen"
                checked={options.widescreen}
                onCheckedChange={(v) => handleOptionChange("widescreen", Boolean(v))}
              />
              <Label htmlFor="widescreen" className="text-foreground">
                Widescreen
              </Label>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
            <div className="space-y-1">
              <Label htmlFor="paddingBefore">Segundos antes del kill</Label>
              <Input
                id="paddingBefore"
                type="number"
                min={0}
                value={options.paddingBefore}
                onChange={(e) => handleOptionChange("paddingBefore", Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="paddingAfter">Segundos después del kill</Label>
              <Input
                id="paddingAfter"
                type="number"
                min={0}
                value={options.paddingAfter}
                onChange={(e) => handleOptionChange("paddingAfter", Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="resolution">Resolución</Label>
              <Select
                value={options.resolution || "720p"}
                onValueChange={(v) => handleOptionChange("resolution", v)}
              >
                <SelectTrigger id="resolution">
                  <SelectValue placeholder="Resolución" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="480p">480p (rápido)</SelectItem>
                  <SelectItem value="720p">720p</SelectItem>
                  <SelectItem value="1080p">1080p</SelectItem>
                  <SelectItem value="WQHD">WQHD</SelectItem>
                  <SelectItem value="4K">4K</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bitrate">Bitrate</Label>
              <Select
                value={String(options.bitrate || 25000)}
                onValueChange={(v) => handleOptionChange("bitrate", Number(v))}
              >
                <SelectTrigger id="bitrate">
                  <SelectValue placeholder="Bitrate" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5000">5 Mbps</SelectItem>
                  <SelectItem value="8000">8 Mbps</SelectItem>
                  <SelectItem value="15000">15 Mbps</SelectItem>
                  <SelectItem value="25000">25 Mbps</SelectItem>
                  <SelectItem value="40000">40 Mbps</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="discordAudioOffset">Offset audio Discord (s)</Label>
              <Input
                id="discordAudioOffset"
                type="number"
                step={0.5}
                value={options.discordAudioOffset ?? 0}
                onChange={(e) => handleOptionChange("discordAudioOffset", Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="guildId">Discord Guild ID</Label>
              <Input
                id="guildId"
                value={guildId}
                onChange={(e) => setGuildId(e.target.value)}
                onBlur={() => guildId && channelId && saveDiscordConfig(guildId, channelId)}
                placeholder="Guild ID"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="channelId">Discord Channel ID</Label>
              <Input
                id="channelId"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                onBlur={() => guildId && channelId && saveDiscordConfig(guildId, channelId)}
                placeholder="Channel ID"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="discordHistory">Historial</Label>
              <Select
                value=""
                onValueChange={(value: string) => {
                  const [g, c] = value.split("|");
                  if (g && c) {
                    setGuildId(g);
                    setChannelId(c);
                  }
                }}
                disabled={discordHistory.length === 0}
              >
                <SelectTrigger id="discordHistory">
                  <History className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Seleccionar anterior..." />
                </SelectTrigger>
                <SelectContent>
                  {discordHistory.map((entry, idx) => (
                    <SelectItem key={idx} value={`${entry.guildId}|${entry.channelId}`}>
                      {entry.guildId} / {entry.channelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={handleQuickScan} disabled={scanDisabled}>
              {scanDisabled ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Scan className="mr-1 h-4 w-4" />}
              {scanDisabled ? "Escaneando..." : "Escanear rápido (60d)"}
            </Button>
            <Button variant="secondary" onClick={handleFullScan} disabled={scanDisabled}>
              {scanDisabled ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ScanLine className="mr-1 h-4 w-4" />}
              {scanDisabled ? "Escaneando..." : "Escanear completo"}
            </Button>
            <Button variant="outline" onClick={handleStartRecording} disabled={isRecording || !guildId || !channelId}>
              <Mic className="mr-1 h-4 w-4" />
              Grabar voz
            </Button>
            <Button variant="outline" onClick={handleStopRecording} disabled={!isRecording}>
              <MicOff className="mr-1 h-4 w-4" />
              Detener voz
            </Button>
            <Button variant="outline" onClick={handleStartSession} disabled={isSessionActive || !guildId || !channelId}>
              <Play className="mr-1 h-4 w-4" />
              Iniciar sesión
            </Button>
            <Button variant="outline" onClick={handleStopSession} disabled={!isSessionActive}>
              <Square className="mr-1 h-4 w-4" />
              Detener sesión
            </Button>
            <Button
              variant="default"
              className="bg-melee-gold text-melee-blue hover:bg-melee-gold/90"
              onClick={handleRenderSelected}
              disabled={!hasSelections || isRendering}
            >
              <Clapperboard className="mr-1 h-4 w-4" />
              {isRendering ? "Renderizando..." : "Renderizar seleccionados"}
            </Button>
            {hasSelections && (
              <span className="self-center text-xs text-muted-foreground">
                {totalSelectedStocks} stock(s) · ~{estimateSeconds()}s estimados
              </span>
            )}
            {systemStatus && (
              <Badge variant="outline" className="ml-auto border-melee-gold/50 text-xs">
                {Math.round(systemStatus.memory.free / 1024 / 1024)} MB libre · {systemStatus.jobs.pending} job(s) en cola · {systemStatus.jobs.running} render(s)
              </Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
