import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  Film,
  ListVideo,
  MessageSquare,
  RefreshCw,
  Smartphone,
  ThumbsUp,
  TvMinimalPlay,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getUploads } from "@/lib/api";
import type { UploadedVideo } from "@/types";

// PT1M23S → "1:23"
function formatDuration(iso: string | null): string | null {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  const mm = h > 0 ? String(min).padStart(2, "0") : String(min);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

function privacyBadge(privacy: string) {
  if (privacy === "public")
    return <Badge className="bg-green-600/80 text-white">Público</Badge>;
  if (privacy === "unlisted")
    return <Badge variant="secondary">No listado</Badge>;
  if (privacy === "private") return <Badge variant="outline">Privado</Badge>;
  return <Badge variant="outline">{privacy}</Badge>;
}

function UploadRow({ video }: { video: UploadedVideo }) {
  const [open, setOpen] = useState(false);
  const duration = formatDuration(video.duration);
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          {video.thumbnail && (
            <img
              src={video.thumbnail}
              alt=""
              className="hidden w-28 shrink-0 rounded sm:block"
            />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold">
                {video.title || "(sin título)"}
              </span>
              {privacyBadge(video.privacy)}
              {video.local?.vertical && (
                <Badge variant="outline" className="gap-1 text-xs">
                  <Smartphone className="h-3 w-3" />
                  Short
                </Badge>
              )}
              {video.local?.type && (
                <Badge variant="outline" className="gap-1 text-xs">
                  {video.local.type === "full-set" ? (
                    <ListVideo className="h-3 w-3" />
                  ) : (
                    <Film className="h-3 w-3" />
                  )}
                  {video.local.type === "full-set" ? "Set" : "Reel"}
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {video.publishedAt && (
                <span>{new Date(video.publishedAt).toLocaleString()}</span>
              )}
              {duration && <span className="font-mono">{duration}</span>}
              <span className="flex items-center gap-1">
                <Eye className="h-3 w-3" />
                {video.views.toLocaleString()}
              </span>
              <span className="flex items-center gap-1">
                <ThumbsUp className="h-3 w-3" />
                {video.likes.toLocaleString()}
              </span>
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                {video.comments.toLocaleString()}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" asChild>
              <a href={video.url} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                YouTube
              </a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setOpen((v) => !v)}
              title={open ? "Ocultar detalles" : "Ver detalles"}
            >
              {open ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {open && (
          <div className="mt-3 space-y-2 border-t border-border/50 pt-2 text-xs">
            {video.description ? (
              <p className="whitespace-pre-wrap text-muted-foreground">
                {video.description}
              </p>
            ) : (
              <p className="text-muted-foreground">(sin descripción)</p>
            )}
            {video.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {video.tags.map((t) => (
                  <Badge key={t} variant="outline" className="text-[10px]">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
            {video.local ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
                {video.local.setName && video.local.setId && (
                  <span>
                    Set:{" "}
                    <Link
                      to={`/sets/${video.local.setId}`}
                      className="text-melee-gold hover:underline"
                    >
                      {video.local.setName}
                    </Link>
                  </span>
                )}
                {video.local.clipCount != null && video.local.clipCount > 0 && (
                  <span>{video.local.clipCount} clips</span>
                )}
                {video.local.outputPath && (
                  <span className="font-mono text-[10px]">
                    {video.local.outputPath.split("/").pop()}
                  </span>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">
                Subido fuera del pipeline (sin metadata local).
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function UploadsPage() {
  const [refresh, setRefresh] = useState(false);
  const query = useQuery({
    queryKey: ["uploads", refresh],
    queryFn: () => getUploads(refresh),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <TvMinimalPlay className="h-5 w-5 text-red-500" />
          Subidos al canal
        </h2>
        <div className="flex items-center gap-2">
          {query.data && (
            <span className="text-xs text-muted-foreground">
              stats de {new Date(query.data.fetchedAt).toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={query.isFetching}
            onClick={() => setRefresh((v) => !v)}
            title="Saltar cache y pedir stats frescas a YouTube"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`}
            />
            Actualizar
          </Button>
        </div>
      </div>

      {query.isLoading && (
        <p className="text-sm text-muted-foreground">Cargando videos del canal…</p>
      )}
      {query.isError && (
        <Card>
          <CardContent className="p-3 text-sm text-red-400">
            Error: {String(query.error)}
          </CardContent>
        </Card>
      )}
      {query.data && query.data.videos.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No hay videos subidos al canal todavía.
        </p>
      )}
      {query.data?.videos.map((v) => <UploadRow key={v.videoId} video={v} />)}
    </div>
  );
}
