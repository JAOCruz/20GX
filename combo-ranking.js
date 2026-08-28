// combo-ranking.js
// Motor de ranking personalizado de combos/stocks.
//
// El usuario define REGLAS ordenadas por prioridad (la primera manda).
// Tipos de regla:
//   containsMove   — el combo contiene el golpe (moveId) en cualquier punto
//   startsWithMove — el combo EMPIEZA con ese golpe
//   endsWithMove   — el combo TERMINA con ese golpe (kill move)
//   minHits        — el combo tiene al menos N golpes
//   maxKillPercent — el kill fue a un % menor o igual a N (kill temprano)
//
// Cada regla puede limitarse a un personaje (characterId) — los moveIds de
// slippi-js son genéricos (Neutral B = 18 para todos), así que
// "Falcon Punch" = containsMove(18) + characterId CAPTAIN_FALCON(2).
//
// Orden: sort por tiers — los items que matchean la regla 0 van primero;
// dentro de ese grupo, los que matchean la regla 1, etc. Empates se
// resuelven por comboLength desc y luego score desc (el ranking default).

const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, 'combo-ranking.json');

const RULE_TYPES = ['containsMove', 'startsWithMove', 'endsWithMove', 'minHits', 'maxKillPercent'];

function loadRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) return { rules: [] };
    const data = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
    const rules = Array.isArray(data?.rules) ? data.rules.filter(isValidRule) : [];
    return { rules };
  } catch (e) {
    console.warn('[combo-ranking] Config corrupta, ignorando:', e.message);
    return { rules: [] };
  }
}

function saveRules(rules) {
  const clean = (Array.isArray(rules) ? rules : []).filter(isValidRule).slice(0, 20);
  const tmp = `${RULES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ rules: clean }, null, 2));
  fs.renameSync(tmp, RULES_FILE);
  return clean;
}

function isValidRule(r) {
  if (!r || typeof r !== 'object') return false;
  if (!RULE_TYPES.includes(r.type)) return false;
  if (r.type === 'minHits' || r.type === 'maxKillPercent') {
    return Number.isFinite(r.value) && r.value >= 0;
  }
  return Number.isFinite(r.moveId);
}

// item: shape de topComboItems — necesita comboMoves (array de moveIds) o
// killMoveId; player.characterId para el scope por personaje.
function ruleMatches(rule, item) {
  if (rule.characterId != null && item.player?.characterId !== rule.characterId) return false;
  switch (rule.type) {
    case 'containsMove':
      return Array.isArray(item.comboMoves) && item.comboMoves.includes(rule.moveId);
    case 'startsWithMove':
      return Array.isArray(item.comboMoves) && item.comboMoves.length > 0 && item.comboMoves[0] === rule.moveId;
    case 'endsWithMove':
      // Con cache viejo (sin comboMoves) usamos killMoveId como fallback.
      if (Array.isArray(item.comboMoves) && item.comboMoves.length > 0) {
        return item.comboMoves[item.comboMoves.length - 1] === rule.moveId;
      }
      return item.killMoveId != null && item.killMoveId === rule.moveId;
    case 'minHits':
      return (item.comboLength || 0) >= rule.value;
    case 'maxKillPercent':
      return typeof item.killPercent === 'number' && item.killPercent <= rule.value;
    default:
      return false;
  }
}

// Ordena items aplicando las reglas en orden de prioridad.
function applyCustomRanking(items, rules) {
  const valid = (rules || []).filter(isValidRule);
  if (valid.length === 0) return items;
  // Pre-computar los matches de cada item para no repetir trabajo en el sort.
  const scored = items.map((item) => ({
    item,
    matches: valid.map((r) => ruleMatches(r, item)),
  }));
  scored.sort((a, b) => {
    for (let i = 0; i < valid.length; i++) {
      const am = a.matches[i] ? 1 : 0;
      const bm = b.matches[i] ? 1 : 0;
      if (am !== bm) return bm - am;
    }
    return (b.item.comboLength - a.item.comboLength) || (b.item.score - a.item.score);
  });
  return scored.map((s) => s.item);
}

module.exports = { RULES_FILE, RULE_TYPES, loadRules, saveRules, ruleMatches, applyCustomRanking };
