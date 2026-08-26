// discord-recorder.js
// Bot de Discord que se une a un canal de voz y graba el audio de todos
// los usuarios humanos presentes, mezclandolos en un solo archivo WAV.
//
// Uso manual:
//   DISCORD_BOT_TOKEN=... node discord-recorder.js start <guildId> <channelId> [userId]
//   DISCORD_BOT_TOKEN=... node discord-recorder.js stop
//
// API:
//   const { startRecording, stopRecording } = require('./discord-recorder');

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const { execFileSync } = require('child_process');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OUTPUT_DIR = process.env.DISCORD_RECORDINGS_DIR || path.join(__dirname, 'discord-recordings');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

let currentRecording = null;

function getTimestampFilename() {
  return `voice_${Date.now()}`;
}

function createWavHeader(dataLength, sampleRate, channels, bitsPerSample) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);

  return buffer;
}

function createOpusDecoder(userId) {
  // Usamos @discordjs/opus para decodificar los paquetes que entrega
  // @discordjs/voice. Es mas robusto que opusscript para streams reales.
  const { OpusEncoder } = require('@discordjs/opus');
  const encoder = new OpusEncoder(48000, 2);
  let packetsDecoded = 0;
  let packetsErrored = 0;

  return {
    decode(packet) {
      try {
        const pcm = encoder.decode(packet);
        packetsDecoded++;
        return pcm;
      } catch (err) {
        packetsErrored++;
        if (packetsErrored <= 5) {
          console.warn(`[discord-recorder] Error decodificando paquete de ${userId}:`, err.message);
        }
        return null;
      }
    },
    stats() {
      return { packetsDecoded, packetsErrored };
    },
  };
}

function pcmFileToWav(pcmPath, wavPath, sampleRate = 48000, channels = 2) {
  const pcmData = fs.readFileSync(pcmPath);
  const header = createWavHeader(pcmData.length, sampleRate, channels, 16);
  fs.writeFileSync(wavPath, Buffer.concat([header, pcmData]));
}

function mixWavs(wavPaths, outputWavPath) {
  if (wavPaths.length === 1) {
    fs.copyFileSync(wavPaths[0], outputWavPath);
    return outputWavPath;
  }

  const listFile = path.join(OUTPUT_DIR, `mix-list-${Date.now()}.txt`);
  fs.writeFileSync(listFile, wavPaths.map((p) => `file '${path.resolve(p)}'`).join('\n'));

  const filter = wavPaths.map((_, i) => `[${i}:a]`).join('') + `amix=inputs=${wavPaths.length}:duration=longest[out]`;
  const args = ['-y'];
  for (const p of wavPaths) args.push('-i', p);
  args.push('-filter_complex', filter, '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', outputWavPath);

  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  try { fs.unlinkSync(listFile); } catch (e) {}
  return outputWavPath;
}

