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

      const combo = findKillCombo(combos, killerIndex, victimIndex, f);
      if (combo && combo.moves && combo.moves.length > 0) {
        const nonPummel = combo.moves.filter((m) => m.moveId !== 52);
        const lastMove = nonPummel[nonPummel.length - 1] || combo.moves[combo.moves.length - 1];
        event.killMove = moves.getMoveName(lastMove.moveId);
        event.killPercent = Math.round(combo.endPercent);
        // Los pummels (moveId 52) NO cuentan como golpes del combo;
        // el grab y los throws (53-56) sí.
        event.comboLength = combo.moves.filter((m) => m.moveId !== 52).length;
        // Frame donde empezó el combo que mató: permite que el clip arranque
        // con el neutral antes del punish, no 7s antes de la muerte.
        event.comboStartFrame = combo.startFrame ?? null;
      }

      events.push(event);
    }
    previousStocks = post.stocksRemaining;
  }
  return events;
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

module.exports = { detectStocks, findKills };

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
