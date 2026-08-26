// cut-clips.js
// Toma las ventanas de highlight (de detect-highlights.js) y las corta
// en clips .mp4 usando la herramienta de linea de comandos "slp-to-video"
// (https://github.com/MiguelTornero/slp-to-video), que internamente usa
// Playback Dolphin (frame dumping) + ffmpeg. No requiere OBS ni grabar
// nada en vivo: renderiza el replay directo a video.
//
// En servidores headless (sin GPU ni display) envuelve Dolphin con xvfb-run
// y carga libOpenGL.so.0 desde una extraccion local.

const { execFileSync, execFile, spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const OPENGL_LIB_DIR = '/home/jay/.local/lib/opengl/usr/lib/x86_64-linux-gnu';

// slp-to-video vuelca los frames (framedump AVI, ~800MB por juego a 720p) en
// os.tmpdir(). En este servidor /tmp es tmpfs = RAM, y los dumps de renders
// fallidos nunca se limpiaban → OOM. Forzamos el volcado a disco real.
const RENDER_TMPDIR = process.env.RENDER_TMPDIR || path.join(__dirname, 'tmp-render');
if (!fs.existsSync(RENDER_TMPDIR)) fs.mkdirSync(RENDER_TMPDIR, { recursive: true });
// Limpia volcados viejos de renders que murieron a la fuerza (SIGKILL no les
// deja limpiar). Solo >2h para no borrar el dump de un render en curso.
try {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const d of fs.readdirSync(RENDER_TMPDIR)) {
    if (!d.startsWith('slp-to-video-')) continue;
    const full = path.join(RENDER_TMPDIR, d);
    if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
  }
} catch (_) { /* ignore */ }

// Ajusta estas rutas a tu instalacion en el servidor (Jarvis)
const CONFIG = {
  sltVideoBin: process.env.SLP_TO_VIDEO_BIN || 'slp-to-video', // si esta en PATH
  dolphinPath:
    process.env.SLIPPI_DOLPHIN_PATH ||
    '/home/jay/slippi-pipeline/playback-dolphin/Slippi_Playback-x86_64.AppImage',
  isoPath:
    process.env.SSBM_ISO_PATH ||
    '/home/jay/slippi-pipeline/melee.iso', // ruta al ISO NTSC 1.02
  ffmpegPath: process.env.FFMPEG_PATH, // opcional si no esta en PATH
  outputDir: process.env.CLIPS_OUTPUT_DIR || path.join(__dirname, 'clips'),
};

function ensureOutputDir() {
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
}

/**
 * Detecta si estamos en un entorno headless que necesite xvfb-run.
 */
function needsXvfb() {
  return !process.env.DISPLAY;
}

/**
 * Construye el comando final para lanzar slp-to-video. En headless envuelve
 * todo con xvfb-run y anade LD_LIBRARY_PATH para libOpenGL.
 */
function buildCommand(bin, args, env) {
  const needs = needsXvfb();
  const finalEnv = { ...process.env, ...env };
  // Ver nota en RENDER_TMPDIR: framedumps a disco, no a tmpfs (RAM).
  finalEnv.TMPDIR = RENDER_TMPDIR;

  if (needs) {
    // Asegurar que libOpenGL local este disponible para el AppImage
    const existingLd = process.env.LD_LIBRARY_PATH || '';
    finalEnv.LD_LIBRARY_PATH = existingLd
      ? `${OPENGL_LIB_DIR}:${existingLd}`
      : OPENGL_LIB_DIR;
    return {
      cmd: 'xvfb-run',
      args: ['-a', bin, ...args],
      env: finalEnv,
    };
  }

  return { cmd: bin, args, env: finalEnv };
}

const PROGRESS_REGEX = /rendering (frames|output file):\s*(\d+\.?\d*)%\s*\(([^)]+)\)/i;
const OPENING_REGEX = /opening playback dolphin/i;

function isProgressLine(line) {
  return PROGRESS_REGEX.test(line) || OPENING_REGEX.test(line);
}