async function startRecording(guildId, channelId, specificUserId = null) {
  if (!BOT_TOKEN) throw new Error('Falta DISCORD_BOT_TOKEN');
  if (!client.isReady()) await client.login(BOT_TOKEN);

  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== 2) throw new Error('Canal de voz no encontrado');

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  // Esperar a que la conexion de voz este lista; sin esto se pierden los
  // primeros paquetes de audio y la grabacion queda vacia.
  await new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      connection.off(VoiceConnectionStatus.Ready, onReady);
      connection.off('error', onError);
    };
    if (connection.state.status === VoiceConnectionStatus.Ready) {
      cleanup();
      return resolve();
    }
    connection.once(VoiceConnectionStatus.Ready, onReady);
    connection.once('error', onError);
    setTimeout(() => {
      cleanup();
      reject(new Error('Timeout esperando conexion de voz lista'));
    }, 15000);
  });

  const baseName = getTimestampFilename();
  const startEpoch = Date.now();

  // Determinar usuarios a grabar
  let targetUserIds = [];
  if (specificUserId) {
    targetUserIds = [specificUserId];
  } else {
    targetUserIds = Array.from(channel.members.values())
      .filter((m) => !m.user.bot)
      .map((m) => m.id);
  }

  if (targetUserIds.length === 0) {
    connection.destroy();
    throw new Error('No hay usuarios de voz para grabar');
  }

  const receiver = connection.receiver;
  const userStreams = [];
  let speakingHandlers = [];

  // Logs de speaking para debug
  const onStartSpeaking = (userId) => {
    console.log(`[discord-recorder] Hablando detectado: ${userId}`);
  };
  receiver.speaking.on('start', onStartSpeaking);
  speakingHandlers.push(() => receiver.speaking.off('start', onStartSpeaking));

  for (const userId of targetUserIds) {
    const pcmPath = path.join(OUTPUT_DIR, `${baseName}_${userId}.pcm`);
    // EndBehaviorType.Manual mantiene la suscripcion viva hasta que nosotros
    // destruyamos la conexion. AfterSilence terminaba el stream tras 1s de
    // silencio y no se reactivaba, causando grabaciones cortas.
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const pcmWrite = fs.createWriteStream(pcmPath);
    const decoder = createOpusDecoder(userId);

    let opusBytesReceived = 0;
    let opusPacketsReceived = 0;

    opusStream.on('data', (packet) => {
      opusBytesReceived += packet.length;
      opusPacketsReceived++;
      const pcm = decoder.decode(packet);
      if (pcm) {
        pcmWrite.write(pcm);
      }
    });
    opusStream.on('error', (err) => {
      console.warn(`[discord-recorder] Error en stream de ${userId}:`, err.message);
    });
    opusStream.on('end', () => {
      pcmWrite.end();
    });

    const finishPromise = new Promise((resolve) => {
      pcmWrite.on('finish', () => resolve());
      pcmWrite.on('close', () => resolve());
      pcmWrite.on('error', (err) => {
        console.warn(`[discord-recorder] Error escribiendo pcm de ${userId}:`, err.message);
        resolve();
      });
      // Fallback de seguridad
      setTimeout(() => resolve(), 5000);
    });

    userStreams.push({ userId, opusStream, decoder, pcmWrite, pcmPath, finishPromise, opusBytesReceived: () => opusBytesReceived, opusPacketsReceived: () => opusPacketsReceived });
  }

  const wavPath = path.join(OUTPUT_DIR, `${baseName}.wav`);

  currentRecording = {
    connection,
    userStreams,
    speakingHandlers,
    baseName,
    wavPath,
    startEpoch,
    targetUserIds,
    guildId,
    channelId,
    channelName: channel.name,
  };

  // Guardar metadata
  const metaPath = path.join(OUTPUT_DIR, `${baseName}.json`);
  fs.writeFileSync(metaPath, JSON.stringify({
    startEpoch,
    userIds: targetUserIds,
    guildId,
    channelId,
    channelName: channel.name,
    startedAt: new Date(startEpoch).toISOString(),
  }, null, 2));

  console.log(`[discord-recorder] Grabando ${targetUserIds.length} usuario(s) en ${channel.name} -> ${wavPath} (startEpoch: ${startEpoch})`);
  return { wavPath, startEpoch, userIds: targetUserIds };
}

