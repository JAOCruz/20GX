// dashboard-mac/app.js
// Frontend vanilla JS para el dashboard de Slippi en macOS.

const API = '/api';
let games = [];
let selectedGame = null;
let stocksData = null;
let selectedStocks = new Map(); // key: direction (a|b), value: Set(indices)
let config = {};
let activeJobs = [];

async function init() {
  bindEvents();
  await loadConfig();
  await loadGames();
  await loadClips();
  startPolling();
}

function bindEvents() {
  document.getElementById('refresh-btn').addEventListener('click', refreshGames);
  document.getElementById('game-search').addEventListener('input', renderGames);
  document.getElementById('game-sort').addEventListener('change', renderGames);
}

async function loadConfig() {
  try {
    const res = await fetch(`${API}/config`);
    config = await res.json();
  } catch (e) {
    console.error('No se pudo cargar config:', e);
  }
}

async function loadGames() {
  setHeaderStatus('Cargando juegos...');
  try {
    const res = await fetch(`${API}/games`);
    const data = await res.json();
    games = data.games || [];
    renderGames();
    setHeaderStatus(`${games.length} juegos`);
  } catch (e) {
    console.error('Error cargando juegos:', e);
    setHeaderStatus('Error cargando juegos');
  }
}

async function refreshGames() {
  setHeaderStatus('Escaneando replays...');
  try {
    await fetch(`${API}/refresh`, { method: 'POST' });
    // El escaneo es asincrono en el servidor; esperamos un poco y recargamos.
    setTimeout(loadGames, 2000);
  } catch (e) {
    console.error('Error refrescando:', e);
    setHeaderStatus('Error al refrescar');
  }
}

function renderGames() {
  const search = document.getElementById('game-search').value.toLowerCase();
  const sort = document.getElementById('game-sort').value;
  const list = document.getElementById('game-list');
  list.innerHTML = '';

  let filtered = games.filter((g) => {
    const text = `${g.fileName} ${g.stageName} ${g.players.map((p) => `${p.connectCode} ${p.characterName} ${p.nametag}`).join(' ')}`.toLowerCase();
    return text.includes(search);
  });

  filtered.sort((a, b) => {
    const da = a.date || a.fileName || '';
    const db = b.date || b.fileName || '';
    return sort === 'oldest' ? da.localeCompare(db) : db.localeCompare(da);
  });

  for (const game of filtered) {
    const item = document.createElement('div');
    item.className = `game-item ${selectedGame && selectedGame.filePath === game.filePath ? 'active' : ''}`;
    item.onclick = () => selectGame(game);
    const p = game.players.slice().sort((x, y) => x.playerIndex - y.playerIndex);
    const vs = p.map((pl) => `<span class="game-char">${escapeHtml(pl.characterName)}</span> ${escapeHtml(pl.connectCode || '')}`).join(' vs ');
    item.innerHTML = `
      <div class="game-title">${escapeHtml(game.fileName)}</div>
      <div class="game-meta">${escapeHtml(game.stageName)} · ${escapeHtml(game.date || '')}</div>
      <div class="game-meta">${vs}</div>
    `;
    list.appendChild(item);
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="game-meta" style="padding:1rem;text-align:center">Sin juegos</div>';
  }
}

async function selectGame(game) {
  selectedGame = game;
  selectedStocks.clear();
  renderGames();

  const workspace = document.getElementById('workspace');
  workspace.innerHTML = '<h2>Cargando stocks...</h2>';

  const players = game.players.slice().sort((a, b) => a.playerIndex - b.playerIndex);
  if (players.length < 2) {
    workspace.innerHTML = '<h2>Juego invalido</h2><p class="game-info">Se necesitan al menos 2 jugadores.</p>';
    return;
  }

  try {
    const res = await fetch(`${API}/stocks?slp=${encodeURIComponent(game.filePath)}&p0=${players[0].playerIndex}&p1=${players[1].playerIndex}`);
    stocksData = await res.json();
    if (stocksData.error) throw new Error(stocksData.error);
    renderWorkspace();
    await loadAudioDelay();
  } catch (e) {
    console.error('Error cargando stocks:', e);
    workspace.innerHTML = `<h2>Error</h2><p class="game-info">${escapeHtml(e.message)}</p>`;
  }
}

