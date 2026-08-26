import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Film,
  Loader2,
  Pencil,
  Plus,
  Scissors,
  Smartphone,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExportThumbnail } from "@/components/ExportThumbnail";
import {
  createSchedule,
  deleteSchedule,
  getExports,
  getSchedule,
  getSets,
  updateSchedule,
} from "@/lib/api";
import type {
  ExportRecord,
  ScheduleBody,
  ScheduleEntry,
  ScheduleStatus,
  SetSummary,
} from "@/types";

// ---------------------------------------------------------------------------
// Constantes y helpers de formato
// ---------------------------------------------------------------------------

const STATUS_META: Record<
  ScheduleStatus,
  { label: string; badge: string; pill: string; spin?: boolean }
> = {
  scheduled: {
    label: "Programado",
    badge: "border-blue-500/50 text-blue-400",
    pill: "border-blue-500/40 bg-blue-600/25 text-blue-200 hover:bg-blue-600/40",
  },
  rendering: {
    label: "Renderizando",
    badge: "border-amber-500/50 text-amber-400",
    pill: "border-amber-500/40 bg-amber-600/25 text-amber-200 hover:bg-amber-600/40",
    spin: true,
  },
  rendered: {
    label: "Listo para subir",
    badge: "border-green-500/50 text-green-400",
    pill: "border-green-500/40 bg-green-600/25 text-green-200 hover:bg-green-600/40",
  },
  uploading: {
    label: "Subiendo",
    badge: "border-amber-500/50 text-amber-400",
    pill: "border-amber-500/40 bg-amber-600/25 text-amber-200 hover:bg-amber-600/40",
    spin: true,
  },
  uploaded: {
    label: "Publicado",
    badge: "border-green-500/50 text-green-400",
    pill: "border-green-500/40 bg-green-600/25 text-green-200 hover:bg-green-600/40",
  },
  error: {
    label: "Error",
    badge: "border-red-500/50 text-red-400",
    pill: "border-red-500/40 bg-red-600/25 text-red-200 hover:bg-red-600/40",
  },
};

