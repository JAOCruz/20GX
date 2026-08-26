// dashboard/app.js
// Lee clips-manifest.json y muestra un dashboard para revisar highlights.

let clips = [];
let selectedId = null;
let votes = {};

const STORAGE_KEY = 'slippi-dashboard-votes';

async function init() {
  votes = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');

  try {
    const res = await fetch('clips-manifest.json');
    const data = await res.json();
    clips = data.clips || [];
  } catch (e) {
    console.error('No se pudo cargar clips-manifest.json:', e);
    clips = [];
  }

  document.getElementById('search').addEventListener('input', renderList);
  document.getElementById('status-filter').addEventListener('change', renderList);

  renderList();
  updateStats();
}

function getStatus(id) {
  return votes[id] || 'pending';
}

function renderList() {
  const search = document.getElementById('search').value.toLowerCase();
  const statusFilter = document.getElementById('status-filter').value;
  const list = document.getElementById('clip-list');
  list.innerHTML = '';

  const filtered = clips.filter((clip) => {
    const status = getStatus(clip.id);
    if (statusFilter !== 'all' && status !== statusFilter) return false;
    const text = `${clip.file} ${clip.reason || ''}`.toLowerCase();
    return text.includes(search);
  });

  for (const clip of filtered) {
    const status = getStatus(clip.id);
    const item = document.createElement('div');
    item.className = `clip-item ${clip.id === selectedId ? 'active' : ''}`;
    item.onclick = () => selectClip(clip.id);

    const duration = clip.durationSeconds
      ? `${clip.durationSeconds.toFixed(1)}s`
      : '';

    item.innerHTML = `
      <div class="title">
        ${escapeHtml(clip.reason || clip.file)}
        <span class="badge ${status}">${status}</span>
      </div>
      <div class="meta">${escapeHtml(clip.file)} ${duration}</div>
    `;
    list.appendChild(item);
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty" style="padding:1rem;color:#94a3b8">Sin clips</div>';
  }
}

function selectClip(id) {
  selectedId = id;
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;

  const wrap = document.getElementById('video-wrap');
  wrap.innerHTML = '';

  const video = document.createElement('video');
  video.src = clip.file;
  video.controls = true;
  video.autoplay = true;
  wrap.appendChild(video);

  document.getElementById('details').style.display = 'flex';
  document.getElementById('detail-title').textContent = clip.reason || clip.file;
  document.getElementById('detail-meta').textContent =
    `${clip.file} · Frames ${clip.startFrame}-${clip.endFrame} · ${clip.durationSeconds ? clip.durationSeconds.toFixed(1) + 's' : ''}`;

  renderList();
}

function setStatus(status) {
  if (!selectedId) return;
  votes[selectedId] = status;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(votes));
  renderList();
  updateStats();
}

function updateStats() {
  const total = clips.length;
  const approved = clips.filter((c) => getStatus(c.id) === 'approved').length;
  const rejected = clips.filter((c) => getStatus(c.id) === 'rejected').length;
  document.getElementById('total-count').textContent = `${total} clips`;
  document.getElementById('approved-count').textContent = `${approved} aprobados`;
  document.getElementById('rejected-count').textContent = `${rejected} rechazados`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

window.setStatus = setStatus;
init();
