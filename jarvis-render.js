// jarvis-render.js
// Renderiza stocks seleccionados usando Jarvis como worker. Copia el .slp si
// hace falta, corre render-selected-stocks.js en Jarvis y envia los clips por
// Telegram directamente desde Jarvis. No copia videos a la Mac para no usar
// ancho de banda de la conexion domestica.
//
// Uso:
//   node jarvis-render.js <slpPath> --attacker-index N --victim-index M --indices 0,2 \
//     [--mix-discord] [--discord-delay 0.5] [--telegram]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectStocks } = require('./detect-stocks');

const DEFAULT_LEAD_SECONDS = Number(process.env.PADDING_BEFORE || '7');
const DEFAULT_PAD_AFTER_SECONDS = Number(process.env.PADDING_AFTER || '2');

const JARVIS_HOST = process.env.JARVIS_HOST || 'jarvis';
const JARVIS_USER = process.env.JARVIS_USER || 'jay';
const JARVIS_SSH_KEY = process.env.JARVIS_SSH_KEY || '/Users/jay/.ssh/id_ed25519_server';
const JARVIS_REMOTE_DIR = process.env.JARVIS_REMOTE_DIR || '/home/jay/slippi-pipeline';

function log(...args) {
  console.error('[jarvis-render]', ...args);
}

