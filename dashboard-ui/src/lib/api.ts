import {
  GamesResponse,
  ScheduleBody,
  ScheduleEntry,
  ScheduleResponse,
  StocksData,
  ProcessOptions,
  Job,
  DashboardResponse,
  ConfigResponse,
  SessionResponse,
  RecordingsResponse,
  GameInfo,
  SelectedStock,
  SetsResponse,
  SetSummary,
  SetStocksResponse,
  ExportSetBody,
  PreviewCreated,
  TopCombosResponse,
  ComboRankingConfig,
  ComboRule,
  MoveInfo,
  TopCombosScanStatus,
  PreviewInfo,
  QueueJob,
  ExportRecord,
  UploadsResponse,
  MusicTrack,
} from "@/types";

const API_BASE = "/api";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export function getStatus() {
  return fetchJson<{ ok: boolean; time: string; replaysDir: string }>(`${API_BASE}/status`);
}

export function getGames() {
  return fetchJson<GamesResponse>(`${API_BASE}/games`);
}

export function refreshGames(duration = false, days = 0) {
  return fetchJson<{ message: string; includeDuration: boolean; days?: number }>(
    `${API_BASE}/refresh?duration=${duration ? 1 : 0}${days > 0 ? `&days=${days}` : ""}`,
    { method: "POST" }
  );
}

export function getStocks(game: GameInfo) {
  if (!game.mainPlayer || !game.opponent) {
    return Promise.reject(new Error("Faltan jugadores para detectar stocks"));
  }
  const params = new URLSearchParams({
    slp: game.filePath,
    attacker: String(game.mainPlayer.playerIndex),
    victim: String(game.opponent.playerIndex),
  });
  return fetchJson<StocksData>(`${API_BASE}/stocks?${params.toString()}`);
}

export function getAudioPreviewUrl(
  game: GameInfo,
  stockIndex: number,
  direction: "main" | "opponent",
  paddingBefore = 7,
  paddingAfter = 2
) {
  if (!game.mainPlayer || !game.opponent) return "";
  const [attacker, victim] =
    direction === "main"
      ? [game.mainPlayer.playerIndex, game.opponent.playerIndex]
      : [game.opponent.playerIndex, game.mainPlayer.playerIndex];
  const params = new URLSearchParams({
    slp: game.filePath,
    attacker: String(attacker),
    victim: String(victim),
    stockIndex: String(stockIndex),
    paddingBefore: String(paddingBefore),
    paddingAfter: String(paddingAfter),
  });
  return `${API_BASE}/audio-preview?${params.toString()}`;
}

export function getVideoPreviewUrl(
  game: GameInfo,
  stockIndex: number,
  direction: "main" | "opponent",
  options: {
    paddingBefore?: number;
    paddingAfter?: number;
    mixDiscord?: boolean;
    discordAudioOffset?: number;
    resolution?: string;
    bitrate?: number;
    widescreen?: boolean;
  } = {}
) {
  if (!game.mainPlayer || !game.opponent) return "";
  const [attacker, victim] =
    direction === "main"
      ? [game.mainPlayer.playerIndex, game.opponent.playerIndex]
      : [game.opponent.playerIndex, game.mainPlayer.playerIndex];
  const params = new URLSearchParams({
    slp: game.filePath,
    attacker: String(attacker),
    victim: String(victim),
    stockIndex: String(stockIndex),
    paddingBefore: String(options.paddingBefore ?? 7),
    paddingAfter: String(options.paddingAfter ?? 2),
    mixDiscord: String(options.mixDiscord ?? false),
    discordAudioOffset: String(options.discordAudioOffset ?? 0),
    resolution: options.resolution || '480p',
    bitrate: String(options.bitrate || 8000),
    widescreen: String(options.widescreen ?? false),
  });
  return `${API_BASE}/video-preview?${params.toString()}`;
}

