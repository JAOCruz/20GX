// find-best-clips.js
// Escanea una carpeta de .slp y encuentra los mejores clips por matchup.
// Optimizado: parsea cada replay UNA VEZ y luego clasifica los combos.

const fs = require('fs');
const path = require('path');
const { detectHighlights, playerMatches } = require('./detect-highlights');

const REPLAYS_DIR = process.argv[2] || '/home/jay/slippi-pipeline/replays';
const OUTPUT_FILE = process.argv[3] || '/home/jay/slippi-pipeline/best-clips.json';

const MIN_MOVES = 4;

// Todos los nombres/tags que nos interesan
const ALL_TARGETS = ['HARD', 'JIMY', 'DOLF', 'ALOR', 'ALORIC', 'HAWK', 'HAWK2', 'ZURA'];

// Matchups que nos interesan para este video
const MATCHUPS = [
  { id: 'hard-vs-dolf',  attackers: ['HARD', 'JIMY'], victims: ['DOLF'],  label: 'HARD/JIMY vs DOLF' },
  { id: 'dolf-vs-hard',  attackers: ['DOLF'],         victims: ['HARD', 'JIMY'], label: 'DOLF vs HARD/JIMY' },
  { id: 'hard-vs-alor',  attackers: ['HARD', 'JIMY'], victims: ['ALOR', 'ALORIC'], label: 'HARD/JIMY vs ALORIC' },
  { id: 'hard-vs-hawk2', attackers: ['HARD', 'JIMY'], victims: ['HAWK', 'HAWK2'], label: 'HARD/JIMY vs HAWK2' },
  { id: 'hard-vs-zura',  attackers: ['HARD', 'JIMY'], victims: ['ZURA'], label: 'HARD/JIMY vs ZURA' },
];

function findSlpFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSlpFiles(fullPath));
    } else if (entry.name.endsWith('.slp') && !entry.name.startsWith('._')) {
      results.push(fullPath);
    }
  }
  return results;
}

function scoreClip(clip) {
  const moveCount = clip.combo?.moves?.length || 0;
  const duration = clip.endFrame - clip.startFrame;
  const hasKill = clip.stockLossFrame !== null ? 1 : 0;
  return moveCount * 1000 + duration * 0.5 + hasKill * 200;
}

async function main() {
  const files = findSlpFiles(REPLAYS_DIR);
  console.log(`[find-best] ${files.length} replays encontrados.`);

  const candidates = {};
  for (const m of MATCHUPS) candidates[m.id] = [];

  let processed = 0;
  for (const slpPath of files) {
    processed++;
    if (processed % 50 === 0) {
      console.log(`[find-best] ${processed}/${files.length}...`);
    }

    try {
      // Detectamos todos los clips donde cualquiera de nuestros targets es atacante
      const allClips = detectHighlights(slpPath, {
        attackers: ALL_TARGETS,
        victims: null, // cualquiera
        minMoves: MIN_MOVES,
        maxMoves: Infinity,
        requireKill: true,
        allowInterrupted: true,
        padBeforeSeconds: 3.0,
        padAfterSeconds: 2.0,
        fastMode: true, // escaneo rapido: no carga frames
      });

      for (const clip of allClips) {
        for (const m of MATCHUPS) {
          const isAttacker = playerMatches(clip.aggressor, m.attackers);
          const isVictim = playerMatches(clip.victim, m.victims);
          if (isAttacker && isVictim) {
            candidates[m.id].push({
              slpPath,
              matchup: m.id,
              label: m.label,
              startFrame: clip.startFrame,
              endFrame: clip.endFrame,
              reason: clip.reason,
              stockLossFrame: clip.stockLossFrame,
              combo: clip.combo,
              score: scoreClip(clip),
            });
          }
        }
      }
    } catch (e) {
      console.warn(`[find-best] Error en ${slpPath}:`, e.message);
    }
  }

  // Ordenar por score
  for (const m of MATCHUPS) {
    candidates[m.id].sort((a, b) => b.score - a.score);
  }

  const summary = MATCHUPS.map((m) => ({
    id: m.id,
    label: m.label,
    count: candidates[m.id].length,
    top: candidates[m.id].slice(0, 5).map((c) => ({
      slpPath: c.slpPath,
      startFrame: c.startFrame,
      endFrame: c.endFrame,
      reason: c.reason,
      score: c.score,
    })),
  }));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalReplays: files.length,
    matchups: summary,
    allCandidates: candidates,
  }, null, 2));

  console.log('\n[find-best] Resumen:');
  for (const s of summary) {
    console.log(`  ${s.label}: ${s.count} clips`);
    for (const t of s.top.slice(0, 3)) {
      console.log(`    - ${t.reason} | ${path.basename(t.slpPath)} [${t.startFrame}-${t.endFrame}]`);
    }
  }
  console.log(`\n[find-best] Guardado en ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('[find-best] Error:', err);
  process.exit(1);
});
