// generate-dashboard.js
// Genera un dashboard HTML a partir de best-clips.json.
// Todo es codigo puro sobre los datos de slippi-js: sin AI.

const fs = require('fs');
const path = require('path');

const BEST_CLIPS_FILE = process.argv[2] || '/home/jay/slippi-pipeline/best-clips.json';
const CLIPS_DIR = process.env.CLIPS_OUTPUT_DIR || '/home/jay/slippi-pipeline/clips-montage';
const OUTPUT_HTML = path.join(CLIPS_DIR, 'dashboard.html');

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function generateHTML(data) {
  const matchups = data.matchups || [];

  let html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Slippi Highlights Dashboard</title>
  <style>
    :root { --bg:#0f172a; --panel:#1e293b; --text:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --ok:#22c55e; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--text); padding:2rem; }
    h1 { margin:0 0 .5rem; font-size:1.5rem; }
    .subtitle { color:var(--muted); margin-bottom:2rem; }
    .filters { display:flex; gap:1rem; flex-wrap:wrap; margin-bottom:2rem; }
    .filters label { display:flex; flex-direction:column; gap:.25rem; color:var(--muted); font-size:.85rem; }
    .filters input, .filters select { padding:.5rem .75rem; border-radius:.5rem; border:1px solid #334155; background:#0b1220; color:var(--text); min-width:140px; }
    .matchup { background:var(--panel); border-radius:1rem; padding:1.25rem; margin-bottom:1.5rem; }
    .matchup h2 { margin:0 0 1rem; font-size:1.1rem; color:var(--accent); }
    table { width:100%; border-collapse:collapse; font-size:.9rem; }
    th, td { text-align:left; padding:.75rem; border-bottom:1px solid #334155; }
    th { color:var(--muted); font-weight:600; }
    tr:hover { background:#283548; }
    .tag { display:inline-block; padding:.15rem .5rem; border-radius:.25rem; background:#0b1220; font-size:.75rem; color:var(--muted); }
    .tag.kill { background:#14532d; color:#86efac; }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .empty { color:var(--muted); font-style:italic; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:1rem; margin-bottom:2rem; }
    .stat { background:var(--panel); padding:1rem; border-radius:.75rem; }
    .stat .value { font-size:1.5rem; font-weight:700; color:var(--accent); }
    .stat .label { color:var(--muted); font-size:.8rem; }
  </style>
</head>
<body>
  <h1>Slippi Highlights Dashboard</h1>
  <p class="subtitle">${data.totalReplays} replays analizados · generado ${new Date(data.generatedAt).toLocaleString('es-ES')}</p>

  <div class="stats">
    <div class="stat"><div class="value">${data.totalReplays}</div><div class="label">Replays</div></div>
    <div class="stat"><div class="value">${matchups.reduce((s,m)=>s+m.count,0)}</div><div class="label">Clips encontrados</div></div>
    <div class="stat"><div class="value">${matchups.filter(m=>m.count>0).length}</div><div class="label">Matchups con clips</div></div>
  </div>

  <div class="filters">
    <label>Min golpes <input type="number" id="minHits" value="4" min="1"></label>
    <label>Max golpes <input type="number" id="maxHits" value="99" min="1"></label>
    <label>Atacante <input type="text" id="attacker" placeholder="ej: HARD"></label>
    <label>Victima <input type="text" id="victim" placeholder="ej: DOLF"></label>
    <label>Matchup
      <select id="matchupSelect"><option value="">Todos</option>${matchups.map(m=>`<option value="${m.id}">${m.label}</option>`).join('')}</select>
    </label>
  </div>

  <div id="results"></div>

  <script>
    const data = ${JSON.stringify(data)};
    const CLIPS_DIR = ${JSON.stringify(CLIPS_DIR)};

    function parseHits(reason) {
      const m = reason.match(/\\((\\d+) golpes\\)/);
      return m ? parseInt(m[1],10) : 0;
    }

    function extractNames(reason) {
      const parts = reason.split(' mata a ');
      if (parts.length < 2) return { attacker: '', victim: '' };
      const attacker = parts[0];
      const victim = parts[1].split(' (')[0];
      return { attacker, victim };
    }

    function filter() {
      const minHits = parseInt(document.getElementById('minHits').value,10) || 0;
      const maxHits = parseInt(document.getElementById('maxHits').value,10) || 99;
      const attacker = document.getElementById('attacker').value.trim().toUpperCase();
      const victim = document.getElementById('victim').value.trim().toUpperCase();
      const matchupId = document.getElementById('matchupSelect').value;

      const container = document.getElementById('results');
      container.innerHTML = '';

      for (const m of data.matchups) {
        if (matchupId && m.id !== matchupId) continue;
        const allCandidates = data.allCandidates[m.id] || [];
        const filtered = allCandidates.filter(c => {
          const hits = parseHits(c.reason);
          const { attacker: a, victim: v } = extractNames(c.reason);
          if (hits < minHits || hits > maxHits) return false;
          if (attacker && !a.toUpperCase().includes(attacker)) return false;
          if (victim && !v.toUpperCase().includes(victim)) return false;
          return true;
        });

        const div = document.createElement('div');
        div.className = 'matchup';
        div.innerHTML = '<h2>' + m.label + ' <span class="tag">' + filtered.length + '/' + m.count + '</span></h2>' +
          (filtered.length === 0 ? '<p class="empty">Sin clips para estos filtros.</p>' :
          '<table><thead><tr><th>#</th><th>Reason</th><th>Golpes</th><th>Duracion</th><th>Archivo</th></tr></thead><tbody>' +
          filtered.map((c,i)=>{
            const hits = parseHits(c.reason);
            const dur = (c.endFrame - c.startFrame) / 60;
            const base = c.slpPath.split('/').pop().replace('.slp','');
            const videoFile = base + '_clip' + (i+1) + '.mp4';
            const videoPath = CLIPS_DIR + '/' + videoFile;
            return '<tr><td>' + (i+1) + '</td><td>' + c.reason + '</td><td>' + hits + '</td><td>' + formatDuration(dur) + '</td>' +
              '<td><a href="file://' + videoPath + '">' + videoFile + '</a></td></tr>';
          }).join('') +
          '</tbody></table>');
        container.appendChild(div);
      }
    }

    function formatDuration(s) {
      const m = Math.floor(s/60); const sec = Math.floor(s%60);
      return m + ':' + sec.toString().padStart(2,'0');
    }

    ['minHits','maxHits','attacker','victim','matchupSelect'].forEach(id =>
      document.getElementById(id).addEventListener('input', filter)
    );
    filter();
  <\/script>
</body>
</html>`;

  return html;
}

function main() {
  if (!fs.existsSync(BEST_CLIPS_FILE)) {
    console.error(`[dashboard] No existe ${BEST_CLIPS_FILE}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(BEST_CLIPS_FILE, 'utf8'));
  const html = generateHTML(data);
  fs.writeFileSync(OUTPUT_HTML, html);
  console.log(`[dashboard] Generado: ${OUTPUT_HTML}`);
}

main();
