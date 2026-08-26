// mac-render.js
// Renderiza stocks seleccionados de un replay .slp usando el Dolphin nativo
// de Slippi en macOS (Slippi Dolphin.app). Crea un directorio de trabajo
// temporal con la config de Dolphin, archivo de comunicacion .json y los
// dumps de video/audio, y los combina en un .mp4 con ffmpeg.
//
// Si Dolphin no genera framedump0.avi, devuelve un error claro indicando que
// el renderizado headless en Mac no esta soportado y sugiere el fallback a
// render-selected-stocks.js en Jarvis.
//
// Uso:
//   node mac-render.js <slpPath> --attacker-index N --victim-index M --indices 0,2,3 \
//     [--output-dir /ruta] [--mix-discord] [--discord-delay 0.5] [--combine]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { detectStocks } = require('./detect-stocks');

// Los modulos de audio se cargan solo si se solicita mezcla de Discord.
let mixDiscordAudioForClip = null;

const FPS = 60;
const DEFAULT_LEAD_SECONDS = Number(process.env.PADDING_BEFORE || '7');
const DEFAULT_PAD_AFTER_SECONDS = Number(process.env.PADDING_AFTER || '2');

const MAC_DOLPHIN = '/Users/jay/Library/Application Support/Slippi Launcher/playback/Slippi Dolphin.app/Contents/MacOS/Slippi Dolphin';
const ISO_CANDIDATES = [
  '/Users/jay/Documents/Games/Melee/Super Smash Bros. Melee (USA) (En,Ja) (Rev 2).iso',
  '/Users/jay/Melee/Super Smash Bros. Melee (USA) (En,Ja) (Rev 2).iso',
  '/Users/jay/Desktop/Melee/Super Smash Bros. Melee (USA) (En,Ja) (Rev 2).iso',
];
const DEFAULT_OUTPUT_DIR = '/Users/jay/Desktop/Slippi Clips/dashboard-mac';

function log(...args) {
  // Los logs de progreso van a stderr; la salida JSON final va a stdout.
  console.error('[mac-render]', ...args);
}

function resolveDolphinPath() {
  return process.env.SLIPPI_DOLPHIN_MAC || MAC_DOLPHIN;
}

