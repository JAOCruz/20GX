#!/bin/bash
# Sincroniza en vivo los replays de Slippi desde Mac a Jarvis.
# Solo escanea la carpeta del mes actual y archivos de los ultimos 10 min.

LOCAL_DIR="/Users/jay/Slippi"
REMOTE_HOST="jay@100.87.41.106"
REMOTE_DIR="/home/jay/slippi-live"

echo "[sync-slippi] Iniciando live sync ligero"

ssh -o ConnectTimeout=10 "$REMOTE_HOST" "mkdir -p $REMOTE_DIR"

cd "$LOCAL_DIR" || exit 1

while true; do
  CURRENT_MONTH=$(date +%Y-%m)
  if [ -d "$CURRENT_MONTH" ]; then
    if find "$CURRENT_MONTH" -name "*.slp" -mmin -10 | grep -q .; then
      find "$CURRENT_MONTH" -name "*.slp" -mmin -10 -print0 | rsync --files-from=- --from0 -avz -e "ssh -o ConnectTimeout=10" ./ "$REMOTE_HOST:$REMOTE_DIR/" >> /tmp/sync-slippi.log 2>&1
    fi
  fi
  sleep 5
done
