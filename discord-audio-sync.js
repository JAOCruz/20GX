// discord-audio-sync.js
// Dado un replay .slp y un frame de highlight, extrae el segmento de audio
// de Discord que corresponde al momento exacto y lo mezcla con el audio del clip.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SlippiGame } = require('@slippi/slippi-js');
const { getRecordings, OUTPUT_DIR } = require('./discord-recorder');

const FPS = 60;

function getSlpStartEpoch(slpPath) {
  try {
    const game = new SlippiGame(slpPath);
    const metadata = game.getMetadata();
    if (metadata && metadata.startAt) {
      return new Date(metadata.startAt).getTime();
    }
  } catch (e) {
    console.warn('[discord-sync] No se pudo leer metadata de', slpPath);
  }
  return null;
}

function findRecordingForTimestamp(epochMs) {
  const recordings = getRecordings();
  // Buscar una grabacion que cubra el timestamp
  for (const rec of recordings) {
    const endEpoch = rec.startEpoch + (rec.durationSeconds * 1000);
    if (epochMs >= rec.startEpoch && epochMs <= endEpoch + 5000) {
      return rec;
    }
  }
  return null;
}

function extractDiscordSegment(recordingPath, startOffsetSeconds, durationSeconds, outputWav) {
  if (startOffsetSeconds >= 0) {
    execFileSync('ffmpeg', [
      '-y',
      '-i', recordingPath,
      '-ss', String(startOffsetSeconds),
      '-t', String(durationSeconds),
      '-acodec', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      outputWav,
    ], { stdio: 'inherit' });
  } else {
    // El clip empieza antes de la grabacion: rellenar con silencio al inicio
    const silenceDuration = Math.min(durationSeconds, -startOffsetSeconds);
    const actualDuration = durationSeconds - silenceDuration;
    const silenceWav = outputWav.replace('.wav', '_silence.wav');
    execFileSync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', `anullsrc=r=48000:cl=stereo`,
      '-t', String(silenceDuration),
      '-acodec', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      silenceWav,
    ], { stdio: 'inherit' });

    const segmentWav = outputWav.replace('.wav', '_raw.wav');
    if (actualDuration > 0) {
      execFileSync('ffmpeg', [
        '-y',
        '-i', recordingPath,
        '-ss', '0',
        '-t', String(actualDuration),
        '-acodec', 'pcm_s16le',
        '-ar', '48000',
        '-ac', '2',
        segmentWav,
      ], { stdio: 'inherit' });
    }

    const concatList = outputWav.replace('.wav', '_concat.txt');
    const files = [silenceWav];
    if (actualDuration > 0) files.push(segmentWav);
    fs.writeFileSync(concatList, files.map((f) => `file '${path.resolve(f)}'`).join('\n'));
    execFileSync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatList,
      '-acodec', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      outputWav,
    ], { stdio: 'inherit' });

    try { fs.unlinkSync(silenceWav); } catch (e) {}
    try { fs.unlinkSync(segmentWav); } catch (e) {}
    try { fs.unlinkSync(concatList); } catch (e) {}
  }
}

function mixAudio(gameAudioPath, discordAudioPath, outputPath) {
  // gameAudioPath puede ser el mp4 del clip (ffmpeg extrae audio automaticamente)
  // Mezclamos ambas pistas con volumen ajustado
  execFileSync('ffmpeg', [
    '-y',
    '-i', gameAudioPath,
    '-i', discordAudioPath,
    '-filter_complex', '[0:a:0]volume=1.0[a0];[1:a:0]volume=1.5[a1];[a0][a1]amix=inputs=2:duration=longest[out]',
    '-map', '[out]',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath,
  ], { stdio: 'inherit' });
}

function replaceAudioInVideo(videoPath, newAudioPath, outputPath) {
  execFileSync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-i', newAudioPath,
    '-c:v', 'copy',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-shortest',
    outputPath,
  ], { stdio: 'inherit' });
}

/**
 * Mezcla el audio de Discord con un clip de Melee.
 * @param {string} slpPath ruta al replay original
 * @param {number} highlightFrame frame del highlight dentro del replay
 * @param {string} clipVideoPath ruta al clip de video generado (mp4)
 * @param {string} outputPath ruta de salida
 * @param {number} leadSeconds segundos antes del highlight que empieza el clip
 * @param {number} [audioOffsetSeconds] offset extra para calibrar el audio de Discord (positivo=retrasar, negativo=adelantar)
 * @returns {{used: boolean, outputPath: string, reason?: string}}
 */
function mixDiscordAudioForClip(slpPath, highlightFrame, clipVideoPath, outputPath, leadSeconds = 7, audioOffsetSeconds = 0) {
  const slpStartEpoch = getSlpStartEpoch(slpPath);
  if (!slpStartEpoch) {
    return { used: false, outputPath: clipVideoPath, reason: 'No se pudo leer startAt del .slp' };
  }

  const highlightEpoch = slpStartEpoch + ((highlightFrame + 123) / FPS) * 1000;
  const recording = findRecordingForTimestamp(highlightEpoch);
  if (!recording) {
    return { used: false, outputPath: clipVideoPath, reason: 'No hay grabacion de Discord que cubra este momento' };
  }

  const discordDelaySeconds = Number(process.env.DISCORD_AUDIO_DELAY || '0');
  // delay positivo = retrasar el audio de Discord (llega mas tarde en el clip)
  // avance negativo = adelantar el audio de Discord (llega antes en el clip)
  const offsetInRecordingSeconds = (highlightEpoch - recording.startEpoch) / 1000 - leadSeconds + discordDelaySeconds + audioOffsetSeconds;

  // Duracion del clip en segundos
  const probe = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    clipVideoPath,
  ], { encoding: 'utf-8' });
  const clipDuration = parseFloat(probe.trim());

  const tempDir = path.join(OUTPUT_DIR, 'tmp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const segmentWav = path.join(tempDir, `discord_segment_${Date.now()}.wav`);
  const mixedAudio = path.join(tempDir, `mixed_audio_${Date.now()}.aac`);

  extractDiscordSegment(recording.path, offsetInRecordingSeconds, clipDuration, segmentWav);
  mixAudio(clipVideoPath, segmentWav, mixedAudio);
  replaceAudioInVideo(clipVideoPath, mixedAudio, outputPath);

  // Limpiar temporales
  try { fs.unlinkSync(segmentWav); } catch (e) {}
  try { fs.unlinkSync(mixedAudio); } catch (e) {}

  return { used: true, outputPath };
}

module.exports = {
  mixDiscordAudioForClip,
  getSlpStartEpoch,
  findRecordingForTimestamp,
  extractDiscordSegment,
};

if (require.main === module) {
  const [slpPath, highlightFrame, clipVideoPath, outputPath] = process.argv.slice(2);
  if (!slpPath || !highlightFrame || !clipVideoPath || !outputPath) {
    console.error('Uso: node discord-audio-sync.js <slpPath> <highlightFrame> <clipVideoPath> <outputPath>');
    process.exit(1);
  }
  const result = mixDiscordAudioForClip(slpPath, parseInt(highlightFrame, 10), clipVideoPath, outputPath);
  console.log(JSON.stringify(result, null, 2));
}
