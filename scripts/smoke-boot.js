#!/usr/bin/env node
/**
 * Boot smoke test.
 *
 * Builds nothing itself — it serves an already-built web bundle, loads it in a real
 * browser, and fails if the app did not actually render.
 *
 * This is the check that would have caught the blank-screen outage: `tsc` and `jest`
 * both reported the problem in a form nobody read, but "does the app render at all"
 * is unambiguous and cannot be argued with.
 *
 * Usage:  node scripts/smoke-boot.js [dir] [--port 8910]
 * Exit 0 = the app rendered. Exit 1 = it did not.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'web-build';
const PORT = Number((process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || 8910);
const BOOT_MS = 12000;      // generous: CI runners are slow
const MIN_HTML = 200;       // #root must contain at least this much markup

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function serve(dir, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(dir, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(path.resolve(dir))) { res.writeHead(403); return res.end(); }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(dir, 'index.html');            // SPA fallback
      }
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.on('error', reject);
    server.listen(port, () => resolve(server));
  });
}

(async () => {
  const dir = path.resolve(DIR);
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    console.error(`FAIL  no index.html in ${dir} — did the build run?`);
    process.exit(1);
  }

  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.error('FAIL  playwright not installed (npm i -D playwright)'); process.exit(1); }

  const server = await serve(dir, PORT);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  let rendered = 0, text = '';
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 45000 });
    // poll rather than sleep a fixed amount, so a fast runner isn't punished
    const deadline = Date.now() + BOOT_MS;
    while (Date.now() < deadline) {
      rendered = await page.evaluate(() => {
        const r = document.getElementById('root') || document.body;
        return r ? r.innerHTML.length : 0;
      });
      if (rendered >= MIN_HTML) break;
      await page.waitForTimeout(400);
    }
    text = (await page.evaluate(() => document.body.innerText || '')).trim();
    if (process.env.SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SMOKE_SCREENSHOT });
  } finally {
    await browser.close();
    server.close();
  }

  const problems = [];
  if (rendered < MIN_HTML) problems.push(`app did not render (#root innerHTML = ${rendered} bytes, need >= ${MIN_HTML})`);
  if (pageErrors.length)   problems.push(`${pageErrors.length} uncaught page error(s)`);

  console.log(`  rendered markup : ${rendered} bytes`);
  console.log(`  visible text    : ${text ? JSON.stringify(text.slice(0, 120)) : '(none)'}`);
  console.log(`  page errors     : ${pageErrors.length}`);
  console.log(`  console errors  : ${consoleErrors.length}`);

  if (problems.length) {
    console.error('\nFAIL  the app does not boot:');
    problems.forEach(p => console.error(`  - ${p}`));
    pageErrors.slice(0, 5).forEach(e => console.error(`  ! ${e}`));
    consoleErrors.slice(0, 5).forEach(e => console.error(`  ! [console] ${e}`));
    process.exit(1);
  }
  console.log('\nPASS  the app boots and renders.');
})().catch(e => { console.error('FAIL  smoke test crashed:', e.message); process.exit(1); });
