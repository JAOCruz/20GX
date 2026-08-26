import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Loader2 } from "lucide-react";
import { getExportThumbnailUrl, uploadExportThumbnail } from "@/lib/api";
import type { ExportRecord } from "@/types";

// Miniatura del thumbnail de YouTube de un export + botón para subir/cambiarlo.
// Detiene la propagación del click para poder usarse dentro de filas clickeables.
export function ExportThumbnail({ record: e }: { record: ExportRecord }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  // Sube tras cada upload para romper el caché de la <img> (misma URL).
  const [version, setVersion] = useState(0);

  const mutation = useMutation({
    mutationFn: (file: File) => uploadExportThumbnail(e.jobId, file),
    onSuccess: () => {
      setVersion((v) => v + 1);
      queryClient.invalidateQueries({ queryKey: ["exports"] });
    },
  });

  const showImg = e.hasThumbnail || version > 0;
  const src = `${getExportThumbnailUrl(e.jobId)}?v=${version || e.completedAt}`;

  return (
    <span
      className="flex items-center gap-1"
      onClick={(ev) => ev.stopPropagation()}
    >
      {showImg && (
        <img
          src={src}
          alt="thumbnail"
          title="Thumbnail de YouTube"
          className="h-9 w-16 shrink-0 rounded border border-border/60 object-cover"
        />
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        className="hidden"
        onChange={(ev) => {
          const file = ev.target.files?.[0];
          if (file) mutation.mutate(file);
          ev.target.value = ""; // permite re-elegir el mismo archivo
        }}
      />
      <button
        type="button"
        title={showImg ? "Cambiar thumbnail" : "Subir thumbnail (jpg/png, máx 10 MB)"}
        disabled={mutation.isPending}
        onClick={() => inputRef.current?.click()}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-melee-gold/40 hover:text-melee-gold disabled:opacity-50"
      >
        {mutation.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ImagePlus className="h-3.5 w-3.5" />
        )}
      </button>
      {mutation.isError && (
        <span
          className="text-xs text-red-400"
          title={String(mutation.error)}
        >
          error
        </span>
      )}
    </span>
  );
}
