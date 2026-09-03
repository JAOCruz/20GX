// detect-stocks.js
// Detecta los stocks que cada jugador le quitó al otro.
//
// Uso:
//   node detect-stocks.js <slpPath> <playerAIndex> <playerBIndex>

const fs = require('fs');
const { SlippiGame, Character, Stage, moves } = require('@slippi/slippi-js');

const FPS = 60;

function findKillCombo(combos, killerIndex, victimIndex, deathFrame) {
  // Busca el combo que mató en las cercanías del frame de muerte.
  let best = null;
  let bestDelta = Infinity;
  for (const combo of combos) {
    if (combo.playerIndex !== victimIndex) continue;
    if (combo.lastHitBy !== killerIndex) continue;
    if (!combo.didKill) continue;
    const delta = Math.abs(combo.endFrame - deathFrame);
    if (delta < bestDelta && delta <= 90) {
      bestDelta = delta;
      best = combo;
    }
  }
  return best;
}

// Adjunta al evento los datos del combo que mató (sin pummels: moveId 52 no
// cuenta como golpe; el grab y los throws 53-56 sí).
function attachKillCombo(event, combos, killerIndex, victimIndex, deathFrame) {
  const combo = findKillCombo(combos, killerIndex, victimIndex, deathFrame);
  if (combo && combo.moves && combo.moves.length > 0) {
    const nonPummel = combo.moves.filter((m) => m.moveId !== 52);
    const lastMove = nonPummel[nonPummel.length - 1] || combo.moves[combo.moves.length - 1];
    event.killMove = moves.getMoveName(lastMove.moveId);
    event.killMoveId = lastMove.moveId;
    // Secuencia completa de golpes del combo que mató (sin pummels):
    // la base del ranking personalizado por movimientos.
    event.comboMoves = nonPummel.map((m) => m.moveId);
    event.killPercent = Math.round(combo.endPercent);
    event.comboLength = nonPummel.length;
    // Frame donde empezó el combo que mató: permite que el clip arranque
    // con el neutral antes del punish, no 7s antes de la muerte.
    event.comboStartFrame = combo.startFrame ?? null;
  }
  return event;
}

function findKills(game, combos, killerIndex, victimIndex) {
  const frames = game.getFrames();
  const events = [];
  let previousStocks = null;

  for (let f = -123; f <= 999999; f++) {
    const frame = frames[f];
    if (!frame || !frame.players || !frame.players[victimIndex]) continue;
    const post = frame.players[victimIndex].post;
    if (!post || typeof post.stocksRemaining !== 'number') continue;

    if (previousStocks !== null && post.stocksRemaining < previousStocks && post.lastHitBy === killerIndex) {
      const event = {
        index: events.length,
        frame: f,
        timeSeconds: Math.round((f + 123) / FPS),
        stocksRemaining: post.stocksRemaining,
      };
      attachKillCombo(event, combos, killerIndex, victimIndex, f);
      events.push(event);
    }
    previousStocks = post.stocksRemaining;
  }
  return events;
}

// Detecta TODAS las caídas de stock de ambos jugadores en una sola pasada.
// Si el juego no atribuye el kill al oponente (lastHitBy distinto: SDs o
// kills sin golpe reciente), el evento queda con killerIndex null y
// sd: true en vez de desaparecer de la lista.
function findAllStockEvents(game, combos, indexA, indexB) {
  const frames = game.getFrames();
  const events = [];
  const prevStocks = {};

  for (let f = -123; f <= 999999; f++) {
    const frame = frames[f];
    if (!frame || !frame.players) continue;
    for (const victimIndex of [indexA, indexB]) {
      const post = frame.players[victimIndex]?.post;
      if (!post || typeof post.stocksRemaining !== 'number') continue;
      const prev = prevStocks[victimIndex];
      prevStocks[victimIndex] = post.stocksRemaining;
      if (prev == null || post.stocksRemaining >= prev) continue;

      const opponent = victimIndex === indexA ? indexB : indexA;
      const killerIndex = post.lastHitBy === opponent ? opponent : null;
      const event = {
        index: events.length,
        frame: f,
        timeSeconds: Math.round((f + 123) / FPS),
        stocksRemaining: post.stocksRemaining,
        killerIndex,
        victimIndex,
        sd: killerIndex == null,
      };
      if (killerIndex != null) attachKillCombo(event, combos, killerIndex, victimIndex, f);
      events.push(event);
    }
  }
  return events;
}

