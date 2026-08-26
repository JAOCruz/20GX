// process-single-game.js
// Procesa un solo .slp: detecta stocks, renderiza clips, opcionalmente envia
// Telegram y copia a Mac. Actualiza dashboard/{label}-games.json.
//
// Uso:
//   node process-single-game.js <replay.slp> [--attacker CODE] [--victim CODE]
//     [--telegram] [--copy-to-mac] [--padding-before N] [--padding-after N]

require('dotenv').config();
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

function parseArgs() {
  const args = process.argv.slice(2);
  const slpPath = args.find((a) => a.endsWith('.slp'));
  const getNext = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  return {
    slpPath,
    attackerCode: getNext('--attacker'),
    victimCode: getNext('--victim'),
    paddingBefore: Number(getNext('--padding-before') || '0'),
    paddingAfter: Number(getNext('--padding-after') || '0'),
    sendTelegram: args.includes('--telegram'),
    copyToMac: args.includes('--copy-to-mac'),
    mixDiscord: args.includes('--mix-discord') || process.env.MIX_DISCORD_AUDIO === '1',
    requireDiscordAudio: args.includes('--require-discord-audio') || process.env.REQUIRE_DISCORD_AUDIO === '1',
  };
}

function getCharacterName(id) {
  const name = Character[id];
  return typeof name === 'string' ? name : `Char ${id}`;
}

