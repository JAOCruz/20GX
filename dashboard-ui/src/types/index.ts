export interface PlayerInfo {
  connectCode: string;
  displayName?: string;
  characterName: string;
  characterId?: number;
  costumeId?: number;
  playerIndex: number;
}

export interface GameInfo {
  filePath: string;
  fileName: string;
  date: string;
  startAt?: string | null;
  startTimestamp?: number | null;
  stage: string;
  stageId?: number;
  duration?: number | null;
  hasRecording?: boolean;
  mainPlayer: PlayerInfo | null;
  opponent: PlayerInfo | null;
  winnerPlayerIndex?: number | null;
}

export interface GamesResponse {
  cached: boolean;
  count: number;
  games: GameInfo[];
  generatedAt?: string;
  options?: Record<string, unknown>;
}

export interface StockItem {
  index: number;
  frame: number;
  timeSeconds: number;
  stocksRemaining?: number;
  killMove?: string;
  killPercent?: number;
}

export interface StocksData {
  slpPath: string;
  stage: string;
  durationSeconds: number;
  playerA: {
    playerIndex: number;
    charId: number;
    charName: string;
    name: string;
  };
  playerB: {
    playerIndex: number;
    charId: number;
    charName: string;
    name: string;
  };
  stocksAtoB: StockItem[];
  stocksBtoA: StockItem[];
}

export interface SelectedStock {
  index: number;
  direction: 'main' | 'opponent';
}

export interface ProcessOptions {
  sendTelegram?: boolean;
  copyToMac?: boolean;
  mixDiscord?: boolean;
  paddingBefore?: number;
  paddingAfter?: number;
  discordAudioOffset?: number;
  resolution?: string;
  bitrate?: number;
  widescreen?: boolean;
}

export interface JobProgress {
  phase: string;
  currentStock: number;
  totalStocks: number;
  stockProgress: number;
  overallProgress: number;
  etaSeconds: number | null;
  startedAt: number;
  lastUpdate: number;
  log: string;
  lastProgressLine?: string;
}

export interface Job {
  id: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
  total: number;
  done: number;
  errors: { file: string; error: string }[];
  outputs: unknown[];
  progress?: JobProgress | null;
  estimatedSeconds?: number;
}

export interface DashboardGame {
  fileName: string;
  filePath: string;
  label: string;
  outputDir: string;
  stocks: { index: number; path: string; direction: 'main' | 'opponent' }[];
  combinedPath?: string;
  date?: string;
  stage?: string;
  durationSeconds?: number;
  attacker?: { name: string; charName: string };
  victim?: { name: string; charName: string };
  winner?: string;
}

export interface DashboardResponse {
  generatedAt: string;
  games: DashboardGame[];
}

export interface DiscordHistoryEntry {
  guildId: string;
  channelId: string;
  usedAt: string;
}

export interface ConfigResponse {
  replaysDir: string;
  discordGuildId: string;
  discordChannelId: string;
  history: DiscordHistoryEntry[];
  estimatedMbPerMin?: number;
}

export interface SessionInfo {
  active: boolean;
  guildId?: string;
  channelId?: string;
  startedAt?: string;
}

export interface SessionResponse {
  session: SessionInfo;
  replaysDir: string;
}

export interface Recording {
  id: string;
  startedAt: string;
  stoppedAt?: string;
  path?: string;
  startEpoch?: number;
  durationSeconds?: number;
  channelName?: string;
  userIds?: string[];
  overlappingGames?: GameInfo[];
}

export interface RecordingsResponse {
  active: boolean;
  recordings: Recording[];
}

export interface SetPlayerRef {
  connectCode: string;
  characterId: number;
}

export interface SetSummary {
  id: string;
  name: string;
  createdAt: string;
  source: "auto" | "manual";
  players: SetPlayerRef[];
  gamePaths: string[];
  wins: [number, number];
  format: string | null;
  date: string;
  gameCount?: number;
  durationSec?: number;
  storyNotes?: string | null;
  playerNames?: string[];
  winnerOverrides?: Record<string, number>;
}

export interface SetsResponse {
  sets: SetSummary[];
}

export interface SetGamePlayer extends SetPlayerRef {
  playerIndex: number;
}

export interface SetStock {
  id: string;
  frame: number;
  timeSeconds: number;
  killerIndex: number;
  victimIndex: number;
  killPercent: number | null;
  killMove: string | null;
  comboLength: number | null;
  comboStartFrame?: number | null;
  score: number;
  // Ventana de frames exacta para preview (opcional, la puede dar el backend).
  frames?: { start: number; end: number } | null;
}

export interface SetGame {
  path: string;
  stage: string;
  durationSec?: number | null;
  winnerIndex?: number | null;
  players: SetGamePlayer[];
  stocks: SetStock[];
}

export interface SetStocksResponse {
  games: SetGame[];
}

export interface ExportItem {
  gamePath: string;
  stockId?: string;
  // Frames exactos opcionales: si vienen, el export usa ESTA ventana en vez
  // de la calculada del stock (los manda el player de previews ya ajustados).
  startFrame?: number;
  endFrame?: number;
}