// Cuando el juego termina en quit (LRAS, gameEndMethod 7) no hay muerte del
// último stock: el perdedor se sale del juego. Generamos un evento sintético
// al final del juego, con el último punish contra el que se rindió como
// contexto del clip (el "combo antes del quit").
function findQuitEvent(game, combos, indexA, indexB) {
  let gameEnd = null;
  try {
    gameEnd = game.getGameEnd?.();
  } catch {
    gameEnd = null;
  }
  if (!gameEnd || gameEnd.gameEndMethod !== 7) return null;
  const quitter = gameEnd.lrasInitiatorIndex;
  if (quitter !== indexA && quitter !== indexB) return null;
  const killer = quitter === indexA ? indexB : indexA;

  const lastFrame = game.getMetadata()?.lastFrame;
  if (typeof lastFrame !== 'number') return null;

  const event = {
    frame: lastFrame,
    timeSeconds: Math.round((lastFrame + 123) / FPS),
    stocksRemaining: null,
    killerIndex: killer,
    victimIndex: quitter,
    quit: true,
  };

  // Último conversion del ganador contra el que se rindió, como contexto.
  let lastConv = null;
  for (const c of combos) {
    if (c.playerIndex !== quitter || c.lastHitBy !== killer) continue;
    if (!lastConv || c.endFrame > lastConv.endFrame) lastConv = c;
  }
  if (lastConv && Array.isArray(lastConv.moves) && lastConv.moves.length > 0) {
    const nonPummel = lastConv.moves.filter((m) => m.moveId !== 52);
    if (nonPummel.length > 0) {
      const lastMove = nonPummel[nonPummel.length - 1];
      event.killMove = moves.getMoveName(lastMove.moveId);
      event.killMoveId = lastMove.moveId;
      event.comboMoves = nonPummel.map((m) => m.moveId);
      event.killPercent = Math.round(lastConv.endPercent);
      event.comboLength = nonPummel.length;
      event.comboStartFrame = lastConv.startFrame ?? null;
    }
  }
  return event;
}

function detectStocks(slpPath, playerAIndex, playerBIndex) {
  const game = new SlippiGame(slpPath);
  const settings = game.getSettings();
  const players = settings.players;

  const playerA = players.find((p) => p.playerIndex === playerAIndex);
  const playerB = players.find((p) => p.playerIndex === playerBIndex);

  if (!playerA || !playerB) {
    throw new Error('No se encontraron los jugadores solicitados');
  }

  const stats = game.getStats();
  const combos = stats?.conversions || stats?.combos || [];
  const stocksAtoB = findKills(game, combos, playerA.playerIndex, playerB.playerIndex);
  const stocksBtoA = findKills(game, combos, playerB.playerIndex, playerA.playerIndex);

  const latest = game.getLatestFrame();
  const durationSeconds = latest && typeof latest.frame === 'number' ? Math.round((latest.frame + 123) / FPS) : 0;

  return {
    slpPath,
    stage: Stage[settings.stageId] || settings.stageId,
    durationSeconds,
    playerA: {
      playerIndex: playerA.playerIndex,
      charId: playerA.characterId,
      charName: Character[playerA.characterId] || playerA.characterId,
      name: playerA.connectCode || playerA.displayName,
    },
    playerB: {
      playerIndex: playerB.playerIndex,
      charId: playerB.characterId,
      charName: Character[playerB.characterId] || playerB.characterId,
      name: playerB.connectCode || playerB.displayName,
    },
    stocksAtoB,
    stocksBtoA,
  };
}

module.exports = { detectStocks, findKills, findAllStockEvents, findQuitEvent };

if (require.main === module) {
  const slpPath = process.argv[2];
  const playerAIndex = parseInt(process.argv[3], 10);
  const playerBIndex = parseInt(process.argv[4], 10);
  if (!slpPath || isNaN(playerAIndex) || isNaN(playerBIndex)) {
    console.error('Uso: node detect-stocks.js <slpPath> <playerAIndex> <playerBIndex>');
    process.exit(1);
  }
  console.log(JSON.stringify(detectStocks(slpPath, playerAIndex, playerBIndex), null, 2));
}
