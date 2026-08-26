#!/usr/bin/env bash
# render-send-copy.sh
# Render stock clips de un replay, los manda por Telegram y los copia a la Mac.
#
# Uso:
#   ./render-send-copy.sh <slpPath> <attackerCharId> <victimCharId> [etiqueta]
#
# Ejemplo:
#   ./render-send-copy.sh /home/jay/slippi-pipeline/replays/slim/Game_20260711T161426.slp 15 21 jiggly-younglink

set -euo pipefail

SLP_PATH="${1:?Falta ruta al .slp}"
ATTACKER="${2:?Falta attackerCharId}"
VICTIM="${3:?Falta victimCharId}"
LABEL="${4:-clip}"

export SSBM_ISO_PATH="${SSBM_ISO_PATH:-/home/jay/slippi-pipeline/melee.iso}"
export SLIPPI_DOLPHIN_PATH="${SLIPPI_DOLPHIN_PATH:-/home/jay/slippi-pipeline/playback-dolphin/Slippi_Playback-x86_64.AppImage}"
export CLIPS_OUTPUT_DIR="/home/jay/slippi-pipeline/clips-auto-${LABEL}"
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-8988066588:AAGmnziOt1ATk9j8IseiAxHyyA50DCq-kgU}"
export TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-6932565341}"

MAC_HOST="${MAC_HOST:-jay@100.69.130.90}"
MAC_KEY="${MAC_KEY:-/home/jay/.ssh/id_ed25519_kimi_mac}"
MAC_DEST_BASE="/Users/jay/Desktop/Slippi Clips"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Renderizando clips: ${LABEL} ==="
node "${SCRIPT_DIR}/stock-clips.js" "${SLP_PATH}" "${ATTACKER}" "${VICTIM}"

echo "=== Enviando por Telegram ==="
node "${SCRIPT_DIR}/send-telegram.js" "${CLIPS_OUTPUT_DIR}"

# Crear carpeta organizada en Mac con fecha del replay
BASENAME="$(basename "${SLP_PATH}" .slp)"
MAC_DEST="${MAC_DEST_BASE}/${LABEL}_${BASENAME}"
echo "=== Copiando a ${MAC_HOST}:${MAC_DEST} ==="
ssh -i "${MAC_KEY}" "${MAC_HOST}" "mkdir -p '${MAC_DEST}'"
scp -i "${MAC_KEY}" "${CLIPS_OUTPUT_DIR}"/*.mp4 "${MAC_HOST}: '${MAC_DEST}/'"

echo "=== Listo: ${LABEL} ==="