function renderWorkspace() {
  if (!selectedGame || !stocksData) return;
  const workspace = document.getElementById('workspace');

  const a = stocksData.playerA;
  const b = stocksData.playerB;

  workspace.innerHTML = `
    <h2>${escapeHtml(a.name || a.charName)} vs ${escapeHtml(b.name || b.charName)}</h2>
    <div class="game-info">
      ${escapeHtml(selectedGame.stageName)} · ${escapeHtml(selectedGame.fileName)} · ${formatDuration(selectedGame.durationSeconds)}
    </div>

    <div class="audio-cal">
      <label title="Positivo = retrasar audio de Discord (llega mas tarde). Negativo = adelantar.">Calibracion audio Discord (+ = atrasar)</label>
      <input type="range" id="audio-delay" min="-5" max="5" step="0.1" value="0" />
      <span class="value" id="audio-delay-value">0.0s</span>
      <button class="btn secondary" id="save-delay-btn" style="display:none">Guardar</button>
    </div>

    <div class="stocks-grid">
      <div class="stocks-column">
        <h3>${escapeHtml(a.name || a.charName)} mata a ${escapeHtml(b.name || b.charName)}
          <button class="btn secondary" style="font-size:0.7rem;padding:0.2rem 0.4rem" data-dir="a" onclick="toggleAll('a')">Todo</button>
        </h3>
        <div id="stocks-a"></div>
      </div>
      <div class="stocks-column">
        <h3>${escapeHtml(b.name || b.charName)} mata a ${escapeHtml(a.name || a.charName)}
          <button class="btn secondary" style="font-size:0.7rem;padding:0.2rem 0.4rem" data-dir="b" onclick="toggleAll('b')">Todo</button>
        </h3>
        <div id="stocks-b"></div>
      </div>
    </div>

    <div class="actions">
      <button class="btn red" id="render-btn">Renderizar seleccionados</button>
      <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.85rem;color:var(--muted)">
        <input type="checkbox" id="mix-discord" checked /> Mezclar audio de Discord
      </label>
      <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.85rem;color:var(--muted)" title="Mac headless no funciona; usar Jarvis por defecto">
        <input type="checkbox" id="use-jarvis" checked /> Usar Jarvis (recomendado)
      </label>
    </div>
    <div class="job-status" id="job-status"></div>

    <div class="discord-box">
      <input type="text" id="guild-id" placeholder="Guild ID" value="${escapeHtml(config.discordGuildId || '')}" />
      <input type="text" id="channel-id" placeholder="Channel ID" value="${escapeHtml(config.discordChannelId || '')}" />
      <button class="btn red" id="discord-start">Grabar Discord</button>
      <button class="btn secondary" id="discord-stop">Detener</button>
      <span class="recording-status" id="recording-status"></span>
    </div>
  `;

  renderStockColumn('a', stocksData.stocksAtoB);
  renderStockColumn('b', stocksData.stocksBtoA);

  document.getElementById('render-btn').addEventListener('click', startRender);
  document.getElementById('audio-delay').addEventListener('input', onDelayInput);
  document.getElementById('audio-delay').addEventListener('change', saveAudioDelay);
  document.getElementById('discord-start').addEventListener('click', startDiscord);
  document.getElementById('discord-stop').addEventListener('click', stopDiscord);
}