/**
 * Ejecuta un comando ocultando el spam de progreso. En terminal (TTY) muestra
 * una sola línea que se actualiza con \r. Si stdout es un pipe (dashboard),
 * reenvía solo las líneas de progreso para que el servidor las pueda parsear.
 */
function runWithCleanProgress(cmd, args, options) {
  const { spawnSync } = require('child_process');
  const result = spawnSync(cmd, args, {
    ...options,
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if (result.error) throw result.error;

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const lines = (stdout + '\n' + stderr).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const isTty = process.stdout && process.stdout.isTTY;
  let lastProgress = '';
  for (const line of lines) {
    if (isProgressLine(line)) {
      lastProgress = line;
      if (isTty) {
        process.stdout.write(`\r${line.padEnd(80)}`);
      } else {
        // Reenviar al padre para que dashboard-server lo parseé
        process.stdout.write(`${line}\n`);
      }
    }
  }
  if (isTty && lastProgress) process.stdout.write('\n');

  if (result.status !== 0) {
    throw new Error(stderr || stdout || `exit ${result.status}`);
  }
}

/**
 * Corta un solo highlight a un archivo .mp4
 * @param {string} slpPath ruta al archivo .slp original
 * @param {{startFrame:number,endFrame:number,reason:string}} highlight
 * @param {string} clipName nombre base del archivo de salida (sin extension)
 * @param {{resolution?:string,bitrate?:number,widescreen?:boolean,timeoutMs?:number}} [quality]
 * @returns {string} ruta al archivo generado
 */
function cutClip(slpPath, highlight, clipName, quality = {}, outputDir = null) {
  const targetDir = outputDir || CONFIG.outputDir;
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const outputFile = path.join(targetDir, `${clipName}.mp4`);

  const args = [
    slpPath,
    '-o', outputFile,
    '-f', String(highlight.startFrame),
    '-t', String(highlight.endFrame),
  ];

  if (CONFIG.isoPath) args.push('-i', CONFIG.isoPath);
  if (CONFIG.dolphinPath) args.push('-d', CONFIG.dolphinPath);
  if (CONFIG.ffmpegPath) args.push('-p', CONFIG.ffmpegPath);

  // Opciones de calidad
  if (quality.resolution) args.push('-I', String(quality.resolution));
  if (quality.bitrate != null) args.push('-b', String(quality.bitrate));
  if (quality.widescreen) args.push('-w');

  console.log(`[cut-clips] Cortando ${clipName}: frames ${highlight.startFrame}-${highlight.endFrame} (${highlight.reason})` +
    (quality.resolution ? ` | res=${quality.resolution}` : '') +
    (quality.bitrate != null ? ` | bitrate=${quality.bitrate}` : '') +
    (quality.widescreen ? ' | widescreen' : ''));

  const { cmd, args: finalArgs, env } = buildCommand(CONFIG.sltVideoBin, args, {
    // slp-to-video busca SSBM.iso en cwd si no se pasa -i; forzamos el ISO.
  });

  // Timeout de 20 minutos por clip por defecto. El renderizado en Jarvis es lento,
  // especialmente la etapa final de ffmpeg.
  const timeoutMs = quality.timeoutMs || 20 * 60 * 1000;
  runWithCleanProgress(cmd, finalArgs, { timeout: timeoutMs, env });

  return outputFile;
}

/**
 * Versión asíncrona de cutClip. Devuelve una promesa y expone el child process
 * para poder cancelarlo si el cliente se desconecta.
 * @param {string} slpPath
 * @param {{startFrame:number,endFrame:number,reason:string}} highlight
 * @param {string} clipName
 * @param {{resolution?:string,bitrate?:number,widescreen?:boolean,timeoutMs?:number}} [quality]
 * @param {string|null} [outputDir]
 * @returns {{promise: Promise<string>, child: import('child_process').ChildProcess}}
 */
function cutClipAsync(slpPath, highlight, clipName, quality = {}, outputDir = null) {
  const targetDir = outputDir || CONFIG.outputDir;
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const outputFile = path.join(targetDir, `${clipName}.mp4`);

  const args = [
    slpPath,
    '-o', outputFile,
    '-f', String(highlight.startFrame),
    '-t', String(highlight.endFrame),
  ];

  if (CONFIG.isoPath) args.push('-i', CONFIG.isoPath);
  if (CONFIG.dolphinPath) args.push('-d', CONFIG.dolphinPath);
  if (CONFIG.ffmpegPath) args.push('-p', CONFIG.ffmpegPath);
  if (quality.resolution) args.push('-I', String(quality.resolution));
  if (quality.bitrate != null) args.push('-b', String(quality.bitrate));
  if (quality.widescreen) args.push('-w');

  console.log(`[cut-clips] (async) Cortando ${clipName}: frames ${highlight.startFrame}-${highlight.endFrame} (${highlight.reason})` +
    (quality.resolution ? ` | res=${quality.resolution}` : '') +
    (quality.bitrate != null ? ` | bitrate=${quality.bitrate}` : '') +
    (quality.widescreen ? ' | widescreen' : ''));

  const { cmd, args: finalArgs, env } = buildCommand(CONFIG.sltVideoBin, args, {});
  const timeoutMs = quality.timeoutMs || 20 * 60 * 1000;
  const expectedSec = (highlight.endFrame - highlight.startFrame + 1) / 60;

  // En este servidor el proceso node de slp-to-video recibe un SIGKILL
  // silencioso ~12-15 min después de arrancar (causa aún no identificada,
  // sin rastro en kernel/journal). El trabajo real ya está hecho para
  // entonces: Dolphin terminó el dump y el ffmpeg huérfano completa el mp4.
  // fileValid(): el output existe y su duración cuadra con los frames.
  const fileValid = () => {
    try {
      if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size === 0) return false;
      const out = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', outputFile,
      ], { encoding: 'utf-8', timeout: 15000 });
      const d = parseFloat(String(out).trim());
      // slp-to-video recorta ~2s de padding al inicio; tolerancia 8s.
      return Number.isFinite(d) && Math.abs(d - expectedSec) <= 8;
    } catch (e) {
      return false;
    }
  };

  // spawn (NO execFile: execFile ignora `detached` en este Node) para que el
  // child (xvfb-run) lidere su propio grupo de procesos y waitCancellable
  // pueda matar Dolphin/ffmpeg nietos con kill(-pid).
  const child = spawn(cmd, finalArgs, { stdio: 'ignore', timeout: timeoutMs, env, detached: true });
  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        return fileValid()
          ? resolve(outputFile)
          : reject(new Error('cutClipAsync: proceso OK pero archivo inválido o incompleto'));
      }
      // Muerte anómala: dar hasta 3 min al ffmpeg huérfano para terminar el
      // archivo (tamaño estable en 3 lecturas de 5s) y validarlo.
      let lastSize = -1;
      let stableReads = 0;
      let waitedSec = 0;
      const iv = setInterval(() => {
        waitedSec += 5;
        if (fs.existsSync(outputFile)) {
          const size = fs.statSync(outputFile).size;
          if (size > 0 && size === lastSize) stableReads++;
          else { stableReads = 0; lastSize = size; }
          if (stableReads >= 3) {
            clearInterval(iv);
            return fileValid()
              ? resolve(outputFile)
              : reject(new Error(`cutClipAsync salió con código ${code}${signal ? ` (señal ${signal})` : ''} y el archivo quedó incompleto`));
          }
        }
        if (waitedSec >= 180) {
          clearInterval(iv);
          reject(new Error(`cutClipAsync salió con código ${code}${signal ? ` (señal ${signal})` : ''}`));
        }
      }, 5000);
    });
  });

  return { promise, child };
}

/**
 * Corta todos los highlights de un replay
 * @param {string} slpPath
 * @param {Array} highlights salida de detectHighlights()
 * @returns {Array<{file:string, reason:string, startFrame:number, endFrame:number}>}
 */
function cutAllClips(slpPath, highlights) {
  const baseName = path.basename(slpPath, '.slp');
  return highlights.map((highlight, idx) => {
    const clipName = `${baseName}_clip${idx + 1}`;
    const file = cutClip(slpPath, highlight, clipName);
    return { file, ...highlight };
  });
}

module.exports = { cutClip, cutClipAsync, cutAllClips, CONFIG };