export function processGames(games: GameInfo[], options: ProcessOptions) {
  return fetchJson<{ jobId: string; message: string; status: string }>(`${API_BASE}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ games, options }),
  });
}

export function processStocks(
  games: { filePath: string; mainPlayer: PlayerIndexRef; opponent: PlayerIndexRef; selectedStocks: SelectedStock[] }[],
  options: ProcessOptions
) {
  return fetchJson<{ jobId: string; message: string; status: string }>(`${API_BASE}/process-stocks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ games, options }),
  });
}

interface PlayerIndexRef {
  playerIndex: number;
  connectCode?: string;
}

export function getJob(jobId: string) {
  return fetchJson<Job>(`${API_BASE}/jobs/${jobId}`);
}

export function getDashboard() {
  return fetchJson<DashboardResponse>(`${API_BASE}/dashboard`);
}

export function getConfig() {
  return fetchJson<ConfigResponse>(`${API_BASE}/config`);
}

export function saveConfig(config: { discordGuildId: string; discordChannelId: string }) {
  return fetchJson<ConfigResponse>(`${API_BASE}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export function startDiscordRecording(guildId: string, channelId: string, userId?: string) {
  return fetchJson<{ message: string }>(`${API_BASE}/discord/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guildId, channelId, userId }),
  });
}

export function stopDiscordRecording() {
  return fetchJson<{ message: string }>(`${API_BASE}/discord/stop`, { method: "POST" });
}

export function getDiscordRecordings() {
  return fetchJson<RecordingsResponse>(`${API_BASE}/discord/recordings`);
}

export function deleteDiscordRecording(file: string) {
  return fetchJson<{ ok: boolean; message: string }>(`${API_BASE}/discord/recordings/${encodeURIComponent(file)}`, {
    method: "DELETE",
  });
}

