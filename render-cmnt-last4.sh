#!/bin/bash
set -e
cd /home/jay/slippi-pipeline
export CLIPS_OUTPUT_DIR=clips-auto/cmnt-last4
export PADDING_BEFORE=7
export PADDING_AFTER=2

GAMES=(
  replays/2026-07/Game_20260711T210134.slp
  replays/2026-07/Game_20260711T210415.slp
  replays/2026-07/Game_20260711T210637.slp
  replays/2026-07/Game_20260711T210836.slp
)

LOG=/tmp/render-cmnt-last4.log
> "$LOG"

for game in "${GAMES[@]}"; do
  echo "=== $(date) - $game ===" | tee -a "$LOG"
  node stock-clips.js "$game" 15 2 >> "$LOG" 2>&1
  echo "" | tee -a "$LOG"
  sleep 5
done

echo "=== $(date) - Enviando Telegram ===" | tee -a "$LOG"
TELEGRAM_BOT_TOKEN='8988066588:AAGmnziOt1ATk9j8IseiAxHyyA50DCq-kgU' TELEGRAM_CHAT_ID='6932565341' node send-telegram.js clips-auto/cmnt-last4 >> "$LOG" 2>&1

echo "=== $(date) - Listo ===" | tee -a "$LOG"
