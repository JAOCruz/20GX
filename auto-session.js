// auto-session.js
// Une una grabación de Discord con el procesamiento automático de replays.
// En vez de vigilar continuamente la carpeta (lo que causaba lag), al detener
// la sesión se sincroniza UNA VEZ desde la Mac los replays recientes y se
// procesan los que se crearon durante la sesión.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { startRecording, stopRecording } = require('./discord-recorder');

const REPLAYS_DIR = process.env.REPLAYS_DIR || path.join(__dirname, 'replays');
const MAC_HOST = process.env.MAC_HOST || 'jay@100.69.130.90';
const MAC_KEY = process.env.MAC_KEY || '/home/jay/.ssh/id_ed25519_kimi_mac';
const MAC_SLIPPI_DIR = process.env.MAC_SLIPPI_DIR || '/Users/jay/Slippi';

let session = null;

function getCurrentMonthFolder() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function findRecentSlpFiles(dir, sinceEpoch) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.slp')) {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= sinceEpoch) {
          out.push(full);
        }
      }
    }
  }
  walk(dir);
  return out.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

function syncRecentFromMac(sinceEpoch) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(REPLAYS_DIR, { recursive: true });
    const minutesAgo = Math.max(1, Math.ceil((Date.now() - sinceEpoch) / 60000) + 10);
    const monthFolder = getCurrentMonthFolder();
    const remoteFolder = `${MAC_SLIPPI_DIR}/${monthFolder}`;

    // Listar archivos recientes directamente en la Mac para no traer todo el mes
    const listCmd = `ssh -o ConnectTimeout=10 -i ${MAC_KEY} ${MAC_HOST} "find ${remoteFolder} -name '*.slp' -mmin -${minutesAgo} -print"`;
    console.log(`[auto-session] Listando archivos .slp de los últimos ${minutesAgo} minutos en ${MAC_HOST}:${remoteFolder}`);

    const listChild = spawn('bash', ['-c', listCmd], { cwd: __dirname });
    let fileList = '';
    listChild.stdout.on('data', (d) => { fileList += d.toString(); });
    listChild.stderr.on('data', (d) => { console.warn(`[auto-session] list stderr: ${d.toString().trim()}`); });

    listChild.on('close', (listCode) => {
      const files = fileList.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && l.endsWith('.slp'));
      if (files.length === 0) {
        console.log('[auto-session] No hay archivos recientes para sincronizar');
        return resolve({ files: [] });
      }

      const listFile = path.join(REPLAYS_DIR, `.sync-list-${Date.now()}.txt`);
      fs.writeFileSync(listFile, files.map((f) => f.replace(`${MAC_SLIPPI_DIR}/`, '')).join('\n'));

      const args = [
        '--files-from', listFile,
        '-avz',
        '-e', `ssh -i ${MAC_KEY} -o ConnectTimeout=10`,
        `${MAC_HOST}:${MAC_SLIPPI_DIR}/`,
        REPLAYS_DIR + '/',
      ];

      console.log(`[auto-session] Sync de ${files.length} archivo(s) reciente(s) desde Mac`);
      const child = spawn('rsync', args, { cwd: __dirname });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('close', (code) => {
        try { fs.unlinkSync(listFile); } catch (e) {}
        if (code !== 0) {
          reject(new Error(stderr || stdout || `rsync exit ${code}`));
        } else {
          resolve({ files, stdout, stderr });
        }
      });
    });
  });
}

