import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Music, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { deleteMusic, getMusic, uploadMusic } from "@/lib/api";

const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".ogg", ".aac", ".flac"];

export interface MusicSelection {
  file: string;
  gameVolume: number;
}

interface MusicPickerProps {
  value: MusicSelection | null;
  onChange: (v: MusicSelection | null) => void;
}

function fmtDur(sec: number | null) {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Selector de música para exports: elige una pista subida, sube nuevas con
// click o drag & drop, y ajusta cuánto se oye el audio del juego encima.
export function MusicPicker({ value, onChange }: MusicPickerProps) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const musicQuery = useQuery({ queryKey: ["music"], queryFn: getMusic });
  const tracks = musicQuery.data?.tracks ?? [];

  const upload = async (file: File) => {
    if (!AUDIO_EXTS.some((e) => file.name.toLowerCase().endsWith(e))) {
      setError(`Formato no soportado: ${file.name}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await uploadMusic(file);
      await queryClient.invalidateQueries({ queryKey: ["music"] });
      onChange({ file: res.track.name, gameVolume: value?.gameVolume ?? 0.2 });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`¿Borrar la pista "${name}"?`)) return;
    await deleteMusic(name).catch(() => {});
    if (value?.file === name) onChange(null);
    queryClient.invalidateQueries({ queryKey: ["music"] });
  };

  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${
        dragOver ? "border-melee-gold bg-melee-gold/10" : "border-border/50"
      }`}
      title="Música sobre el export. Arrastrá un mp3/wav/m4a/ogg acá para subirlo."
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) upload(f);
      }}
    >
      <Music className="h-3.5 w-3.5 shrink-0 text-melee-gold" />
      <Select
        value={value?.file ?? "none"}
        onValueChange={(v) =>
          onChange(v !== "none" ? { file: v, gameVolume: value?.gameVolume ?? 0.2 } : null)
        }
      >
        <SelectTrigger className="h-7 w-[150px] border-0 bg-transparent px-1 text-xs shadow-none">
          <SelectValue placeholder="Sin música" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Sin música</SelectItem>
          {tracks.map((t) => (
            <SelectItem key={t.name} value={t.name}>
              {t.name} {t.durationSec != null && `(${fmtDur(t.durationSec)})`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && (
        <Select
          value={String(value.gameVolume)}
          onValueChange={(v) => onChange({ ...value, gameVolume: Number(v) })}
        >
          <SelectTrigger
            className="h-7 w-[92px] border-0 bg-transparent px-1 text-xs shadow-none"
            title="Volumen del audio del juego mezclado con la música"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">Juego 0%</SelectItem>
            <SelectItem value="0.15">Juego 15%</SelectItem>
            <SelectItem value="0.2">Juego 20%</SelectItem>
            <SelectItem value="0.35">Juego 35%</SelectItem>
            <SelectItem value="0.5">Juego 50%</SelectItem>
          </SelectContent>
        </Select>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-melee-gold"
        title="Subir pista (o arrastrala acá)"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5" />
        )}
      </Button>
      {value && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
          title="Borrar la pista seleccionada del servidor"
          onClick={() => remove(value.file)}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      )}
      <input
        ref={fileInput}
        type="file"
        accept={AUDIO_EXTS.join(",")}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = "";
        }}
      />
      {error && <span className="text-[10px] text-destructive">{error}</span>}
    </div>
  );
}
