// post-to-discord.js
// Sube cada clip generado a un canal de Discord (via webhook) para que
// el cliente/usuario los revise antes de publicarlos en YouTube.
// Usa el mismo patron que ya usas en #scout-archive: lista numerada +
// reaccion para confirmar. La reaccion la debe escuchar tu bot de
// OpenClaw (no un webhook, los webhooks no reciben eventos) para
// disparar el siguiente paso (subida a YouTube via MCP de browser).

const fs = require('fs');

/**
 * @param {string} webhookUrl URL del webhook de Discord del canal, ej #media-review
 * @param {Array<{file:string, reason:string, startFrame:number, endFrame:number}>} clips
 */
async function postClipsForReview(webhookUrl, clips) {
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const form = new FormData();

    const content =
      `**Highlight ${i + 1}** — ${clip.reason}\n` +
      `Frames ${clip.startFrame}-${clip.endFrame} (~${((clip.endFrame - clip.startFrame) / 60).toFixed(1)}s)\n` +
      `Reacciona con ✅ para aprobar la subida a YouTube.`;

    form.append('payload_json', JSON.stringify({ content }));
    form.append(
      'file',
      new Blob([fs.readFileSync(clip.file)], { type: 'video/mp4' }),
      clip.file.split('/').pop()
    );

    const res = await fetch(webhookUrl, { method: 'POST', body: form });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord respondio ${res.status}: ${text}`);
    }

    console.log(`[post-to-discord] Subido: ${clip.file}`);

    // Pequena pausa para no saturar el rate limit del webhook
    await new Promise((r) => setTimeout(r, 1500));
  }
}

module.exports = { postClipsForReview };