function processSingleGame(filePath, options, onLog) {
  return new Promise((resolve, reject) => {
    const args = [path.join(__dirname, 'process-single-game.js'), filePath];
    if (options.paddingBefore) args.push('--padding-before', String(options.paddingBefore));
    if (options.paddingAfter) args.push('--padding-after', String(options.paddingAfter));
    if (options.sendTelegram) args.push('--telegram');
    if (options.copyToMac) args.push('--copy-to-mac');
    if (options.mixDiscord) args.push('--mix-discord');
    if (options.requireDiscordAudio) args.push('--require-discord-audio');

    const child = spawn('node', args, {
      cwd: __dirname,
      env: {
        ...process.env,
        MIX_DISCORD_AUDIO: options.mixDiscord ? '1' : '0',
        DISCORD_AUDIO_OFFSET: String(options.discordAudioOffset || '0'),
        RENDER_RESOLUTION: options.resolution || '',
        RENDER_BITRATE: String(options.bitrate || ''),
        RENDER_WIDESCREEN: options.widescreen ? '1' : '0',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      if (onLog) onLog(text);
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (onLog) onLog(text);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `exit ${code}`));
      } else {
        resolve({ filePath, stdout, stderr });
      }
    });
  });
}

async function startAutoSession(guildId, channelId, options = {}) {
  if (session) throw new Error('Ya hay una sesión activa');

  const recording = await startRecording(guildId, channelId);

  // Por defecto descartar clips sin audio de Discord
  const finalOptions = {
    requireDiscordAudio: true,
    ...options,
  };

  session = {
    guildId,
    channelId,
    recording,
    options: finalOptions,
    status: 'recording',
    startTime: Date.now(),
    detectedFiles: [],
    logs: [`Sesión iniciada: ${new Date().toISOString()}`, `Grabando en canal ${channelId}`],
  };

  return {
    status: 'recording',
    recording,
    replaysDir: REPLAYS_DIR,
  };
}

async function stopAutoSession() {
  if (!session) throw new Error('No hay sesión activa');
  if (session.status === 'stopped') throw new Error('La sesión ya se detuvo');

  session.status = 'stopping';
  const recordingResult = await stopRecording();
  session.recording.wavPath = recordingResult.wavPath;
  session.recording.durationSeconds = recordingResult.durationSeconds || 0;

  // Sincronizar solo los replays recientes desde la Mac para no llenar el disco
  session.logs.push('Sincronizando replays recientes desde la Mac...');
  try {
    const syncResult = await syncRecentFromMac(session.startTime - 5 * 60 * 1000);
    session.logs.push(`Sync completado: ${syncResult.files?.length || 0} archivo(s).`);
  } catch (err) {
    session.logs.push(`ERROR sync: ${err.message}`);
  }

  // Buscar archivos creados durante la sesión (5 min antes por si empezó antes)
  const since = session.startTime - 5 * 60 * 1000;
  const filesToProcess = findRecentSlpFiles(REPLAYS_DIR, since);
  session.detectedFiles = filesToProcess;
  session.status = filesToProcess.length > 0 ? 'processing' : 'completed';
  session.logs.push(`Grabación finalizada. ${filesToProcess.length} replay(s) para procesar.`);

  if (filesToProcess.length > 0) {
    (async () => {
      for (let i = 0; i < filesToProcess.length; i++) {
        const filePath = filesToProcess[i];
        session.logs.push(`[${i + 1}/${filesToProcess.length}] Procesando ${path.basename(filePath)}...`);
        try {
          await processSingleGame(filePath, session.options, (text) => session.logs.push(text.trim()));
          session.logs.push(`[${i + 1}/${filesToProcess.length}] Listo ${path.basename(filePath)}`);
        } catch (err) {
          session.logs.push(`[${i + 1}/${filesToProcess.length}] ERROR ${path.basename(filePath)}: ${err.message}`);
        }
      }
      session.status = 'completed';
      session.logs.push(`Sesión completada: ${new Date().toISOString()}`);
    })();
  }

  return {
    status: session.status,
    recording: recordingResult,
    detectedFiles: filesToProcess,
  };
}

function getSession() {
  if (!session) return null;
  return {
    status: session.status,
    guildId: session.guildId,
    channelId: session.channelId,
    recording: session.recording,
    detectedFiles: session.detectedFiles,
    logs: session.logs.slice(-100),
  };
}

function clearSession() {
  session = null;
}

module.exports = {
  startAutoSession,
  stopAutoSession,
  getSession,
  clearSession,
};
