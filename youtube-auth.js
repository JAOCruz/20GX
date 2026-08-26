// youtube-auth.js — Autorización OAuth one-shot para YouTube Data API v3.
// Sin dependencias (Node 18+). Corre en una máquina CON navegador (la Mac):
//
//   node youtube-auth.js client_secret.json
//
// Abre el URL que imprime, autoriza con la cuenta del canal, y el script
// guarda youtube-token.json (access + refresh token) al lado del client secret.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const PORT = 3847;
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
].join(' ');

const secretPath = process.argv[2] || 'client_secret.json';
const secret = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
const creds = secret.installed || secret.web;
if (!creds) {
  console.error('client_secret.json inválido');
  process.exit(1);
}
const redirectUri = `http://localhost:${PORT}/oauth2callback`;

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString();
    const req = https.request(
      'https://oauth2.googleapis.com/token',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) reject(new Error(JSON.stringify(json)));
            else resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end('nope');
    return;
  }
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (err || !code) {
    res.writeHead(400).end('Error de autorización: ' + (err || 'sin code'));
    console.error('Error:', err || 'sin code');
    process.exit(1);
  }
  try {
    const tokens = await exchangeCode(code);
    if (!tokens.refresh_token) {
      res.writeHead(500).end('Google no devolvió refresh_token. Revoca el acceso en myaccount.google.com/permissions y reintenta.');
      process.exit(1);
    }
    const out = {
      ...tokens,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      obtained_at: new Date().toISOString(),
    };
    const outPath = path.join(path.dirname(secretPath), 'youtube-token.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    fs.chmodSync(outPath, 0o600);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Listo ✅</h2><p>Autorización guardada. Ya puedes cerrar esta pestaña y avisarle a Kimi.</p>');
    console.log('TOKEN GUARDADO EN:', outPath);
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500).end('Falló el intercambio: ' + e.message);
    console.error('Falló el intercambio:', e.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\n=== ABRE ESTE URL EN EL NAVEGADOR ===\n');
  console.log(authUrl);
  console.log('\nEsperando autorización en', redirectUri, '...\n');
});