// Semana de LUNES a domingo.
const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatTimeHM(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDateTime(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(seconds?: number | null) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSize(bytes?: number | null) {
  if (bytes == null || !isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Valor inicial para un input datetime-local a partir de un ISO (hora local).
function toLocalInput(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function dateKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isToday(d: Date) {
  return dateKey(d) === dateKey(new Date());
}

// Semanas (lunes-domingo) que cubren el mes de `cursor` (cursor = día 1 del mes).
function buildMonthWeeks(cursor: Date): Date[][] {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // lunes = 0
  const d = new Date(year, month, 1 - offset);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    weeks.push(week);
    // Si la próxima semana ya empieza fuera del mes, terminamos.
    if (d.getMonth() !== month) break;
  }
  return weeks;
}

// Combina la fecha del día clickeado con la hora del input -> ISO local.
function combineDateTime(date: Date, time: string) {
  const [hh, mm] = time.split(":").map(Number);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hh || 0,
    mm || 0
  ).toISOString();
}

// ---------------------------------------------------------------------------
// UI compartida de la página
// ---------------------------------------------------------------------------

function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function EntryPill({
  entry,
  onClick,
}: {
  entry: ScheduleEntry;
  onClick: () => void;
}) {
  const meta = STATUS_META[entry.status];
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={`${entry.name} · ${meta.label}${entry.error ? ` · ${entry.error}` : ""}`}
      className={`flex w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-left text-[11px] transition-colors ${meta.pill}`}
    >
      {meta.spin && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
      <span className="shrink-0 font-mono">{formatTimeHM(entry.publishAt)}</span>
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

function TypeBadges({ type, vertical }: { type: string; vertical?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <Badge variant="outline" className="text-xs">
        {type === "reel" ? (
          <Scissors className="mr-1 h-3 w-3" />
        ) : (
          <Film className="mr-1 h-3 w-3" />
        )}
        {type === "reel" ? "Reel" : "Set"}
      </Badge>
      {vertical && (
        <Badge variant="outline" className="text-xs" title="Vertical (Shorts)">
          <Smartphone className="h-3 w-3" />
        </Badge>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Modal de detalle de una entry (info + editar/eliminar si scheduled)
// ---------------------------------------------------------------------------

function EntryDetailModal({
  entry,
  onClose,
}: {
  entry: ScheduleEntry;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const editable = entry.status === "scheduled";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [description, setDescription] = useState(entry.description);
  const [tags, setTags] = useState(entry.tags.join(", "));
  const [publishAt, setPublishAt] = useState(toLocalInput(entry.publishAt));

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["schedule"] });

  const updateMutation = useMutation({
    mutationFn: () =>
      updateSchedule(entry.id, {
        title: title.trim(),
        description: description.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        ...(publishAt ? { publishAt: new Date(publishAt).toISOString() } : {}),
      }),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSchedule(entry.id),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const onDelete = () => {
    if (
      window.confirm(
        `¿Eliminar la publicación programada de "${entry.name}" (${formatDateTime(
          entry.publishAt
        )})?`
      )
    ) {
      deleteMutation.mutate();
    }
  };

  const meta = STATUS_META[entry.status];

  return (
    <Modal onClose={onClose}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={`text-xs ${meta.badge}`}>
            {meta.spin && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {meta.label}
          </Badge>
          <TypeBadges type={entry.type} vertical={entry.vertical} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
          onClick={onClose}
          title="Cerrar"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <h3 className="mt-2 text-lg font-semibold">
        <Link
          to={`/sets/${encodeURIComponent(entry.setId)}`}
          className="hover:text-melee-gold hover:underline"
        >
          {entry.name}
        </Link>
      </h3>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Publicación
          </div>
          <div className="font-mono text-xs">{formatDateTime(entry.publishAt)}</div>
        </div>
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Render estimado
          </div>
          <div className="font-mono text-xs">
            ~{formatDuration(entry.renderEstimateSec)}
          </div>
        </div>
        {entry.status === "scheduled" && entry.renderStartAt && (
          <div className="col-span-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Se renderiza a partir de
            </div>
            <div className="font-mono text-xs">
              ~{formatDateTime(entry.renderStartAt)}
            </div>
          </div>
        )}
      </div>

      {entry.status === "error" && entry.error && (
        <p className="mt-3 rounded-md border border-red-500/40 bg-red-600/10 p-2 text-xs text-red-300">
          {entry.error}
        </p>
      )}

      {entry.status === "uploaded" && entry.youtubeUrl && (
        <a
          href={entry.youtubeUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-600/10 px-2.5 py-1.5 text-sm text-red-300 hover:bg-red-600/20"
        >
          📺 Ver en YouTube
        </a>
      )}

      {!editing ? (
        <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Título
            </div>
            <p className="text-sm">{entry.title || "—"}</p>
          </div>
          {entry.description && (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Descripción
              </div>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {entry.description}
              </p>
            </div>
          )}
          {entry.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {entry.tags.map((t) => (
                <Badge key={t} variant="outline" className="text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
          <div className="space-y-1">
            <Label className="text-xs">Título</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Descripción</Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Tags (separados por coma)</Label>
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Fecha y hora</Label>
              <Input
                type="datetime-local"
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
          </div>
          {updateMutation.isError && (
            <Badge variant="destructive">{String(updateMutation.error)}</Badge>
          )}
        </div>
      )}

      {editable && (
        <div className="mt-4 flex items-center gap-2 border-t border-border/50 pt-3">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => updateMutation.mutate()}
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Guardar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" />
              Editar
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Eliminar
          </Button>
        </div>
      )}
      {deleteMutation.isError && (
        <p className="mt-2 text-xs text-red-400">
          Error al eliminar: {String(deleteMutation.error)}
        </p>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Modal "Programar para <fecha>": export ya renderizado o nuevo render
// ---------------------------------------------------------------------------

type RenderChoice =
  | { type: "reel"; targetDurationSec: number }
  | { type: "full-set" };

function DayScheduleModal({
  date,
  allEntries,
  onClose,
  onOpenEntry,
}: {
  date: Date;
  allEntries: ScheduleEntry[];
  onClose: () => void;
  onOpenEntry: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"export" | "render">("export");
  const [time, setTime] = useState("18:00");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedExport, setSelectedExport] = useState<ExportRecord | null>(null);
  const [selectedSet, setSelectedSet] = useState<SetSummary | null>(null);
  const [renderChoice, setRenderChoice] = useState<RenderChoice | null>(null);

  const exportsQuery = useQuery({ queryKey: ["exports"], queryFn: getExports });
  const setsQuery = useQuery({ queryKey: ["sets"], queryFn: getSets });

  // Exports elegibles: existen en disco y no se subieron todavía.
  const availableExports = useMemo(
    () =>
      (exportsQuery.data?.exports ?? []).filter((e) => e.exists && !e.youtubeUrl),
    [exportsQuery.data]
  );

  // Los exports ya programados vienen marcados por el backend (ex.scheduled,
  // match por jobId con fallback por nombre en GET /api/exports).

  const dayEntries = useMemo(
    () =>
      allEntries
        .filter((e) => dateKey(new Date(e.publishAt)) === dateKey(date))
        .sort(
          (a, b) =>
            new Date(a.publishAt).getTime() - new Date(b.publishAt).getTime()
        ),
    [allEntries, date]
  );

  const mutation = useMutation({
    mutationFn: (body: ScheduleBody) => createSchedule(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      onClose();
    },
  });

  const submit = () => {
    if (mutation.isPending) return;
    const publishAt = combineDateTime(date, time);
    const extras = {
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
    };
    if (tab === "export") {
      if (!selectedExport) return;
      mutation.mutate({ exportJobId: selectedExport.jobId, publishAt, ...extras });
    } else {
      if (!selectedSet || !renderChoice) return;
      mutation.mutate({
        setId: selectedSet.id,
        ...renderChoice,
        publishAt,
        ...extras,
      });
    }
  };

  const canSubmit =
    tab === "export" ? Boolean(selectedExport) : Boolean(selectedSet && renderChoice);

  const dateLabel = capitalize(
    date.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
    })
  );

  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <CalendarClock className="h-5 w-5 text-melee-gold" />
          Programar para {dateLabel}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground"
          onClick={onClose}
          title="Cerrar"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {dayEntries.length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Ya programado este día
          </div>
          {dayEntries.map((e) => (
            <EntryPill
              key={e.id}
              entry={e}
              onClick={() => {
                onClose();
                onOpenEntry(e.id);
              }}
            />
          ))}
        </div>
      )}

      {/* Tabs de fuente */}
      <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg border border-border/60 bg-black/20 p-1">
        <button
          type="button"
          onClick={() => setTab("export")}
          className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            tab === "export"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <Upload className="h-4 w-4" />
          Export ya renderizado
        </button>
        <button
          type="button"
          onClick={() => setTab("render")}
          className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            tab === "render"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <Film className="h-4 w-4" />
          Nuevo render
        </button>
      </div>

      {/* Lista según tab */}
      <div className="mt-3 max-h-56 space-y-1.5 overflow-y-auto pr-1">
        {tab === "export" ? (
          exportsQuery.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando exports...
            </p>
          ) : availableExports.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hay exports renderizados pendientes de subir.
            </p>
          ) : (
            availableExports.map((ex) => {
              const already = Boolean(ex.scheduled);
              const selected = selectedExport?.jobId === ex.jobId;
              return (
                // div con role=button para poder anidar el botón de thumbnail.
                <div
                  key={ex.jobId}
                  role="button"
                  tabIndex={already ? -1 : 0}
                  aria-disabled={already}
                  title={ex.fileName}
                  onClick={() => {
                    if (!already) setSelectedExport(ex);
                  }}
                  onKeyDown={(ev) => {
                    if (!already && (ev.key === "Enter" || ev.key === " ")) {
                      setSelectedExport(ex);
                    }
                  }}
                  className={`flex w-full flex-wrap items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors ${
                    already ? "cursor-not-allowed" : "cursor-pointer"
                  } ${
                    selected
                      ? "border-melee-gold bg-melee-gold/10"
                      : already
                      ? "border-border/40 opacity-50"
                      : "border-border/60 bg-black/20 hover:border-melee-gold/40"
                  }`}
                >
                  <ExportThumbnail record={ex} />
                  <span className="font-semibold">{ex.name}</span>
                  <TypeBadges type={ex.type} vertical={ex.vertical} />
                  {already && (
                    <Badge
                      variant="outline"
                      className="border-blue-500/50 text-xs text-blue-400"
                    >
                      Programado {formatTimeHM(ex.scheduled!.publishAt)}
                    </Badge>
                  )}
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{ex.clipCount} clips</span>
                    <span>{formatSize(ex.sizeBytes)}</span>
                    <span className="font-mono">
                      {formatDateTime(ex.completedAt)}
                    </span>
                  </span>
                </div>
              );
            })
          )
        ) : setsQuery.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando sets...
          </p>
        ) : (setsQuery.data?.sets ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay sets disponibles.</p>
        ) : (
          (setsQuery.data?.sets ?? []).map((s) => {
            const selected = selectedSet?.id === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedSet(s)}
                className={`flex w-full flex-wrap items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors ${
                  selected
                    ? "border-melee-gold bg-melee-gold/10"
                    : "border-border/60 bg-black/20 hover:border-melee-gold/40"
                }`}
              >
                <span className="font-semibold">{s.name}</span>
                <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {s.wins[0]} — {s.wins[1]}
                  </span>
                  {s.gameCount != null && <span>{s.gameCount} juegos</span>}
                  <span className="font-mono">{formatDuration(s.durationSec)}</span>
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Tipo de render (solo tab "Nuevo render" y con set elegido) */}
      {tab === "render" && selectedSet && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Tipo de render
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[30, 60, 90].map((sec) => {
              const active =
                renderChoice?.type === "reel" &&
                renderChoice.targetDurationSec === sec;
              return (
                <Button
                  key={sec}
                  size="sm"
                  variant={active ? "default" : "secondary"}
                  className="h-8 text-xs"
                  onClick={() =>
                    setRenderChoice({ type: "reel", targetDurationSec: sec })
                  }
                  title={`Auto-selecciona los mejores stocks hasta llenar ~${sec}s`}
                >
                  <Scissors className="h-3.5 w-3.5" />
                  Reel {sec}s
                </Button>
              );
            })}
            <Button
              size="sm"
              variant={renderChoice?.type === "full-set" ? "default" : "secondary"}
              className="h-8 text-xs"
              onClick={() => setRenderChoice({ type: "full-set" })}
            >
              <Film className="h-3.5 w-3.5" />
              Set completo
            </Button>
          </div>
        </div>
      )}

      {/* Hora + metadatos opcionales */}
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Hora de publicación</Label>
          <Input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Título (opcional)</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Se genera automático si lo dejás vacío"
            className="h-8 text-sm"
          />
        </div>
      </div>
      <div className="mt-2 space-y-1">
        <Label className="text-xs">Descripción (opcional)</Label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Se genera automático si lo dejás vacío"
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      {mutation.isError && (
        <div className="mt-2">
          <Badge variant="destructive">Error: {String(mutation.error)}</Badge>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2 border-t border-border/50 pt-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancelar
        </Button>
        <Button size="sm" onClick={submit} disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CalendarClock className="h-4 w-4" />
          )}
          {tab === "export" ? "Programar subida" : "Programar render + subida"}
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Página principal: grid mensual
// ---------------------------------------------------------------------------

export function SchedulePage() {
  // cursor = día 1 del mes visible (cambiar de mes no toca la query).
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dayModalDate, setDayModalDate] = useState<Date | null>(null);

  const scheduleQuery = useQuery({
    queryKey: ["schedule"],
    queryFn: getSchedule,
    // Hay estados vivos (rendering/uploading): poll suave para refrescar.
    refetchInterval: 10000,
  });

  const entries = useMemo(
    () =>
      [...(scheduleQuery.data?.entries ?? [])].sort(
        (a, b) =>
          new Date(a.publishAt).getTime() - new Date(b.publishAt).getTime()
      ),
    [scheduleQuery.data]
  );

  const entriesByDay = useMemo(() => {
    const map = new Map<string, ScheduleEntry[]>();
    for (const e of entries) {
      const key = dateKey(new Date(e.publishAt));
      const list = map.get(key);
      if (list) list.push(e);
      else map.set(key, [e]);
    }
    return map;
  }, [entries]);

  const weeks = useMemo(() => buildMonthWeeks(cursor), [cursor]);

  const monthLabel = capitalize(
    cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
  );

  // Resumen del mes visible + próxima publicación futura.
  const monthCount = useMemo(
    () =>
      entries.filter((e) => {
        const d = new Date(e.publishAt);
        return (
          d.getFullYear() === cursor.getFullYear() &&
          d.getMonth() === cursor.getMonth()
        );
      }).length,
    [entries, cursor]
  );
  const inProgressCount = entries.filter(
    (e) => e.status === "rendering" || e.status === "uploading"
  ).length;
  const nextEntry =
    entries.find(
      (e) => e.status === "scheduled" && new Date(e.publishAt).getTime() >= Date.now()
    ) ?? null;

  // El detalle se deriva por id para que se refresque con el polling.
  const detailEntry = detailId
    ? entries.find((e) => e.id === detailId) ?? null
    : null;

  const shiftMonth = (delta: number) =>
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));

  return (
    <div className="space-y-4 p-4">
      {/* Header: título + navegación de mes */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <CalendarClock className="h-7 w-7 text-melee-gold" />
          <h1 className="text-3xl font-bold text-foreground">Calendario</h1>
          {scheduleQuery.isFetching && !scheduleQuery.isLoading && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => shiftMonth(-1)}
            title="Mes anterior"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="min-w-44 text-center text-xl font-semibold">
            {monthLabel}
          </h2>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => shiftMonth(1)}
            title="Mes siguiente"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="ml-1 h-8"
            onClick={() => {
              const d = new Date();
              setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
            }}
          >
            Hoy
          </Button>
        </div>
      </div>

      {/* Resumen */}
      <div className="flex flex-wrap gap-2 text-sm">
        <div className="rounded-lg border border-border/60 bg-card px-3 py-1.5">
          <span className="text-muted-foreground">Este mes: </span>
          <span className="font-semibold text-melee-gold">
            {monthCount} publicación{monthCount !== 1 ? "es" : ""}
          </span>
        </div>
        <div className="rounded-lg border border-border/60 bg-card px-3 py-1.5">
          <span className="text-muted-foreground">Próxima: </span>
          {nextEntry ? (
            <span className="font-semibold">
              {formatDateTime(nextEntry.publishAt)} · {nextEntry.name}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
        {inProgressCount > 0 && (
          <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-600/10 px-3 py-1.5 text-amber-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {inProgressCount} en proceso
          </div>
        )}
      </div>

      {/* Grid mensual (semana lunes-domingo) */}
      {scheduleQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando programación...
        </div>
      ) : scheduleQuery.isError ? (
        <p className="text-sm text-destructive">
          Error cargando la programación: {String(scheduleQuery.error)}
        </p>
      ) : (
        <div className="grid grid-cols-7 gap-1.5">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="px-2 py-1 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {d}
            </div>
          ))}
          {weeks.flat().map((day) => {
            const inMonth = day.getMonth() === cursor.getMonth();
            const today = isToday(day);
            const dayEntries = entriesByDay.get(dateKey(day)) ?? [];
            const visible = dayEntries.slice(0, 3);
            const hidden = dayEntries.length - visible.length;
            return (
              <div
                key={day.toISOString()}
                onClick={() => setDayModalDate(day)}
                title="Click para programar en este día"
                className={`min-h-28 cursor-pointer rounded-lg border p-2 transition-colors ${
                  inMonth
                    ? "border-border/60 bg-black/20 hover:border-melee-gold/50"
                    : "border-border/30 bg-black/5 hover:border-border/60"
                } ${today ? "ring-2 ring-melee-gold/70" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-sm font-semibold ${
                      today
                        ? "flex h-6 w-6 items-center justify-center rounded-full bg-melee-gold text-black"
                        : inMonth
                        ? "text-foreground"
                        : "text-muted-foreground/50"
                    }`}
                  >
                    {day.getDate()}
                  </span>
                  <Plus className="h-3.5 w-3.5 text-muted-foreground/40" />
                </div>
                <div className="mt-1.5 space-y-1">
                  {visible.map((e) => (
                    <EntryPill key={e.id} entry={e} onClick={() => setDetailId(e.id)} />
                  ))}
                  {hidden > 0 && (
                    <span className="block px-1 text-[10px] font-medium text-muted-foreground">
                      +{hidden} más
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {detailEntry && (
        <EntryDetailModal entry={detailEntry} onClose={() => setDetailId(null)} />
      )}
      {dayModalDate && (
        <DayScheduleModal
          date={dayModalDate}
          allEntries={entries}
          onClose={() => setDayModalDate(null)}
          onOpenEntry={(entryId) => setDetailId(entryId)}
        />
      )}
    </div>
  );
}
