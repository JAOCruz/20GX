#!/bin/bash
# cleanup.sh
# Mata procesos de Dolphin/ffmpeg/slp-to-video que hayan quedado colgados.
# Uso: bash cleanup.sh

echo "[cleanup] Matando procesos pesados residuales..."

pkill -9 -f "dolphin-emu" 2>/dev/null || true
pkill -9 -f "Dolphin" 2>/dev/null || true
pkill -9 -f "ffmpeg" 2>/dev/null || true
pkill -9 -f "slp-to-video" 2>/dev/null || true

sleep 1

echo "[cleanup] Procesos restantes:"
ps aux | grep -iE "dolphin|ffmpeg|slp-to-video" | grep -v grep | wc -l
echo "[cleanup] Listo."
