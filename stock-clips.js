// stock-clips.js
// Extrae clips de cada stock que un atacante (por personaje) mato a una victima
// (por personaje). Util para "saca un clip de cada stock que Jigglypuff mato a Young Link".
//
// Uso:
//   CLIPS_OUTPUT_DIR=/home/jay/slippi-pipeline/clips-stocks \
//   node stock-clips.js <slpPath> <attackerCharId> <victimCharId>
//
// Ejemplo Jigglypuff (15) vs Young Link (23):
//   node stock-clips.js /ruta/Game_20260711T162744.slp 15 23

const fs = require('fs');
const path = require('path');
const { SlippiGame, Character, Stage, moves: Moves } = require('@slippi/slippi-js');
const { cutClip } = require('./cut-clips');
const { execFileSync } = require('child_process');
const { mixDiscordAudioForClip } = require('./discord-audio-sync');

const FPS = 60;
const DEFAULT_LEAD_SECONDS = Number(process.env.PADDING_BEFORE || '7'); // segundos antes del stock loss
const DEFAULT_PAD_AFTER_SECONDS = Number(process.env.PADDING_AFTER || '2'); // segundos despues
const MIX_DISCORD = process.env.MIX_DISCORD_AUDIO === '1';
const REQUIRE_DISCORD_AUDIO = process.env.REQUIRE_DISCORD_AUDIO === '1';
const DISCORD_AUDIO_OFFSET = Number(process.env.DISCORD_AUDIO_OFFSET || '0');
const QUALITY = {
  resolution: process.env.RENDER_RESOLUTION || undefined,
  bitrate: process.env.RENDER_BITRATE ? Number(process.env.RENDER_BITRATE) : undefined,
  widescreen: process.env.RENDER_WIDESCREEN === '1',
};

const slpPath = process.argv[2];
const attackerCharId = parseInt(process.argv[3], 10);
const victimCharId = parseInt(process.argv[4], 10);
const outputDir = process.env.CLIPS_OUTPUT_DIR || path.join(__dirname, 'clips-stocks');

if (!slpPath || isNaN(attackerCharId) || isNaN(victimCharId)) {
  console.error('Uso: node stock-clips.js <slpPath> <attackerCharId> <victimCharId>');
  console.error('  Jigglypuff=15, YoungLink=23, Link=2, Marth=8, etc.');
  process.exit(1);
}

function ensureDir() {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
}

function findStockLossEvents(game, attackerIndex, victimIndex) {
  const frames = game.getFrames();
  const events = [];
  let previousStocks = null;

  for (let f = -123; f <= 999999; f++) {
    const frame = frames[f];
    if (!frame || !frame.players || !frame.players[victimIndex]) continue;
    const post = frame.players[victimIndex].post;
    if (!post || typeof post.stocksRemaining !== 'number') continue;

    if (previousStocks !== null && post.stocksRemaining < previousStocks) {
      const lastHitBy = post.lastHitBy;
      if (lastHitBy === attackerIndex) {
        events.push({ frame: f, stocksRemaining: post.stocksRemaining });
      }
    }
    previousStocks = post.stocksRemaining;
  }
  return events;
}

function getMoveName(moveId) {
  try {
    return Moves.getMoveShortName(moveId) || Moves.getMoveName(moveId) || `Move ${moveId}`;
  } catch (e) {
    return `Move ${moveId}`;
  }
}

function enrichEventsWithComboData(game, events, attackerIndex, victimIndex) {
  const stats = game.getStats();
  const combos = (stats && stats.combos) || [];

  return events.map((ev) => {
    // Buscar el combo que termina en este stock loss (didKill y endFrame cercano)
    const matchingCombo = combos.find((c) => {
      const isVictim = c.playerIndex === victimIndex;
      const isAttacker = c.lastHitBy === attackerIndex;
      const killFrame = c.didKill && Math.abs(c.endFrame - ev.frame) <= 5;
      return isVictim && isAttacker && killFrame;
    });

    const lastMove = matchingCombo?.moves?.[matchingCombo.moves.length - 1];
    const victimFrame = game.getFrames()[ev.frame];
    const victimPost = victimFrame?.players?.[victimIndex]?.post;

    return {
      ...ev,
      comboStartPercent: matchingCombo?.startPercent ?? null,
      comboEndPercent: matchingCombo?.endPercent ?? null,
      comboDamage: matchingCombo ? (matchingCombo.endPercent - matchingCombo.startPercent) : null,
      comboHits: matchingCombo?.moves?.length ?? null,
      killMoveId: lastMove?.moveId ?? null,
      killMoveName: lastMove ? getMoveName(lastMove.moveId) : 'desconocido',
      killMoveDamage: lastMove?.damage ?? null,
      killPercent: victimPost?.percent ?? matchingCombo?.endPercent ?? null,
    };
  });
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function combineClips(files, outputFile) {
  const listFile = path.join(outputDir, 'concat-stocks.txt');
  fs.writeFileSync(
    listFile,
    files.map((f) => `file '${path.resolve(f)}'`).join('\n')
  );
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    outputFile,
  ], { stdio: 'inherit' });
}

