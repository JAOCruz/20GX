// scan-replays.js
// Escanea recursivamente una carpeta de .slp y devuelve metadata de cada replay.
// Usa cache en disco para no re-leer todos los archivos en cada request.

const fs = require('fs');
const path = require('path');
const { SlippiGame, Character, Stage } = require('@slippi/slippi-js');

const FPS = 60;
const MAIN_PLAYERS = [/HARD/i, /JIMY/i];

function findMainPlayer(players) {
  for (const pattern of MAIN_PLAYERS) {
    const p = players.find((pl) => pattern.test(pl.connectCode));
    if (p) return p;
  }
  return null;
}

function parseGameDate(fileName) {
  const m = fileName.match(/Game_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

function getCharacterName(id) {
  const name = Character[id];
  return typeof name === 'string' ? name : `Char ${id}`;
}

function formatStageName(raw) {
  if (!raw) return raw;
  return raw
    .replace(/_/g, ' ')
    .split(' ')
    .map((w) => (w.length <= 3 ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

function scanReplay(filePath) {
  try {
    const game = new SlippiGame(filePath);
    const settings = game.getSettings();
    if (!settings || !settings.players || settings.players.length < 2) return null;

    let durationSeconds = 0;
    try {
      const meta = game.getMetadata();
      const lastFrame = meta && typeof meta.lastFrame === 'number' ? meta.lastFrame : null;
      if (lastFrame != null) {
        durationSeconds = Math.max(0, Math.round((lastFrame + 123) / FPS));
      } else {
        const latest = game.getLatestFrame();
        if (latest && typeof latest.frame === 'number') {
          durationSeconds = Math.max(0, Math.round((latest.frame + 123) / FPS));
        }
      }
    } catch (e) {
      // ignore
    }

    const main = findMainPlayer(settings.players);
    const opponent = main
      ? settings.players.find((p) => p.playerIndex !== main.playerIndex)
      : null;

    // Ganador por stocks/porcentaje en el último frame (regla de Melee:
    // más stocks gana; empate de stocks → menor porcentaje; empate total
    // → null). Se usa como fallback y para corregir timeouts.
    const stocksWinner = () => {
      try {
        const latest = game.getLatestFrame();
        if (!latest || !latest.players) return null;
        let best = null;
        let tied = false;
        for (const p of settings.players) {
          const post = latest.players[p.playerIndex] && latest.players[p.playerIndex].post;
          if (!post) continue;
          const stocks = post.stocksRemaining ?? 0;
          const pct = post.percent ?? 0;
          if (!best || stocks > best.stocks || (stocks === best.stocks && pct < best.pct)) {
            tied = best != null && stocks === best.stocks && pct === best.pct;
            best = { playerIndex: p.playerIndex, stocks, pct };
          } else if (stocks === best.stocks && pct === best.pct) {
            tied = true;
          }
        }
        return best && best.stocks > 0 && !tied ? best.playerIndex : null;
      } catch (e) {
        return null;
      }
    };

    let winnerPlayerIndex = null;
    let placementsWinner = null;
    let gameEndMethod = null;
    let lrasInitiator = null;
    try {
      const gameEnd = game.getGameEnd();
      gameEndMethod = gameEnd ? gameEnd.gameEndMethod : null;
      if (gameEnd && typeof gameEnd.lrasInitiatorIndex === 'number' && gameEnd.lrasInitiatorIndex >= 0) {
        lrasInitiator = gameEnd.lrasInitiatorIndex;
      }
      if (gameEnd && Array.isArray(gameEnd.placements)) {
        const winner = gameEnd.placements.find((p) => p.position === 0);
        if (winner) placementsWinner = winner.playerIndex;
      }
    } catch (e) {
      // ignore
    }
    // Reglas de ganador según gameEndMethod (enum slippi):
    //   1 = TIME (timeout): los placements del .slp a veces contradicen
    //       stocks/porcentaje reales → manda la regla de Melee (stocks/pct
    //       del último frame); placements solo si hay empate total.
    //   7 = NO_CONTEST (LRAS, alguien quitteó): quien quitta PIERDE, sin
    //       importar stocks/pct. (Antes se trataba como timeout y daba el
    //       ganador al revés en sets donde el perdedor quittaba.)
    //   resto (2=GAME, 3=STOCK): placements confiables; stocks como
    //   fallback para replays offline viejos sin placements.
    if (gameEndMethod === 7) {
      if (lrasInitiator != null) {
        const other = settings.players.find((p) => p.playerIndex !== lrasInitiator);
        winnerPlayerIndex = other ? other.playerIndex : null;
      } else {
        winnerPlayerIndex = stocksWinner() ?? placementsWinner;
      }
    } else if (gameEndMethod === 1) {
      winnerPlayerIndex = stocksWinner() ?? placementsWinner;
    } else {
      winnerPlayerIndex = placementsWinner ?? stocksWinner();
    }

    let startTimestamp = null;
    let startAt = null;
    try {
      const meta = game.getMetadata();
      if (meta && meta.startAt) {
        const d = new Date(meta.startAt);
        if (!isNaN(d.getTime())) {
          startTimestamp = d.getTime();
          startAt = d.toISOString();
        }
      }
    } catch (e) {
      // ignore
    }
    if (!startTimestamp) {
      const parsed = parseGameDate(path.basename(filePath));
      if (parsed) {
        const d = new Date(parsed.replace(' ', 'T'));
        if (!isNaN(d.getTime())) {
          startTimestamp = d.getTime();
          startAt = d.toISOString();
        }
      }
    }

    return {
      filePath,
      fileName: path.basename(filePath),
      folder: path.basename(path.dirname(filePath)),
      date: parseGameDate(path.basename(filePath)),
      startAt,
      startTimestamp,
      stageId: settings.stageId,
      stage: formatStageName(Stage[settings.stageId]) || `Stage ${settings.stageId}`,
      duration: durationSeconds,
      players: settings.players.map((p) => ({
        playerIndex: p.playerIndex,
        connectCode: p.connectCode || '—',
        nametag: p.nametag || '',
        displayName: p.displayName || '',
        characterId: p.characterId,
        costumeId: p.characterColor ?? 0,
        characterName: getCharacterName(p.characterId),
      })),
      mainPlayer: main
        ? { playerIndex: main.playerIndex, connectCode: main.connectCode, displayName: main.displayName || '', characterId: main.characterId, costumeId: main.characterColor ?? 0, characterName: getCharacterName(main.characterId) }
        : null,
      opponent: opponent
        ? { playerIndex: opponent.playerIndex, connectCode: opponent.connectCode, displayName: opponent.displayName || '', characterId: opponent.characterId, costumeId: opponent.characterColor ?? 0, characterName: getCharacterName(opponent.characterId) }
        : null,
      winnerPlayerIndex,
    };
  } catch (err) {
    console.warn(`[scan-replays] Error leyendo ${filePath}:`, err.message);
    return null;
  }
}

function walkDir(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.slp')) {
      files.push(fullPath);
    }
  }
  return files;
}

function parseFileDate(fileName) {
  const m = fileName.match(/Game_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
}

function isWithinAge(fileName, maxAgeDays) {
  if (!maxAgeDays || maxAgeDays <= 0) return true;
  const date = parseFileDate(fileName);
  if (!date) return true; // si no se puede parsear, incluir por defecto
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  return date >= cutoff;
}

async function scanBatch(files, progressCallback, offset, total) {
  const promises = files.map(async (filePath, i) => {
    const g = scanReplay(filePath);
    const globalIdx = offset + i;
    if (progressCallback && globalIdx % 10 === 0) progressCallback(globalIdx + 1, total);
    return g;
  });
  const results = await Promise.all(promises);
  return results.filter(Boolean);
}

async function scanReplays(dir, { includeDuration = false, progressCallback = null, batchSize = 4, maxAgeDays = 0 } = {}) {
  if (!fs.existsSync(dir)) return [];
  const allFiles = walkDir(dir);
  const files = maxAgeDays > 0
    ? allFiles.filter((f) => isWithinAge(path.basename(f), maxAgeDays))
    : allFiles;
  const games = [];
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const results = await scanBatch(batch, progressCallback, i, files.length);
    games.push(...results);
    // ceder event loop entre batches para no bloquear el servidor
    await new Promise((r) => setTimeout(r, 0));
  }
  games.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return games;
}

function getCachePath() {
  return path.join(__dirname, 'dashboard', 'all-games-cache.json');
}

function loadCachedGames() {
  const cachePath = getCachePath();
  if (!fs.existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (Array.isArray(data.games)) return data;
    return null;
  } catch (e) {
    return null;
  }
}

function saveCachedGames(games, options = {}) {
  const cachePath = getCachePath();
  const dir = path.dirname(cachePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: games.length,
    options,
    games,
  }, null, 2));
}

module.exports = {
  scanReplays,
  scanReplay,
  loadCachedGames,
  saveCachedGames,
  getCachePath,
  formatStageName,
};

if (require.main === module) {
  const dir = process.argv[2] || path.join(__dirname, 'replays');
  scanReplays(dir).then((games) => {
    console.log(JSON.stringify(games, null, 2));
  });
}
