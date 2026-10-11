#!/usr/bin/env node
/**
 * Bundle secret scanner.
 *
 * Greps the BUILT output for credential patterns. This is deliberately different from
 * scanning the source tree: no secret is committed to this repository, yet
 * `EXPO_PUBLIC_*` variables are inlined into the client bundle at build time. The
 * leak happens at build, so the check has to happen at build.
 *
 * Proven: building with EXPO_PUBLIC_OPENAI_API_KEY='sk-CANARY-...' puts that exact
 * string into web-build/bundles/web-*.js twice.
 *
 * Usage:  node scripts/scan-bundle-secrets.js [dir]
 * Exit 0 = clean. Exit 1 = a credential-shaped string is in shippable output.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(process.argv[2] || 'web-build');

// Each pattern is a real provider key shape.
//
// `entropy: true` additionally requires the match to contain a digit AND an uppercase
// letter. Real keys always do; English-ish identifiers almost never do. Without this,
// `sk-[A-Za-z0-9_-]{20,}` happily matches the MaterialCommunityIcons glyph name
// "sk-round-bottom-empty-outline" that ships in this very bundle. A scanner that cries
// wolf on every build gets switched off within a week, so precision matters more here
// than catching an exotic key format.
const PATTERNS = [
  // classic sk-<48 base62>, or sk-proj-<...>; no hyphens inside the body
  ['OpenAI key',        /sk-(?:proj-)?[A-Za-z0-9]{32,}/g,            true],
  ['xAI / Grok key',    /xai-[A-Za-z0-9]{20,}/g,                     true],
  ['Google API key',    /AIza[0-9A-Za-z_-]{35}/g,                    false],
  ['AWS access key',    /AKIA[0-9A-Z]{16}/g,                         false],
  ['GitHub token',      /gh[pousr]_[A-Za-z0-9]{36,}/g,               true],
  ['Stripe secret key', /sk_(?:live|test)_[A-Za-z0-9]{20,}/g,        true],
  ['SendGrid key',      /SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, true],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, false],
];

// Values that are obviously templates, not live credentials.
const BENIGN = /your_|_here|example|placeholder|CANARY|xxxxx|XXXXX|\.\.\.|<[A-Z_]+>/i;

const looksRandom = s => /[0-9]/.test(s) && /[A-Z]/.test(s);

const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.map', '.txt']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SCAN_EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = walk(DIR);
if (!files.length) {
  console.error(`FAIL  nothing to scan in ${DIR} — did the build run?`);
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const body = fs.readFileSync(file, 'utf8');
  for (const [label, re, entropy] of PATTERNS) {
    for (const m of body.match(re) || []) {
      if (BENIGN.test(m)) continue;
      if (entropy && !looksRandom(m)) continue;   // an all-lowercase word is not a key
      hits.push({ file: path.relative(process.cwd(), file), label, sample: m.slice(0, 12) + '…' });
    }
  }
}

console.log(`  scanned ${files.length} built file(s) under ${path.relative(process.cwd(), DIR) || '.'}`);

if (hits.length) {
  console.error(`\nFAIL  ${hits.length} credential-shaped string(s) in shippable output:\n`);
  const seen = new Set();
  for (const h of hits) {
    const k = h.file + h.sample;
    if (seen.has(k)) continue;
    seen.add(k);
    console.error(`  ${h.label.padEnd(18)} ${h.sample}  in  ${h.file}`);
  }
  console.error(`
  Anything prefixed EXPO_PUBLIC_ is inlined into the client bundle and is readable
  by every user. Move the secret behind a server-side proxy and have the app call
  your endpoint instead. Then rotate the exposed key — it must be treated as public.`);
  process.exit(1);
}

console.log('PASS  no credentials in the built output.');