function resolveIsoPath() {
  if (process.env.SSBM_ISO_PATH) return process.env.SSBM_ISO_PATH;
  for (const candidate of ISO_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return ISO_CANDIDATES[0];
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function buildDolphinIni() {
  return `[General]
DumpPath =
[Interface]
ConfirmStop = False
HideCursor = False
AutoHideCursor = False
MainWindowPosX = 0
MainWindowPosY = 0
MainWindowWidth = 1
MainWindowHeight = 1
ShowToolbar = False
ShowStatusbar = False
ShowSeekbar = False
ShowLogWindow = False
ShowLogConfigWindow = False
ExtendedFPSInfo = False
PauseOnFocusLost = False
DisableTooltips = True
[Display]
FullscreenResolution = Auto
Fullscreen = False
RenderToMain = True
RenderWindowAutoSize = False
KeepWindowOnTop = False
[Core]
SlippiPlaybackDisplayFrameIndex = False
[Movie]
DumpFrames = True
DumpFramesSilent = True
ShowInputDisplay = False
ShowRTC = False
[DSP]
DumpAudio = True
DumpAudioSilent = True
Backend = No audio output
Volume = 25
[Input]
BackgroundInput = False
`;
}

function buildGfxIni(bitrateKbps = 25000, efbScale = 4) {
  return `[Hardware]
VSync = True
[Settings]
AspectRatio = 0
Crop = False
ShowFPS = False
DumpTextures = False
DumpVertexLoader = False
DumpEFBTarget = False
DumpFramesAsImages = False
InternalResolutionFrameDumps = True
DumpFormat = avi
DumpCodec = h264
DumpPath =
BitrateKbps = ${Math.round(bitrateKbps)}
EFBScale = ${Math.round(efbScale)}
[Enhancements]
[Stereoscopy]
[Hacks]
EFBScaledCopy = True
`;
}

function prepareWorkDir(workDir, slpPath, startFrame, endFrame, options = {}) {
  const userDir = path.join(workDir, 'User');
  const configDir = path.join(userDir, 'Config');
  ensureDir(configDir);

  fs.writeFileSync(path.join(configDir, 'Dolphin.ini'), buildDolphinIni());
  fs.writeFileSync(
    path.join(configDir, 'GFX.ini'),
    buildGfxIni(options.bitrateKbps || 25000, options.efbScale || 4),
  );

  const inputJson = {
    mode: 'queue',
    queue: [
      {
        path: slpPath,
        startFrame,
        endFrame,
      },
    ],
  };
  const inputJsonPath = path.join(workDir, `${path.basename(slpPath, '.slp')}.json`);
  fs.writeFileSync(inputJsonPath, JSON.stringify(inputJson, null, 2));

  return { userDir, inputJsonPath };
}

function waitForFile(filePath, timeoutMs = 30000, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > 0) {
            clearInterval(timer);
            resolve(true);
          }
        } catch (e) {
          // ignore
        }
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

function runDolphin(slpPath, startFrame, endFrame, options = {}) {
  return new Promise((resolve, reject) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slippi-mac-render-'));
    const { userDir, inputJsonPath } = prepareWorkDir(workDir, slpPath, startFrame, endFrame, options);

    const dolphinPath = resolveDolphinPath();
    const isoPath = resolveIsoPath();

    if (!fs.existsSync(dolphinPath)) {
      return reject(new Error(`No se encuentra el binario de Dolphin: ${dolphinPath}`));
    }
    if (!fs.existsSync(isoPath)) {
      return reject(new Error(`No se encuentra el ISO: ${isoPath}`));
    }

    const args = [
      '-u', userDir,
      '--output-directory', workDir,
      '-i', inputJsonPath,
      '-e', isoPath,
      '-b',
      '--cout',
      '--hide-seekbar',
    ];

    log('Ejecutando Dolphin:', dolphinPath, args.join(' '));
    const child = spawn(dolphinPath, args, {
      cwd: workDir,
      timeout: options.timeoutMs || 20 * 60 * 1000,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (text.includes('[NO_GAME]') && !killed) {
        killed = true;
        log('Dolphin reporto fin de juego, terminando proceso...');
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 10000);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Fallo al ejecutar Dolphin: ${err.message}`));
    });

    child.on('exit', async (code, signal) => {
      const videoDump = path.join(workDir, 'framedump0.avi');
      const audioDump = path.join(workDir, 'dspdump.wav');

      if (!fs.existsSync(videoDump) || fs.statSync(videoDump).size === 0) {
        // Puede que el archivo aun este siendo finalizado; esperamos un poco.
        const appeared = await waitForFile(videoDump, 15000);
        if (!appeared) {
          return reject(
            new Error(
              'Native Mac frame dumping failed: Dolphin did not produce framedump0.avi. ' +
              'Mac headless rendering is not currently supported. ' +
              'Use the Jarvis fallback (render-selected-stocks.js / cut-clips.js) instead.',
            ),
          );
        }
      }

      resolve({
        workDir,
        videoDump,
        audioDump,
        exitCode: code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function combineDumps(videoDump, audioDump, outputFile) {
  ensureDir(path.dirname(outputFile));
  const args = ['-y', '-i', videoDump];
  if (fs.existsSync(audioDump) && fs.statSync(audioDump).size > 0) {
    args.push('-i', audioDump);
  }
  args.push(
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    outputFile,
  );
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
}

function combineClips(files, outputFile) {
  if (files.length === 0) return null;
  if (files.length === 1) {
    fs.copyFileSync(files[0], outputFile);
    return outputFile;
  }
  ensureDir(path.dirname(outputFile));
  const listFile = path.join(path.dirname(outputFile), `concat-${Date.now()}.txt`);
  fs.writeFileSync(listFile, files.map((f) => `file '${path.resolve(f)}'`).join('\n'));
  try {
    execFileSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', outputFile,
    ], { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(listFile); } catch (e) {}
  }
  return outputFile;
}

function loadMixDiscord() {
  if (!mixDiscordAudioForClip) {
    const mod = require('./discord-audio-sync');
    mixDiscordAudioForClip = mod.mixDiscordAudioForClip;
  }
}

function mixDiscordForClip(slpPath, highlightFrame, clipPath, outputDir, leadSeconds, delaySeconds) {
  loadMixDiscord();
  const mixedOutput = path.join(outputDir, `${path.basename(clipPath, '.mp4')}_mixed.mp4`);
  // Aplicar el delay de calibracion de este juego via variable de entorno.
  // Cada invocacion CLI de mac-render.js corre en su propio proceso, por lo que
  // es seguro mutar process.env aqui.
  const originalDelay = process.env.DISCORD_AUDIO_DELAY;
  process.env.DISCORD_AUDIO_DELAY = String(delaySeconds || 0);
  try {
    const result = mixDiscordAudioForClip(slpPath, highlightFrame, clipPath, mixedOutput, leadSeconds);
    if (result.used) {
      fs.renameSync(mixedOutput, clipPath);
      return { used: true, reason: null };
    }
    try { fs.unlinkSync(mixedOutput); } catch (e) {}
    return { used: false, reason: result.reason || 'No se mezclo audio de Discord' };
  } finally {
    if (originalDelay === undefined) {
      delete process.env.DISCORD_AUDIO_DELAY;
    } else {
      process.env.DISCORD_AUDIO_DELAY = originalDelay;
    }
  }
}

function getEventsForDirection(stocksData, attackerIndex, victimIndex) {
  // detect-stocks.js devuelve stocksAtoB cuando A ataca a B.
  if (stocksData.playerA.playerIndex === attackerIndex && stocksData.playerB.playerIndex === victimIndex) {
    return stocksData.stocksAtoB;
  }
  if (stocksData.playerB.playerIndex === attackerIndex && stocksData.playerA.playerIndex === victimIndex) {
    return stocksData.stocksBtoA;
  }
  return [];
}

async function renderSelectedStocks(slpPath, attackerIndex, victimIndex, selectedIndices, options = {}) {
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  ensureDir(outputDir);

  const stocksData = detectStocks(slpPath, attackerIndex, victimIndex);
  const events = getEventsForDirection(stocksData, attackerIndex, victimIndex);
  const baseName = path.basename(slpPath, '.slp');
  const leadFrames = Math.round((options.leadSeconds ?? DEFAULT_LEAD_SECONDS) * FPS);
  const padAfterFrames = Math.round((options.padAfterSeconds ?? DEFAULT_PAD_AFTER_SECONDS) * FPS);
  const startFrame = stocksData.startFrame ?? -123;
  const lastFrame = stocksData.lastFrame ?? events[events.length - 1]?.frame ?? 999999;

  const selectedEvents = selectedIndices
    .map((idx) => ({ idx, ev: events[idx] }))
    .filter(({ ev }) => ev);

  if (selectedEvents.length === 0) {
    throw new Error('No se encontraron stocks para los indices seleccionados');
  }

  const renderedFiles = [];
  const leadSeconds = options.leadSeconds ?? DEFAULT_LEAD_SECONDS;

  for (const { idx, ev } of selectedEvents) {
    const clipStart = Math.max(startFrame, ev.frame - leadFrames);
    const clipEnd = Math.min(lastFrame, ev.frame + padAfterFrames);
    const clipName = `${baseName}_stock${idx + 1}`;
    const outputFile = path.join(outputDir, `${clipName}.mp4`);

    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0 && !options.force) {
      log(`Stock ${idx + 1}: ya existe ${outputFile}, saltando.`);
      renderedFiles.push(outputFile);
      continue;
    }

    log(`Renderizando stock ${idx + 1}: frame ${ev.frame}`);
    const dolphinResult = await runDolphin(slpPath, clipStart, clipEnd, options);
    combineDumps(dolphinResult.videoDump, dolphinResult.audioDump, outputFile);

    // Limpiar directorio de trabajo de Dolphin
    try {
      fs.rmSync(dolphinResult.workDir, { recursive: true, force: true });
    } catch (e) {
      log('No se pudo limpiar workDir:', e.message);
    }

    if (options.mixDiscord) {
      const mixResult = mixDiscordForClip(
        slpPath,
        ev.frame,
        outputFile,
        outputDir,
        leadSeconds,
        options.discordDelaySeconds || 0,
      );
      if (mixResult.used) {
        log(`Stock ${idx + 1}: audio de Discord mezclado`);
      } else {
        log(`Stock ${idx + 1}: sin audio de Discord (${mixResult.reason})`);
      }
    }

    renderedFiles.push(outputFile);
  }

  let combinedFile = null;
  if (options.combine && renderedFiles.length > 0) {
    combinedFile = path.join(outputDir, `${baseName}_selected-stocks.mp4`);
    if (!fs.existsSync(combinedFile) || options.force) {
      log('Combinando clips seleccionados...');
      combineClips(renderedFiles, combinedFile);
    } else {
      log('Combinado ya existe, saltando.');
    }
  }

  return {
    slpPath,
    attackerIndex,
    victimIndex,
    clips: renderedFiles.map((file, i) => ({
      id: `stock${selectedEvents[i].idx + 1}`,
      file,
      fileName: path.basename(file),
      stockFrame: selectedEvents[i].ev.frame,
      stockTimeSeconds: Math.round((selectedEvents[i].ev.frame + 123) / FPS),
    })),
    combined: combinedFile,
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
  const outputDir = getFlag('--output-dir') || DEFAULT_OUTPUT_DIR;
  const mixDiscord = args.includes('--mix-discord');
  const combine = args.includes('--combine');
  const force = args.includes('--force');
  const discordDelaySeconds = parseFloat(getFlag('--discord-delay') || '0');
  const leadSeconds = parseFloat(getFlag('--lead') || String(DEFAULT_LEAD_SECONDS));
  const padAfterSeconds = parseFloat(getFlag('--pad-after') || String(DEFAULT_PAD_AFTER_SECONDS));
  const bitrateKbps = parseFloat(getFlag('--bitrate') || '25000');
  const efbScale = parseInt(getFlag('--efb-scale') || '4', 10);

  let selectedIndices = [];
  if (indicesRaw) {
    selectedIndices = indicesRaw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
  }

  return {
    slpPath,
    attackerIndex: attackerIndex !== undefined ? parseInt(attackerIndex, 10) : undefined,
    victimIndex: victimIndex !== undefined ? parseInt(victimIndex, 10) : undefined,
    selectedIndices,
    outputDir,
    mixDiscord,
    combine,
    force,
    discordDelaySeconds,
    leadSeconds,
    padAfterSeconds,
    bitrateKbps,
    efbScale,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.slpPath) {
    console.error('Uso: node mac-render.js <slpPath> --attacker-index N --victim-index M --indices 0,2 [--output-dir ...] [--mix-discord] [--discord-delay 0.5] [--combine]');
    process.exit(1);
  }
  if (opts.attackerIndex === undefined || opts.victimIndex === undefined) {
    console.error('Faltan --attacker-index y --victim-index');
    process.exit(1);
  }
  if (opts.selectedIndices.length === 0) {
    console.error('Faltan --indices (lista separada por comas)');
    process.exit(1);
  }

  try {
    const result = await renderSelectedStocks(opts.slpPath, opts.attackerIndex, opts.victimIndex, opts.selectedIndices, {
      outputDir: opts.outputDir,
      mixDiscord: opts.mixDiscord,
      combine: opts.combine,
      force: opts.force,
      discordDelaySeconds: opts.discordDelaySeconds,
      leadSeconds: opts.leadSeconds,
      padAfterSeconds: opts.padAfterSeconds,
      bitrateKbps: opts.bitrateKbps,
      efbScale: opts.efbScale,
    });
    console.log(JSON.stringify({ success: true, ...result }));
  } catch (err) {
    console.error(err.message);
    console.log(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

module.exports = { renderSelectedStocks, runDolphin, combineDumps };

if (require.main === module) {
  main();
}
