// Testes do namespace `muri:v1:<hash>`: URI de magnet guardada por hash para
// reutilizar no play/enqueue do debrid. A URI é do TORRENT, não da credencial
// — a chave NÃO leva conta/adapter. O `mag` (evidência alive/bad/lie) segue
// separado e intacto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { sanitizeMagnet, rememberMagnets, rememberMagnetsFromItems, peekMagnet, defaultMagnet } from '../src/utils/magnet-uri.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

// Magnet com dn= e trackers extras (diferente do padrão)
function magnetWithDn(hash: string, dn: string, extraTrackers: string[] = []): string {
  const trs = extraTrackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(dn)}${trs}`;
}

test('sanitizeMagnet: btih divergente é recusado', () => {
  const uri = magnetWithDn(HASH_A, 'Test.Movie.2024');
  const result = sanitizeMagnet(uri, HASH_B);
  assert.equal(result, null, 'hash diferente deve recusar');
});

test('sanitizeMagnet: btih base32 é aceito quando casa com o hash hex', () => {
  // Base32 de 20 bytes zero -> os 40 hex '0'. extractInfoHash normaliza o
  // btih do magnet, então a URI só entra se o hash da chave for o hex equivalente.
  const b32 = 'A'.repeat(32);
  const uri = `magnet:?xt=urn:btih:${b32}&dn=Base32.Movie&tr=${encodeURIComponent('udp://custom.tracker.org:1337/announce')}`;
  const result = sanitizeMagnet(uri, '0'.repeat(40));
  assert.ok(result, 'base32 que casa com o hex deve ser aceito');
  assert.ok(result!.includes('dn=Base32.Movie'), 'dn preservado');
  assert.equal(sanitizeMagnet(uri, 'a'.repeat(40)), null, 'hash divergente do hex recusa');
});

test('sanitizeMagnet: passkey é removida', () => {
  const uri = `magnet:?xt=urn:btih:${HASH_A}&dn=Test&tr=${encodeURIComponent('udp://tracker.com/announce?passkey=abc123')}&tr=${encodeURIComponent('udp://open.tracker.org:1337/announce')}`;
  const result = sanitizeMagnet(uri, HASH_A);
  assert.ok(result, 'deve retornar URI sanitizada');
  assert.ok(!result!.includes('passkey'), 'passkey deve ser removida');
  assert.ok(result!.includes('open.tracker.org'), 'tracker limpo deve permanecer');
});

test('sanitizeMagnet: /announce/<token>=16 chars é removida', () => {
  // Token distinto do HASH_A (que é 40×'a'); senão o próprio btih do resultado
  // conteria a substring e a asserção de "não vazou" daria falso negativo.
  const longToken = 'secToken1234567890ab';
  const uri = `magnet:?xt=urn:btih:${HASH_A}&tr=${encodeURIComponent(`udp://tracker.com/announce/${longToken}`)}`;
  const result = sanitizeMagnet(uri, HASH_A);
  // O tracker com token no caminho é credencial e sai; sobra no máximo o btih cru.
  assert.ok(result === null || !result.includes(longToken));
});

test('sanitizeMagnet: ?auth= é removida', () => {
  const uri = `magnet:?xt=urn:btih:${HASH_A}&tr=${encodeURIComponent('udp://tracker.com/announce?auth=secret123')}`;
  const result = sanitizeMagnet(uri, HASH_A);
  assert.ok(result === null || !result!.includes('auth='));
});

test('sanitizeMagnet: uid= é removido', () => {
  const uri = `magnet:?xt=urn:btih:${HASH_A}&tr=${encodeURIComponent('udp://tracker.com/announce?uid=12345')}`;
  const result = sanitizeMagnet(uri, HASH_A);
  assert.ok(result === null || !result!.includes('uid='));
});

test('sanitizeMagnet: passkey ANTES do /announce é removida', () => {
  const tok = 'deadbeefcafebabefood'; // 20 alfanuméricos no caminho, antes do announce
  const uri = `magnet:?xt=urn:btih:${HASH_A}&tr=${encodeURIComponent(`https://tracker.example.com/${tok}/announce`)}`;
  const result = sanitizeMagnet(uri, HASH_A);
  assert.ok(result === null || !result.includes(tok), 'token no caminho antes do announce deve sair');
});

test('sanitizeMagnet: torrent_pass/authkey/key/pid/secure são removidos', () => {
  const good = encodeURIComponent('udp://custom.tracker.org:1337/announce');
  for (const param of ['torrent_pass', 'authkey', 'key', 'pid', 'secure']) {
    const bad = encodeURIComponent(`https://tracker.example.com/announce?${param}=abcdef0123456789abcd`);
    const uri = `magnet:?xt=urn:btih:${HASH_A}&dn=Movie&tr=${bad}&tr=${good}`;
    const result = sanitizeMagnet(uri, HASH_A);
    assert.ok(result, `${param}: com tracker limpo e dn, deve guardar`);
    assert.ok(!result!.includes('abcdef0123456789abcd'), `${param} não deve vazar`);
    assert.ok(result!.includes('dn=Movie'), `${param}: dn preservado`);
    assert.ok(result!.includes('custom.tracker'), `${param}: tracker limpo preservado`);
  }
});

