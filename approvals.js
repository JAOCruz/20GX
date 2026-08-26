// approvals.js
// Persistencia de aprobaciones de subida a YouTube en approvals.json
// (escritura atómica tmp + rename, tolera archivo faltante/corrupto).
//
// Flujo: set-export.js crea un approval 'pending' al terminar un export y lo
// manda por Telegram con botones inline; telegram-compile-bot.js resuelve los
// callbacks (subir / editar título / editar descripción / descartar).
//
// Campos: id, filePath, setId, type ('reel'|'full-set'), title, description,
// tags, status ('pending'|'scheduled'|'uploaded'|'discarded'), messageId, chatId,
// youtubeUrl, createdAt. Extras de display: setName, header, isText.

const fs = require('fs');
const path = require('path');

const APPROVALS_FILE = path.join(__dirname, 'approvals.json');

function loadApprovals() {
  if (!fs.existsSync(APPROVALS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[approvals] approvals.json corrupto, ignorando:', e.message);
    return [];
  }
}

function saveApprovals(approvals) {
  const tmp = `${APPROVALS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(approvals, null, 2));
  fs.renameSync(tmp, APPROVALS_FILE);
}

function createApproval(data) {
  const approvals = loadApprovals();
  const approval = {
    id: `ap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filePath: data.filePath,
    setId: data.setId || null,
    setName: data.setName || null,
    type: data.type || 'reel',
    title: data.title || '',
    description: data.description || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    status: 'pending',
    messageId: data.messageId || null,
    chatId: data.chatId || null,
    youtubeUrl: data.youtubeUrl || null,
    header: data.header || '',
    isText: !!data.isText,
    createdAt: new Date().toISOString(),
  };
  approvals.push(approval);
  saveApprovals(approvals);
  return approval;
}

function getApproval(id) {
  return loadApprovals().find((a) => a.id === id) || null;
}

function updateApproval(id, patch) {
  const approvals = loadApprovals();
  const idx = approvals.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  approvals[idx] = { ...approvals[idx], ...patch, id: approvals[idx].id };
  saveApprovals(approvals);
  return approvals[idx];
}

function findByMessageId(messageId) {
  return loadApprovals().find((a) => String(a.messageId) === String(messageId)) || null;
}

function findByFilePath(filePath) {
  return loadApprovals().find((a) => a.filePath === filePath) || null;
}

// Reels ya subidos de un set (para numerar "Highlights Pt.N").
function countUploadedReels(setId) {
  return loadApprovals().filter(
    (a) => a.setId === setId && a.type === 'reel' && a.status === 'uploaded'
  ).length;
}

// Teclado inline de aprobación (lo usan set-export.js y telegram-compile-bot.js).
function approvalKeyboard(approvalId) {
  return {
    inline_keyboard: [[
      { text: '✅ Subir a YouTube', callback_data: `appr_upload:${approvalId}` },
      { text: '📅 Programar', callback_data: `appr_sched:${approvalId}` },
      { text: '✏️ Título', callback_data: `appr_title:${approvalId}` },
      { text: '📝 Descripción', callback_data: `appr_desc:${approvalId}` },
      { text: '❌ Descartar', callback_data: `appr_discard:${approvalId}` },
    ]],
  };
}

module.exports = {
  APPROVALS_FILE,
  loadApprovals,
  createApproval,
  getApproval,
  updateApproval,
  findByMessageId,
  findByFilePath,
  countUploadedReels,
  approvalKeyboard,
};
