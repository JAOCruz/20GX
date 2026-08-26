// upload-to-youtube.js
// Subida automatica de un clip a YouTube Studio usando Playwright.
// NOTA: requiere que tengas una sesion/cookies de YouTube validas,
// o que el navegador ya este logueado en youtube.com.
//
// Uso:
//   node upload-to-youtube.js /ruta/a/clip.mp4 "Titulo del video" "Descripcion"

const { chromium } = require('playwright');

const COOKIES_PATH = process.env.YT_COOKIES_PATH || './youtube-cookies.json';
const THUMBNAIL_PATH = process.env.YT_THUMBNAIL_PATH || null;

async function uploadToYouTube(videoPath, title, description) {
  const browser = await chromium.launch({ headless: false }); // headless:false para login inicial
  const context = await browser.newContext();

  // Cargar cookies si existen
  if (require('fs').existsSync(COOKIES_PATH)) {
    const cookies = JSON.parse(require('fs').readFileSync(COOKIES_PATH, 'utf-8'));
    await context.addCookies(cookies);
  }

  const page = await context.newPage();

  try {
    // 1. Abrir YouTube Studio upload
    await page.goto('https://studio.youtube.com/channel/videos/upload');

    // 2. Seleccionar archivo
    const fileInput = await page.locator('input[type=file]');
    await fileInput.setInputFiles(videoPath);

    // 3. Rellenar titulo y descripcion
    await page.fill('input#textbox[aria-label="Title (required)"]', title);
    await page.fill('textbox#textbox[aria-label="Tell viewers about your video"]', description);

    // 4. Esperar a que termine la subida
    await page.waitForFunction(
      () => document.body.innerText.includes('Processing will begin shortly'),
      { timeout: 300000 }
    );

    // 5. Miniatura opcional
    if (THUMBNAIL_PATH) {
      const thumbInput = await page.locator('input[type=file]').nth(1);
      await thumbInput.setInputFiles(THUMBNAIL_PATH);
    }

    // 6. Guardar cookies para la proxima vez
    const cookies = await context.cookies();
    require('fs').writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));

    console.log('[youtube] Subida completada (falta publicar manualmente o agendar).');
  } catch (e) {
    console.error('[youtube] Error durante la subida:', e.message);
    throw e;
  } finally {
    await browser.close();
  }
}

async function main() {
  const [videoPath, title, description] = process.argv.slice(2);
  if (!videoPath || !title) {
    console.error('Uso: node upload-to-youtube.js <clip.mp4> "Titulo" "Descripcion"');
    process.exit(1);
  }
  await uploadToYouTube(videoPath, title, description || '');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