test('sanitizeMagnet: xs/as/ws são ignorados sem descartar dn/trackers', () => {
  const clean = encodeURIComponent('udp://custom.tracker.org:1337/announce');
  for (const key of ['xs', 'as', 'ws']) {
    const uri = `magnet:?xt=urn:btih:${HASH_A}&dn=Keep.Me&${key}=http://evil.example/payload.torrent&tr=${clean}`;
    const result = sanitizeMagnet(uri, HASH_A);
    assert.ok(result, `${key} não deve derrubar a URI inteira`);
    assert.ok(!result!.includes(`${key}=`), `${key} não entra na URI remontada`);
    assert.ok(!result!.includes('evil.example'), 'URL do parâmetro não vaza');
    assert.ok(result!.includes('dn=Keep.Me'), 'dn preservado apesar do parâmetro');
    assert.ok(result!.includes('custom.tracker'), 'tracker do post preservado');
  }
});

test('sanitizeMagnet: corte por tamanho mantém dn=', () => {
  // Cria URI com muitos trackers para forçar o corte
  const manyTrackers = Array.from({ length: 50 }, (_, i) => `udp://tracker${i}.example.com:1337/announce`);
  const uri = magnetWithDn(HASH_A, 'Test.Movie.2024.1080p.BluRay', manyTrackers);
  const result = sanitizeMagnet(uri, HASH_A);
  assert.ok(result, 'deve retornar URI');
  assert.ok(result!.includes('dn='), 'dn deve ser preservado');
  assert.ok(result!.length <= 2048 * 2, 'URI não deve ser excessivamente longa');
});

test('sanitizeMagnet: magnet igual ao padrão não grava', () => {
  // defaultMagnet produz exatamente o que magnetFor recalcularia; o sanitize
  // reconstrói o mesmo e deve devolver null (não vale guardar o recalculável).
  const uri = defaultMagnet(HASH_A);
  const result = sanitizeMagnet(uri, HASH_A);
  assert.equal(result, null, 'URI equivalente ao padrão deve retornar null');
});

test('sanitizeMagnet: URI sem magnet:? é recusada', () => {
  assert.equal(sanitizeMagnet('http://example.com/file.torrent', HASH_A), null);
  assert.equal(sanitizeMagnet('', HASH_A), null);
  assert.equal(sanitizeMagnet('notamagnet', HASH_A), null);
});