function main() {
  ensureDir();

  const game = new SlippiGame(slpPath);
  const settings = game.getSettings();
  const players = settings.players;

  const attacker = players.find((p) => p.characterId === attackerCharId);
  const victim = players.find((p) => p.characterId === victimCharId);

  if (!attacker || !victim) {
    console.error(`No se encontraron los personajes solicitados en ${slpPath}`);
    console.error('Personajes en el replay:', players.map((p) => ({ idx: p.playerIndex, char: p.characterId, name: p.connectCode || p.displayName })));
    process.exit(1);
  }

  console.log(`Atacante: ${attacker.connectCode || attacker.displayName} (char ${attackerCharId})`);
  console.log(`Victima:  ${victim.connectCode || victim.displayName} (char ${victimCharId})`);

  const rawEvents = findStockLossEvents(game, attacker.playerIndex, victim.playerIndex);
  const events = enrichEventsWithComboData(game, rawEvents, attacker.playerIndex, victim.playerIndex);
  console.log(`\nStocks perdidos por ${victim.connectCode || victim.displayName} a manos de ${attacker.connectCode || attacker.displayName}: ${events.length}`);

  if (events.length === 0) {
    console.log('No hay clips para generar.');
    return;
  }

  const leadFrames = Math.round(DEFAULT_LEAD_SECONDS * FPS);
  const padAfterFrames = Math.round(DEFAULT_PAD_AFTER_SECONDS * FPS);
  const startFrame = settings.startFrame ?? -123;
  const lastFrame = settings.lastFrame ?? game.getLatestFrame().frame ?? 999999;

  const renderedFiles = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const clipStart = Math.max(startFrame, ev.frame - leadFrames);
    const clipEnd = Math.min(lastFrame, ev.frame + padAfterFrames);
    const clipName = `${path.basename(slpPath, '.slp')}_stock${i + 1}`;
    const outputFile = path.join(outputDir, `${clipName}.mp4`);

    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0) {
      console.log(`\n[stock-clips] Stock ${i + 1}: ya existe ${outputFile}, saltando.`);
      renderedFiles.push(outputFile);
      continue;
    }

    console.log(`\n[stock-clips] Stock ${i + 1}: frame ${ev.frame} (${formatTime(ev.frame / 60)})`);
    let file = cutClip(slpPath, {
      startFrame: clipStart,
      endFrame: clipEnd,
      reason: `${attacker.connectCode || attacker.displayName} mata stock ${i + 1}`,
    }, clipName, QUALITY);

    if (MIX_DISCORD) {
      const mixedOutput = file.replace('.mp4', '_mixed.mp4');
      const result = mixDiscordAudioForClip(slpPath, ev.frame, file, mixedOutput, DEFAULT_LEAD_SECONDS, DISCORD_AUDIO_OFFSET);
      if (result.used) {
        console.log(`[stock-clips] Stock ${i + 1}: audio de Discord mezclado`);
        fs.renameSync(mixedOutput, file);
      } else {
        console.log(`[stock-clips] Stock ${i + 1}: sin audio de Discord (${result.reason})`);
        if (REQUIRE_DISCORD_AUDIO) {
          console.log(`[stock-clips] Stock ${i + 1}: descartado por falta de audio de Discord`);
          try { fs.unlinkSync(file); } catch (e) {}
          try { fs.unlinkSync(mixedOutput); } catch (e) {}
          continue;
        }
      }
    }

    renderedFiles.push(file);
  }

  // Combinar todos los stocks en un solo clip
  const combinedOutput = path.join(outputDir, `${path.basename(slpPath, '.slp')}_all-stocks.mp4`);
  if (fs.existsSync(combinedOutput) && fs.statSync(combinedOutput).size > 0) {
    console.log('\n[stock-clips] Combinado ya existe, saltando.');
  } else {
    console.log('\n[stock-clips] Combinando clips...');
    combineClips(renderedFiles, combinedOutput);
  }

  // Datos extra para los mensajes
  const gameEnd = game.getGameEnd();
  const winner = players.find(
    (p) => p.playerIndex === gameEnd?.placements?.find((pl) => pl.position === 0)?.playerIndex
  );
  const durationSeconds = Math.round((lastFrame + 123) / FPS);

  // Generar manifest
  const manifest = {
    generatedAt: new Date().toISOString(),
    slpPath,
    stage: Stage[settings.stageId] || settings.stageId,
    durationSeconds,
    winner: winner ? (winner.connectCode || winner.displayName) : 'desconocido',
    attacker: {
      charId: attackerCharId,
      charName: Character[attackerCharId] || attackerCharId,
      name: attacker.connectCode || attacker.displayName,
    },
    victim: {
      charId: victimCharId,
      charName: Character[victimCharId] || victimCharId,
      name: victim.connectCode || victim.displayName,
    },
    stockKills: events.length,
    clips: renderedFiles.map((f, i) => ({
      id: `stock${i + 1}`,
      file: path.basename(f),
      stockFrame: events[i].frame,
      stockTimeSeconds: Math.round((events[i].frame + 123) / FPS),
      killMoveId: events[i].killMoveId,
      killMoveName: events[i].killMoveName,
      killMoveDamage: events[i].killMoveDamage,
      killPercent: events[i].killPercent,
      comboStartPercent: events[i].comboStartPercent,
      comboEndPercent: events[i].comboEndPercent,
      comboDamage: events[i].comboDamage,
      comboHits: events[i].comboHits,
    })),
    combined: path.basename(combinedOutput),
  };
  const manifestName = `${path.basename(slpPath, '.slp')}-manifest.json`;
  fs.writeFileSync(path.join(outputDir, manifestName), JSON.stringify(manifest, null, 2));

  console.log(`\n[stock-clips] Listo. ${renderedFiles.length} clip(s) individual(es) + combinado.`);
  console.log(`  Output: ${outputDir}`);
  console.log(`  Combinado: ${combinedOutput}`);
}

main();