function renderStockColumn(dir, stocks) {
  const container = document.getElementById(`stocks-${dir}`);
  if (!container) return;
  if (!selectedStocks.has(dir)) selectedStocks.set(dir, new Set());
  container.innerHTML = '';
  if (!stocks || stocks.length === 0) {
    container.innerHTML = '<div class="game-meta">Sin stocks</div>';
    return;
  }
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    const row = document.createElement('label');
    row.className = 'stock-row';
    const checked = selectedStocks.get(dir).has(i) ? 'checked' : '';
    row.innerHTML = `
      <input type="checkbox" data-dir="${dir}" data-idx="${i}" ${checked}>
      <span class="time">${formatTime(s.timeSeconds)}</span>
      <span class="remaining">stock ${s.stocksRemaining} restante(s)</span>
    `;
    const cb = row.querySelector('input');
    cb.addEventListener('change', () => toggleStock(dir, i, cb.checked));
    container.appendChild(row);
  }
}

function toggleStock(dir, idx, checked) {
  const set = selectedStocks.get(dir) || new Set();
  if (checked) set.add(idx);
  else set.delete(idx);
  selectedStocks.set(dir, set);
}

window.toggleAll = function(dir) {
  const stocks = dir === 'a' ? stocksData.stocksAtoB : stocksData.stocksBtoA;
  const set = selectedStocks.get(dir) || new Set();
  if (set.size === stocks.length) {
    set.clear();
  } else {
    for (let i = 0; i < stocks.length; i++) set.add(i);
  }
  selectedStocks.set(dir, set);
  renderStockColumn(dir, stocks);
};

async function loadAudioDelay() {
  if (!selectedGame) return;
  try {
    const res = await fetch(`${API}/audio-delay?slp=${encodeURIComponent(selectedGame.filePath)}`);
    const data = await res.json();
    const slider = document.getElementById('audio-delay');
    const value = document.getElementById('audio-delay-value');
    if (slider) slider.value = data.delaySeconds || 0;
    if (value) {
      const v = data.delaySeconds || 0;
      const label = v > 0 ? 'atrasar' : v < 0 ? 'adelantar' : 'sync';
      value.textContent = `${Math.abs(v).toFixed(1)}s ${label}`;
    }
  } catch (e) {
    console.error('Error cargando delay:', e);
  }
}

function onDelayInput(e) {
  const v = parseFloat(e.target.value);
  const label = v > 0 ? 'atrasar' : v < 0 ? 'adelantar' : 'sync';
  document.getElementById('audio-delay-value').textContent = `${Math.abs(v).toFixed(1)}s ${label}`;
}

async function saveAudioDelay() {
  if (!selectedGame) return;
  const slider = document.getElementById('audio-delay');
  const delay = parseFloat(slider.value);
  try {
    await fetch(`${API}/audio-delay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slpPath: selectedGame.filePath, delaySeconds: delay }),
    });
  } catch (e) {
    console.error('Error guardando delay:', e);
  }
}

async function startRender() {
  if (!selectedGame) return;
  const mixDiscord = document.getElementById('mix-discord').checked;
  const useJarvis = document.getElementById('use-jarvis').checked;
  const statusEl = document.getElementById('job-status');
  statusEl.textContent = '';
  statusEl.className = 'job-status';

  const directions = [
    { dir: 'a', attacker: stocksData.playerA.playerIndex, victim: stocksData.playerB.playerIndex },
    { dir: 'b', attacker: stocksData.playerB.playerIndex, victim: stocksData.playerA.playerIndex },
  ];

  let any = false;
  for (const { dir, attacker, victim } of directions) {
    const indices = Array.from(selectedStocks.get(dir) || []).sort((x, y) => x - y);
    if (indices.length === 0) continue;
    any = true;
    try {
      const res = await fetch(`${API}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slpPath: selectedGame.filePath,
          attackerIndex: attacker,
          victimIndex: victim,
          indices,
          mixDiscord,
          backend: useJarvis ? 'jarvis' : 'mac',
        }),
      });
      const data = await res.json();
      if (data.error) {
        statusEl.textContent = data.error;
        statusEl.className = 'job-status error';
      } else if (data.jobId) {
        activeJobs.push(data.jobId);
        statusEl.textContent = `Render ${data.jobId} iniciado...`;
      }
    } catch (e) {
      console.error('Error iniciando render:', e);
      statusEl.textContent = e.message;
      statusEl.className = 'job-status error';
    }
  }

  if (!any) {
    statusEl.textContent = 'Selecciona al menos un stock';
    statusEl.className = 'job-status error';
  }
}

