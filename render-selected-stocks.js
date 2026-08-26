// render-selected-stocks.js
// Renderiza solo los stocks seleccionados de un replay.
//
// Uso:
//   CLIPS_OUTPUT_DIR=/ruta/out node render-selected-stocks.js <slpPath> <attackerCharId> <victimCharId> <stockIndex1> ...
//   CLIPS_OUTPUT_DIR=/ruta/out node render-selected-stocks.js <slpPath> --attacker-index N --victim-index M <stockIndex1> ...

const fs = require('fs');
const path = require('path');
const { SlippiGame, Character, Stage } = require('@slippi/slippi-js');
const { cutClip } = require('./cut-clips');
const { execFileSync } = require('child_process');
const { mixDiscordAudioForClip } = require('./discord-audio-sync');

const FPS = 60;
const DEFAULT_LEAD_SECONDS = Number(process.env.PADDING_BEFORE || '7');
const DEFAULT_PAD_AFTER_SECONDS = Number(process.env.PADDING_AFTER || '2');
const MIX_DISCORD = process.env.MIX_DISCORD_AUDIO === '1';
const DISCORD_AUDIO_OFFSET = Number(process.env.DISCORD_AUDIO_OFFSET || '0');
const QUALITY = {
  resolution: process.env.RENDER_RESOLUTION || undefined,
  bitrate: process.env.RENDER_BITRATE ? Number(process.env.RENDER_BITRATE) : undefined,
  widescreen: process.env.RENDER_WIDESCREEN === '1',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const slpPath = args.find((a) => a.endsWith('.slp'));

  const takeFlag = (flag) => {
    const i = args.indexOf(flag);
    if (i >= 0 && i + 1 < args.length) {
      const value = parseInt(args[i + 1], 10);
      return { value, consumed: [i, i + 1] };
    }
    return { value: undefined, consumed: [] };
  };

  const attackerFlag = takeFlag('--attacker-index');
  const victimFlag = takeFlag('--victim-index');
  const consumed = new Set([...attackerFlag.consumed, ...victimFlag.consumed]);

  // Todo argumento que no sea flag, ni valor de flag, ni el slpPath es un índice de stock
  const positional = args
    .map((a, i) => ({ a, i }))
    .filter(({ a, i }) => !a.startsWith('--') && !consumed.has(i) && a !== slpPath)
    .map(({ a }) => parseInt(a, 10))
    .filter((n) => !isNaN(n));

  if (attackerFlag.value !== undefined && victimFlag.value !== undefined) {
    return { slpPath, attackerIndex: attackerFlag.value, victimIndex: victimFlag.value, attackerCharId: NaN, victimCharId: NaN, selectedIndices: positional };
  }

  const attackerCharId = positional[0];
  const victimCharId = positional[1];
  const selectedIndices = positional.slice(2);
  return { slpPath, attackerIndex: attackerFlag.value, victimIndex: victimFlag.value, attackerCharId, victimCharId, selectedIndices };
}

const opts = parseArgs();
const outputDir = process.env.CLIPS_OUTPUT_DIR || path.join(__dirname, 'clips-stocks');

if (!opts.slpPath) {
  console.error('Uso: node render-selected-stocks.js <slpPath> (<attackerCharId> <victimCharId> | --attacker-index N --victim-index M) <stockIndex>...');
  process.exit(1);
}

if ((isNaN(opts.attackerCharId) || isNaN(opts.victimCharId)) && (opts.attackerIndex === undefined || opts.victimIndex === undefined)) {
  console.error('Debes indicar attackerCharId+victimCharId o --attacker-index + --victim-index');
  process.exit(1);
}

if (opts.selectedIndices.length === 0) {
  console.error('Debes indicar al menos un stockIndex');
  process.exit(1);
}

function ensureDir() {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
}

function detectStocks(game, attackerIndex, victimIndex) {
  const frames = game.getFrames();
  const events = [];
  let previousStocks = null;
  for (let f = -123; f <= 999999; f++) {
    const frame = frames[f];
    if (!frame || !frame.players || !frame.players[victimIndex]) continue;
    const post = frame.players[victimIndex].post;
    if (!post || typeof post.stocksRemaining !== 'number') continue;
    if (previousStocks !== null && post.stocksRemaining < previousStocks && post.lastHitBy === attackerIndex) {
      events.push({ frame: f, stocksRemaining: post.stocksRemaining });
    }
    previousStocks = post.stocksRemaining;
  }
  return events;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function combineClips(files, outputFile) {
  const listFile = path.join(outputDir, 'concat-selected.txt');
  fs.writeFileSync(listFile, files.map((f) => `file '${path.resolve(f)}'`).join('\n'));
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-stats', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outputFile,
  ], { stdio: 'inherit' });
}

