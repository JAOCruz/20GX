import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpDown,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Crown,
  Film,
  GripVertical,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Rocket,
  Scissors,
  Smartphone,
  Sparkles,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StockIcon } from "@/components/StockIcon";
import { JobPanel } from "@/components/JobPanel";
import { TopCombosPanel } from "@/components/TopCombosPanel";
import { ScheduleModal } from "@/components/ScheduleModal";
import { SpecsGrid } from "@/components/SpecsGrid";
import { ImportDropzone } from "@/components/ImportDropzone";
import { AddGamesModal } from "@/components/AddGamesModal";
import {
  cancelQueueJob,
  createPreview,
  createSchedule,
  exportSet,
  getConfig,
  getJob,
  getPreview,
  getSetStocks,
  getSets,
  listQueueJobs,
  updateSet,
} from "@/lib/api";
import { useDashboardStore } from "@/hooks/useDashboardStore";
import type { ExportSetBody, PreviewStatus, ScheduleBody, SetGame, SetStock, TopCombo } from "@/types";

interface ReelPick {
  gamePath: string;
  stockId: string;
  gameLabel: string;
  timeSeconds: number;
  comboStartFrame?: number | null;
  score: number;
}

function formatTime(seconds: number) {
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

// Identificación + detalles de un preview dentro de la sesión de revisión.
interface PreviewTarget {
  key: string; // `${gamePath}:${stockId}`
  gamePath: string;
  gameLabel: string;
  stockId: string;
  stockFrame: number; // frame de la muerte (para mostrar el lead)
  startFrame: number;
  endFrame: number;
  // Detalles del stock/juego para el panel lateral del player.
  stage: string;
  timeSeconds: number;
  killMove: string | null;
  killPercent: number | null;
  comboLength: number | null;
  score: number;
  killerCode: string;
  killerCharacterId?: number;
  victimCode: string;
  victimCharacterId?: number;
}

// Preview de la sesión: pending/rendering (chip con spinner + ETA) o done
// (clickeable). Los renders siguen polleando en background aunque el usuario
// pida otro preview.
interface SessionPreview extends PreviewTarget {
  previewId?: string; // id devuelto por POST /api/previews (para mapear a jobId)
  status: PreviewStatus;
  url?: string;
  error?: string;
  progress?: number;
  etaSec?: number | null;
}

// La sesión se persiste en localStorage por set (`previewSession:<setId>`).
// Los chips done reviven al instante (el backend cachea por id = hash de
// gamePath+frames); los pending/rendering se re-consultan por previewId.
interface StoredPreviewSession {
  currentKey: string | null;
  items: SessionPreview[];
}

function loadPreviewSession(setId: string): StoredPreviewSession {
  try {
    const raw = localStorage.getItem(`previewSession:${setId}`);
    if (!raw) return { currentKey: null, items: [] };
    const parsed = JSON.parse(raw) as Partial<StoredPreviewSession>;
    return {
      currentKey: typeof parsed.currentKey === "string" ? parsed.currentKey : null,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch {
    return { currentKey: null, items: [] };
  }
}

// Ventana de frames para el preview: usa stock.frames si el backend lo manda;
// si no, desde el inicio del combo (o 7s antes de la muerte) hasta 2s después.
function stockPreviewFrames(stock: SetStock): { startFrame: number; endFrame: number } {
  if (stock.frames) return { startFrame: stock.frames.start, endFrame: stock.frames.end };
  const start =
    typeof stock.comboStartFrame === "number"
      ? stock.comboStartFrame
      : stock.frame - 7 * 60;
  return { startFrame: Math.max(-123, start), endFrame: stock.frame + 2 * 60 };
}

// Ganador aproximado (fallback cuando el server no manda winnerIndex): NO es
// "quien mató último" — es quien queda con stocks cuando termina el juego.
// Si ambos pierden el último stock, el que murió primero pierde (el otro
// queda con stocks). Tie-break final: el que murió más tarde pierde.
function winnerIndexOf(game: SetGame): number | null {
  if (game.players.length < 2) return null;
  const lost = new Map(game.players.map((p) => [p.playerIndex, 0]));
  let lastDeath: SetStock | null = null;
  for (const s of game.stocks) {
    lost.set(s.victimIndex, (lost.get(s.victimIndex) ?? 0) + 1);
    if (!lastDeath || s.frame >= lastDeath.frame) lastDeath = s;
  }
  const [a, b] = game.players;
  const la = lost.get(a.playerIndex) ?? 0;
  const lb = lost.get(b.playerIndex) ?? 0;
  if (la !== lb) return la < lb ? a.playerIndex : b.playerIndex;
  // Mismo stock count: el último en morir pierde.
  if (lastDeath) {
    return lastDeath.victimIndex === a.playerIndex ? b.playerIndex : a.playerIndex;
  }
  return null;
}

export function SetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { options, setCurrentJob, currentJob } = useDashboardStore();

  const setsQuery = useQuery({ queryKey: ["sets"], queryFn: getSets });
  const set = setsQuery.data?.sets.find((s) => s.id === id) ?? null;

  const stocksQuery = useQuery({
    queryKey: ["set-stocks", id],
    queryFn: () => getSetStocks(id!),
    enabled: Boolean(id),
    // Puede venir cache vieja del browser: refetch agresivo para agarrar
    // los comboStartFrame nuevos del backend.
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  // Orden local de juegos (se persiste con PUT al reordenar).
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => {
    if (!set) return;
    if (order === null) {
      setOrder(set.gamePaths);
      return;
    }
    // Si cambiaron los MIEMBROS del set (add/remove), resincronizar.
    // No comparar orden: eso pelearía con el drag & drop de reordenar.
    const sameMembers =
      order.length === set.gamePaths.length &&
      order.every((p) => set.gamePaths.includes(p));
    if (!sameMembers) setOrder(set.gamePaths);
  }, [set, order]);

  const games = useMemo(() => stocksQuery.data?.games ?? [], [stocksQuery.data]);
  const gamesByPath = useMemo(() => new Map(games.map((g) => [g.path, g])), [games]);

  const orderedGames = useMemo(() => {
    const paths = order ?? set?.gamePaths ?? [];
    const seen = new Set<string>();
    const result: SetGame[] = [];
    for (const p of paths) {
      const g = gamesByPath.get(p);
      if (g) {
        result.push(g);
        seen.add(p);
      }
    }
    for (const g of games) {
      if (!seen.has(g.path)) result.push(g);
    }
    return result;
  }, [order, set, gamesByPath, games]);

  // Rango de scores para la escala de color de los badges.
  const scoreRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const g of games) {
      for (const s of g.stocks) {
        if (s.score < min) min = s.score;
        if (s.score > max) max = s.score;
      }
    }
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 0 };
    return { min, max };
  }, [games]);

  const scoreClass = (score: number) => {
    const { min, max } = scoreRange;
    const t = max > min ? (score - min) / (max - min) : 1;
    if (t >= 0.66) return "border-red-400/50 bg-red-600/80 text-white";
    if (t >= 0.33) return "border-amber-400/50 bg-amber-600/80 text-white";
    return "border-slate-400/50 bg-slate-600/80 text-white";
  };

  // Selección ordenada de stocks para el reel.
  const [picks, setPicks] = useState<ReelPick[]>([]);
  const [sortByScore, setSortByScore] = useState(false);
  const [topN, setTopN] = useState(5);

  // Sesión de previews: los renders pedidos siguen polleando en background
  // aunque el usuario pida otro (el backend los sigue renderizando y
  // cacheando). La playlist muestra todos: pending/rendering con spinner y
  // ETA, done clickeables. El player muestra el item con key === currentKey.
  // Se restaura de localStorage al montar (ver loadPreviewSession).
  const [session, setSession] = useState<SessionPreview[]>(
    () => (id ? loadPreviewSession(id).items : [])
  );
  const [currentKey, setCurrentKey] = useState<string | null>(
    () => (id ? loadPreviewSession(id).currentKey : null)
  );
  const currentKeyRef = useRef<string | null>(null);
  currentKeyRef.current = currentKey;
  // Delta (en segundos) del control de lead: > 0 = más contexto antes.
  const [leadDelta, setLeadDelta] = useState(4);
  // Delta (en segundos) del control de pad: > 0 = más tiempo después del kill.
  const [padDelta, setPadDelta] = useState(2);
  // Player colapsable: minimizado queda una barra compacta (~40px) que
  // no tapa la lista; el video sigue montado (y reproduciendo) oculto.
  const [playerCollapsed, setPlayerCollapsed] = useState(false);
  // Barra de export colapsable, persistida por set en localStorage
  // (`exportBarCollapsed:<setId>`) para que sobreviva recargas.
  const [exportBarCollapsed, setExportBarCollapsed] = useState<boolean>(() => {
    if (!id) return false;
    try {
      return localStorage.getItem(`exportBarCollapsed:${id}`) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!id) return;
    try {
      localStorage.setItem(`exportBarCollapsed:${id}`, exportBarCollapsed ? "1" : "0");
    } catch {
      // localStorage no disponible: no romper la página.
    }
  }, [exportBarCollapsed, id]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoPlaying, setVideoPlaying] = useState(false);

  const toggleVideoPlayback = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  // Un timer de polling por key: viven independientes hasta done/error.
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = pollTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  const current = useMemo(
    () => session.find((s) => s.key === currentKey) ?? null,
    [session, currentKey]
  );

  const sessionByKey = useMemo(() => {
    const m = new Map<string, SessionPreview>();
    for (const s of session) m.set(s.key, s);
    return m;
  }, [session]);

  const stopPolling = (key: string) => {
    const t = pollTimers.current.get(key);
    if (t) {
      clearTimeout(t);
      pollTimers.current.delete(key);
    }
  };

  const patchSession = (key: string, patch: Partial<SessionPreview>) =>
    setSession((prev) => {
      const idx = prev.findIndex((p) => p.key === key);
      if (idx < 0) return prev;
      return [...prev.slice(0, idx), { ...prev[idx], ...patch }, ...prev.slice(idx + 1)];
    });

  const pollSessionPreview = async (key: string, previewId: string) => {
    try {
      const info = await getPreview(previewId);
      patchSession(key, {
        previewId,
        status: info.status,
        url: info.url,
        error: info.error,
        progress: info.progress,
        etaSec: info.etaSec,
      });
      if (info.status === "done" || info.status === "error") {
        pollTimers.current.delete(key);
        // Auto-cargar en el player solo si está vacío: si el usuario está
        // viendo otro video no se le roba el foco (si ya muestra este key,
        // el player se actualiza solo porque deriva de `session`).
        if (info.status === "done" && currentKeyRef.current === null) {
          setCurrentKey(key);
        }
        return;
      }
    } catch (e) {
      patchSession(key, { status: "error", error: String(e) });
      pollTimers.current.delete(key);
      return;
    }
    pollTimers.current.set(
      key,
      setTimeout(() => pollSessionPreview(key, previewId), 2000)
    );
  };

  // Persistir la sesión en cada cambio (sin campos efímeros: progress/etaSec).
  useEffect(() => {
    if (!id) return;
    try {
      const items = session.map(
        ({ progress: _progress, etaSec: _etaSec, ...rest }) => rest
      );
      localStorage.setItem(
        `previewSession:${id}`,
        JSON.stringify({ currentKey, items } satisfies StoredPreviewSession)
      );
    } catch {
      // localStorage lleno o no disponible: no romper la página.
    }
  }, [session, currentKey, id]);

  // Al montar: re-consultar los chips restaurados que quedaron vivos
  // (pending/rendering) y reanudar su polling; si el GET da 404/error, el
  // catch de pollSessionPreview los marca como error.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    for (const item of session) {
      if (
        (item.status === "pending" || item.status === "rendering") &&
        item.previewId
      ) {
        pollSessionPreview(item.key, item.previewId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPreviewRender = async (base: PreviewTarget, focus: boolean) => {
    stopPolling(base.key);
    // Alta o reemplazo (re-render con distinto lead) en la playlist.
    setSession((prev) => {
      const item: SessionPreview = { ...base, status: "pending" };
      const idx = prev.findIndex((p) => p.key === base.key);
      if (idx >= 0) return [...prev.slice(0, idx), item, ...prev.slice(idx + 1)];
      return [...prev, item];
    });
    if (focus) {
      // Click explícito: cargar en el player y expandirlo si estaba minimizado.
      setCurrentKey(base.key);
      setPlayerCollapsed(false);
    }
    try {
      const created = await createPreview({
        gamePath: base.gamePath,
        startFrame: base.startFrame,
        endFrame: base.endFrame,
      });
      patchSession(base.key, { previewId: created.id, etaSec: created.etaSec });
      // El POST no devuelve url: el GET la trae (aunque ya esté cacheado).
      await pollSessionPreview(base.key, created.id);
    } catch (e) {
      patchSession(base.key, { status: "error", error: String(e) });
    }
  };

  const requestPreview = (game: SetGame, gameLabel: string, stock: SetStock) => {
    const { startFrame, endFrame } = stockPreviewFrames(stock);
    const killer = game.players.find((p) => p.playerIndex === stock.killerIndex);
    const victim = game.players.find((p) => p.playerIndex === stock.victimIndex);
    const target: PreviewTarget = {
      key: `${game.path}:${stock.id}`,
      gamePath: game.path,
      gameLabel,
      stockId: stock.id,
      stockFrame: stock.frame,
      startFrame,
      endFrame,
      stage: game.stage,
      timeSeconds: stock.timeSeconds,
      killMove: stock.killMove,
      killPercent: stock.killPercent,
      comboLength: stock.comboLength,
      score: stock.score,
      killerCode: killer?.connectCode ?? `P${stock.killerIndex + 1}`,
      killerCharacterId: killer?.characterId,
      victimCode: victim?.connectCode ?? `P${stock.victimIndex + 1}`,
      victimCharacterId: victim?.characterId,
    };
    const existing = sessionByKey.get(target.key);
    // Si ya hay un preview vivo o listo con la misma ventana, solo enfocarlo.
    if (
      existing &&
      existing.status !== "error" &&
      existing.startFrame === startFrame &&
      existing.endFrame === endFrame
    ) {
      setCurrentKey(target.key);
      return;
    }
    startPreviewRender(target, true);
  };

  // Play de un combo del TopCombosPanel: reutiliza la sesión de previews (el
  // stockId del combo matchea el id del stock, así que comparte key y chip).
  const requestComboPreview = (combo: TopCombo) => {
    const gi = orderedGames.findIndex((g) => g.path === combo.gamePath);
    const target: PreviewTarget = {
      key: `${combo.gamePath}:${combo.stockId}`,
      gamePath: combo.gamePath,
      gameLabel: gi >= 0 ? `G${gi + 1}` : "G?",
      stockId: combo.stockId,
      stockFrame: combo.frame,
      startFrame: combo.startFrame,
      endFrame: combo.endFrame,
      stage: combo.stage,
      timeSeconds: combo.timeSeconds,
      killMove: combo.killMove,
      killPercent: combo.killPercent,
      comboLength: combo.comboLength,
      score: combo.score,
      killerCode: combo.player?.connectCode ?? "?",
      killerCharacterId: combo.player?.characterId,
      victimCode: combo.opponent?.connectCode ?? "?",
      victimCharacterId: combo.opponent?.characterId,
    };
    const existing = sessionByKey.get(target.key);
    if (
      existing &&
      existing.status !== "error" &&
      existing.startFrame === target.startFrame &&
      existing.endFrame === target.endFrame
    ) {
      setCurrentKey(target.key);
      setPlayerCollapsed(false);
      return;
    }
    startPreviewRender(target, true);
  };

  // Aplica el delta del control de lead: nuevo startFrame = startFrameActual -
  // delta*60 (delta > 0 = más contexto antes; < 0 recorta). Nunca menor que
  // -123 y siempre dejando >= 1s antes del kill.
  const applyLead = (delta: number) => {
    if (!current || !delta) return;
    const startFrame = Math.min(
      current.stockFrame - 60,
      Math.max(-123, current.startFrame - Math.round(delta * 60))
    );
    if (startFrame === current.startFrame) return;
    startPreviewRender(
      {
        key: current.key,
        gamePath: current.gamePath,
        gameLabel: current.gameLabel,
        stockId: current.stockId,
        stockFrame: current.stockFrame,
        startFrame,
        endFrame: current.endFrame,
        stage: current.stage,
        timeSeconds: current.timeSeconds,
        killMove: current.killMove,
        killPercent: current.killPercent,
        comboLength: current.comboLength,
        score: current.score,
        killerCode: current.killerCode,
        killerCharacterId: current.killerCharacterId,
        victimCode: current.victimCode,
        victimCharacterId: current.victimCharacterId,
      },
      true
    );
  };

  // Aplica el delta del control de pad: nuevo endFrame = endFrameActual +
  // delta*60 (delta > 0 = más tiempo después del kill; < 0 recorta el final).
  // Siempre dejando >= 0.5s después del kill y que el clip dure >= 1s.
  const applyPad = (delta: number) => {
    if (!current || !delta) return;
    const endFrame = Math.max(
      current.stockFrame + 30,
      current.startFrame + 60,
      current.endFrame + Math.round(delta * 60)
    );
    if (endFrame === current.endFrame) return;
    startPreviewRender(
      {
        key: current.key,
        gamePath: current.gamePath,
        gameLabel: current.gameLabel,
        stockId: current.stockId,
        stockFrame: current.stockFrame,
        startFrame: current.startFrame,
        endFrame,
        stage: current.stage,
        timeSeconds: current.timeSeconds,
        killMove: current.killMove,
        killPercent: current.killPercent,
        comboLength: current.comboLength,
        score: current.score,
        killerCode: current.killerCode,
        killerCharacterId: current.killerCharacterId,
        victimCode: current.victimCode,
        victimCharacterId: current.victimCharacterId,
      },
      true
    );
  };

  const playSessionPreview = (item: SessionPreview) => {
    setCurrentKey(item.key);
    setPlayerCollapsed(false);
  };

  // Cancela de verdad el render: POST /api/previews no devuelve jobId, así que
  // se mapea previewId -> jobId listando los jobs vivos de la cola
  // (type 'preview', payload.id === previewId) y se cancela ese job.
  const cancelSessionPreview = async (item: SessionPreview) => {
    stopPolling(item.key);
    if (currentKeyRef.current === item.key) setCurrentKey(null);
    setSession((prev) => prev.filter((p) => p.key !== item.key));
    if (!item.previewId) return;
    try {
      const [pending, running] = await Promise.all([
        listQueueJobs("pending"),
        listQueueJobs("running"),
      ]);
      const job = [...pending.jobs, ...running.jobs].find(
        (j) => j.type === "preview" && j.payload?.id === item.previewId
      );
      if (job) await cancelQueueJob(job.id);
    } catch {
      // Si no se pudo cancelar en el backend, igual ya salió de la sesión.
    }
  };

  // Drag & drop nativo para reordenar los chips de la playlist.
  const dragChip = useRef<number | null>(null);
  const [dragOverChip, setDragOverChip] = useState<number | null>(null);

  const dropChip = (target: number) => {
    const from = dragChip.current;
    dragChip.current = null;
    setDragOverChip(null);
    if (from === null || from === target) return;
    setSession((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const isPicked = (gamePath: string, stockId: string) =>
    picks.some((p) => p.gamePath === gamePath && p.stockId === stockId);

  const togglePick = (game: SetGame, gameLabel: string, stock: SetStock) => {
    setPicks((prev) => {
      const idx = prev.findIndex(
        (p) => p.gamePath === game.path && p.stockId === stock.id
      );
      if (idx >= 0) return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      return [
        ...prev,
        {
          gamePath: game.path,
          stockId: stock.id,
          gameLabel,
          timeSeconds: stock.timeSeconds,
          comboStartFrame: stock.comboStartFrame,
          score: stock.score,
        },
      ];
    });
  };

  const selectTopN = () => {
    const all: { game: SetGame; label: string; stock: SetStock }[] = [];
    orderedGames.forEach((g, i) => {
      for (const s of g.stocks) all.push({ game: g, label: `G${i + 1}`, stock: s });
    });
    all.sort((a, b) => b.stock.score - a.stock.score);
    setPicks(
      all.slice(0, Math.max(1, topN)).map(({ game, label, stock }) => ({
        gamePath: game.path,
        stockId: stock.id,
        gameLabel: label,
        timeSeconds: stock.timeSeconds,
        comboStartFrame: stock.comboStartFrame,
        score: stock.score,
      }))
    );
  };

  // Estimación por pick: si hay combo detectado, el clip va desde 4s antes del
  // inicio del combo hasta 2s después de la muerte (+ ~1s del kill en sí).
  // Sin combo: ventana fija lead+pad+9s como antes.
  const padAfter = options.paddingAfter ?? 2;
  const secPerStockFallback = (options.paddingBefore ?? 7) + padAfter + 9;
  const pickSeconds = (p: ReelPick) => {
    if (typeof p.comboStartFrame === "number") {
      const comboStartSec = Math.max(0, (p.comboStartFrame + 123) / 60);
      return Math.max(6, p.timeSeconds - comboStartSec + 4 + padAfter + 1);
    }
    return secPerStockFallback;
  };
  const reelEstimateSec = Math.round(picks.reduce((sum, p) => sum + pickSeconds(p), 0));

  // Estimación de peso del video final (~48 MB/min medido de renders reales).
  const configQuery = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const mbPerMin = configQuery.data?.estimatedMbPerMin ?? 48;
  const fullSetSec = orderedGames.reduce((sum, g) => sum + (g.durationSec ?? 180), 0);

  // Drag & drop nativo para reordenar juegos.
  const dragGame = useRef<number | null>(null);
  const [dragOverGame, setDragOverGame] = useState<number | null>(null);

  const reorderMutation = useMutation({
    mutationFn: (gamePaths: string[]) => updateSet(id!, { gamePaths }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sets"] });
    },
  });

  // Quitar un juego del set (ej: warmup). Re-deriva score/format en el server.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [showAddGames, setShowAddGames] = useState(false);
  const removeGameMutation = useMutation({
    mutationFn: (gamePaths: string[]) => updateSet(id!, { gamePaths }),
    onSuccess: (_data, gamePaths) => {
      const kept = new Set(gamePaths);
      // Limpiar previews/picks que referencien juegos eliminados.
      setSession((prev) => prev.filter((s) => kept.has(s.gamePath)));
      setPicks((prev) => prev.filter((p) => kept.has(p.gamePath)));
      setConfirmRemove(null);
      queryClient.invalidateQueries({ queryKey: ["sets"] });
      queryClient.invalidateQueries({ queryKey: ["set-stocks", id] });
    },
  });

  // Override manual del ganador de un juego (intercambia al otro jugador).
  const swapWinnerMutation = useMutation({
    mutationFn: ({ gamePath, winnerIndex }: { gamePath: string; winnerIndex: number }) =>
      updateSet(id!, { winnerOverrides: { [gamePath]: winnerIndex } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sets"] });
      queryClient.invalidateQueries({ queryKey: ["set-stocks", id] });
    },
  });

  const swapWinner = (game: SetGame) => {
    const current = game.winnerIndex ?? winnerIndexOf(game);
    const other = game.players.find((p) => p.playerIndex !== current);
    if (!other) return;
    swapWinnerMutation.mutate({ gamePath: game.path, winnerIndex: other.playerIndex });
  };

  const removeGame = (gamePath: string) => {
    const next = (set?.gamePaths ?? []).filter((p) => p !== gamePath);
    setOrder(next);
    removeGameMutation.mutate(next);
  };

  const dropGame = (target: number) => {
    const from = dragGame.current;
    dragGame.current = null;
    setDragOverGame(null);
    if (from === null || from === target) return;
    const next = orderedGames.map((g) => g.path);
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    setOrder(next);
    reorderMutation.mutate(next);
  };

  // Drag & drop nativo para reordenar la selección del reel.
  const dragPick = useRef<number | null>(null);
  const [dragOverPick, setDragOverPick] = useState<number | null>(null);

  const dropPick = (target: number) => {
    const from = dragPick.current;
    dragPick.current = null;
    setDragOverPick(null);
    if (from === null || from === target) return;
    setPicks((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  // Scroll al hacer click en un juego del timeline.
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [flashGame, setFlashGame] = useState<string | null>(null);
  const scrollToGame = (path: string) => {
    sectionRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setFlashGame(path);
    setTimeout(() => setFlashGame(null), 1200);
  };

  // Notas de historia (narrativa del set, contexto para YouTube).
  const [storyNotes, setStoryNotes] = useState<string | null>(null);
  useEffect(() => {
    if (set && storyNotes === null) setStoryNotes(set.storyNotes ?? "");
  }, [set, storyNotes]);

  const storyNotesMutation = useMutation({
    mutationFn: (notes: string) => updateSet(id!, { storyNotes: notes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sets"] });
    },
  });

  // Renombrar el set inline desde el header.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const renameMutation = useMutation({
    mutationFn: (name: string) => updateSet(id!, { name }),
    onSuccess: () => {
      setEditingName(false);
      queryClient.invalidateQueries({ queryKey: ["sets"] });
    },
  });

  // Publicación directa a YouTube (sin pasar por Telegram): título/descripción
  // editables + createSchedule con publishAt a +2min (el scheduler rechaza
  // fechas pasadas; el tick corre cada 60s, renderiza y sube solo).
  // useState normal: NO se resetea con el polling de previews.
  const [pubTitle, setPubTitle] = useState<string | null>(null);
  const [pubDescription, setPubDescription] = useState("");
  const [pubDone, setPubDone] = useState<string | null>(null);
  useEffect(() => {
    if (set && pubTitle === null) setPubTitle(`${set.name} - Highlights`);
  }, [set, pubTitle]);

  const publishMutation = useMutation({
    mutationFn: (body: ScheduleBody) => createSchedule(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      setPubDone("En cola: se renderiza y sube solo en ~1-2 min ✓");
    },
  });

  // Nombres para overlay: parchean nametags vacíos de los .slp al renderizar.
  // El orden es por índice contra set.players; un campo vacío se manda como ""
  // en su posición para no desalinear el resto.
  const [namesDraft, setNamesDraft] = useState<string[] | null>(null);
  const [namesSaved, setNamesSaved] = useState(false);
  useEffect(() => {
    if (set && namesDraft === null) {
      setNamesDraft(set.players.map((_, i) => set.playerNames?.[i] ?? ""));
    }
  }, [set, namesDraft]);

  const playerNamesMutation = useMutation({
    mutationFn: (playerNames: string[]) => updateSet(id!, { playerNames }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sets"] });
      setNamesSaved(true);
      setTimeout(() => setNamesSaved(false), 3000);
    },
  });

  // Exportación.
  const [vertical, setVertical] = useState(false);
  const [leadSeconds, setLeadSeconds] = useState(0);
  const [queuedJobId, setQueuedJobId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // Base del modal "Programar" (tipo/items/vertical ya fijados por el botón).
  const [scheduleBase, setScheduleBase] = useState<Omit<
    ScheduleBody,
    "publishAt" | "title" | "description" | "tags"
  > | null>(null);

  const exportMutation = useMutation({
    mutationFn: (body: ExportSetBody) => exportSet(id!, body),
    onSuccess: async (res) => {
      setQueuedJobId(res.jobId);
      try {
        const job = await getJob(res.jobId);
        setCurrentJob(job);
      } catch {
        // Si falla el fetch inicial del job, el panel lo retoma por polling.
      }
    },
    onError: (e) => setExportError(String(e)),
  });

  const doExport = (body: ExportSetBody) => {
    setExportError(null);
    setQueuedJobId(null);
    // Un leadSeconds explícito en el body (ej: export de previews ya ajustados)
    // pisa al input global "Contexto extra".
    exportMutation.mutate({ leadSeconds, ...body });
  };

  // Previews listos (done) en el orden actual de la playlist: sus frames ya
  // vienen ajustados por el usuario con el control de lead.
  const sessionDone = session.filter((s) => s.status === "done" && s.url);
  const previewsExportSec = Math.round(
    sessionDone.reduce((sum, s) => sum + (s.endFrame - s.startFrame) / 60, 0)
  );

  const exportPreviews = () =>
    doExport({
      type: "reel",
      items: sessionDone.map((s) => ({
        gamePath: s.gamePath,
        stockId: s.stockId,
        startFrame: s.startFrame,
        endFrame: s.endFrame,
      })),
      // Los frames ya vienen ajustados: sin lead extra.
      leadSeconds: 0,
      ...(vertical ? { vertical: true } : {}),
    });

  // "Subir directo": mismos items que exportPreviews, pero encolado en el
  // scheduler para render + upload a YouTube sin pasar por Telegram.
  const publishNow = () => {
    if (sessionDone.length === 0 || publishMutation.isPending) return;
    setPubDone(null);
    const title = (pubTitle ?? "").trim();
    const description = pubDescription.trim();
    publishMutation.mutate({
      setId: id!,
      type: "reel",
      items: sessionDone.map((s) => ({
        gamePath: s.gamePath,
        stockId: s.stockId,
        startFrame: s.startFrame,
        endFrame: s.endFrame,
      })),
      leadSeconds: 0,
      ...(vertical ? { vertical: true } : {}),
      publishAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      // Si quedan vacíos, el backend genera la metadata automáticamente.
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      tags: [],
    });
  };

  const exportFullSet = () =>
    doExport({
      type: "full-set",
      items: orderedGames.map((g) => ({ gamePath: g.path })),
      ...(vertical ? { vertical: true } : {}),
    });

  const exportReel = (seconds: number) => {
    if (picks.length > 0) {
      doExport({
        type: "reel",
        items: picks.map((p) => ({ gamePath: p.gamePath, stockId: p.stockId })),
        ...(vertical ? { vertical: true } : {}),
      });
    } else {
      doExport({
        type: "reel",
        items: [],
        targetDurationSec: seconds,
        ...(vertical ? { vertical: true } : {}),
      });
    }
  };

  const etaSeconds =
    currentJob?.status === "running" ? currentJob.progress?.etaSeconds : null;

  if (setsQuery.isLoading) {
    return <p className="p-4 text-muted-foreground">Cargando set...</p>;
  }

  if (!set) {
    return (
      <div className="space-y-4 p-4">
        <p className="text-muted-foreground">Set no encontrado.</p>
        <Link to="/sets" className="text-melee-gold hover:underline">
          ← Volver a sets
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/sets" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Film className="h-6 w-6 text-melee-red" />
          {editingName ? (
            <div className="flex items-center gap-2">
              <Input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && nameDraft.trim()) {
                    renameMutation.mutate(nameDraft.trim());
                  }
                  if (e.key === "Escape") setEditingName(false);
                }}
                autoFocus
                className="h-8 w-72"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-melee-gold"
                title="Guardar nombre"
                disabled={!nameDraft.trim() || renameMutation.isPending}
                onClick={() => renameMutation.mutate(nameDraft.trim())}
              >
                {renameMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                title="Cancelar"
                onClick={() => setEditingName(false)}
              >
                <X className="h-4 w-4" />
              </Button>
              {renameMutation.isError && (
                <Badge variant="destructive">
                  {String(renameMutation.error)}
                </Badge>
              )}
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-foreground">{set.name}</h1>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-melee-gold"
                title="Renombrar set"
                onClick={() => {
                  setNameDraft(set.name);
                  setEditingName(true);
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {set.format && (
            <Badge variant="outline" className="border-melee-gold/50 text-melee-gold">
              {set.format}
            </Badge>
          )}
          <span>{formatDate(set.date)}</span>
          <span>
            {set.wins[0]} — {set.wins[1]}
          </span>
        </div>
      </div>

      {/* Nombres para overlay: parchean nametags vacíos al renderizar.
          El índice matchea contra set.players (por characterId en el backend). */}
      {set.players.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border/50 bg-card px-3 py-2">
          {set.players.map((p, i) => (
            <div key={`${p.connectCode}-${i}`} className="flex items-center gap-2">
              <StockIcon characterId={p.characterId} size={20} />
              <span className="text-xs font-semibold">{p.connectCode}</span>
              <span className="text-[10px] text-muted-foreground">
                char {p.characterId}
              </span>
              <Input
                value={namesDraft?.[i] ?? ""}
                onChange={(e) => {
                  const next = [
                    ...(namesDraft ?? set.players.map(() => "")),
                  ];
                  next[i] = e.target.value;
                  setNamesDraft(next);
                  setNamesSaved(false);
                }}
                placeholder="Nombre para overlay (ej: LEIN)"
                maxLength={16}
                disabled={playerNamesMutation.isPending}
                className="h-7 w-36 text-xs"
              />
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={playerNamesMutation.isPending || !namesDraft}
            onClick={() => namesDraft && playerNamesMutation.mutate(namesDraft)}
            title="Guarda los nombres en el set (PUT /api/sets/:id, playerNames por índice)"
          >
            {playerNamesMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Guardar nombres
          </Button>
          {namesSaved && (
            <Badge
              variant="outline"
              className="border-green-500/50 text-xs text-green-400"
            >
              Guardado ✓
            </Badge>
          )}
          {playerNamesMutation.isError && (
            <Badge variant="destructive">
              {String(playerNamesMutation.error)}
            </Badge>
          )}
        </div>
      )}

      <JobPanel />

      {/* Timeline de juegos */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Juegos del set</CardTitle>
            <div className="flex items-center gap-2">
              {reorderMutation.isPending && (
                <Badge variant="outline" className="text-xs">
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Guardando orden...
                </Badge>
              )}
              {reorderMutation.isError && (
                <Badge variant="destructive">{String(reorderMutation.error)}</Badge>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => setShowAddGames(true)}
                title="Agregar juegos de la librería escaneada (o soltá .slp/.zip en la ventana)"
              >
                <Plus className="h-3.5 w-3.5" />
                Agregar
              </Button>
              {removeGameMutation.isPending && (
                <Badge variant="outline" className="text-xs">
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Actualizando set...
                </Badge>
              )}
              {removeGameMutation.isError && (
                <Badge variant="destructive">
                  {String(removeGameMutation.error)}
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {stocksQuery.isLoading ? (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {set.gamePaths.map((p, i) => (
                <div
                  key={p}
                  className="h-24 w-40 shrink-0 animate-pulse rounded-md border border-border bg-muted/30"
                  aria-label={`Cargando juego ${i + 1}`}
                />
              ))}
            </div>
          ) : stocksQuery.isError ? (
            <p className="text-sm text-destructive">
              Error cargando stocks del set: {String(stocksQuery.error)}
            </p>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {orderedGames.map((game, i) => {
                // Ganador: fuente de verdad = server (placements + regla LRAS
                // + overrides manuales). El heurístico local es solo fallback.
                const winnerIdx = game.winnerIndex ?? winnerIndexOf(game);
                return (
                  <button
                    key={game.path}
                    type="button"
                    draggable
                    onDragStart={() => {
                      dragGame.current = i;
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverGame(i);
                    }}
                    onDragLeave={() =>
                      setDragOverGame((prev) => (prev === i ? null : prev))
                    }
                    onDrop={() => dropGame(i)}
                    onDragEnd={() => {
                      dragGame.current = null;
                      setDragOverGame(null);
                    }}
                    onClick={() => scrollToGame(game.path)}
                    title={`${game.path}\nArrastrá para reordenar`}
                    className={`w-44 shrink-0 cursor-grab rounded-md border p-3 text-left text-sm transition-colors active:cursor-grabbing ${
                      dragOverGame === i
                        ? "border-melee-gold bg-melee-gold/10"
                        : flashGame === game.path
                        ? "border-melee-gold/60 bg-melee-gold/5"
                        : "border-border bg-black/20 hover:border-melee-gold/40"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-melee-gold">G{i + 1}</span>
                      <span className="flex items-center gap-1">
                        {confirmRemove === game.path ? (
                          <>
                            <span
                              role="button"
                              tabIndex={0}
                              title="Confirmar: quitar del set"
                              className="rounded p-0.5 text-green-400 hover:bg-green-500/20"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeGame(game.path);
                              }}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              title="Cancelar"
                              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmRemove(null);
                              }}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              <X className="h-3.5 w-3.5" />
                            </span>
                          </>
                        ) : (
                          <span
                            role="button"
                            tabIndex={0}
                            title="Quitar del set (no borra el archivo)"
                            className="rounded p-0.5 text-muted-foreground/50 hover:bg-destructive/20 hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmRemove(game.path);
                            }}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <X className="h-3.5 w-3.5" />
                          </span>
                        )}
                        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-1">
                      <span className="truncate text-xs text-muted-foreground">
                        {game.stage}
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        title="Corregir ganador: intercambiar quién ganó este juego"
                        className="shrink-0 rounded p-0.5 text-muted-foreground/50 hover:bg-melee-gold/20 hover:text-melee-gold"
                        onClick={(e) => {
                          e.stopPropagation();
                          swapWinner(game);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <ArrowUpDown className="h-3 w-3" />
                      </span>
                    </div>
                    <div className="mt-2 space-y-1">
                      {game.players.map((p) => (
                        <div key={p.playerIndex} className="flex items-center gap-1.5">
                          <StockIcon characterId={p.characterId} size={16} />
                          <span className="truncate text-xs">{p.connectCode}</span>
                          {winnerIdx === p.playerIndex && (
                            <Crown className="h-3 w-3 fill-melee-gold text-melee-gold" />
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-[10px] text-muted-foreground">
                      {game.stocks.length} stocks
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Panel superior: previews + exportación. Bloque normal en el flujo
          de la página (sin sticky): al hacer scroll baja con todo lo demás
          y nunca queda flotando sobre la lista de juegos/stocks. */}
      <div className="space-y-2">
      {session.length > 0 && (
        <Card className="border-melee-red/30 bg-melee-blue">
          <CardContent className={playerCollapsed ? "p-0" : "space-y-2 p-3"}>
            {playerCollapsed ? (
              /* Barra compacta ~40px: no tapa la lista de stocks. El video
                 sigue montado abajo (hidden) y continúa reproduciéndose. */
              <div className="flex h-10 items-center gap-2 px-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-melee-gold"
                  onClick={() => setPlayerCollapsed(false)}
                  title="Expandir player"
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
                {current?.status === "done" && current.url && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-melee-gold"
                    onClick={toggleVideoPlayback}
                    title={videoPlaying ? "Pausar" : "Reproducir"}
                  >
                    {videoPlaying ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
                {current &&
                  (current.status === "pending" || current.status === "rendering") && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-melee-gold" />
                  )}
                <span className="truncate text-xs">
                  {current ? (
                    <>
                      <span className="font-semibold text-melee-gold">
                        {current.gameLabel}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {current.stage} · @ {formatTime(current.timeSeconds)}
                      </span>
                    </>
                  ) : (
                    "Previews"
                  )}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {session.length} clip{session.length !== 1 ? "s" : ""}
                </span>
                {vertical && (
                  <span title="Modo Short vertical activo">
                    <Smartphone className="h-3.5 w-3.5 shrink-0 text-melee-gold" />
                  </span>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  Previews ({session.length})
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={sessionDone.length === 0 || exportMutation.isPending}
                    onClick={exportPreviews}
                    title="Exporta los previews con los frames exactos que ajustaste, en el orden de la playlist"
                  >
                    {exportMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Scissors className="h-3.5 w-3.5" />
                    )}
                    Exportar previews ({sessionDone.length}
                    {sessionDone.length > 0 && ` · ≈${previewsExportSec}s`})
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={sessionDone.length === 0}
                    onClick={() =>
                      setScheduleBase({
                        setId: id!,
                        type: "reel",
                        // Mismos items que "Exportar previews": frames exactos
                        // ajustados en la playlist, sin lead extra.
                        items: sessionDone.map((s) => ({
                          gamePath: s.gamePath,
                          stockId: s.stockId,
                          startFrame: s.startFrame,
                          endFrame: s.endFrame,
                        })),
                        leadSeconds: 0,
                        ...(vertical ? { vertical: true } : {}),
                      })
                    }
                    title="Programar la publicación en YouTube de la playlist ajustada"
                  >
                    <CalendarClock className="h-3.5 w-3.5" />
                    Programar
                  </Button>
                  {/* Mismo estado `vertical` que la barra de export de abajo:
                      marcarlo en un lado se refleja en el otro. */}
                  <Label
                    className="flex cursor-pointer items-center gap-1 px-1 text-xs text-muted-foreground"
                    title="Exportar/programar en 1080x1920 vertical para Shorts"
                  >
                    <Checkbox
                      checked={vertical}
                      onCheckedChange={(v) => setVertical(v === true)}
                    />
                    <Smartphone className="h-3.5 w-3.5" />
                    Short
                  </Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={() => setPlayerCollapsed(true)}
                    title="Minimizar player (sigue sonando/cargado)"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                    Minimizar
                  </Button>
                </div>
              </div>
            )}
            <div className={playerCollapsed ? "hidden" : "space-y-2"}>
            {current ? (
              <div className="grid gap-3 md:grid-cols-3">
                <div className="md:col-span-2">
                  {current.status === "done" && current.url ? (
                    <video
                      key={current.url}
                      ref={videoRef}
                      src={current.url}
                      controls
                      autoPlay
                      playsInline
                      preload="auto"
                      onPlay={() => setVideoPlaying(true)}
                      onPause={() => setVideoPlaying(false)}
                      onCanPlay={(e) => e.currentTarget.play().catch(() => {})}
                      onError={(e) => {
                        // Un 404 transitorio dejaba el video gris para siempre:
                        // reintenta una sola vez reasignando el src.
                        const v = e.currentTarget;
                        if (v.dataset.retried || !current.url) return;
                        v.dataset.retried = "1";
                        v.src = current.url;
                        v.load();
                        v.play().catch(() => {});
                      }}
                      // El preview se renderiza en 4:3 (Melee nativo ~640x480).
                      // Sin aspect-video: el player toma el ratio real del video,
                      // sin barras negras a los lados y más grande (max-h mayor).
                      className="mx-auto max-h-[55vh] w-auto max-w-full rounded-md border border-border bg-black"
                    />
                  ) : current.status === "error" ? (
                    <div className="mx-auto flex aspect-[4/3] max-h-[55vh] w-full max-w-[min(100%,73vh)] items-center justify-center rounded-md border border-destructive/50 bg-black/40 p-3 text-center text-xs text-destructive">
                      Error renderizando preview: {current.error ?? "desconocido"}
                    </div>
                  ) : (
                    <div className="mx-auto flex aspect-[4/3] max-h-[55vh] w-full max-w-[min(100%,73vh)] flex-col items-center justify-center gap-2 rounded-md border border-border bg-black/40 text-xs text-muted-foreground">
                      <Loader2 className="h-6 w-6 animate-spin text-melee-gold" />
                      {current.status === "pending"
                        ? "En cola..."
                        : "Renderizando preview..."}
                      {typeof current.progress === "number" &&
                        ` ${Math.round(current.progress * 100)}%`}
                      {current.etaSec != null && (
                        <span className="text-melee-gold">
                          falta ~{Math.max(1, Math.round(current.etaSec))}s
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {/* Detalles del stock/juego + control de lead */}
                <div className="space-y-1.5 text-xs md:col-span-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-melee-gold">
                      {current.gameLabel}
                    </span>
                    <span className="text-muted-foreground">{current.stage}</span>
                    <span className="font-mono text-muted-foreground">
                      @ {formatTime(current.timeSeconds)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StockIcon characterId={current.killerCharacterId} size={16} />
                    <span className="font-semibold">{current.killerCode}</span>
                    <span className="text-muted-foreground">→</span>
                    <StockIcon characterId={current.victimCharacterId} size={16} />
                    <span>{current.victimCode}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {current.killMove && (
                      <span className="text-melee-gold">
                        {current.killMove}
                        {current.killPercent != null && ` · ${current.killPercent}%`}
                      </span>
                    )}
                    {current.comboLength != null && current.comboLength > 1 && (
                      <span className="text-muted-foreground">
                        combo x{current.comboLength}
                      </span>
                    )}
                    <span className="text-muted-foreground">
                      score {current.score.toFixed(1)}
                    </span>
                  </div>
                  <div className="font-mono text-muted-foreground">
                    frames {current.startFrame} → {current.endFrame}
                  </div>
                  <div className="text-muted-foreground">
                    empieza{" "}
                    {((current.stockFrame - current.startFrame) / 60).toFixed(1)}s antes
                    del kill · termina{" "}
                    {((current.endFrame - current.stockFrame) / 60).toFixed(1)}s después
                  </div>
                  <div className="flex items-center gap-1 pt-1">
                    <span className="text-muted-foreground">Contexto:</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-7 p-0 text-xs"
                      onClick={() => setLeadDelta((v) => v - 2)}
                      title="Restar 2s al delta"
                    >
                      −
                    </Button>
                    <Input
                      type="number"
                      value={leadDelta}
                      onChange={(e) => setLeadDelta(Number(e.target.value) || 0)}
                      className="h-7 w-16 text-xs"
                      title="Delta en segundos: positivo = más contexto antes, negativo = recorta"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-7 p-0 text-xs"
                      onClick={() => setLeadDelta((v) => v + 2)}
                      title="Sumar 2s al delta"
                    >
                      +
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={!leadDelta}
                      onClick={() => applyLead(leadDelta)}
                      title="Re-renderiza con startFrame desplazado por el delta (mismo kill)"
                    >
                      Aplicar
                    </Button>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Final:</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-7 p-0 text-xs"
                      onClick={() => setPadDelta((v) => v - 1)}
                      title="Restar 1s al delta"
                    >
                      −
                    </Button>
                    <Input
                      type="number"
                      value={padDelta}
                      onChange={(e) => setPadDelta(Number(e.target.value) || 0)}
                      className="h-7 w-16 text-xs"
                      title="Delta en segundos: positivo = más tiempo después del kill, negativo = recorta el final"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-7 p-0 text-xs"
                      onClick={() => setPadDelta((v) => v + 1)}
                      title="Sumar 1s al delta"
                    >
                      +
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={!padDelta}
                      onClick={() => applyPad(padDelta)}
                      title="Re-renderiza con endFrame desplazado por el delta (mismo kill)"
                    >
                      Aplicar
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Elegí un preview de la lista para cargarlo acá.
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 border-t border-border/50 pt-2">
              {session.map((item, i) => {
                const busy =
                  item.status === "pending" || item.status === "rendering";
                return (
                  <div
                    key={item.key}
                    draggable
                    onDragStart={() => {
                      dragChip.current = i;
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverChip(i);
                    }}
                    onDrop={() => dropChip(i)}
                    onDragEnd={() => {
                      dragChip.current = null;
                      setDragOverChip(null);
                    }}
                    title={
                      item.status === "error"
                        ? `Error: ${item.error ?? "desconocido"}`
                        : busy
                        ? "Renderizando... · Arrastrá para reordenar"
                        : "Click para cargar en el player · Arrastrá para reordenar"
                    }
                    className={`flex cursor-grab items-center gap-1 rounded-md border px-2 py-1 text-xs active:cursor-grabbing ${
                      dragOverChip === i
                        ? "border-melee-gold bg-melee-gold/10"
                        : item.status === "error"
                        ? "border-destructive/60 bg-destructive/10"
                        : currentKey === item.key
                        ? "border-melee-gold/60 bg-melee-gold/5"
                        : "border-border bg-black/30 hover:border-melee-gold/40"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => playSessionPreview(item)}
                      className="flex items-center gap-1"
                    >
                      {busy && (
                        <Loader2 className="h-3 w-3 animate-spin text-melee-gold" />
                      )}
                      <span className="font-semibold text-melee-gold">
                        {item.gameLabel}
                      </span>
                      <span className="font-mono">
                        {Math.round((item.endFrame - item.startFrame) / 60)}s
                      </span>
                      {item.comboLength != null && item.comboLength > 1 && (
                        <span className="text-muted-foreground">
                          {item.comboLength} hits
                        </span>
                      )}
                      {busy && item.etaSec != null && (
                        <span className="text-muted-foreground">
                          ~{Math.max(1, Math.round(item.etaSec))}s
                        </span>
                      )}
                      {item.status === "error" && (
                        <span className="text-destructive">error</span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => cancelSessionPreview(item)}
                      title={busy ? "Cancelar render" : "Quitar de la lista"}
                      className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            {sessionDone.length > 0 && (
              <div className="rounded-md border border-border/50 bg-black/20 p-2">
                <SpecsGrid
                  durationSec={previewsExportSec}
                  clips={sessionDone.length}
                  vertical={vertical}
                  leadSeconds={0}
                  mbPerMin={mbPerMin}
                />
              </div>
            )}
            {sessionDone.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                "Exportar previews" usa los frames exactos que ajustaste acá; el reel
                de la sección Export usa la ventana original del stock.
              </p>
            )}
            {sessionDone.length > 0 && (
              <div className="space-y-2 rounded-md border border-border/50 bg-black/20 p-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <Rocket className="h-3.5 w-3.5 text-melee-gold" />
                  Publicación
                  <span className="font-normal">
                    — sube a YouTube sin pasar por Telegram
                  </span>
                </div>
                <Input
                  value={pubTitle ?? ""}
                  onChange={(e) => setPubTitle(e.target.value)}
                  placeholder="Título de YouTube"
                  disabled={publishMutation.isPending}
                  className="h-7 text-xs"
                />
                <textarea
                  value={pubDescription}
                  onChange={(e) => setPubDescription(e.target.value)}
                  rows={2}
                  placeholder="Descripción de YouTube (opcional — se genera automática si la dejás vacía)"
                  disabled={publishMutation.isPending}
                  className="flex w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={publishMutation.isPending}
                    onClick={publishNow}
                    title="Renderiza la playlist ajustada y la sube a YouTube apenas termine"
                  >
                    {publishMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Rocket className="h-3.5 w-3.5" />
                    )}
                    Subir directo
                  </Button>
                  {pubDone && (
                    <Badge
                      variant="outline"
                      className="border-green-500/50 text-xs text-green-400"
                    >
                      {pubDone}
                    </Badge>
                  )}
                  {publishMutation.isError && (
                    <Badge variant="destructive">
                      {String(publishMutation.error)}
                    </Badge>
                  )}
                </div>
              </div>
            )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Exportación: set completo, reel, picks (antes barra flotante inferior) */}
      <Card className="border-melee-red/30 bg-melee-blue/95">
        <CardContent className={exportBarCollapsed ? "p-0" : "space-y-3 p-3"}>
          {exportBarCollapsed ? (
            /* Barra compacta ~40px: título + badges mínimos (picks, job vivo). */
            <div className="flex h-10 items-center gap-2 px-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-melee-gold"
                onClick={() => setExportBarCollapsed(false)}
                title="Expandir barra de export"
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Film className="h-3.5 w-3.5 text-melee-gold" />
              <span className="truncate text-xs font-semibold">
                Export · Set completo
              </span>
              {picks.length > 0 && (
                <Badge
                  variant="outline"
                  className="border-melee-gold/50 text-xs text-melee-gold"
                >
                  Reel: {picks.length} stocks
                </Badge>
              )}
              {currentJob?.status === "running" ? (
                <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin text-melee-gold" />
                  Renderizando
                  {etaSeconds != null &&
                    ` · ETA ~${Math.max(0, Math.round(etaSeconds))}s`}
                </span>
              ) : (
                queuedJobId && (
                  <Badge
                    variant="outline"
                    className="ml-auto shrink-0 border-green-500/50 text-xs text-green-400"
                  >
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                    Encolado ✓
                  </Badge>
                )
              )}
            </div>
          ) : (
          <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">
              Reel ({picks.length} stocks)
            </span>
            {picks.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => setPicks([])}
              >
                <X className="h-3.5 w-3.5" />
                Limpiar
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setExportBarCollapsed(true)}
              title="Minimizar barra de export"
            >
              <ChevronDown className="h-3.5 w-3.5" />
              Minimizar
            </Button>
          </div>

          {/* Specs del export: set completo y reel seleccionado */}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1 rounded-md border border-border/50 bg-black/20 p-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Set completo
              </span>
              <SpecsGrid
                durationSec={fullSetSec}
                clips={orderedGames.length}
                vertical={vertical}
                leadSeconds={leadSeconds}
                mbPerMin={mbPerMin}
              />
            </div>
            {picks.length > 0 && (
              <div className="space-y-1 rounded-md border border-border/50 bg-black/20 p-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Reel seleccionado
                </span>
                <SpecsGrid
                  durationSec={reelEstimateSec}
                  clips={picks.length}
                  vertical={vertical}
                  leadSeconds={leadSeconds}
                  mbPerMin={mbPerMin}
                />
              </div>
            )}
          </div>

          {picks.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {picks.map((pick, i) => (
                <div
                  key={`${pick.gamePath}-${pick.stockId}`}
                  draggable
                  onDragStart={() => {
                    dragPick.current = i;
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverPick(i);
                  }}
                  onDrop={() => dropPick(i)}
                  onDragEnd={() => {
                    dragPick.current = null;
                    setDragOverPick(null);
                  }}
                  title="Arrastrá para reordenar"
                  className={`flex cursor-grab items-center gap-1 rounded-md border px-2 py-1 text-xs active:cursor-grabbing ${
                    dragOverPick === i
                      ? "border-melee-gold bg-melee-gold/10"
                      : "border-border bg-black/30"
                  }`}
                >
                  <span className="text-muted-foreground">{i + 1}.</span>
                  <span className="font-semibold text-melee-gold">{pick.gameLabel}</span>
                  <span className="font-mono">{formatTime(pick.timeSeconds)}</span>
                  <Badge
                    variant="outline"
                    className={`px-1 py-0 text-[10px] ${scoreClass(pick.score)}`}
                  >
                    {pick.score.toFixed(1)}
                  </Badge>
                  <button
                    type="button"
                    title="Quitar del reel"
                    onClick={() =>
                      setPicks((prev) =>
                        prev.filter(
                          (p) =>
                            !(p.gamePath === pick.gamePath && p.stockId === pick.stockId)
                        )
                      )
                    }
                    className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={exportFullSet}
              disabled={exportMutation.isPending || orderedGames.length === 0}
            >
              {exportMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Film className="h-4 w-4" />
              )}
              Set completo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-melee-gold"
              disabled={orderedGames.length === 0}
              onClick={() =>
                setScheduleBase({
                  setId: id!,
                  type: "full-set",
                  items: orderedGames.map((g) => ({ gamePath: g.path })),
                  leadSeconds,
                  ...(vertical ? { vertical: true } : {}),
                })
              }
              title="Programar la publicación del set completo en YouTube"
            >
              <CalendarClock className="h-4 w-4" />
            </Button>
            {picks.length > 0 ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => exportReel(0)}
                  disabled={exportMutation.isPending}
                  title="Exporta tus stocks seleccionados completos, en el orden de la lista"
                >
                  <Scissors className="h-4 w-4" />
                  Exportar reel ({picks.length} stocks · ≈{reelEstimateSec}s)
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-melee-gold"
                  onClick={() =>
                    setScheduleBase({
                      setId: id!,
                      type: "reel",
                      items: picks.map((p) => ({
                        gamePath: p.gamePath,
                        stockId: p.stockId,
                      })),
                      leadSeconds,
                      ...(vertical ? { vertical: true } : {}),
                    })
                  }
                  title="Programar la publicación del reel en YouTube"
                >
                  <CalendarClock className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">
                  Auto (mejores por score):
                </span>
                {[30, 60, 90].map((sec) => (
                  <Button
                    key={sec}
                    size="sm"
                    variant="secondary"
                    onClick={() => exportReel(sec)}
                    disabled={exportMutation.isPending}
                    title={`Auto-selecciona los mejores stocks hasta llenar ~${sec}s`}
                  >
                    Reel {sec}s
                  </Button>
                ))}
              </>
            )}
            <Label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={vertical}
                onCheckedChange={(v) => setVertical(v === true)}
              />
              <Smartphone className="h-3.5 w-3.5" />
              Vertical (Shorts)
            </Label>
            <Label
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title="Segundos extra de contexto antes de cada clip del export"
            >
              Contexto extra (s)
              <Input
                type="number"
                min={0}
                max={60}
                value={leadSeconds}
                onChange={(e) =>
                  setLeadSeconds(Math.min(60, Math.max(0, Number(e.target.value) || 0)))
                }
                className="h-8 w-16 text-xs"
              />
            </Label>
            {queuedJobId && (
              <Badge variant="outline" className="border-green-500/50 text-green-400">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                Encolado ✓ (job {queuedJobId})
              </Badge>
            )}
            {etaSeconds != null && (
              <span className="text-xs text-muted-foreground">
                ETA: ~{Math.max(0, Math.round(etaSeconds))}s
              </span>
            )}
            {exportError && (
              <Badge variant="destructive">Error: {exportError}</Badge>
            )}
          </div>
          </>
          )}
        </CardContent>
      </Card>
      </div>

      {/* Top Combos del set: arriba de la lista en mobile, al lado en xl.
          El ▶ de cada combo carga el preview en el panel superior. */}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="order-first xl:order-last xl:col-span-1">
          <TopCombosPanel scope="set" setId={id} onPlay={requestComboPreview} />
        </div>

      {/* Stocks agrupados por juego */}
      <Card className="border-border bg-card xl:col-span-2">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg">Stocks</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setSortByScore((v) => !v)}
              >
                <ArrowUpDown className="h-3.5 w-3.5" />
                {sortByScore ? "Por score" : "Cronológico"}
              </Button>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={1}
                  value={topN}
                  onChange={(e) => setTopN(Number(e.target.value) || 1)}
                  className="h-8 w-16 text-xs"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={selectTopN}
                  disabled={stocksQuery.isLoading}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Top {topN} por score
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {stocksQuery.isLoading ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Analizando replays... puede tardar unos segundos la primera vez.
              </div>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-12 animate-pulse rounded-md border border-border bg-muted/30"
                />
              ))}
            </div>
          ) : stocksQuery.isError ? null : orderedGames.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Este set no tiene juegos.
            </p>
          ) : (
            orderedGames.map((game, gi) => {
              const stocks = sortByScore
                ? [...game.stocks].sort((a, b) => b.score - a.score)
                : [...game.stocks].sort((a, b) => a.timeSeconds - b.timeSeconds);
              const label = `G${gi + 1}`;
              return (
                <div
                  key={game.path}
                  ref={(el) => {
                    if (el) sectionRefs.current.set(game.path, el);
                    else sectionRefs.current.delete(game.path);
                  }}
                  className={`scroll-mt-4 rounded-md border p-3 ${
                    flashGame === game.path
                      ? "border-melee-gold/60 bg-melee-gold/5"
                      : "border-border/60"
                  }`}
                >
                  <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <span className="text-melee-gold">{label}</span>
                    <span className="text-muted-foreground">{game.stage}</span>
                    <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                      {game.players.map((p) => (
                        <span key={p.playerIndex} className="flex items-center gap-1">
                          <StockIcon characterId={p.characterId} size={14} />
                          {p.connectCode}
                        </span>
                      ))}
                    </span>
                  </h4>
                  {stocks.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Sin stocks detectados.</p>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {stocks.map((stock) => {
                        const killer = game.players.find(
                          (p) => p.playerIndex === stock.killerIndex
                        );
                        const victim = game.players.find(
                          (p) => p.playerIndex === stock.victimIndex
                        );
                        const pv = sessionByKey.get(`${game.path}:${stock.id}`);
                        const pvRendering =
                          pv?.status === "pending" || pv?.status === "rendering";
                        return (
                          <div
                            key={stock.id}
                            className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-black/20 p-2 text-sm"
                          >
                            <Checkbox
                              checked={isPicked(game.path, stock.id)}
                              onCheckedChange={() => togglePick(game, label, stock)}
                              aria-label={`Seleccionar stock ${stock.id}`}
                            />
                            <span className="font-mono text-xs text-muted-foreground">
                              {formatTime(stock.timeSeconds)}
                            </span>
                            <span className="flex items-center gap-1">
                              <StockIcon characterId={killer?.characterId} size={16} />
                              <span className="text-xs font-semibold">
                                {killer?.connectCode ?? `P${stock.killerIndex + 1}`}
                              </span>
                            </span>
                            <span className="text-muted-foreground">→</span>
                            <span className="flex items-center gap-1">
                              <StockIcon characterId={victim?.characterId} size={16} />
                              <span className="text-xs">
                                {victim?.connectCode ?? `P${stock.victimIndex + 1}`}
                              </span>
                            </span>
                            {stock.killMove && (
                              <span className="text-xs text-melee-gold">
                                {stock.killMove}
                                {stock.killPercent != null && ` · ${stock.killPercent}%`}
                              </span>
                            )}
                            {stock.comboLength != null && stock.comboLength > 1 && (
                              <span className="text-xs text-muted-foreground">
                                combo x{stock.comboLength}
                              </span>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-melee-gold"
                              title="Preview del stock"
                              onClick={() => requestPreview(game, label, stock)}
                            >
                              {pvRendering ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Play className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Badge
                              variant="outline"
                              className={`ml-auto text-xs ${scoreClass(stock.score)}`}
                            >
                              {stock.score.toFixed(1)}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
      </div>

      {/* Notas de historia (narrativa) */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Notas de historia (narrativa)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            value={storyNotes ?? ""}
            onChange={(e) => setStoryNotes(e.target.value)}
            rows={4}
            placeholder={'Contexto narrativo del set, usado como base para generar títulos y descripciones de YouTube. Ej: "Cuenti era el mejor de RD, Lein le ganó por primera vez..."'}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => storyNotesMutation.mutate(storyNotes ?? "")}
              disabled={
                storyNotesMutation.isPending ||
                storyNotes === null ||
                storyNotes === (set.storyNotes ?? "")
              }
            >
              {storyNotesMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Guardar
            </Button>
            {storyNotesMutation.isSuccess && storyNotes === (set.storyNotes ?? "") && (
              <Badge variant="outline" className="border-green-500/50 text-green-400">
                Guardado ✓
              </Badge>
            )}
            {storyNotesMutation.isError && (
              <Badge variant="destructive">{String(storyNotesMutation.error)}</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {scheduleBase && (
        <ScheduleModal
          base={scheduleBase}
          initialTitle={pubTitle ?? ""}
          initialDescription={pubDescription}
          onClose={() => setScheduleBase(null)}
        />
      )}

      {/* Drag & drop de .slp/.zip directo a este set (modal abre preseleccionado) */}
      <ImportDropzone presetSetId={id} />

      {showAddGames && (
        <AddGamesModal
          setId={id!}
          existingPaths={set.gamePaths}
          onClose={() => setShowAddGames(false)}
        />
      )}
    </div>
  );
}
