// slippi-watcher.js
// Observa una carpeta de replays de Slippi y emite los archivos .slp nuevos.
// Usa polling en vez de fs.watch para evitar eventos duplicados y problemas
// con archivos que aún se están escribiendo por red.

const fs = require('fs');
const path = require('path');

function getAllSlpFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.slp')) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

function watchReplays(dir, onNewFile, { intervalMs = 5000, settleMs = 5000 } = {}) {
  let known = new Set(getAllSlpFiles(dir));
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    const current = getAllSlpFiles(dir);
    for (const filePath of current) {
      if (!known.has(filePath)) {
        known.add(filePath);
        // Esperar a que el archivo termine de escribirse
        setTimeout(() => {
          if (!stopped) onNewFile(filePath);
        }, settleMs);
      }
    }
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    knownCount: () => known.size,
  };
}

module.exports = { watchReplays, getAllSlpFiles };
