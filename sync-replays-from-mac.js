// sync-replays-from-mac.js
// Sincroniza carpetas de replays desde la Mac a Jarvis via rsync/ssh.
// Por defecto sincroniza los ultimos 2 meses para no copiar todo el historial.
//
// Uso:
//   node sync-replays-from-mac.js [meses-atras]

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAC_HOST = process.env.MAC_HOST || 'jay@100.69.130.90';
const MAC_KEY = process.env.MAC_KEY || '/home/jay/.ssh/id_ed25519_kimi_mac';
const MAC_SOURCE = '/Users/jay/Slippi';
const LOCAL_DEST = process.env.REPLAYS_DIR || path.join(__dirname, 'replays');

function getRecentFolders(monthsBack = 2) {
  const folders = [];
  const now = new Date();
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    folders.push(`${y}-${m}`);
  }
  return folders;
}

function syncFolder(folder) {
  const localFolder = path.join(LOCAL_DEST, folder);
  if (!fs.existsSync(localFolder)) fs.mkdirSync(localFolder, { recursive: true });

  console.log(`[sync] Sincronizando ${folder}...`);
  const result = spawnSync('rsync', [
    '-avz', '--progress',
    '-e', `ssh -i ${MAC_KEY}`,
    `${MAC_HOST}:${MAC_SOURCE}/${folder}/`,
    `${localFolder}/`,
  ], { stdio: 'inherit' });

  if (result.error) throw result.error;
  return result.status === 0;
}

function main() {
  const monthsBack = parseInt(process.argv[2] || '2', 10);
  const folders = getRecentFolders(monthsBack);
  console.log(`[sync] Sincronizando carpetas: ${folders.join(', ')}`);

  for (const folder of folders) {
    syncFolder(folder);
  }

  console.log('[sync] Listo.');
}

main();