function findPlayers(settings, attackerCode, victimCode) {
  let attacker = null;
  let victim = null;

  if (attackerCode) {
    attacker = settings.players.find((p) => new RegExp(attackerCode.replace(/#/g, ''), 'i').test(p.connectCode?.replace(/#/g, '')));
  }
  if (victimCode) {
    victim = settings.players.find((p) => new RegExp(victimCode.replace(/#/g, ''), 'i').test(p.connectCode?.replace(/#/g, '')));
  }

  if (!attacker && !victim) {
    // Si no se especifica, usar HARD/JIMY como atacante si existe
    const main = settings.players.find((p) => /HARD|JIMY/i.test(p.connectCode));
    if (main) {
      attacker = main;
      victim = settings.players.find((p) => p.playerIndex !== main.playerIndex);
    }
  }

  if (!attacker || !victim) return null;
  return { attacker, victim };
}

function findStockKills(gamePath, attacker, victim) {
  const game = new SlippiGame(gamePath);
  const frames = game.getFrames();
  const events = [];
  let previousStocks = null;

  for (let f = -123; f <= 999999; f++) {
    const frame = frames[f];
    if (!frame || !frame.players || !frame.players[victim.playerIndex]) continue;
    const post = frame.players[victim.playerIndex].post;
    if (!post || typeof post.stocksRemaining !== 'number') continue;
    if (previousStocks !== null && post.stocksRemaining < previousStocks && post.lastHitBy === attacker.playerIndex) {
      events.push({ frame: f, stocksRemaining: post.stocksRemaining });
    }
    previousStocks = post.stocksRemaining;
  }
  return events;
}

function runStockClips(slpPath, attackerCharId, victimCharId, outputDir, paddingBefore, paddingAfter, mixDiscord, requireDiscordAudio) {
  console.log(`[process-single] Renderizando ${path.basename(slpPath)} -> ${outputDir}`);
  const env = {
    ...process.env,
    CLIPS_OUTPUT_DIR: outputDir,
    SSBM_ISO_PATH: SSBM_ISO,
    SLIPPI_DOLPHIN_PATH: DOLPHIN,
    MIX_DISCORD_AUDIO: mixDiscord ? '1' : '0',
  };
  if (paddingBefore) env.PADDING_BEFORE = String(paddingBefore);
  if (paddingAfter) env.PADDING_AFTER = String(paddingAfter);
  if (mixDiscord) env.MIX_DISCORD_AUDIO = '1';
  if (requireDiscordAudio) env.REQUIRE_DISCORD_AUDIO = '1';

  const result = spawnSync('node', [path.join(__dirname, 'stock-clips.js'), slpPath, String(attackerCharId), String(victimCharId)], {
    cwd: __dirname,
    env,
    stdio: 'inherit',
    timeout: 60 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`stock-clips.js salio con codigo ${result.status}`);
}

function sendTelegramFolder(folderPath) {
  console.log(`[process-single] Enviando ${folderPath} por Telegram`);
  const result = spawnSync('node', [path.join(__dirname, 'send-telegram.js'), folderPath], {
    cwd: __dirname,
    env: { ...process.env, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHAT_ID: CHAT_ID },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
}

function copyToMac(folderPath, label) {
  const macDest = `${MAC_DEST_BASE}/${label}`;
  console.log(`[process-single] Copiando a Mac: ${macDest}`);
  const mkdir = spawnSync('ssh', ['-i', MAC_KEY, MAC_HOST, `mkdir -p '${macDest}'`], { stdio: 'inherit' });
  if (mkdir.error) throw mkdir.error;
  const copy = spawnSync('scp', ['-i', MAC_KEY, `${folderPath}/*.mp4`, `${MAC_HOST}:'${macDest}/'`], { stdio: 'inherit', shell: true });
  if (copy.error) throw copy.error;
}

function determineWinner(game, attacker, victim) {
  const latest = game.getLatestFrame();
  if (!latest || !latest.players) return null;
  const aPost = latest.players[attacker.playerIndex]?.post;
  const vPost = latest.players[victim.playerIndex]?.post;
  if (!aPost || !vPost) return null;
  if (aPost.stocksRemaining > vPost.stocksRemaining) return attacker.connectCode;
  if (vPost.stocksRemaining > aPost.stocksRemaining) return victim.connectCode;
  return null;
}

function generateDashboardEntry(gamePath, info, outputDir) {
  const manifestPath = path.join(outputDir, 'stock-clips-manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  return {
    gamePath,
    fileName: path.basename(gamePath),
    label: info.label,
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

function saveDashboardEntry(entry, outputDir) {
  const dashboardDir = path.join(__dirname, 'dashboard');
  if (!fs.existsSync(dashboardDir)) fs.mkdirSync(dashboardDir, { recursive: true });

  const relativeOutputDir = path.basename(outputDir);
  const dashboardGame = {
    fileName: entry.fileName,
    filePath: entry.gamePath,
    label: entry.label,
    outputDir: relativeOutputDir,
    stage: entry.stage,
    durationSeconds: entry.durationSeconds,
    attacker: entry.attacker,
    victim: entry.victim,
    winner: entry.winner,
    stockKills: entry.stockKills,
    date: new Date().toISOString(),
    stocks: (entry.clips || []).map((c) => ({
      index: parseInt(c.id.replace(/\D/g, ''), 10) || 0,
      path: `/clips-auto/${relativeOutputDir}/${c.file}`,
      direction: 'main',
    })),
    combinedPath: entry.combined ? `/clips-auto/${relativeOutputDir}/${entry.combined}` : undefined,
  };

  const file = path.join(dashboardDir, `${entry.label}-games.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), games: [dashboardGame] }, null, 2));
}

async function main() {
  const opts = parseArgs();
  if (!opts.slpPath) {
    console.error('Uso: node process-single-game.js <replay.slp> [opciones]');
    process.exit(1);
  }

  const game = new SlippiGame(opts.slpPath);
  const settings = game.getSettings();
  const players = findPlayers(settings, opts.attackerCode, opts.victimCode);
  if (!players) {
    console.error('[process-single] No se pudo determinar atacante/víctima');
    process.exit(1);
  }

  const { attacker, victim } = players;
  const stockKills = findStockKills(opts.slpPath, attacker, victim);
  if (stockKills.length === 0) {
    console.log('[process-single] No se encontraron stocks para renderizar.');
    return;
  }

  const latest = game.getLatestFrame();
  const durationSeconds = latest && typeof latest.frame === 'number' ? Math.round((latest.frame + 123) / FPS) : 0;
  const stageName = Stage[settings.stageId] || `Stage ${settings.stageId}`;
  const label = `${path.basename(opts.slpPath, '.slp')}`;
  const outputDir = path.join(__dirname, 'clips-auto', label);

  console.log(`[process-single] ${attacker.connectCode} (${getCharacterName(attacker.characterId)}) vs ${victim.connectCode} (${getCharacterName(victim.characterId)})`);
  console.log(`[process-single] Stage: ${stageName} | Stocks: ${stockKills.length} | Duración: ${durationSeconds}s`);

  runStockClips(opts.slpPath, attacker.characterId, victim.characterId, outputDir, opts.paddingBefore, opts.paddingAfter, opts.mixDiscord, opts.requireDiscordAudio);

  if (opts.sendTelegram) sendTelegramFolder(outputDir);
  if (opts.copyToMac) copyToMac(outputDir, label);

  const winner = determineWinner(game, attacker, victim);
  const entry = generateDashboardEntry(opts.slpPath, {
    label,
    stage: stageName,
    durationSeconds,
  }, outputDir);

  if (entry) {
    entry.winner = winner;
    saveDashboardEntry(entry, outputDir);
  }

  console.log('[process-single] Listo.');
}

main().catch((err) => {
  console.error('[process-single] Error:', err);
  process.exit(1);
});