export interface ExportSetBody {
  type: "full-set" | "reel";
  items: ExportItem[];
  targetDurationSec?: number;
  vertical?: boolean;
  // Segundos extra de contexto antes de cada clip (0-60).
  leadSeconds?: number;
  // Pista de música (de /api/music) mezclada sobre el export. null = sin música.
  music?: { file: string; gameVolume?: number } | null;
}

export interface MusicTrack {
  name: string;
  sizeBytes: number;
  durationSec: number | null;
}

export type PreviewStatus = "pending" | "rendering" | "done" | "error";

export interface PreviewCreated {
  id: string;
  status: PreviewStatus;
  cached?: boolean;
  etaSec?: number | null;
}

export interface PreviewInfo {
  id: string;
  status: PreviewStatus;
  url?: string;
  error?: string;
  progress?: number;
  etaSec?: number | null;
}

// Item del ranking Top Combos (GET /api/top-combos y /api/sets/:id/top-combos).
export interface TopComboPlayer {
  connectCode: string;
  characterId: number;
}

export interface TopCombo {
  gamePath: string;
  stockId: string;
  stage: string;
  gameDate: string | null;
  // Posición del juego dentro del set (0-based; null si no aplica/global).
  gameIndex?: number | null;
  frame: number; // frame de la muerte
  timeSeconds: number;
  comboLength: number;
  killMove: string | null;
  killPercent: number | null;
  score: number;
  player: TopComboPlayer | null; // killer
  opponent: TopComboPlayer | null; // victim
  startFrame: number;
  endFrame: number;
}

export interface TopCombosResponse {
  items: TopCombo[];
  coverage: { analyzed: number; total: number };
}

// Estado del scan global de stocks (GET /api/top-combos/scan).
export interface TopCombosScanStatus {
  status: "idle" | "pending" | "running" | "completed" | "failed" | "cancelled";
  jobId?: string;
  progress: { phase: string; current: number; total: number; failed?: number } | null;
  error?: string | null;
}

// Job de la cola SQLite (GET /api/queue/jobs). En los type 'preview',
// payload.id es el id del preview (sirve para mapear previewId -> jobId).
export interface QueueJob {
  id: string;
  type: string;
  payload: { id?: string } & Record<string, unknown>;
  status: string;
  error?: string | null;
}

// Programación de publicaciones en YouTube (GET/POST /api/schedule).
export type ScheduleStatus =
  | "scheduled"
  | "rendering"
  | "rendered"
  | "uploading"
  | "uploaded"
  | "error";

export interface ScheduleEntry {
  id: string;
  setId: string;
  name: string;
  type: "reel" | "full-set";
  vertical: boolean;
  title: string;
  description: string;
  tags: string[];
  publishAt: string; // ISO
  status: ScheduleStatus;
  jobId?: string;
  youtubeUrl?: string;
  error?: string;
  renderEstimateSec: number;
  renderStartAt: string; // ISO: a partir de cuándo se renderiza
  createdAt: string;
}

export interface ScheduleResponse {
  entries: ScheduleEntry[];
}

// Body de POST /api/schedule. Dos formas:
// - Nuevo render: setId + type (+ items/targetDurationSec/vertical/leadSeconds).
// - Solo subida de un export ya renderizado: exportJobId.
// Si title/description/tags no vienen, el backend los genera automáticamente.
export interface ScheduleBody {
  setId?: string;
  type?: "reel" | "full-set";
  items?: ExportItem[];
  targetDurationSec?: number;
  vertical?: boolean;
  leadSeconds?: number;
  music?: { file: string; gameVolume?: number } | null;
  exportJobId?: string;
  publishAt: string; // ISO
  title?: string;
  description?: string;
  tags?: string[];
}

// Registro del historial de exports (GET /api/exports), ordenado por fecha desc.
export interface ExportRecord {
  jobId: string;
  name: string;
  setName?: string | null;
  type: "reel" | "full-set";
  vertical: boolean;
  setId: string;
  createdAt?: string;
  completedAt: string;
  fileName: string;
  url: string; // ruta relativa servida por el mismo server (/compilations/x.mp4)
  sizeBytes: number;
  clipCount: number;
  durationSec?: number | null;
  exists: boolean;
  title?: string | null;
  approvalStatus: "pending" | "uploaded" | "discarded" | null;
  youtubeUrl?: string | null;
  hasThumbnail?: boolean;
  // Entry activa de schedule.json asociada (match por jobId, fallback por nombre).
  scheduled?: { id: string; status: ScheduleStatus; publishAt: string } | null;
}

// GET /api/uploads — video del canal de YouTube con stats + metadata local.
export interface UploadedVideo {
  videoId: string;
  url: string;
  title: string;
  description: string;
  tags: string[];
  publishedAt: string | null;
  thumbnail: string | null;
  privacy: string; // public | unlisted | private
  duration: string | null; // ISO 8601
  views: number;
  likes: number;
  comments: number;
  local: {
    scheduleId: string;
    setId: string | null;
    setName: string | null;
    type: "reel" | "full-set" | null;
    clipCount: number | null;
    vertical: boolean;
    outputPath: string | null;
  } | null;
}

export interface UploadsResponse {
  fetchedAt: string;
  videos: UploadedVideo[];
}
