// Dedupe com dublagem genérica (_Dub) herdando BR do post, e o selo 📦 da foto
// salva (fromSnapshot) preservado no merge. Extraído de br-global.test.ts pelo
// orçamento de 400 linhas.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toStremioStream, dedupeByHash } from '../src/utils/format.js';

const HASH_A = 'a'.repeat(40);

test('dedupeByHash: espelho global com dublagem genérica (_Dub) herda BR/dublado do post BR', () => {
  // Coyote vs. Acme (tt1756855, 2026-09-18): o kickass trazia o mesmo hash do
  // "[1080p DUBLADO 4.26 GB]" da vacatorrent com 160 seeders, e o único dublado
  // da obra sumia nas cotas como 1080p global.
  const post = toStremioStream({
    title: 'Coyote vs. ACME (2026) [1080p DUBLADO 4.26 GB]', infoHash: HASH_A, seeders: 1,
    size: 4.26 * 1024 ** 3, tracker: 'Vaca Torrent', indexer: 'vacatorrent', isBr: true,
  })!;
  const espelho = toStremioStream({
    title: 'Coyote_Vs_Acme_2026_1080p_WEBRip_Dub', infoHash: HASH_A, seeders: 160,
    size: 4.26 * 1024 ** 3, tracker: 'kickasstorrents.to', indexer: 'kickasstorrents-to', isBr: false,
  })!;
  for (const order of [[post, espelho], [espelho, post]]) {
    const [merged] = dedupeByHash(order);
    assert.equal(merged._br, true, 'herda a origem BR do post');
    assert.equal(merged._dubbed, true, 'herda o dublado do post');
    assert.equal(merged._seeders, 160);
    assert.match(String(merged.name), /\bBR\b/);
  }
  // Idioma estrangeiro nomeado junto do "Dub" não herda.
  const latino = toStremioStream({ title: 'Coyote Vs Acme 2026 1080p Latino Dub', infoHash: HASH_A, seeders: 160, indexer: 'thepiratebay' })!;
  assert.equal(dedupeByHash([post, latino])[0]._br, false);
  // "Dub" como pedaço de outra palavra não conta.
  const dubai = toStremioStream({ title: 'Coyote.Vs.Acme.2026.1080p.WEB.Dubai-GRP', infoHash: HASH_A, seeders: 160, indexer: 'thepiratebay' })!;
  assert.equal(dedupeByHash([post, dubai])[0]._br, false);
});

test('foto salva (fromSnapshot) exibe 📦/~N e o merge preserva o selo', () => {
  const snap = toStremioStream({
    title: 'Beverly Hills Cop II 1987 1080p BluRay', infoHash: HASH_A, seeders: 99,
    size: 3.5 * 1024 ** 3, tracker: 'kickasstorrents-to', indexer: 'kickasstorrents-to', fromSnapshot: true,
  })!;
  assert.match(String(snap.name), /📦/);
  assert.match(String(snap.title), /📦 👤 ~99/);
  assert.equal(snap._fromSnapshot, true);
  assert.equal(snap._fromFallback, undefined, 'foto do idx não é reserva: sem as exclusões do fallback');
  // Merge que remonta o nome (qualidade mais rica no perdedor) não apaga o selo.
  const semQualidade = toStremioStream({ title: 'Beverly Hills Cop II', infoHash: HASH_A, seeders: 1, indexer: 'thepiratebay' })!;
  const [merged] = dedupeByHash([{ ...snap, _quality: semQualidade._quality }, { ...snap, _fromSnapshot: false, _seeders: 1 }]);
  assert.match(String(merged.name), /📦/);
});
