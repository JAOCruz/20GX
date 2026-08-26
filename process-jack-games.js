// process-jack-games.js
// Renderiza todos los stocks de JIMY#831 vs JACK#778 de los ultimos 3 juegos,
// envia los clips por Telegram con metadata y los copia a la Mac.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SlippiGame, Character, Stage } = require('@slippi/slippi-js');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8988066588:AAGmnziOt1ATk9j8IseiAxHyyA50DCq-kgU';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6932565341';
const MAC_HOST = process.env.MAC_HOST || 'jay@100.69.130.90';
const MAC_KEY = process.env.MAC_KEY || '/home/jay/.ssh/id_ed25519_kimi_mac';
const MAC_DEST_BASE = '/Users/jay/Desktop/Slippi Clips';

const SSBM_ISO = process.env.SSBM_ISO_PATH || '/home/jay/slippi-pipeline/melee.iso';
const DOLPHIN = process.env.SLIPPI_DOLPHIN_PATH || '/home/jay/slippi-pipeline/playback-dolphin/Slippi_Playback-x86_64.AppImage';

const FPS = 60;
const SECONDS_PER_FRAME = 0.55; // estimado en jarvis basado en renders anteriores

const GAMES = [
  '/home/jay/slippi-pipeline/replays/jack/Game_20260711T183845.slp',
  '/home/jay/slippi-pipeline/replays/jack/Game_20260711T183610.slp',
  '/home/jay/slippi-pipeline/replays/jack/Game_20260711T183351.slp',
];

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function findStockKills(gamePath) {
  const game = new SlippiGame(gamePath);
  const settings = game.getSettings();
  const attacker = settings.players.find((p) => /JIMY#831/i.test(p.connectCode));
  const victim = settings.players.find((p) => /JACK#778/i.test(p.connectCode));
  if (!attacker || !victim) {
    console.warn(`[process-jack] No se encontraron jugadores esperados en ${gamePath}`);
    return { count: 0, attackerCharId: null, victimCharId: null };
  }

  const frames = game.getFrames();
  const events = [];
  let previousStocks = null;
  for (let f = -123; f <= 999999; f++) {
    const frame = frames[f];
    if (!frame || !frame.players || !frame.players[victim.playerIndex]) continue;
    const post = frame.players[victim.playerIndex].post;
    if (!post || typeof post.stocksRemaining !== 'number') continue;
    if (previousStocks !== null && post.stocksRemaining < previousStocks && post.lastHitBy === attacker.playerIndex) {
      events.push({ frame: f });
    }
    previousStocks = post.stocksRemaining;
  }
  return {
    count: events.length,
    attackerCharId: attacker.characterId,
    victimCharId: victim.characterId,
    stage: Stage[settings.stageId] || settings.stageId,
    durationSeconds: Math.round((game.getLatestFrame().frame + 123) / FPS),
  };
}

async function telegramRequest(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, ...body }),
  });
  const data = await res.json();
  if (!data.ok) console.error('[telegram] error:', data);
  return data;
}

function runStockClips(slpPath, attackerCharId, victimCharId, outputDir) {
  console.log(`\n[process-jack] Renderizando ${path.basename(slpPath)} -> ${outputDir}`);
  const result = spawnSync('node', [path.join(__dirname, 'stock-clips.js'), slpPath, String(attackerCharId), String(victimCharId)], {
    cwd: __dirname,
    env: { ...process.env, CLIPS_OUTPUT_DIR: outputDir, SSBM_ISO_PATH: SSBM_ISO, SLIPPI_DOLPHIN_PATH: DOLPHIN },
    stdio: 'inherit',
    timeout: 60 * 60 * 1000, // 1h por juego
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`stock-clips.js salio con codigo ${result.status}`);
}

function sendTelegramFolder(folderPath) {
  console.log(`\n[process-jack] Enviando ${folderPath} por Telegram`);
  const result = spawnSync('node', [path.join(__dirname, 'send-telegram.js'), folderPath], {
    cwd: __dirname,
    env: { ...process.env, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHAT_ID: CHAT_ID },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
}

function copyToMac(folderPath, label) {
  const macDest = `${MAC_DEST_BASE}/${label}`;
  console.log(`\n[process-jack] Copiando a Mac: ${macDest}`);
  const mkdir = spawnSync('ssh', ['-i', MAC_KEY, MAC_HOST, `mkdir -p '${macDest}'`], { stdio: 'inherit' });
  if (mkdir.error) throw mkdir.error;
  const copy = spawnSync('scp', ['-i', MAC_KEY, `${folderPath}/*.mp4`, `${MAC_HOST}:'${macDest}/'`], { stdio: 'inherit', shell: true });
  if (copy.error) throw copy.error;
}

function generateDashboardEntry(gamePath, info, outputDir) {
  const manifestPath = path.join(outputDir, 'stock-clips-manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  return {
    gamePath,
    fileName: path.basename(gamePath),
    label: `jack-${path.basename(gamePath, '.slp')}`,
    stage: info.stage,
    durationSeconds: info.durationSeconds,
    attacker: manifest.attacker,
    victim: manifest.victim,
    stockKills: manifest.stockKills,
    winner: manifest.winner,
    clips: manifest.clips.map((c) => ({ id: c.id, file: c.file, stockTimeSeconds: c.stockTimeSeconds })),
    combined: manifest.combined,
  };
}

async function main() {
  const gameInfos = GAMES.map((p) => ({ path: p, ...findStockKills(p) }));
  const totalStocks = gameInfos.reduce((sum, g) => sum + g.count, 0);
  const estimatedSeconds = Math.round(totalStocks * 661 * SECONDS_PER_FRAME);

  console.log('[process-jack] Juegos encontrados:');
  for (const g of gameInfos) {
    console.log(`  ${path.basename(g.path)}: ${g.count} stocks | ${g.stage} | ${formatTime(g.durationSeconds)}`);
  }
  console.log(`\n[process-jack] Total stocks a renderizar: ${totalStocks}`);
  console.log(`[process-jack] Tiempo estimado: ~${formatTime(estimatedSeconds)}`);

  // Mensaje de inicio
  await telegramRequest('sendMessage', {
    text: `🥊 Renderizando kills de JIMY#831 vs JACK#778\n🎮 ${GAMES.length} juegos · 💥 ${totalStocks} stocks\n⏱️ Estimado: ~${formatTime(estimatedSeconds)} en el servidor.`,
  });

  const dashboardEntries = [];

  for (const g of gameInfos) {
    if (g.count === 0) continue;
    const label = `jack-${path.basename(g.path, '.slp')}`;
    const outputDir = path.join(__dirname, 'clips-auto', label);
    runStockClips(g.path, g.attackerCharId, g.victimCharId, outputDir);
    sendTelegramFolder(outputDir);
    copyToMac(outputDir, label);
    const entry = generateDashboardEntry(g.path, g, outputDir);
    if (entry) dashboardEntries.push(entry);
  }

  // Guardar dashboard JSON
  const dashboardDir = path.join(__dirname, 'dashboard');
  if (!fs.existsSync(dashboardDir)) fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'jack-games.json'), JSON.stringify({ generatedAt: new Date().toISOString(), games: dashboardEntries }, null, 2));

  // Mensaje final
  await telegramRequest('sendMessage', { text: `✅ Listo. ${totalStocks} kills de JIMY#831 vs JACK#778 enviados y copiados a tu Mac.` });
  console.log('\n[process-jack] Proceso completo.');
}

main().catch((err) => {
  console.error('[process-jack] Error:', err);
  process.exit(1);
});
