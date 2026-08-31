// slippi-ratings.js
// Ratings ranked de Slippi (ELO) por connect code, con cache en
// slippi-ratings.json (escritura atómica tmp + rename, TTL de 7 días).
//
// NUNCA rompe el pipeline: si la API falla, el jugador queda con
// rating = null (bonus de ELO 0 en el ranking de auto-shorts).
//
// Nota: el gateway viejo (gql-gateway-dot-slippi.uc.r.appspot.com) ya no
// expone GraphQL (sirve el SPA de slippi.gg); el endpoint actual es
// internal.slippi.gg/graphql con UserProfilePageQuery.

const fs = require('fs');
const path = require('path');

const RATINGS_FILE = path.join(__dirname, 'slippi-ratings.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // refetch si fetchedAt > 7 días
const FETCH_TIMEOUT_MS = 10_000;
const GQL_URL = 'https://internal.slippi.gg/graphql';

const QUERY = `query UserProfilePageQuery($cc: String!) {
  getUser(connectCode: $cc) {
    displayName
    rankedNetplayProfile {
      ratingOrdinal
      ratingUpdateCount
      dailyGlobalPlacement
      dailyRegionalPlacement
      continent
      wins
      losses
    }
  }
}`;

function log(...args) {
  console.log(`[slippi-ratings] ${new Date().toISOString()}`, ...args);
}

function loadCache() {
  if (!fs.existsSync(RATINGS_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    console.warn('[slippi-ratings] Cache corrupto, ignorando:', e.message);
    return {};
  }
}

function saveCache(cache) {
  const tmp = `${RATINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, RATINGS_FILE);
}

function isFresh(entry) {
  return entry && Number.isFinite(entry.fetchedAt) && Date.now() - entry.fetchedAt < TTL_MS;
}

// Consulta el rating de UN connect code (ej. "NOTME#882").
// Devuelve { rating, displayName, fetchedAt } — rating null si el jugador no
// tiene ranked o la API falló.
async function fetchRating(connectCode) {
  const code = String(connectCode || '').trim().toUpperCase();
  const empty = { rating: null, displayName: null, fetchedAt: Date.now() };
  if (!code) return empty;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://slippi.gg' },
        body: JSON.stringify({
          operationName: 'UserProfilePageQuery',
          query: QUERY,
          variables: { cc: code },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      throw new Error(data.errors[0].message || 'GraphQL error');
    }
    const user = data?.data?.getUser;
    const rating = user?.rankedNetplayProfile?.ratingOrdinal;
    return {
      rating: Number.isFinite(rating) ? rating : null,
      displayName: user?.displayName || null,
      fetchedAt: Date.now(),
    };
  } catch (e) {
    log(`Rating de ${code} no disponible:`, e.message);
    return empty;
  }
}

// Devuelve { "CODE#123": { rating, displayName, fetchedAt } } para los códigos
// pedidos, usando el cache cuando está fresco y refetcheando el resto.
// Secuencial a propósito: la API de Slippi rate-limita (~1 req/s).
async function getRatings(connectCodes) {
  const cache = loadCache();
  const out = {};
  let dirty = false;
  for (const raw of connectCodes || []) {
    const code = String(raw || '').trim().toUpperCase();
    if (!code || /^P\d+$/.test(code)) continue; // replays offline: 'P1'/'P2'
    if (out[code]) continue;
    const cached = cache[code];
    if (isFresh(cached)) {
      out[code] = cached;
      continue;
    }
    const entry = await fetchRating(code);
    cache[code] = entry;
    out[code] = entry;
    dirty = true;
  }
  if (dirty) {
    try {
      saveCache(cache);
    } catch (e) {
      log('No se pudo guardar el cache:', e.message);
    }
  }
  return out;
}

module.exports = { RATINGS_FILE, getRatings, fetchRating };
