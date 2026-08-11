// Smoke test descartável do modo Torznab do resolver TorrentDosFilmes V2.
// Roda uma cópia local do servidor numa porta de teste (sem tocar na stack).
// Uso:
//   node smoke-test.js
//   docker compose exec -T torrentdosfilmes-resolver node /app/smoke-test.js
process.env.PORT = '8793';
require('./server.js');

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const base = 'http://127.0.0.1:8793';

  const caps = await fetch(`${base}/api?t=caps`);
  console.log('caps →', caps.status);

  const res = await fetch(`${base}/api?t=search&q=oppenheimer`);
  const xml = await res.text();
  const enclosures = [...xml.matchAll(/<enclosure\b[^>]*url=["']([^"']+)["']/g)].map((m) => m[1]);
  console.log(`search "oppenheimer" → ${res.status}, ${enclosures.length} release(s)`);
  if (res.status !== 200) throw new Error(`search falhou: HTTP ${res.status}`);
  if (enclosures.length < 1) throw new Error('nenhum enclosure de download retornado');
  enclosures.slice(0, 5).forEach((u) => console.log(' -', u.slice(0, 90), '…'));

  const pick = enclosures[0].replace('http://torrentdosfilmes-resolver:8703', base);
  const dl = await fetch(pick, { redirect: 'manual' });
  const location = dl.headers.get('location') || '';
  console.log(`\ndl "${pick.slice(0, 90)}…" → HTTP ${dl.status}`);
  console.log('location:', location.slice(0, 120));

  if (dl.status !== 302) throw new Error(`esperado 302, obtido ${dl.status}`);
  if (!location.startsWith('magnet:?')) throw new Error(`location não é magnet: ${location.slice(0, 60)}`);
  if (!/\bxt=urn:btih:[0-9a-f]{40}/i.test(location)) throw new Error('magnet sem xt (info hash) preservado');

  const trs = (location.match(/[?&]tr=/g) || []).length;
  const dn = /[?&]dn=/.test(location);
  if (trs < 1) throw new Error('magnet sem parâmetro tr (trackers) preservado');
  if (location.includes('dn=') && !dn) throw new Error('parâmetro dn do magnet foi mascarado');
  if (location.includes('&amp;') || location.includes('&#38;')) throw new Error('magnet com entidades não decodificadas');
  // A fonte TorrentDosFilmes emite magnet só com xt+tr (dn é opcional no
  // magnet); o redirect preserva o que vier da fonte.
  console.log(`magnet preserva xt + ${trs} tr; dn=${dn ? 'preservado' : 'ausente na fonte'}`);

  process.exit(0);
})().catch((err) => {
  console.error('FALHOU:', err);
  process.exit(1);
});