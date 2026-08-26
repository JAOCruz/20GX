// scan-worker.js
// Worker standalone para escanear replays y guardar cache.
// El dashboard-server lo lanza como proceso hijo para no bloquear el API.

const { scanReplays, saveCachedGames, loadCachedGames } = require('./scan-replays');
const { detectSets } = require('./detect-sets');
const { loadSets } = require('./sets-store');

const REPLAYS_DIR = process.env.REPLAYS_DIR || '/home/jay/slippi-live';
const includeDuration = process.argv.includes('--duration=1') || process.argv.includes('--duration');
const maxAgeArg = process.argv.find((a) => a.startsWith('--max-age-days='));
const maxAgeDays = maxAgeArg ? Number(maxAgeArg.split('=')[1]) || 0 : 0;

async function main() {
  const start = Date.now();
  console.log(`[scan-worker] Iniciando scan de ${REPLAYS_DIR} (includeDuration=${includeDuration}, maxAgeDays=${maxAgeDays})`);

  const games = await scanReplays(REPLAYS_DIR, {
    includeDuration,
    batchSize: 4,
    maxAgeDays,
    progressCallback: (done, total) => {
      if (done % 10 === 0 || done === total) {
        console.log(`[scan-worker] ${done}/${total}`);
      }
    },
  });

  // Scan parcial (por días): merge con el cache existente para no perder
  // los juegos viejos que esta pasada no escaneó.
  let finalGames = games;
  if (maxAgeDays > 0) {
    const existing = loadCachedGames();
    if (existing?.games?.length) {
      const byPath = new Map(existing.games.map((g) => [g.filePath, g]));
      for (const g of games) byPath.set(g.filePath, g);
      finalGames = [...byPath.values()];
      finalGames.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      console.log(`[scan-worker] Merge con cache: ${games.length} recientes + cache → ${finalGames.length} total`);
    }
  }

  saveCachedGames(finalGames, { includeDuration, sourceDir: REPLAYS_DIR, maxAgeDays });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[scan-worker] Cache guardado: ${finalGames.length} juegos en ${elapsed}s`);

  // Auto-detectar sets nuevos sobre los juegos recién escaneados.
  try {
    const result = detectSets(finalGames, loadSets());
    if (result.added > 0) {
      console.log(`[scan-worker] Sets detectados: ${result.added} nuevo(s)`);
    }
  } catch (err) {
    console.warn('[scan-worker] Error detectando sets:', err.message);
  }
}

main().catch((err) => {
  console.error('[scan-worker] Error:', err);
  process.exit(1);
});
