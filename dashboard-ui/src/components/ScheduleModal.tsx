import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CheckCircle2, Loader2, Smartphone, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSchedule } from "@/lib/api";
import type { ScheduleBody } from "@/types";

// Default: la próxima hora en punto, en formato datetime-local (hora local).
function defaultPublishAt() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

interface ScheduleModalProps {
  // Todo lo fijado por el botón que abrió el modal (tipo, items, vertical...).
  base: Omit<ScheduleBody, "publishAt" | "title" | "description" | "tags">;
  // Pre-llenado opcional (ej: lo ya escrito en la sección Publicación).
  initialTitle?: string;
  initialDescription?: string;
  onClose: () => void;
}

export function ScheduleModal({ base, initialTitle, initialDescription, onClose }: ScheduleModalProps) {
  const queryClient = useQueryClient();
  const [publishAt, setPublishAt] = useState(defaultPublishAt());
  const [title, setTitle] = useState(initialTitle ?? "");
  const [description, setDescription] = useState(initialDescription ?? "");
  const [tags, setTags] = useState("");
  const [success, setSuccess] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: ScheduleBody) => createSchedule(body),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      setSuccess(
        `Programado para ${new Date(res.entry.publishAt).toLocaleString()}`
      );
      setTimeout(onClose, 1800);
    },
  });

  const submit = () => {
    if (!publishAt || mutation.isPending) return;
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    mutation.mutate({
      ...base,
      publishAt: new Date(publishAt).toISOString(),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(tagList.length > 0 ? { tags: tagList } : {}),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="h-4 w-4 text-melee-gold" />
            Programar publicación
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

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-xs">
            {base.type === "reel" ? "Reel" : "Set completo"}
          </Badge>
          {base.vertical && (
            <Badge variant="outline" className="text-xs" title="Vertical (Shorts)">
              <Smartphone className="h-3 w-3" />
            </Badge>
          )}
          {base.items && (
            <span className="text-xs text-muted-foreground">
              {base.items.length} clips
            </span>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="schedule-publishAt" className="text-xs">
            Fecha y hora de publicación
          </Label>
          <Input
            id="schedule-publishAt"
            type="datetime-local"
            value={publishAt}
            onChange={(e) => setPublishAt(e.target.value)}
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="schedule-title" className="text-xs">
            Título
          </Label>
          <Input
            id="schedule-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Se genera automático si lo dejás vacío"
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="schedule-description" className="text-xs">
            Descripción
          </Label>
          <textarea
            id="schedule-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Se genera automático si lo dejás vacío"
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="schedule-tags" className="text-xs">
            Tags
          </Label>
          <Input
            id="schedule-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="melee, combo, falco (separados por coma)"
            className="h-8 text-sm"
          />
        </div>

        {mutation.isError && (
          <Badge variant="destructive">Error: {String(mutation.error)}</Badge>
        )}
        {success && (
          <div className="flex items-center gap-1.5 text-sm text-green-400">
            <CheckCircle2 className="h-4 w-4" />
            {success}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={!publishAt || mutation.isPending || Boolean(success)}
          >
            {mutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CalendarClock className="h-4 w-4" />
            )}
            Programar
          </Button>
        </div>
      </div>
    </div>
  );
}