function main() {
  ensureDir();
  const game = new SlippiGame(opts.slpPath);
  const settings = game.getSettings();
  const players = settings.players;

  let attacker, victim;
  if (opts.attackerIndex !== undefined && opts.victimIndex !== undefined) {
    attacker = players.find((p) => p.playerIndex === opts.attackerIndex);
    victim = players.find((p) => p.playerIndex === opts.victimIndex);
  } else {
    attacker = players.find((p) => p.characterId === opts.attackerCharId);
    victim = players.find((p) => p.characterId === opts.victimCharId);
  }

  if (!attacker || !victim) {
    console.error('Jugadores no encontrados');
    process.exit(1);
  }

  const events = detectStocks(game, attacker.playerIndex, victim.playerIndex);
  const selectedEvents = opts.selectedIndices
    .map((idx) => events[idx])
    .filter(Boolean);

  if (selectedEvents.length === 0) {
    console.log('No hay stocks seleccionados para renderizar.');
    return;
  }

  const startFrame = settings.startFrame ?? -123;
  const lastFrame = settings.lastFrame ?? game.getLatestFrame().frame ?? 999999;
  const leadFrames = Math.round(DEFAULT_LEAD_SECONDS * FPS);
  const padAfterFrames = Math.round(DEFAULT_PAD_AFTER_SECONDS * FPS);

  const renderedFiles = [];
  for (let i = 0; i < selectedEvents.length; i++) {
    const ev = selectedEvents[i];
    const originalIdx = opts.selectedIndices[i];
    const clipStart = Math.max(startFrame, ev.frame - leadFrames);
    const clipEnd = Math.min(lastFrame, ev.frame + padAfterFrames);
    const clipName = `${path.basename(opts.slpPath, '.slp')}_stock${originalIdx + 1}`;
    const outputFile = path.join(outputDir, `${clipName}.mp4`);

    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0) {
      console.log(`[render-selected] Stock ${originalIdx + 1}: ya existe, saltando.`);
      renderedFiles.push(outputFile);
      continue;
    }

    console.log(`[render-selected] Stock ${originalIdx + 1}: frame ${ev.frame} (${formatTime(ev.frame / 60)})`);
    let file = cutClip(opts.slpPath, {
      startFrame: clipStart,
      endFrame: clipEnd,
      reason: `${attacker.connectCode || attacker.displayName} mata stock ${originalIdx + 1}`,
    }, clipName, QUALITY);

    if (MIX_DISCORD) {
      const mixedOutput = file.replace('.mp4', '_mixed.mp4');
      const result = mixDiscordAudioForClip(opts.slpPath, ev.frame, file, mixedOutput, DEFAULT_LEAD_SECONDS, DISCORD_AUDIO_OFFSET);
      if (result.used) {
        console.log(`[render-selected] Stock ${originalIdx + 1}: audio de Discord mezclado (offset ${DISCORD_AUDIO_OFFSET}s)`);
        fs.renameSync(mixedOutput, file);
      } else {
        console.log(`[render-selected] Stock ${originalIdx + 1}: sin audio de Discord (${result.reason})`);
      }
    }

    renderedFiles.push(file);
  }

  // Combinar seleccionados
  const combinedOutput = path.join(outputDir, `${path.basename(opts.slpPath, '.slp')}_selected-stocks.mp4`);
  if (fs.existsSync(combinedOutput) && fs.statSync(combinedOutput).size > 0) {
    console.log('[render-selected] Combinado ya existe, saltando.');
  } else {
    console.log('[render-selected] Combinando clips seleccionados...');
    combineClips(renderedFiles, combinedOutput);
  }

  const gameEnd = game.getGameEnd();
  const winner = players.find((p) => p.playerIndex === gameEnd?.placements?.find((pl) => pl.position === 0)?.playerIndex);
  const latest = game.getLatestFrame();
  const durationSeconds = Math.round(((latest?.frame ?? lastFrame) + 123) / FPS);

  const manifest = {
    generatedAt: new Date().toISOString(),
    slpPath: opts.slpPath,
    stage: Stage[settings.stageId] || settings.stageId,
    durationSeconds,
    winner: winner ? (winner.connectCode || winner.displayName) : 'desconocido',
    attacker: {
      charId: attacker.characterId,
      charName: Character[attacker.characterId] || attacker.characterId,
      name: attacker.connectCode || attacker.displayName,
    },
    victim: {
      charId: victim.characterId,
      charName: Character[victim.characterId] || victim.characterId,
      name: victim.connectCode || victim.displayName,
    },
    stockKills: events.length,
    selectedStocks: opts.selectedIndices,
    clips: renderedFiles.map((f, i) => ({
      id: `stock${opts.selectedIndices[i] + 1}`,
      file: path.basename(f),
      stockFrame: selectedEvents[i].frame,
      stockTimeSeconds: Math.round((selectedEvents[i].frame + 123) / FPS),
    })),
    combined: path.basename(combinedOutput),
  };
  fs.writeFileSync(path.join(outputDir, 'selected-stocks-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[render-selected] Listo. ${renderedFiles.length} clip(s) + combinado.`);
}

main();
