#!/bin/bash
# copy-from-mac.sh
# Copia los replays de Slippi de los ultimos 2 meses desde la Mac a Jarvis.
# Asume que la carpeta mensual esta en /Users/jay/Slippi/YYYY-MM/

set -e

MAC_USER="jay"
MAC_HOST="100.69.130.90"
MAC_SSH_KEY="/home/jay/.ssh/id_ed25519_kimi_mac"
MAC_SLIPPI_DIR="/Users/jay/Slippi"
LOCAL_DIR="/home/jay/slippi-pipeline/replays"

# Meses actuales y anterior
CURRENT_MONTH=$(date +%Y-%m)
PREV_MONTH=$(date -d "last month" +%Y-%m 2>/dev/null || date -v-1m +%Y-%m 2>/dev/null)

mkdir -p "$LOCAL_DIR/$CURRENT_MONTH"
mkdir -p "$LOCAL_DIR/$PREV_MONTH"

echo "[copy] Copiando replays de $CURRENT_MONTH y $PREV_MONTH..."

for month in "$CURRENT_MONTH" "$PREV_MONTH"; do
  echo "[copy] Procesando $month..."
  ssh -i "$MAC_SSH_KEY" "$MAC_USER@$MAC_HOST" \
    "find $MAC_SLIPPI_DIR/$month -name '*.slp' -type f" 2>/dev/null | \
  while read -r slp; do
    rel="${slp#$MAC_SLIPPI_DIR/$month/}"
    dest="$LOCAL_DIR/$month/$rel"
    mkdir -p "$(dirname "$dest")"
    scp -i "$MAC_SSH_KEY" "$MAC_USER@$MAC_HOST:\"$slp\"" "$dest"
    echo "[copy] Copiado: $rel"
  done
done

echo "[copy] Listo. Replays en: $LOCAL_DIR"
