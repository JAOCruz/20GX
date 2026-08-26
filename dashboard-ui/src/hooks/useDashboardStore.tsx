import React, { createContext, useContext, useState, useCallback } from "react";
import { SelectedStock, ProcessOptions, Job, DiscordHistoryEntry } from "@/types";

interface DashboardState {
  options: ProcessOptions;
  setOptions: (opts: ProcessOptions | ((prev: ProcessOptions) => ProcessOptions)) => void;
  selectedGames: Set<string>;
  toggleGame: (filePath: string) => void;
  setGameSelected: (filePath: string, selected: boolean) => void;
  selectedStocks: Map<string, SelectedStock[]>;
  toggleStock: (filePath: string, stock: SelectedStock) => void;
  setStocksForGame: (filePath: string, stocks: SelectedStock[]) => void;
  expandedGame: string | null;
  setExpandedGame: (filePath: string | null) => void;
  currentJob: Job | null;
  setCurrentJob: (job: Job | null) => void;
  jobLogs: string;
  setJobLogs: (logs: string | ((prev: string) => string)) => void;
  guildId: string;
  setGuildId: (id: string) => void;
  channelId: string;
  setChannelId: (id: string) => void;
  discordHistory: DiscordHistoryEntry[];
  setDiscordHistory: (history: DiscordHistoryEntry[]) => void;
  isRecording: boolean;
  setIsRecording: (v: boolean) => void;
  isSessionActive: boolean;
  setIsSessionActive: (v: boolean) => void;
}

const DashboardContext = createContext<DashboardState | null>(null);

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptionsState] = useState<ProcessOptions>({
    sendTelegram: false,
    copyToMac: false,
    mixDiscord: false,
    paddingBefore: 7,
    paddingAfter: 2,
    discordAudioOffset: 0,
    resolution: '720p',
    bitrate: 25000,
    widescreen: false,
  });
  const [selectedGames, setSelectedGames] = useState<Set<string>>(new Set());
  const [selectedStocks, setSelectedStocksState] = useState<Map<string, SelectedStock[]>>(new Map());
  const [expandedGame, setExpandedGame] = useState<string | null>(null);
  const [currentJob, setCurrentJob] = useState<Job | null>(null);
  const [jobLogs, setJobLogsState] = useState<string>("");
  const [guildId, setGuildId] = useState<string>("");
  const [channelId, setChannelId] = useState<string>("");
  const [discordHistory, setDiscordHistory] = useState<DiscordHistoryEntry[]>([]);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isSessionActive, setIsSessionActive] = useState<boolean>(false);

  const setOptions = useCallback(
    (opts: ProcessOptions | ((prev: ProcessOptions) => ProcessOptions)) => {
      setOptionsState(opts);
    },
    []
  );

  const toggleGame = useCallback((filePath: string) => {
    setSelectedGames((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  const setGameSelected = useCallback((filePath: string, selected: boolean) => {
    setSelectedGames((prev) => {
      const next = new Set(prev);
      if (selected) next.add(filePath);
      else next.delete(filePath);
      return next;
    });
  }, []);

  const toggleStock = useCallback((filePath: string, stock: SelectedStock) => {
    setSelectedStocksState((prev) => {
      const next = new Map(prev);
      const list = next.get(filePath) ?? [];
      const idx = list.findIndex((s) => s.index === stock.index && s.direction === stock.direction);
      if (idx >= 0) {
        next.set(filePath, [...list.slice(0, idx), ...list.slice(idx + 1)]);
      } else {
        next.set(filePath, [...list, stock]);
      }
      return next;
    });
  }, []);

  const setStocksForGame = useCallback((filePath: string, stocks: SelectedStock[]) => {
    setSelectedStocksState((prev) => {
      const next = new Map(prev);
      next.set(filePath, stocks);
      return next;
    });
  }, []);

  const setJobLogs = useCallback(
    (logs: string | ((prev: string) => string)) => {
      setJobLogsState(logs);
    },
    []
  );

  return (
    <DashboardContext.Provider
      value={{
        options,
        setOptions,
        selectedGames,
        toggleGame,
        setGameSelected,
        selectedStocks,
        toggleStock,
        setStocksForGame,
        expandedGame,
        setExpandedGame,
        currentJob,
        setCurrentJob,
        jobLogs,
        setJobLogs,
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
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboardStore() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboardStore must be used within DashboardProvider");
  return ctx;
}
