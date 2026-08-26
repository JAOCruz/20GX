import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileUp, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createSet, getSets, importFile, refreshGames, updateSet } from "@/lib/api";

type Destination = "new" | "existing" | "library";

function defaultSetName() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Set ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Dropzone global: escucha drag & drop de archivos .slp/.zip a nivel ventana
// mientras está montado y ofrece importarlos a un set o a la librería.
// Con presetSetId (montado en SetDetailPage) el modal abre preseleccionado
// en "Set existente" apuntando a ese set.
export function ImportDropzone({ presetSetId }: { presetSetId?: string }) {
  const queryClient = useQueryClient();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [files, setFiles] = useState<File[] | null>(null);
  const [dest, setDest] = useState<Destination>("new");
  const [name, setName] = useState(defaultSetName());
  const [setId, setSetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const setsQuery = useQuery({ queryKey: ["sets"], queryFn: getSets });

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (files || busy) return; // ya hay una importación abierta
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      const zips = dropped.filter((f) => f.name.toLowerCase().endsWith(".zip"));
      const slps = dropped.filter((f) => f.name.toLowerCase().endsWith(".slp"));
      // Si hay un zip, se procesa solo ese.
      const accepted = zips.length > 0 ? [zips[0]] : slps;
      if (accepted.length === 0) return;
      setError(null);
      setSuccess(null);
      setProgress(null);
      setName(defaultSetName());
      setDest(presetSetId ? "existing" : "new");
      setSetId(presetSetId ?? "");
      setFiles(accepted);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [files, busy, presetSetId]);

  const close = () => {
    if (busy) return;
    setFiles(null);
    setError(null);
    setSuccess(null);
    setProgress(null);
  };

  const runImport = async () => {
    if (!files || busy) return;
    if (dest === "new" && !name.trim()) {
      setError("Ponele un nombre al set");
      return;
    }
    if (dest === "existing" && !setId) {
      setError("Elegí un set de la lista");
      return;
    }
    setError(null);
    setBusy(true);
    setProgress({ done: 0, total: files.length });
    const allPaths: string[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const res = await importFile(
          files[i],
          dest === "new"
            ? { target: "set", name: name.trim() }
            : dest === "existing"
              ? { target: "add-to-set", setId }
              : { target: "games" }
        );
        allPaths.push(...res.paths);
        setProgress({ done: i + 1, total: files.length });
      }
      if (dest === "new") {
        const { set } = await createSet({ name: name.trim(), gamePaths: allPaths });
        setSuccess(`Set "${set.name}" creado con ${allPaths.length} juegos`);
      } else if (dest === "existing") {
        const current = setsQuery.data?.sets.find((s) => s.id === setId);
        await updateSet(setId, {
          gamePaths: [...(current?.gamePaths ?? []), ...allPaths],
        });
        setSuccess(
          `${allPaths.length} juegos agregados a "${current?.name ?? "el set"}"`
        );
      } else {
        try {
          await refreshGames();
        } catch {
          /* 409 si ya hay un scan corriendo: los juegos entran en el próximo */
        }
        setSuccess(`${allPaths.length} juegos importados a la librería`);
      }
      queryClient.invalidateQueries({ queryKey: ["sets"] });
      queryClient.invalidateQueries({ queryKey: ["games"] });
      // Si se agregó a un set, refrescar sus stocks/juegos en SetDetailPage.
      if (dest === "existing" && setId) {
        queryClient.invalidateQueries({ queryKey: ["set-stocks", setId] });
      }
      setBusy(false);
      setTimeout(() => {
        setFiles(null);
        setSuccess(null);
        setProgress(null);
      }, 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <>
      {dragging && !files && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/70">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-melee-gold/70 bg-card/90 px-10 py-8">
            <FileUp className="h-10 w-10 text-melee-gold" />
            <p className="text-lg font-semibold text-foreground">
              Soltá los .slp o .zip acá
            </p>
            <p className="text-sm text-muted-foreground">
              Importá replays a un set o a la librería
            </p>
          </div>
        </div>
      )}

      {files && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={close}
        >
          <div
            className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <FileUp className="h-4 w-4 text-melee-gold" />
                Importar replays
              </h3>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground"
                onClick={close}
                disabled={busy}
                title="Cerrar"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-xs">
                {files.length} archivo{files.length === 1 ? "" : "s"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {files
                  .slice(0, 3)
                  .map((f) => f.name)
                  .join(", ")}
                {files.length > 3 ? `, +${files.length - 3} más` : ""}
              </span>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Destino</Label>
              <div className="grid grid-cols-3 gap-1 rounded-md border border-border p-1">
                {(
                  [
                    ["new", "Set nuevo"],
                    ["existing", "Set existente"],
                    ["library", "Solo librería"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDest(value)}
                    disabled={busy}
                    className={`rounded px-2 py-1.5 text-xs transition-colors ${
                      dest === value
                        ? "bg-melee-gold/20 font-semibold text-melee-gold"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {dest === "new" && (
              <div className="space-y-1">
                <Label htmlFor="import-name" className="text-xs">
                  Nombre del set
                </Label>
                <Input
                  id="import-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  className="h-8 text-sm"
                />
              </div>
            )}

            {dest === "existing" && (
              <div className="space-y-1">
                <Label className="text-xs">Set</Label>
                <Select value={setId} onValueChange={setSetId} disabled={busy}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="Elegí un set..." />
                  </SelectTrigger>
                  <SelectContent>
                    {(setsQuery.data?.sets ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} ({s.gameCount ?? s.gamePaths.length} juegos)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {progress && (
              <div className="space-y-1">
                <Progress
                  value={(progress.done / progress.total) * 100}
                  className="h-2"
                />
                <p className="text-xs text-muted-foreground">
                  Subiendo {progress.done}/{progress.total}...
                </p>
              </div>
            )}

            {error && <Badge variant="destructive">Error: {error}</Badge>}
            {success && (
              <div className="flex items-center gap-1.5 text-sm text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                {success}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
                Cancelar
              </Button>
              <Button size="sm" onClick={runImport} disabled={busy || Boolean(success)}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileUp className="h-4 w-4" />
                )}
                Importar
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
