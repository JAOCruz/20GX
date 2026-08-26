// youtube-channel.js — Lista los videos subidos al canal + stats (views, likes,
// comentarios) vía YouTube Data API v3. Usa el mismo youtube-token.json que
// youtube-upload.js (scope 'youtube' alcanza para lectura del canal propio).
// Cache de 10 min en uploads-cache.json para no quemar cuota.

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, 'youtube-token.json');
const CACHE_PATH = path.join(__dirname, 'uploads-cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getAccessToken() {
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: token.client_id,
      client_secret: token.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error('Refresh token falló: ' + JSON.stringify(json));
  const updated = { ...token, ...json, refreshed_at: new Date().toISOString() };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(updated, null, 2), { mode: 0o600 });
  return updated.access_token;
}

async function ytGet(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`YouTube API ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    if (Date.now() - new Date(c.fetchedAt).getTime() < CACHE_TTL_MS) return c;
  } catch (_) { /* cache inválido: refetch */ }
  return null;
}

/**
 * Lista los últimos videos del canal con stats.
 * @param {object} opts
 * @param {number} [opts.maxResults]  Default 25.
 * @param {boolean} [opts.force]  Ignora el cache.
 * @returns {Promise<{fetchedAt: string, videos: Array}>}
 */
async function listChannelUploads({ maxResults = 25, force = false } = {}) {
  if (!force) {
    const cached = readCache();
    if (cached) return cached;
  }
  const accessToken = await getAccessToken();
  const ch = await ytGet(
    'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true',
    accessToken
  );
  const uploadsId = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error('No se encontró la playlist de uploads del canal');

  const pl = await ytGet(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=${maxResults}`,
    accessToken
  );
  const ids = (pl.items || [])
    .map((i) => i.snippet?.resourceId?.videoId)
    .filter(Boolean);
  if (ids.length === 0) return { fetchedAt: new Date().toISOString(), videos: [] };

  const vids = await ytGet(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,status,contentDetails&id=${ids.join(',')}`,
    accessToken
  );
  const videos = (vids.items || []).map((v) => ({
    videoId: v.id,
    url: `https://youtu.be/${v.id}`,
    title: v.snippet?.title || '',
    description: v.snippet?.description || '',
    tags: v.snippet?.tags || [],
    publishedAt: v.snippet?.publishedAt || null,
    thumbnail: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || null,
    privacy: v.status?.privacyStatus || 'unknown',
    duration: v.contentDetails?.duration || null, // ISO 8601 (PT1M23S)
    views: Number(v.statistics?.viewCount || 0),
    likes: Number(v.statistics?.likeCount || 0),
    comments: Number(v.statistics?.commentCount || 0),
  }));
  // playlistItems ya viene en orden de subida (más reciente primero); videos.list
  // no garantiza orden, así que reordenamos según ids.
  const order = new Map(ids.map((id, i) => [id, i]));
  videos.sort((a, b) => (order.get(a.videoId) ?? 999) - (order.get(b.videoId) ?? 999));

  const result = { fetchedAt: new Date().toISOString(), videos };
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(result, null, 2));
  } catch (_) { /* best effort */ }
  return result;
}

module.exports = { listChannelUploads };
