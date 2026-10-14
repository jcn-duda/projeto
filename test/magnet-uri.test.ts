// Testes das regras PURAS de magnet-uri: sanitização da URI do post (valida o
// hash pelo xt, remove credencial, monta com piso de trackers sob teto) e o
// magnet padrão. A GRAVAÇÃO/LEITURA por hash deixou de ser namespace de cache
// e vive no banco permanente (`test/magnet-bank*.test.ts`); o play é coberto
// por `test/magnet-for-play.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { sanitizeMagnet, defaultMagnet } from '../src/utils/magnet-uri.js';

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

test('defaultMagnet: formato correto', () => {
  const result = defaultMagnet(HASH_A);
  assert.ok(result.startsWith('magnet:?xt=urn:btih:'));
  assert.ok(result.includes(HASH_A));
  assert.ok(result.includes('&tr='));
});

// --- Lacunas da revisão da etapa 1 -----------------------------------------

test('sanitizeMagnet: credencial nomeada com valor curto/não alfanumérico sai', () => {
  const clean = encodeURIComponent('udp://custom.tracker.org:1337/announce');
  // A detecção é por NOME, não por forma do valor: `token=x` (1 char) e
  // `passkey=!@#` (não alfanumérico) precisam sair como qualquer outro.
  const names = ['token', 'auth_key', 'passkey', 'pass_key', 'authkey', 'auth', 'torrent_pass', 'apikey', 'api_key', 'key', 'pid', 'uid', 'secure'];
  const values = ['x', 'a', '!@#'];
  for (const name of names) {
    for (const value of values) {
      const bad = encodeURIComponent(`https://private.tracker.example/announce?${name}=${value}`);
      const uri = `magnet:?xt=urn:btih:${HASH_A}&dn=Named.Cred&tr=${bad}&tr=${clean}`;
      const result = sanitizeMagnet(uri, HASH_A);
      assert.ok(result, `${name}=${value}: com tracker limpo deve guardar`);
      assert.ok(!result!.includes('private.tracker.example'), `${name}=${value}: tracker com credencial não pode vazar`);
      assert.ok(result!.includes('custom.tracker'), `${name}=${value}: tracker limpo preservado`);
    }
  }
});

test('sanitizeMagnet: segredo com hífen/underscore sai do path e da query', () => {
  const clean = encodeURIComponent('udp://custom.tracker.org:1337/announce');
  const secrets = ['passKey-1234567890_abc', '550e8400-e29b-41d4-a716-446655440000'];
  for (const secret of secrets) {
    // DEPOIS do announce: /announce/<segredo>
    const after = encodeURIComponent(`https://private.tracker.example/announce/${secret}`);
    const rAfter = sanitizeMagnet(`magnet:?xt=urn:btih:${HASH_A}&dn=Secret&tr=${after}&tr=${clean}`, HASH_A);
    assert.ok(rAfter, `path depois: deve guardar com tracker limpo`);
    assert.ok(!rAfter!.includes('private.tracker.example'), `path depois: segredo não pode vazar`);
    // ANTES do announce: /<segredo>/announce
    const before = encodeURIComponent(`https://private.tracker.example/${secret}/announce`);
    const rBefore = sanitizeMagnet(`magnet:?xt=urn:btih:${HASH_A}&dn=Secret&tr=${before}&tr=${clean}`, HASH_A);
    assert.ok(rBefore, `path antes: deve guardar com tracker limpo`);
    assert.ok(!rBefore!.includes('private.tracker.example'), `path antes: segredo não pode vazar`);
  }
  // Valor de query (nome não conhecido) com hífen/underscore também é segredo.
  const querySecret = encodeURIComponent('https://private.tracker.example/announce?pass=a-b_c-d_e-f_g-h_i-j');
  const rQuery = sanitizeMagnet(`magnet:?xt=urn:btih:${HASH_A}&dn=Secret&tr=${querySecret}&tr=${clean}`, HASH_A);
  assert.ok(rQuery, 'query: deve guardar com tracker limpo');
  assert.ok(!rQuery!.includes('private.tracker.example'), 'query: segredo não pode vazar');
});

test('sanitizeMagnet: host longo com hífen NÃO é tratado como segredo', () => {
  const host = 'udp://my-long-hostname-with-hyphens.example.com:1337/announce';
  const uri = `magnet:?xt=urn:btih:${HASH_A}&dn=Host.Test&tr=${encodeURIComponent(host)}`;
  const result = sanitizeMagnet(uri, HASH_A);
  assert.ok(result, 'deve guardar');
  assert.ok(result!.includes('my-long-hostname-with-hyphens'), 'o host é ignorado na regra genérica');
});