async function stopRecording() {
  if (!currentRecording) throw new Error('No hay grabacion activa');

  const rec = currentRecording;
  const { connection, userStreams, speakingHandlers, wavPath, startEpoch, targetUserIds } = rec;

  try {
    // Remover handlers de speaking
    for (const cleanup of speakingHandlers) cleanup();

    // Destruir conexion; esto cierra los subscriptions.
    connection.destroy();

    // Esperar a que los writestreams de pcm cierren y escriban todo.
    console.log('[discord-recorder] Esperando cierre de streams de pcm...');
    await Promise.all(userStreams.map((u) => u.finishPromise));
    await new Promise((r) => setTimeout(r, 1000));

    // Convertir cada archivo PCM a WAV
    const wavPaths = [];
    const debugInfo = [];
    for (const { pcmPath, userId, opusBytesReceived, opusPacketsReceived, decoder } of userStreams) {
      try {
        const pcmSize = fs.existsSync(pcmPath) ? fs.statSync(pcmPath).size : 0;
        const stats = decoder ? decoder.stats() : { packetsDecoded: 0, packetsErrored: 0 };
        console.log(`[discord-recorder] Usuario ${userId}: ${opusPacketsReceived()} paquetes / ${opusBytesReceived()} bytes opus -> ${pcmSize} bytes pcm (decodificados: ${stats.packetsDecoded}, errores: ${stats.packetsErrored})`);
        if (pcmSize === 0) continue;
        const wavPathIndividual = pcmPath.replace('.pcm', '.wav');
        pcmFileToWav(pcmPath, wavPathIndividual);
        const wavSize = fs.statSync(wavPathIndividual).size;
        const duration = wavSize > 44 ? Math.round((wavSize - 44) / (48000 * 2 * 2)) : 0;
        wavPaths.push(wavPathIndividual);
        debugInfo.push({ userId, pcmSize, wavSize, duration, ...stats });
      } catch (err) {
        console.warn(`[discord-recorder] No se pudo convertir audio de ${userId}:`, err.message);
      }
    }

    let finalDurationSeconds = 0;
    if (wavPaths.length === 0) {
      // Ningun audio capturado, crear silencio de 1 segundo para no romper downstream
      console.warn('[discord-recorder] Ningun audio capturado, generando silencio');
      const silence = Buffer.alloc(48000 * 2 * 2);
      const header = createWavHeader(silence.length, 48000, 2, 16);
      fs.writeFileSync(wavPath, Buffer.concat([header, silence]));
      finalDurationSeconds = 1;
    } else {
      mixWavs(wavPaths, wavPath);
      const stat = fs.statSync(wavPath);
      finalDurationSeconds = stat.size > 44 ? Math.round((stat.size - 44) / (48000 * 2 * 2)) : 0;

      // Si el resultado final es razonablemente largo, limpiar archivos individuales.
      if (finalDurationSeconds >= 2) {
        for (const { pcmPath } of userStreams) {
          try { fs.unlinkSync(pcmPath); } catch (e) {}
          try { fs.unlinkSync(pcmPath.replace('.pcm', '.wav')); } catch (e) {}
        }
      } else {
        console.warn(`[discord-recorder] Grabacion muy corta (${finalDurationSeconds}s), conservando archivos individuales para debug`);
      }
    }

    // Guardar debug info
    const metaPath = path.join(OUTPUT_DIR, `${rec.baseName}.json`);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      meta.durationSeconds = finalDurationSeconds;
      meta.debug = debugInfo;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch (e) {}

    console.log(`[discord-recorder] Grabacion finalizada: ${wavPath} (${finalDurationSeconds}s)`);
    return { wavPath, startEpoch, userIds: targetUserIds, durationSeconds: finalDurationSeconds };
  } finally {
    currentRecording = null;
  }
}

function isRecording() {
  return currentRecording !== null;
}

function deleteRecording(fileName) {
  const base = fileName.replace(/\.wav$/, '');
  const filesToDelete = [
    path.join(OUTPUT_DIR, `${base}.wav`),
    path.join(OUTPUT_DIR, `${base}.json`),
  ];
  // También archivos individuales de usuario si existen
  const individualPattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_[0-9]+\\.(pcm|wav)$`);
  if (fs.existsSync(OUTPUT_DIR)) {
    for (const f of fs.readdirSync(OUTPUT_DIR)) {
      if (individualPattern.test(f)) {
        filesToDelete.push(path.join(OUTPUT_DIR, f));
      }
    }
  }
  let deleted = false;
  for (const p of filesToDelete) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      deleted = true;
    }
  }
  return deleted;
}

function getRecordings() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => {
      const base = f.replace('.wav', '');
      const metaPath = path.join(OUTPUT_DIR, `${base}.json`);
      const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : {};
      const stat = fs.statSync(path.join(OUTPUT_DIR, f));
      return {
        file: f,
        path: path.join(OUTPUT_DIR, f),
        startEpoch: meta.startEpoch || 0,
        durationSeconds: meta.durationSeconds || (stat.size > 44 ? Math.round((stat.size - 44) / (48000 * 2 * 2)) : 0),
        userIds: meta.userIds || [],
        channelName: meta.channelName || '',
      };
    })
    .sort((a, b) => b.startEpoch - a.startEpoch);
}

// CLI
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'start') {
    const [guildId, channelId, userId] = process.argv.slice(3);
    startRecording(guildId, channelId, userId)
      .then(() => {
        console.log('[discord-recorder] Presiona Ctrl+C para detener');
      })
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });

    process.on('SIGINT', async () => {
      console.log('\n[discord-recorder] Deteniendo...');
      try { await stopRecording(); } catch (e) { console.error(e); }
      process.exit(0);
    });
  } else if (cmd === 'stop') {
    stopRecording()
      .then((r) => console.log('Listo:', r))
      .catch((err) => { console.error(err); process.exit(1); })
      .finally(() => client.destroy());
  } else if (cmd === 'list') {
    console.log(getRecordings());
    client.destroy();
  } else {
    console.log('Uso: node discord-recorder.js start <guildId> <channelId> [userId]');
    console.log('     node discord-recorder.js stop');
    console.log('     node discord-recorder.js list');
    process.exit(1);
  }
}

module.exports = { startRecording, stopRecording, getRecordings, isRecording, deleteRecording, OUTPUT_DIR };
