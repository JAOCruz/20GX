# Pipeline de highlights de Slippi

Detecta los momentos destacados de una partida de Melee directamente desde
el archivo `.slp` (sin video grabado), los corta en clips `.mp4`, y los sube
a un canal de Discord para revisión antes de publicarlos en YouTube.

## Estado actual en Jarvis

- ✅ `slp-to-video` instalado y linkeado globalmente.
- ✅ Slippi Dolphin (`dolphin-emu`) descargado y extraído en `./squashfs-root/usr/bin/dolphin-emu`.
- ✅ `libOpenGL.so.0` extraído manualmente porque el servidor no tiene GPU.
- ✅ `Xvfb` disponible para correr Dolphin sin monitor.
- ✅ ffmpeg ya estaba instalado (`/usr/bin/ffmpeg`).
- ✅ Replay de prueba en `/home/jay/Game_20260709T123752.slp`.
- ⏳ **Falta**: el ISO de Melee 1.02 NTSC.

## Instalación (ya hecha en Jarvis)

```bash
cd /home/jay/slippi-pipeline
npm install

git clone https://github.com/MiguelTornero/slp-to-video.git
cd slp-to-video
npm install --no-optional
npm run build
npm link
cd ..
```

## Configuración

Define estas variables de entorno (o exporta antes de correr):

```bash
export SSBM_ISO_PATH="/home/jay/slippi-pipeline/melee.iso"  # <-- sube tu ISO aqui
export SLIPPI_DOLPHIN_PATH="/home/jay/slippi-pipeline/squashfs-root/usr/bin/dolphin-emu"
export FFMPEG_PATH="/usr/bin/ffmpeg"          # opcional, ya esta en PATH
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
export CLIPS_OUTPUT_DIR="/home/jay/slippi-pipeline/clips"
```

> El dolphin path ya tiene default en `cut-clips.js`, así que solo es obligatorio `SSBM_ISO_PATH`.

## Uso

### Headless (sin monitor)

```bash
cd /home/jay/slippi-pipeline
./run-headless.sh node process-replay.js /home/jay/Game_20260709T123752.slp
```

El wrapper `run-headless.sh` hace dos cosas:
1. Pone en `LD_LIBRARY_PATH` la `libOpenGL.so.0` extraída.
2. Corre todo bajo `xvfb-run -a` para que Dolphin tenga un display virtual.

### Probar solo la detección de highlights

```bash
node detect-highlights.js /home/jay/Game_20260709T123752.slp
```

## Cómo funciona

1. `detect-highlights.js` lee el `.slp` con `@slippi/slippi-js` y busca
   combos de 3+ golpes o que terminen en kill. Fusiona ventanas cercanas
   y les agrega colchón de 1-1.5s antes/después.
2. `cut-clips.js` llama a `slp-to-video` por cada ventana, que abre
   Playback Dolphin, reproduce solo ese rango de frames, y usa el frame
   dumping de Dolphin + ffmpeg para generar el `.mp4` — sin grabar pantalla.
3. `post-to-discord.js` sube cada clip al canal de revisión con un mensaje
   pidiendo reacción ✅.

## Lo que falta conectar (siguiente paso)

1. **Subir el ISO de Melee** a `/home/jay/slippi-pipeline/melee.iso` (o donde prefieras y actualizar `SSBM_ISO_PATH`).
2. Correr `./run-headless.sh node process-replay.js ...` y revisar que los clips se vean bien.
3. Después, conectar Discord/YouTube: los webhooks solo **envían** mensajes — no pueden **escuchar** reacciones. Para que el ✅ dispare la subida a YouTube necesitas un bot de Discord (`discord.js`) escuchando `messageReactionAdd` y llamando al MCP de Playwright.