export function startSession(guildId: string, channelId: string, options: ProcessOptions) {
  return fetchJson<{ message: string }>(`${API_BASE}/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guildId, channelId, options }),
  });
}

export function stopSession() {
  return fetchJson<{ message: string }>(`${API_BASE}/session/stop`, { method: "POST" });
}

export function getSession() {
  return fetchJson<SessionResponse>(`${API_BASE}/session`);
}

export function getScanStatus() {
  return fetchJson<{ running: boolean; startedAt: string | null; completedAt: string | null; count: number; error: string | null }>(
    `${API_BASE}/scan-status`
  );
}

export function getSystemStatus() {
  return fetchJson<{
    memory: { total: number; free: number; used: number };
    disk: { available: string; usePercent: string };
    processes: { pid: string; etime: string; cmd: string }[];
    jobs: { pending: number; running: number };
  }>(`${API_BASE}/system`);
}

export function getSets() {
  return fetchJson<SetsResponse>(`${API_BASE}/sets`);
}

export function createSet(body: { name?: string; gamePaths: string[] }) {
  return fetchJson<{ set: SetSummary }>(`${API_BASE}/sets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateSet(id: string, body: { name?: string; gamePaths?: string[]; storyNotes?: string; playerNames?: string[]; winnerOverrides?: Record<string, number | null> }) {
  return fetchJson<{ set: SetSummary }>(`${API_BASE}/sets/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteSet(id: string) {
  return fetchJson<{ ok: true }>(`${API_BASE}/sets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function detectSets() {
  return fetchJson<{ added: number; sets: SetSummary[] }>(`${API_BASE}/sets/detect`, {
    method: "POST",
  });
}

export function getSetStocks(id: string) {
  return fetchJson<SetStocksResponse>(`${API_BASE}/sets/${encodeURIComponent(id)}/stocks`);
}

export function exportSet(id: string, body: ExportSetBody) {
  return fetchJson<{ jobId: string }>(`${API_BASE}/sets/${encodeURIComponent(id)}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------- Música para exports ----------

export function getMusic() {
  return fetchJson<{ tracks: MusicTrack[] }>(`${API_BASE}/music`);
}

export async function uploadMusic(file: File): Promise<{ track: MusicTrack }> {
  const res = await fetch(`${API_BASE}/music`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-filename": encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

export function deleteMusic(name: string) {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/music/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export function createPreview(body: { gamePath: string; startFrame: number; endFrame: number }) {
  return fetchJson<PreviewCreated>(`${API_BASE}/previews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getPreview(id: string) {
  return fetchJson<PreviewInfo>(`${API_BASE}/previews/${encodeURIComponent(id)}`);
}

export function getTopCombos(limit = 10, minHits = 3, custom = false) {
  return fetchJson<TopCombosResponse>(
    `${API_BASE}/top-combos?limit=${limit}&minHits=${minHits}${custom ? "&custom=1" : ""}`
  );
}

export function getSetTopCombos(id: string, limit = 10, minHits = 3, custom = false) {
  return fetchJson<TopCombosResponse>(
    `${API_BASE}/sets/${encodeURIComponent(id)}/top-combos?limit=${limit}&minHits=${minHits}${custom ? "&custom=1" : ""}`
  );
}

export function getMoves() {
  return fetchJson<{ moves: MoveInfo[] }>(`${API_BASE}/moves`);
}

export function getComboRanking() {
  return fetchJson<ComboRankingConfig>(`${API_BASE}/combo-ranking`);
}

export function saveComboRanking(rules: ComboRule[]) {
  return fetchJson<{ ok: boolean; rules: ComboRule[] }>(`${API_BASE}/combo-ranking`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rules }),
  });
}

export function startTopCombosScan() {
  return fetchJson<{ ok: boolean; jobId: string }>(`${API_BASE}/top-combos/scan`, {
    method: "POST",
  });
}

export function getTopCombosScanStatus() {
  return fetchJson<TopCombosScanStatus>(`${API_BASE}/top-combos/scan`);
}

export function listQueueJobs(status?: string, limit = 100) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set("status", status);
  return fetchJson<{ jobs: QueueJob[] }>(`${API_BASE}/queue/jobs?${params.toString()}`);
}

export function cancelQueueJob(id: string) {
  return fetchJson<{ ok: boolean; message: string }>(
    `${API_BASE}/queue/jobs/${encodeURIComponent(id)}/cancel`,
    { method: "POST" }
  );
}

export function getExports() {
  return fetchJson<{ exports: ExportRecord[] }>(`${API_BASE}/exports`);
}

// URL del thumbnail de YouTube de un export (404 si no tiene).
export function getExportThumbnailUrl(jobId: string) {
  return `${API_BASE}/exports/${encodeURIComponent(jobId)}/thumbnail`;
}

// Sube/reemplaza el thumbnail: body raw con el Content-Type de la imagen.
export async function uploadExportThumbnail(jobId: string, file: File) {
  const res = await fetch(getExportThumbnailUrl(jobId), {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ ok: boolean; hasThumbnail: boolean }>;
}

// Sube un archivo .slp o .zip (binario crudo) al endpoint de import.
export async function importFile(
  file: File,
  params: { target: "set" | "add-to-set" | "games"; name?: string; setId?: string }
) {
  const qs = new URLSearchParams({ target: params.target });
  if (params.name) qs.set("name", params.name);
  if (params.setId) qs.set("setId", params.setId);
  const res = await fetch(`${API_BASE}/import?${qs.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-filename": encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    saved?: number;
    paths?: string[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as { ok: boolean; saved: number; paths: string[] };
}

export function getSchedule() {
  return fetchJson<ScheduleResponse>(`${API_BASE}/schedule`);
}

export function createSchedule(body: ScheduleBody) {
  return fetchJson<{ entry: ScheduleEntry }>(`${API_BASE}/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateSchedule(
  id: string,
  body: { title?: string; description?: string; tags?: string[]; publishAt?: string }
) {
  return fetchJson<{ entry: ScheduleEntry }>(
    `${API_BASE}/schedule/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

export function deleteSchedule(id: string) {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/schedule/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function getUploads(refresh = false) {
  return fetchJson<UploadsResponse>(
    `${API_BASE}/uploads${refresh ? "?refresh=1" : ""}`
  );
}
