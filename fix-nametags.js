// fix-nametags.js
// Crea una copia temporal de un .slp con nametags vacíos rellenados.
// Por qué: el Playback Dolphin renderiza "undefined" cuando el nametag de un
// jugador está vacío (replays offline importados suelen traerlo así), y ese
// texto queda quemado en el video final sobre el HUD de porcentajes.
//
// El .slp es binario: sección raw con eventos [cmd][payload]. El evento
// Game Start (0x36) trae por jugador un nametag de 16 bytes Shift_JIS en
// offset 0x161 + playerIndex*0x10 del payload. Reemplazar bytes por un nombre
// ASCII de <=8 chars no cambia el tamaño del archivo (se rellena con \0).
//
// Uso lib:  const { patchSlpNametags } = require('./fix-nametags');
//           patchSlpNametags(src, dest, { 1: 'CUENTI', 2: 'LEIN' })  // por port
// Uso CLI:  node fix-nametags.js <src.slp> <dest.slp> "CUENTI" "LEIN"

const fs = require('fs');
const { SlippiGame } = require('@slippi/slippi-js');

const CMD_PAYLOAD_SIZES = 0x35;
const CMD_GAME_START = 0x36;
const NAMETAG_BASE = 0x161;
const NAMETAG_LEN = 0x10;
const MAX_TAG_CHARS = 8; // el HUD de Melee recorta tags largos

// Localiza el offset absoluto del payload del primer evento Game Start en la
// sección raw del archivo. Estructura: 11 bytes de cabecera ("{U\x03raw[$U\x01l"),
// evento 0x35 (payload sizes), luego el stream de eventos.
function findGameStartPayloadOffset(buf) {
  const RAW_PREFIX = Buffer.from([0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55]); // "{U\x03raw[$U"
  const rawStart = buf.indexOf(RAW_PREFIX);
  if (rawStart === -1) throw new Error('No se encontró la sección raw del .slp');
  let pos = rawStart + RAW_PREFIX.length;
  // Tras el prefix viene el largo de la sección raw en ubjson: opcionalmente
  // '#', luego un marcador de tipo ('U'=u8, 'l'=i32, 'L'=i64) y sus bytes BE.
  if (buf[pos] === 0x23) pos += 1;
  const t = buf[pos];
  pos += 1 + (t === 0x55 ? 1 : t === 0x6c ? 4 : 8);

  if (buf[pos] !== CMD_PAYLOAD_SIZES) throw new Error('El primer evento no es payload-sizes (0x35)');
  const sizesLen = buf[pos + 1];
  const sizes = {};
  for (let i = 0; i + 3 <= sizesLen; i += 3) {
    sizes[buf[pos + 2 + i]] = buf.readUInt16BE(pos + 3 + i);
  }
  const pairBytes = Math.floor(sizesLen / 3) * 3;

  // El Game Start sigue inmediatamente; el byte de largo a veces cuenta un
  // byte de más/menos según el writer, así que probamos los vecinos.
  // OJO: los offsets de slippi-js (0x161 etc.) cuentan DESDE el byte de
  // comando, no desde después — por eso devolvemos cand, no cand+1.
  const base = pos + 2 + pairBytes;
  for (const cand of [base - 1, base, base + 1]) {
    if (buf[cand] === CMD_GAME_START) return cand;
  }
  throw new Error('No se encontró evento Game Start');
}

// Lee settings con slippi-js para saber qué nametags vienen vacíos y en qué
// índice de jugador (el array de settings es 0-based; namesByPort es 1-based).
function emptyNametagIndices(slpPath) {
  const game = new SlippiGame(slpPath);
  const players = game.getSettings()?.players || [];
  const empty = [];
  players.forEach((p, i) => {
    if (!p.nametag || !p.nametag.trim()) empty.push({ index: i, port: p.port });
  });
  return empty;
}

/**
 * Escribe `dest` como copia de `src` con los nametags vacíos rellenados.
 * @param {string} src  .slp original (no se modifica)
 * @param {string} dest copia parcheada
 * @param {Object<string,string>} namesByPort  ej. { '1': 'CUENTI', '2': 'LEIN' }
 * @returns {number} cuántos nametags se parchearon
 */
function patchSlpNametags(src, dest, namesByPort) {
  const empty = emptyNametagIndices(src);
  if (empty.length === 0) {
    fs.copyFileSync(src, dest);
    return 0;
  }
  const buf = fs.readFileSync(src);
  const gameStartAbs = findGameStartPayloadOffset(buf);
  // El nametag se guarda en Shift_JIS con ASCII fullwidth (ＣＵＥＮ, no CUEN).
  const iconv = require('iconv-lite');
  const toFullwidth = (s) => s.split('').map((c) => {
    const code = c.charCodeAt(0);
    return code >= 0x21 && code <= 0x7e ? String.fromCharCode(code + 0xfee0) : c;
  }).join('');
  let patched = 0;
  for (const { index, port } of empty) {
    const name = (namesByPort[String(port)] || '').trim();
    if (!name) continue;
    const tag = toFullwidth(name.toUpperCase().slice(0, MAX_TAG_CHARS));
    const encoded = iconv.encode(tag, 'Shift_JIS');
    const off = gameStartAbs + NAMETAG_BASE + index * NAMETAG_LEN;
    encoded.copy(buf, off, 0, Math.min(encoded.length, NAMETAG_LEN - 1));
    buf.fill(0, off + Math.min(encoded.length, NAMETAG_LEN - 1), off + NAMETAG_LEN);
    patched += 1;
  }
  fs.writeFileSync(dest, buf);
  return patched;
}

module.exports = { patchSlpNametags };

if (require.main === module) {
  const [src, dest, p1, p2] = process.argv.slice(2);
  if (!src || !dest) {
    console.error('Uso: node fix-nametags.js <src.slp> <dest.slp> [nombreP1] [nombreP2]');
    process.exit(1);
  }
  const names = {};
  if (p1) names['1'] = p1;
  if (p2) names['2'] = p2;
  const n = patchSlpNametags(src, dest, names);
  console.log(`Parcheados ${n} nametag(s) -> ${dest}`);
}