function ssh(args, options = {}) {
  const fullArgs = ['-i', JARVIS_SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${JARVIS_USER}@${JARVIS_HOST}`, ...args];
  return execFileSync('ssh', fullArgs, { encoding: 'utf-8', ...options });
}

function scp(localPath, remotePath, options = {}) {
  const args = ['-i', JARVIS_SSH_KEY, '-o', 'BatchMode=yes', '-r', localPath, `${JARVIS_USER}@${JARVIS_HOST}:${remotePath}`];
  return execFileSync('scp', args, { encoding: 'utf-8', ...options });
}

function mapMacPathToJarvis(macPath) {
  // /Users/jay/Slippi/YYYY-MM/Game_...slp -> /home/jay/slippi-live/YYYY-MM/Game_...slp
  return macPath.replace(/^\/Users\/jay\/Slippi\//, '/home/jay/slippi-live/');
}

function ensureSlpOnJarvis(macSlpPath) {
  const jarvisPath = mapMacPathToJarvis(macSlpPath);
  try {
    const check = ssh([`test -f '${jarvisPath}' && echo yes || echo no`]).trim();
    if (check === 'yes') {
      log('SLP ya existe en Jarvis:', jarvisPath);
      return jarvisPath;
    }
  } catch (e) {
    // continuar a copiar
  }

  const remoteDir = path.posix.dirname(jarvisPath);
  ssh([`mkdir -p '${remoteDir}'`]);
  scp(macSlpPath, jarvisPath);
  log('SLP copiado a Jarvis:', jarvisPath);
  return jarvisPath;
}

function runRenderOnJarvis(jarvisSlpPath, attackerIndex, victimIndex, selectedIndices, outputDir, mixDiscord) {
  const indicesArg = selectedIndices.join(' ');
  const slpVideoBin = `${JARVIS_REMOTE_DIR}/slp-to-video/bin/run.js`;
  const envVars = [
    `CLIPS_OUTPUT_DIR='${outputDir}'`,
    `PADDING_BEFORE='${DEFAULT_LEAD_SECONDS}'`,
    `PADDING_AFTER='${DEFAULT_PAD_AFTER_SECONDS}'`,
    `SLP_TO_VIDEO_BIN='${slpVideoBin}'`,
  ];
  if (mixDiscord) envVars.push(`MIX_DISCORD_AUDIO='1'`);
  const cmd = `export ${envVars.join(' ')} && cd '${JARVIS_REMOTE_DIR}' && node render-selected-stocks.js '${jarvisSlpPath}' --attacker-index ${attackerIndex} --victim-index ${victimIndex} ${indicesArg}`;
  log('Ejecutando en Jarvis:', cmd);
  const stdout = ssh([cmd], { stdio: ['ignore', 'pipe', 'inherit'] });
  log('Jarvis stdout:', stdout);
  return stdout;
}

function sendClipsViaTelegram(jarvisOutputDir) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  const envVars = [];
  if (botToken) envVars.push(`TELEGRAM_BOT_TOKEN='${botToken}'`);
  if (chatId) envVars.push(`TELEGRAM_CHAT_ID='${chatId}'`);
  const envPrefix = envVars.length > 0 ? `export ${envVars.join(' ')} && ` : '';
  const cmd = `cd '${JARVIS_REMOTE_DIR}' && ${envPrefix}node send-telegram.js '${jarvisOutputDir}'`;
  log('Enviando clips por Telegram desde Jarvis:', cmd.replace(botToken, '***'));
  const stdout = ssh([cmd], { stdio: ['ignore', 'pipe', 'inherit'] });
  log('Telegram stdout:', stdout);
  return stdout;
}

function listJarvisFiles(jarvisOutputDir) {
  const stdout = ssh([`ls -1 '${jarvisOutputDir}' 2>/dev/null || echo ''`]);
  return stdout.split('\n').filter(Boolean);
}

function getEventsForDirection(stocksData, attackerIndex, victimIndex) {
  if (stocksData.playerA.playerIndex === attackerIndex && stocksData.playerB.playerIndex === victimIndex) {
    return stocksData.stocksAtoB;
  }
  if (stocksData.playerB.playerIndex === attackerIndex && stocksData.playerA.playerIndex === victimIndex) {
    return stocksData.stocksBtoA;
  }
  return [];
}

async function renderSelectedStocksOnJarvis(macSlpPath, attackerIndex, victimIndex, selectedIndices, options = {}) {
  const baseName = path.basename(macSlpPath, '.slp');
  const jarvisOutputDir = `/home/jay/slippi-pipeline/clips-mac-dashboard/${baseName}`;

  const jarvisSlpPath = ensureSlpOnJarvis(macSlpPath);
  runRenderOnJarvis(jarvisSlpPath, attackerIndex, victimIndex, selectedIndices, jarvisOutputDir, options.mixDiscord);

  const stocksData = detectStocks(macSlpPath, attackerIndex, victimIndex);
  const events = getEventsForDirection(stocksData, attackerIndex, victimIndex);

  const renderedFiles = [];
  for (const idx of selectedIndices) {
    const ev = events[idx];
    if (!ev) continue;
    renderedFiles.push(`${jarvisOutputDir}/${baseName}_stock${idx + 1}.mp4`);
  }

  const combinedFile = `${jarvisOutputDir}/${baseName}_selected-stocks.mp4`;

  let telegramOutput = null;
  if (options.sendTelegram !== false) {
    try {
      telegramOutput = sendClipsViaTelegram(jarvisOutputDir);
    } catch (e) {
      log('Error enviando por Telegram:', e.message);
    }
  }

  const remoteFiles = listJarvisFiles(jarvisOutputDir);

  return {
    slpPath: macSlpPath,
    attackerIndex,
    victimIndex,
    clips: renderedFiles.map((f) => ({ file: f, fileName: path.basename(f) })),
    combined: remoteFiles.includes(`${baseName}_selected-stocks.mp4`) ? combinedFile : null,
    telegramOutput,
    remoteFiles,
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const slpPath = args.find((a) => a.endsWith('.slp'));
  const getFlag = (flag, next = true) => {
    const i = args.indexOf(flag);
    if (i >= 0 && i + 1 < args.length) return next ? args[i + 1] : true;
    return next ? undefined : false;
  };

  const attackerIndex = getFlag('--attacker-index');
  const victimIndex = getFlag('--victim-index');
  const indicesRaw = getFlag('--indices') || '';
  const mixDiscord = args.includes('--mix-discord');
  const sendTelegram = args.includes('--telegram');
  const discordDelaySeconds = parseFloat(getFlag('--discord-delay') || '0');
  const leadSeconds = parseFloat(getFlag('--lead') || String(DEFAULT_LEAD_SECONDS));
  const padAfterSeconds = parseFloat(getFlag('--pad-after') || String(DEFAULT_PAD_AFTER_SECONDS));

  const selectedIndices = indicesRaw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));

  return {
    slpPath,
    attackerIndex: attackerIndex !== undefined ? parseInt(attackerIndex, 10) : undefined,
    victimIndex: victimIndex !== undefined ? parseInt(victimIndex, 10) : undefined,
    selectedIndices,
    mixDiscord,
    sendTelegram,
    discordDelaySeconds,
    leadSeconds,
    padAfterSeconds,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.slpPath) {
    console.error('Uso: node jarvis-render.js <slpPath> --attacker-index N --victim-index M --indices 0,2 [--mix-discord] [--telegram]');
    process.exit(1);
  }
  if (opts.attackerIndex === undefined || opts.victimIndex === undefined) {
    console.error('Faltan --attacker-index y --victim-index');
    process.exit(1);
  }
  if (opts.selectedIndices.length === 0) {
    console.error('Faltan --indices');
    process.exit(1);
  }

  try {
    const result = await renderSelectedStocksOnJarvis(opts.slpPath, opts.attackerIndex, opts.victimIndex, opts.selectedIndices, {
      mixDiscord: opts.mixDiscord,
      sendTelegram: opts.sendTelegram,
      discordDelaySeconds: opts.discordDelaySeconds,
      leadSeconds: opts.leadSeconds,
      padAfterSeconds: opts.padAfterSeconds,
    });
    console.log(JSON.stringify({ success: true, ...result }));
  } catch (err) {
    console.error(err.message);
    console.log(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

module.exports = { renderSelectedStocksOnJarvis };

if (require.main === module) {
  main();
}
