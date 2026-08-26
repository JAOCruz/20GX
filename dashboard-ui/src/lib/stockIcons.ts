// Mapa de characterId + costumeId (characterColor) -> icono de stock descargado
// de https://imgur.com/a/melee-stock-icon-dump-vvljG
// Los archivos viven en /public/stocks-color/ y se sirven desde /stocks-color/

export type StockSuffix =
  | "DEF" | "BLK" | "BLU" | "GRN" | "RED" | "WHT" | "YLW" | "PNK" | "CYN" | "ORA" | "PRP";

// Nombres completos por characterId (para búsquedas/filtros en la UI).
export const CHAR_NAMES: Record<number, string> = {
  0: "Captain Falcon",
  1: "Donkey Kong",
  2: "Fox",
  3: "Mr. Game & Watch",
  4: "Kirby",
  5: "Bowser",
  6: "Link",
  7: "Luigi",
  8: "Mario",
  9: "Marth",
  10: "Mewtwo",
  11: "Ness",
  12: "Peach",
  13: "Pikachu",
  14: "Ice Climbers",
  15: "Jigglypuff",
  16: "Samus",
  17: "Yoshi",
  18: "Zelda",
  19: "Sheik",
  20: "Falco",
  21: "Young Link",
  22: "Dr. Mario",
  23: "Roy",
  24: "Pichu",
  25: "Ganondorf",
};

// Prefijos de 3 letras usados en el dump de Imgur.
const CHAR_PREFIX: Record<number, string> = {
  0: "CPT", // Captain Falcon
  1: "DKG", // Donkey Kong
  2: "FOX", // Fox
  3: "GNW", // Mr. Game & Watch
  4: "KIR", // Kirby
  5: "BOW", // Bowser
  6: "LNK", // Link
  7: "LUI", // Luigi
  8: "MAR", // Mario
  9: "MRT", // Marth
  10: "MEW", // Mewtwo
  11: "NES", // Ness
  12: "PEA", // Peach
  13: "PIK", // Pikachu
  14: "ICS", // Ice Climbers
  15: "PUF", // Jigglypuff
  16: "SAM", // Samus
  17: "YOS", // Yoshi
  18: "ZLD", // Zelda
  19: "ZLD", // Sheik (usa iconos de Zelda)
  20: "FAL", // Falco
  21: "YLK", // Young Link
  22: "DOC", // Dr. Mario
  23: "ROY", // Roy
  24: "PCH", // Pichu
  25: "GAN", // Ganondorf
};

// Orden de colores por costume index (characterColor) extraido del orden de
// los iconos en https://www.ssbwiki.com/Alternate_costume_(SSBM)
const COSTUME_ORDER: Record<number, StockSuffix[]> = {
  0: ["DEF", "BLK", "RED", "WHT", "GRN", "BLU"], // Captain Falcon
  1: ["DEF", "BLK", "RED", "BLU", "GRN"], // Donkey Kong
  2: ["DEF", "RED", "BLU", "GRN"], // Fox
  3: ["DEF", "RED", "BLU", "GRN"], // Mr. Game & Watch
  4: ["DEF", "YLW", "BLU", "RED", "GRN", "WHT"], // Kirby
  5: ["DEF", "RED", "BLU", "BLK"], // Bowser
  6: ["DEF", "RED", "BLU", "BLK", "WHT"], // Link
  7: ["DEF", "WHT", "BLU", "PNK"], // Luigi
  8: ["DEF", "YLW", "BLK", "BLU", "GRN"], // Mario
  9: ["DEF", "RED", "GRN", "BLK", "WHT"], // Marth
  10: ["DEF", "RED", "BLU", "GRN"], // Mewtwo
  11: ["DEF", "YLW", "BLU", "GRN"], // Ness
  12: ["DEF", "YLW", "WHT", "BLU", "GRN"], // Peach
  13: ["DEF", "RED", "BLU", "GRN"], // Pikachu
  14: ["DEF", "GRN", "ORA", "RED"], // Ice Climbers
  15: ["DEF", "RED", "BLU", "GRN", "YLW"], // Jigglypuff
  16: ["DEF", "PNK", "BLK", "GRN", "PRP"], // Samus
  17: ["DEF", "RED", "BLU", "YLW", "PNK", "CYN"], // Yoshi
  18: ["DEF", "RED", "BLU", "GRN", "WHT"], // Zelda
  19: ["DEF", "RED", "BLU", "GRN", "WHT"], // Sheik
  20: ["DEF", "RED", "BLU", "GRN"], // Falco
  21: ["DEF", "RED", "BLU", "WHT", "BLK"], // Young Link
  22: ["DEF", "RED", "BLU", "GRN", "BLK"], // Dr. Mario
  23: ["DEF", "RED", "BLU", "GRN", "YLW"], // Roy
  24: ["DEF", "RED", "BLU", "GRN"], // Pichu
  25: ["DEF", "RED", "BLU", "GRN", "PRP"], // Ganondorf
};

export function getStockIconPath(characterId?: number | null, costumeId?: number | null): string {
  if (characterId == null) return "/stocks-color/000000.png";
  const prefix = CHAR_PREFIX[characterId];
  if (!prefix) return "/stocks-color/000000.png";
  const order = COSTUME_ORDER[characterId] || [];
  const suffix = order[costumeId ?? 0] || "DEF";
  return `/stocks-color/${prefix}${suffix}.png`;
}
