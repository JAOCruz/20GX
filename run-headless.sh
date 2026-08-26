#!/bin/bash
# Wrapper para correr el pipeline sin monitor (headless) usando Xvfb.
# Uso:
#   ./run-headless.sh node process-replay.js /ruta/a/partida.slp

set -e

# libOpenGL.so.0 extraido manualmente del .deb de libglvnd
export LD_LIBRARY_PATH="/home/jay/slippi-pipeline/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH}"

# Xvfb ya esta instalado en Jarvis; -a busca un DISPLAY libre automaticamente
exec xvfb-run -a "$@"