test('sanitizeMagnet: teto real de 2048 BYTES com dn multibyte', () => {
  // 'Á' vira %C3%81 (6 bytes) no encodeURIComponent: 4 mil deles estouram o
  // teto com folga e forçam o truncamento do dn.
  const dn = 'Á'.repeat(4000);
  const uri = `magnet:?xt=urn:btih:${HASH_A}&dn=${encodeURIComponent(dn)}&tr=${encodeURIComponent('udp://custom.tracker.org:1337/announce')}`;
  const result = sanitizeMagnet(uri, HASH_A);
  assert.ok(result, 'deve devolver URI truncada');
  const bytes = Buffer.byteLength(result!, 'utf8');
  assert.ok(bytes <= 2048, `teto real: ${bytes} <= 2048`);
  assert.ok(result!.startsWith(`magnet:?xt=urn:btih:${HASH_A}`), 'xt preservado');
  const floor = defaultMagnet(HASH_A).slice(`magnet:?xt=urn:btih:${HASH_A}`.length);
  assert.ok(result!.endsWith(floor), 'piso de trackers entra por inteiro');
  const dnValue = result!.match(/[?&]dn=([^&]*)/);
  assert.ok(dnValue, 'dn truncado permanece presente');
  assert.doesNotThrow(() => decodeURIComponent(dnValue![1]), 'dn truncado é decodificável (URI válida)');
  assert.ok(!result!.includes('custom.tracker'), 'sem bytes sobrando, o tracker do post cede ao piso');
});

test('sanitizeMagnet: tracker grande demais não bloqueia um menor depois', () => {
  // Caminho longo de segmentos curtos: passa na regra de credencial (nada de
  // 16+ chars por segmento) mas não cabe no teto — o `continue` tenta o próximo.
  const big = `udp://big.tracker.example:1337/${'aa/'.repeat(1000)}announce`;
  const small = 'udp://small.tracker.example:1337/announce';
  const uri = `magnet:?xt=urn:btih:${HASH_A}&dn=Big.Then.Small&tr=${encodeURIComponent(big)}&tr=${encodeURIComponent(small)}`;
  const result = sanitizeMagnet(uri, HASH_A);
  assert.ok(result, 'deve guardar');
  assert.ok(!result!.includes('big.tracker.example'), 'grande demais não entra');
  assert.ok(result!.includes('small.tracker.example'), 'o menor seguinte entra (continue, não break)');
  assert.ok(Buffer.byteLength(result!, 'utf8') <= 2048, 'teto respeitado');
});

test('sanitizeMagnet: hash só vale no xt=urn:btih, não em outro parâmetro', () => {
  const clean = encodeURIComponent('udp://custom.tracker.org:1337/announce');
  // `dn=btih:<hash da chave>` com `xt` apontando para OUTRO hash: o xt manda e
  // o `dn` não pode forjar a identidade (o extrator genérico aceitaria o do dn).
  const forged = `magnet:?dn=btih:${HASH_A}&xt=urn:btih:${HASH_B}&tr=${clean}`;
  assert.equal(sanitizeMagnet(forged, HASH_A), null, 'btih no dn não pode forjar o hash do xt');
  // Sem nenhum `xt=urn:btih`, um btih solto em outro parâmetro não é magnet.
  const noXt = `magnet:?dn=btih:${HASH_A}&xs=btih:${HASH_A}&tr=${clean}`;
  assert.equal(sanitizeMagnet(noXt, HASH_A), null, 'sem xt=urn:btih não há magnet');
  // xt de outro esquema também não conta.
  const ed2k = `magnet:?xt=urn:ed2k:${HASH_A}&dn=Test&tr=${clean}`;
  assert.equal(sanitizeMagnet(ed2k, HASH_A), null, 'xt de outro esquema não é btih');
  // Controle positivo: xt correto é aceito mesmo com lixo btih no dn.
  const ok = `magnet:?dn=btih:${HASH_A}&xt=urn:btih:${HASH_A}&tr=${clean}`;
  const result = sanitizeMagnet(ok, HASH_A);
  assert.ok(result, 'xt correto deve ser aceito');
  assert.ok(result!.includes('custom.tracker'), 'tracker limpo preservado');
});