async function startDiscord() {
  const guildId = document.getElementById('guild-id').value.trim();
  const channelId = document.getElementById('channel-id').value.trim();
  const statusEl = document.getElementById('recording-status');
  if (!guildId || !channelId) {
    statusEl.textContent = 'Faltan Guild/Channel ID';
    return;
  }
  try {
    const res = await fetch(`${API}/discord/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildId, channelId }),
    });
    const data = await res.json();
    statusEl.textContent = data.error ? `Error: ${data.error}` : 'Grabando...';
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}

async function stopDiscord() {
  const statusEl = document.getElementById('recording-status');
  try {
    const res = await fetch(`${API}/discord/stop`, { method: 'POST' });
    const data = await res.json();
    statusEl.textContent = data.error ? `Error: ${data.error}` : `Grabado ${data.durationSeconds || 0}s`;
    loadClips();
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}

async function loadClips() {
  try {
    const res = await fetch(`${API}/clips`);
    const data = await res.json();
    renderClips(data.clips || []);
  } catch (e) {
    console.error('Error cargando clips:', e);
  }
}

function renderClips(clips) {
  const list = document.getElementById('clip-list');
  list.innerHTML = '';
  for (const clip of clips) {
    const item = document.createElement('div');
    item.className = 'clip-item';
    const files = clip.files || [];
    const label = files.length > 0 ? files.join(', ') : (clip.jobId || 'clip');
    item.title = label;
    item.innerHTML = `<div>${escapeHtml(label)}</div><div class="game-meta">${clip.telegramSent ? '✅ Telegram' : '⏳'}</div>`;
    list.appendChild(item);
  }
  if (clips.length === 0) {
    list.innerHTML = '<div class="game-meta" style="padding:0.75rem;text-align:center">Sin clips enviados aun</div>';
  }
}

function playClip(fileName) {
  // Los clips ya no se almacenan localmente; se envian por Telegram.
  const panel = document.getElementById('video-panel');
  panel.innerHTML = '<div class="empty-video">Los clips se envian por Telegram.<br>Revisalos en la app de Telegram.</div>';
}

function startPolling() {
  setInterval(async () => {
    if (activeJobs.length === 0) return;
    const stillRunning = [];
    const statusEl = document.getElementById('job-status');
    for (const jobId of activeJobs) {
      try {
        const res = await fetch(`${API}/jobs/${jobId}`);
        const job = await res.json();
        if (job.status === 'completed') {
          const clips = (job.output && job.output.clips) || [];
          const telegram = job.output && job.output.telegramOutput ? ' — enviado por Telegram' : '';
          const msg = `Job ${jobId} completado: ${clips.length} clip(s)${telegram}`;
          if (statusEl && !statusEl.classList.contains('error')) {
            statusEl.textContent = msg;
            statusEl.className = 'job-status ok';
          }
          loadClips();
        } else if (job.status === 'failed') {
          if (statusEl) {
            statusEl.textContent = `Job ${jobId} fallo: ${job.error || 'error desconocido'}`;
            statusEl.className = 'job-status error';
          }
        } else {
          stillRunning.push(jobId);
        }
      } catch (e) {
        stillRunning.push(jobId);
      }
    }
    activeJobs = stillRunning;
  }, 1500);
}

function setHeaderStatus(text) {
  document.getElementById('header-status').textContent = text;
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

init();
