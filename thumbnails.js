// thumbnails.js
// Thumbnails de YouTube por export, guardados en thumbnails/<jobId>.<ext>.
// Los usan dashboard-server.js (subir/servir), telegram-compile-bot.js
// (guardar desde una foto) y youtube-upload.js (aplicar con thumbnails.set).

const fs = require('fs');
const path = require('path');

const THUMBNAILS_DIR = path.join(__dirname, 'thumbnails');
const EXTS = ['jpg', 'jpeg', 'png'];
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const MAX_BYTES = 10 * 1024 * 1024; // límite de YouTube para thumbnails

function ensureDir() {
  if (!fs.existsSync(THUMBNAILS_DIR)) fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

// Los jobId son "job-<timestamp>-<rand>"; validar para evitar path traversal.
function isValidJobId(jobId) {
  return typeof jobId === 'string' && /^[A-Za-z0-9-]+$/.test(jobId);
}

// Busca el thumbnail de un job. Devuelve { path, ext, mime, sizeBytes } o null.
function findThumbnail(jobId) {
  if (!isValidJobId(jobId)) return null;
  for (const ext of EXTS) {
    const filePath = path.join(THUMBNAILS_DIR, `${jobId}.${ext}`);
    if (fs.existsSync(filePath)) {
      return { path: filePath, ext, mime: MIME[ext], sizeBytes: fs.statSync(filePath).size };
    }
  }
  return null;
}

// Guarda (o reemplaza) el thumbnail de un job. Elimina variantes con otra ext.
function saveThumbnail(jobId, buffer, ext) {
  if (!isValidJobId(jobId)) throw new Error(`jobId inválido: ${jobId}`);
  if (!EXTS.includes(ext)) throw new Error(`Extensión no soportada: ${ext}`);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Imagen vacía');
  if (buffer.length > MAX_BYTES) throw new Error('Imagen muy grande (máx 10 MB)');
  ensureDir();
  for (const other of EXTS) {
    if (other === ext) continue;
    try { fs.unlinkSync(path.join(THUMBNAILS_DIR, `${jobId}.${other}`)); } catch (e) { /* no existe */ }
  }
  const filePath = path.join(THUMBNAILS_DIR, `${jobId}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = { THUMBNAILS_DIR, MAX_BYTES, isValidJobId, findThumbnail, saveThumbnail };
