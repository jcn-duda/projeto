#!/usr/bin/env node
// Oráculo do protetor do VacaTorrent: nextProtectedUrl, extractMagnet e
// isNonMagnetTarget do TS sobre as páginas reais da cadeia
// (go.php → processar.php → t.co → relay.php).
//   DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/vacatorrent-protector.mjs
// Saída: rust/crates/adom-resolvers/tests/golden/vacatorrent-protector.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distImport, fixture } from './lib.mjs';

const p = await distImport('resolvers/profiles/vacatorrent-parsers.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURES = [
  'crawl/vaca/protector-processar.html',
  'crawl/vaca/protector-tco.html',
  'crawl/vaca/protector-hosts.html',
  'crawl/vaca/protector-final-drive.html',
  'crawl/vaca/protector-final-magnet.txt',
  'crawl/vaca/movie-page-protector-only.html',
  'vacatorrent/go.php.html',
];
const BASES = [
  'https://systemtech.space/enc/processar.php?enc=abc',
  'https://vacadb.org/gate/2',
  'https://vaqueirofilmes1.com/pt/movie/x/',
];
const cases = [];
for (const name of FIXTURES) {
  const html = fixture(name);
  for (const base of BASES) {
    cases.push({
      fixture: name,
      base,
      next: p.nextProtectedUrl(html, base) ?? null,
      magnet: p.extractMagnet(html) ?? null,
      non_magnet: Boolean(p.isNonMagnetTarget(html)),
    });
  }
}
// Sintéticos: os ramos que as páginas reais não exercitam.
const synth = [
  `<script>const next = "https:\/\/systemtech.space\/enc\/relay.php?x=1";</script>`,
  `<script>window.next='https://www.youtube.com/redirect?q=https%3A%2F%2Ft.co%2FAbC'</script>`,
  `<div data-next="https://systemtech.space/isca"></div><script>var next = "https://t.co/real"</script>`,
  `<script>URL_ETAPA2 = "https://vacadb.org/etapa2?id=9";</script>`,
  `<meta http-equiv="refresh" content="0;url=https://systemtech.space/enc/go.php?id=1">`,
  `<script>const next = "https://evil.example/x";</script>`,
  `<a href="magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&amp;dn=X">`,
];
for (const [i, html] of synth.entries()) {
  for (const base of BASES.slice(0, 2)) {
    cases.push({
      fixture: `synth#${i}`,
      html,
      base,
      next: p.nextProtectedUrl(html, base) ?? null,
      magnet: p.extractMagnet(html) ?? null,
      non_magnet: Boolean(p.isNonMagnetTarget(html)),
    });
  }
}
const out = path.join(ROOT, 'rust/crates/adom-resolvers/tests/golden/vacatorrent-protector.json');
fs.writeFileSync(out, `${JSON.stringify({ cases })}\n`);
console.log(`[golden] vacatorrent-protector: ${cases.length} caso(s) → ${path.relative(ROOT, out)}`);
for (const c of cases.filter((c) => c.next || c.magnet || c.non_magnet).slice(0, 12)) console.log(`  ${c.fixture} @${c.base.slice(8, 30)} next=${c.next} magnet=${c.magnet?.slice(0, 30)} nm=${c.non_magnet}`);