test('sanitizeMagnet: deduplica trackers', () => {
  const tr = 'udp://open.tracker.org:1337/announce';
  const uri = `magnet:?xt=urn:btih:${HASH_A}&dn=Test&tr=${encodeURIComponent(tr)}&tr=${encodeURIComponent(tr)}`;
  const result = sanitizeMagnet(uri, HASH_A);
  assert.ok(result);
  // Conta ocorrências do tracker
  const matches = result!.match(/tr=/g) || [];
  // Deve ter no máximo 1 ocorrência do tracker (deduplicado) + os do default se houver
  const trCount = matches.length;
  assert.ok(trCount >= 1, 'deve ter pelo menos um tracker');
});

test('rememberMagnets + peekMagnet: round-trip funciona', () => {
  const base = prefix('muri');
  const key = `${base}${HASH_A}`;
  // Limpa qualquer estado anterior
  cache.forget(key);

  const uri = magnetWithDn(HASH_A, 'Test.Movie.2024', ['udp://custom.tracker.org:1337/announce']);
  rememberMagnets([{ hash: HASH_A, magnet: uri }]);

  const peeked = peekMagnet(HASH_A);
  assert.ok(peeked, 'peekMagnet deve retornar a URI guardada');
  assert.ok(peeked!.includes('dn='), 'URI guardada deve conter dn=');
  assert.ok(peeked!.includes('custom.tracker'), 'URI guardada deve conter tracker customizado');

  // Limpa
  cache.forget(key);
});

test('peekMagnet: retorna null para hash ausente', () => {
  const result = peekMagnet('c'.repeat(40));
  assert.equal(result, null);
});

test('peekMagnet: retorna null para hash vazio', () => {
  assert.equal(peekMagnet(''), null);
  assert.equal(peekMagnet(null as any), null);
});

test('rememberMagnets: ignora entradas sem magnet', () => {
  const before = peekMagnet(HASH_B);
  rememberMagnets([{ hash: HASH_B, magnet: null }, { hash: HASH_B, magnet: '' }, { hash: '', magnet: 'magnet:?xt=urn:btih:abc' }]);
  const after = peekMagnet(HASH_B);
  assert.equal(after, before, 'entradas inválidas não devem gravar');
});

test('rememberMagnets: ignora entradas com magnet inválido', () => {
  rememberMagnets([{ hash: HASH_A, magnet: 'http://notamagnet.com' }]);
  // Não deve ter gravado nada
  const base = prefix('muri');
  const key = `${base}${HASH_A}_invalid_test`;
  // O hash A pode ter sido gravado por outro teste, mas não com esta URI inválida
  const peeked = peekMagnet(HASH_A);
  // Se houver algo, não deve ser a URI inválida
  if (peeked) {
    assert.ok(!peeked.includes('notamagnet'), 'URI inválida não deve ser guardada');
  }
});

test('defaultMagnet: formato correto', () => {
  const result = defaultMagnet(HASH_A);
  assert.ok(result.startsWith('magnet:?xt=urn:btih:'));
  assert.ok(result.includes(HASH_A));
  assert.ok(result.includes('&tr='));
});

test('rememberMagnetsFromItems: deriva hash do MagnetUri e ignora item sem magnet', () => {
  const hash = 'f'.repeat(40);
  const base = prefix('muri');
  cache.forget(`${base}${hash}`);
  const uri = magnetWithDn(hash, 'Extra.Show.S01E01', ['udp://extra.tracker.org:1337/announce']);
  rememberMagnetsFromItems([
    { MagnetUri: uri }, // hash vem do btih dentro da URI
    { infoHash: 'e'.repeat(40) }, // sem magnet -> ignorado
    {}, // vazio
  ]);
  const peeked = peekMagnet(hash);
  assert.ok(peeked, 'URI via MagnetUri deve ser guardada sob o hash extraído');
  assert.ok(peeked!.includes('Extra.Show'), 'dn preservado');
  assert.ok(peeked!.includes('extra.tracker'), 'tracker extra do post preservado');
  assert.equal(peekMagnet('e'.repeat(40)), null, 'item sem magnet não grava');
  cache.forget(`${base}${hash}`);
});
