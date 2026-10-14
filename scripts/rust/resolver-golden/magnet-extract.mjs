#!/usr/bin/env node
// Oráculo do extrator de magnet (resolvers/magnet-extract.ts): as três
// variantes vivas (básica nerd/tdf, rica bludv/comando, vaca com base64)
// sobre as fixtures de post/protetor e casos sintéticos.
//   node scripts/rust/resolver-golden/magnet-extract.mjs
// Saída: rust/crates/adom-resolvers/tests/golden/magnet-extract.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distImport } from './lib.mjs';

const { createMagnetExtractor } = await distImport('resolvers/magnet-extract.js');
const { decodeEntities } = await distImport('resolvers/text.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIX = path.join(ROOT, 'test/fixtures');
const variants = {
  basic: createMagnetExtractor({ decodeEntities }),
  rich: createMagnetExtractor({ decodeEntities, encodedVariants: true }),
  vaca: createMagnetExtractor({ decodeEntities, encodedVariants: true, b64DataLink: true }),
};
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : /\.(html|txt)$/.test(e.name) ? [p] : [];
});
const files = walk(FIX).filter((f) => !/sitemap|pagina-|catalog/.test(f));
const b64 = (s) => Buffer.from(s).toString('base64');
const synth = [
  `<a href="magnet:?xt=urn:btih:26fd5f8f143c2ab785d1c99696c142c95629f029&amp;dn=Batman A Queda do Morcego - Parte 1.2026.1080p&amp;tr=udp://t.org:80/announce">x</a>`,
  `<script>var url = "magnet%3A%3Fxt%3Durn%3Abtih%3AABC%26dn%3DX";</script>`,
  `<script>window.location.href = 'magnet:?xt=urn:btih:abc&amp;dn=Y';</script>`,
  `<div data-download="magnet:?xt=urn:btih:def"></div>`,
  `<p>magnet%3A%3Fxt%3Durn%3Abtih%3AFFF&amp;dn=Z</p>`,
  `<p>texto magnet:?xt=urn:btih:raw&dn=W fim</p>`,
  `<div data-link="${b64('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=x')}"></div>`,
  `<div data-link="${b64('magnet:?xt=urnbtih0123456789abcdef0123456789abcdef01234567&tr=udptracker')}"></div>`,
  `<div data-link="${b64('https://drive.google.com/file/d/xyz/view')}"></div>`,
  `<a href='MAGNET:?xt=urn:btih:UP&amp;dn=Caixa'>`,
  '',
];
const cases = [];
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  const rel = path.relative(FIX, f).split(path.sep).join('/');
  const out = Object.fromEntries(Object.entries(variants).map(([k, fn]) => [k, fn(html) ?? null]));
  cases.push({ fixture: rel, ...out });
}
for (const [i, html] of synth.entries()) {
  const out = Object.fromEntries(Object.entries(variants).map(([k, fn]) => [k, fn(html) ?? null]));
  cases.push({ fixture: `synth#${i}`, html, ...out });
}
const file = path.join(ROOT, 'rust/crates/adom-resolvers/tests/golden/magnet-extract.json');
fs.writeFileSync(file, `${JSON.stringify({ cases })}\n`);
const hits = cases.filter((c) => c.basic || c.rich || c.vaca).length;
console.log(`[golden] magnet-extract: ${cases.length} caso(s), ${hits} com magnet → ${path.relative(ROOT, file)}`);
