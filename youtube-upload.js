// youtube-upload.js — Sube videos a YouTube Data API v3 sin dependencias.
// Usa youtube-token.json (generado por youtube-auth.js) con auto-refresh.
//
// Uso CLI:  node youtube-upload.js <video.mp4> "Título" "Descripción" [--short] [--privacy public|unlisted|private]
// Uso lib:  const { uploadVideo } = require('./youtube-upload');
//           await uploadVideo({ filePath, title, description, isShort, privacy });

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { findThumbnail } = require('./thumbnails');

const TOKEN_PATH = path.join(__dirname, 'youtube-token.json');
// Progreso del upload en curso, compartido entre procesos (el bot de Telegram
// lo lee para /status). Se escribe throttled (~cada 2s) durante el PUT.
const UPLOAD_STATUS_PATH = path.join(__dirname, 'upload-status.json');

// Transform que cuenta bytes y vuelca progreso a upload-status.json.
function trackUploadProgress(filePath, totalBytes) {
  const { Transform } = require('stream');
  let sent = 0;
  let lastWrite = 0;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  return new Transform({
    transform(chunk, enc, cb) {
      sent += chunk.length;
      const now = Date.now();
      if (now - lastWrite > 2000) {
        lastWrite = now;
        const elapsedSec = (now - startMs) / 1000;
        const bytesPerSec = sent / Math.max(elapsedSec, 0.1);
        try {
          fs.writeFileSync(UPLOAD_STATUS_PATH, JSON.stringify({
            filePath, totalBytes, bytesSent: sent, bytesPerSec: Math.round(bytesPerSec),
            etaSec: Math.round((totalBytes - sent) / Math.max(bytesPerSec, 1)),
            startedAt, updatedAt: new Date().toISOString(),
          }));
        } catch (_) { /* best effort */ }
      }
      cb(null, chunk);
    },
  });
}

function clearUploadProgress() {
  try { fs.rmSync(UPLOAD_STATUS_PATH, { force: true }); } catch (_) { /* ignore */ }
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('Falta youtube-token.json — corre youtube-auth.js primero');
  }
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
}

async function refreshAccessToken(token) {
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

async function getAccessToken() {
  const token = loadToken();
  // El access token dura ~1h; refrescamos siempre (barato y seguro).
  return refreshAccessToken(token);
}

// Aplica un thumbnail a un video ya subido (thumbnails.set, upload simple).
async function setThumbnail(accessToken, videoId, thumbPath, mime) {
  const buf = fs.readFileSync(thumbPath);
  const res = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': mime,
        'Content-Length': String(buf.length),
      },
      body: buf,
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`thumbnails.set falló ${res.status}: ${text.slice(0, 300)}`);
  }
}

/**
 * Sube un video a YouTube.
 * @param {object} opts
 * @param {string} opts.filePath  Ruta del .mp4
 * @param {string} opts.title     Título (si isShort, se asegura de incluir #Shorts)
 * @param {string} [opts.description]
 * @param {boolean} [opts.isShort]  Agrega #Shorts al título/descripción
 * @param {string} [opts.privacy]  'private' | 'unlisted' | 'public' (default: private —
 *   apps OAuth sin verificar de Google solo pueden subir como private)
 * @param {string[]} [opts.tags]
 * @param {string} [opts.jobId]  Job del export; si existe thumbnails/<jobId>.{jpg,jpeg,png}
 *   se aplica como thumbnail del video (un error aquí NO tumba la subida).
 * @returns {{ videoId: string, url: string, thumbnailSet: boolean }}
 */
async function uploadVideo({ filePath, title, description = '', isShort = false, privacy = 'private', tags = [], jobId = null }) {
  if (!fs.existsSync(filePath)) throw new Error(`No existe: ${filePath}`);
  const accessToken = await getAccessToken();

  if (isShort) {
    if (!/#shorts/i.test(title)) title = `${title} #Shorts`;
    if (!/#shorts/i.test(description)) description = `${description}\n#Shorts`.trim();
  }

  const metadata = {
    snippet: {
      title: title.slice(0, 100),
      description,
      tags,
      categoryId: '20', // Gaming
    },
    status: {
      privacyStatus: privacy,
      selfDeclaredMadeForKids: false,
    },
  };

  // 1. Iniciar resumable upload.
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(fs.statSync(filePath).size),
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!initRes.ok) {
    const text = await initRes.text();
    throw new Error(`YouTube init falló ${initRes.status}: ${text.slice(0, 400)}`);
  }
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube no devolvió upload URL');

  // 2. Subir el binario en streaming (los full-sets pasan de 2GB: leerlos a un
  // Buffer con readFileSync revienta el límite de Buffer de Node).
  const fileSize = fs.statSync(filePath).size;
  let putRes;
  try {
    putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(fileSize) },
      body: fs.createReadStream(filePath).pipe(trackUploadProgress(filePath, fileSize)),
      duplex: 'half',
    });
  } finally {
    clearUploadProgress();
  }
  const putJson = await putRes.json().catch(() => ({}));
  if (!putRes.ok) {
    throw new Error(`YouTube upload falló ${putRes.status}: ${JSON.stringify(putJson).slice(0, 400)}`);
  }
  const videoId = putJson.id;

  // 3. Thumbnail opcional del export (thumbnails/<jobId>.<ext>). Un fallo aquí
  // no debe tumbar la subida: el video ya quedó arriba.
  let thumbnailSet = false;
  if (jobId) {
    const thumb = findThumbnail(jobId);
    if (thumb) {
      try {
        await setThumbnail(accessToken, videoId, thumb.path, thumb.mime);
        thumbnailSet = true;
      } catch (e) {
        console.warn(`[youtube-upload] No se pudo aplicar el thumbnail de ${jobId}:`, e.message);
      }
    }
  }
  return { videoId, url: `https://youtu.be/${videoId}`, thumbnailSet };
}

module.exports = { uploadVideo, applyThumbnailByUrl };

// Aplica un thumbnail a un video YA subido (url youtu.be/VIDEO_ID o watch?v=).
async function applyThumbnailByUrl(youtubeUrl, thumbPath, mime) {
  const m = String(youtubeUrl).match(/(?:youtu\.be\/|v=)([\w-]{11})/);
  if (!m) throw new Error(`No pude sacar el videoId de: ${youtubeUrl}`);
  const accessToken = await getAccessToken();
  await setThumbnail(accessToken, m[1], thumbPath, mime);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const filePath = args[0];
  const title = args[1] || path.basename(filePath || '', '.mp4');
  const description = args[2] || '';
  const isShort = args.includes('--short');
  const privacyArg = args.find((a) => a.startsWith('--privacy='));
  const privacy = privacyArg ? privacyArg.split('=')[1] : 'private';
  if (!filePath) {
    console.error('Uso: node youtube-upload.js <video.mp4> "Título" "Descripción" [--short] [--privacy=public|unlisted|private]');
    process.exit(1);
  }
  uploadVideo({ filePath, title, description, isShort, privacy })
    .then((r) => console.log('SUBIDO:', r.url))
    .catch((e) => {
      console.error('FALLO:', e.message);
      process.exit(1);
    });
}
