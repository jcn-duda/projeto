// Rodada 2: checagem ligada; o contrato do src/runtime.ts é puro (sem rede).
import { test } from 'node:test';
import assert from 'node:assert';

// Contrato do src/runtime.js para as opções novas do install URL: preferDubbed
// ("a"), excludeCam ("c"), maxSizeGb ("z"), brFirst ("bf"), jackettIndexers
// ("ji") e os limites por qualidade max2160p ("q4"), max1080p ("q1"),
// max720p ("q7"), max480p ("q5") e maxSd ("qs"). O módulo é importável sem
// subir servidor (diferente de addon.js) e nada aqui toca rede — só
// normalização, clamp e roundtrip do segmento de config.
import config from '../src/config.js';
import * as runtime from '../src/runtime.js';

const { MAX_CONFIG_SEGMENT, SCHEMA, defaults, normalize, encode, decode } = runtime;

// `decode` devolve os defaults ou null; nos testes o segmento é sempre válido
// por construção, então os acessos diretos assumem o tipo não-nulo — o cast
// (`as` em .ts; `!` era proibido em .js) é o que documenta essa invariante.
type DecodedOptions = NonNullable<ReturnType<typeof decode>>;

test('SCHEMA declara as opções novas com chave curta, tipo e limites', () => {
  assert.deepEqual(SCHEMA.preferDubbed, { type: 'bool', key: 'a' });
  assert.deepEqual(SCHEMA.excludeCam, { type: 'bool', key: 'c' });
  assert.deepEqual(SCHEMA.maxSizeGb, { type: 'int', key: 'z', min: 0, max: 200 });
});

test('SCHEMA declara os limites por qualidade com chave curta e 0..100', () => {
  assert.deepEqual(SCHEMA.max2160p, { type: 'int', key: 'q4', min: 0, max: 100 });
  assert.deepEqual(SCHEMA.max1080p, { type: 'int', key: 'q1', min: 0, max: 100 });
  assert.deepEqual(SCHEMA.max720p, { type: 'int', key: 'q7', min: 0, max: 100 });
  assert.deepEqual(SCHEMA.max480p, { type: 'int', key: 'q5', min: 0, max: 100 });
  assert.deepEqual(SCHEMA.maxSd, { type: 'int', key: 'qs', min: 0, max: 100 });
});

test('SCHEMA declara brFirst (bf) e jackettIndexers (ji) com tipo e chave curta', () => {
  assert.deepEqual(SCHEMA.brFirst, { type: 'bool', key: 'bf' });
  assert.deepEqual(SCHEMA.jackettIndexers, { type: 'list', key: 'ji' });
  assert.deepEqual(SCHEMA.indexerPriority, { type: 'list', key: 'ip' });
});

test('SCHEMA declara exceção BR ao cachedOnly com chave curta', () => {
  assert.deepEqual(SCHEMA.showUncachedBr, { type: 'bool', key: 'bu' });
  assert.equal(defaults().showUncachedBr, false);
  assert.equal(normalize({ bu: 1 }).showUncachedBr, true);
  assert.equal((decode(encode({ bu: 0 })) as DecodedOptions).showUncachedBr, false);
});

test('defaults() segue o operador em preferDubbed e não filtra CAM/tamanho', () => {
  const d = defaults();
  // Dublado antes de legendado é o padrão do operador (PREFER_DUBBED, ligado):
  // sem isso as cotas por qualidade, que não distinguem áudio, enchiam com
  // legendadas do mesmo post e empurravam a dublada para fora.
  assert.equal(d.preferDubbed, config.preferDubbed);
  assert.equal(d.preferDubbed, true);
  assert.equal(d.excludeCam, false);
  assert.equal(d.maxSizeGb, 0);
});

test('defaults() traz quatro streams por qualidade', () => {
  const d = defaults();
  assert.equal(d.max2160p, config.qualityLimits['2160p']);
  assert.equal(d.max1080p, config.qualityLimits['1080p']);
  assert.equal(d.max720p, config.qualityLimits['720p']);
  assert.equal(d.max480p, config.qualityLimits['480p']);
  assert.equal(d.maxSd, config.qualityLimits.SD);
  assert.equal(d.maxUnknown, config.qualityLimits.unknown);
});

test('defaults() traz brFirst true e jackettIndexers herdado do config', () => {
  const d = defaults();
  assert.equal(d.brFirst, true);
  assert.deepEqual(d.jackettIndexers, config.jackett.indexers);
  assert.deepEqual(d.indexerPriority, []);
});

test('normalize preserva ordem da prioridade de indexadores', () => {
  const out = normalize({ ip: ' NerdFilmes, ComandoTorrents ' });
  assert.deepEqual(out.indexerPriority, ['nerdfilmes', 'comandotorrents']);
  assert.deepEqual((decode(encode({ ip: out.indexerPriority })) as DecodedOptions).indexerPriority, out.indexerPriority);
});

test('normalize lê as chaves curtas e ignora chave desconhecida', () => {
  const out = normalize({ a: true, c: true, z: 25, x: 'zzz' });
  assert.equal(out.preferDubbed, true);
  assert.equal(out.excludeCam, true);
  assert.equal(out.maxSizeGb, 25);
  // Chave fora do SCHEMA não vira opção nem derruba a normalização.
  assert.equal('x' in out, false);
  assert.equal(out.maxResults, config.maxResults);
  // null e não-objeto devolvem os defaults sem quebrar.
  assert.deepEqual(normalize(null), defaults());
  assert.deepEqual(normalize('abc'), defaults());
});

test('maxSizeGb (z) trunca e clampa em 0..200; fora do range cai no default', () => {
  assert.equal(normalize({ z: 12.9 }).maxSizeGb, 12);
  assert.equal(normalize({ z: -5 }).maxSizeGb, 0);
  assert.equal(normalize({ z: 999 }).maxSizeGb, 200);
  assert.equal(normalize({ z: 'abc' }).maxSizeGb, 0);
});

test('normalize lê as chaves curtas q4/q1/q7/q5/qs dos limites por qualidade', () => {
  const out = normalize({ q4: 0, q1: 25, q7: 50, q5: 75, qs: 100 });
  assert.equal(out.max2160p, 0);
  assert.equal(out.max1080p, 25);
  assert.equal(out.max720p, 50);
  assert.equal(out.max480p, 75);
  assert.equal(out.maxSd, 100);
});

test('limites por qualidade truncam e clampam em 0..100; fora do range cai no default', () => {
  assert.equal(normalize({ q4: 12.9 }).max2160p, 12);
  assert.equal(normalize({ q1: -5 }).max1080p, 0);
  assert.equal(normalize({ q7: 999 }).max720p, 100);
  // Valor imprestável cai no default DA INSTÂNCIA, não num número fixo: o
  // default mudou de 4 para 6 quando as seis cotas viraram um controle só.
  assert.equal(normalize({ q5: 'abc' }).max480p, config.qualityLimits['480p']);
  // null é ignorado na normalização e mantém o default.
  assert.equal(normalize({ qs: null }).maxSd, config.qualityLimits.SD);
});

test('preferDubbed (a) e excludeCam (c) só são true com valores afirmativos', () => {
  for (const truthy of [true, 1, '1', 'true']) {
    assert.equal(normalize({ a: truthy }).preferDubbed, true);
    assert.equal(normalize({ c: truthy }).excludeCam, true);
  }
  for (const falsy of [false, 0, '0', 'false', '', 'qualquer']) {
    assert.equal(normalize({ a: falsy }).preferDubbed, false);
    assert.equal(normalize({ c: falsy }).excludeCam, false);
  }
});

test('brFirst (bf) só é true com valores afirmativos', () => {
  for (const truthy of [true, 1, '1', 'true']) {
    assert.equal(normalize({ bf: truthy }).brFirst, true);
  }
  for (const falsy of [false, 0, '0', 'false', '', 'qualquer']) {
    assert.equal(normalize({ bf: falsy }).brFirst, false);
  }
});

test('normalize lê ji com trim/lowercase e vazio explícito vira lista vazia', () => {
  const out = normalize({ ji: ' ComandoTorrents, NERDFILMES ,  ' });
  assert.deepEqual(out.jackettIndexers, ['comandotorrents', 'nerdfilmes']);
  // CSV vazio, array vazio e só separadores não viram indexer algum.
  assert.deepEqual(normalize({ ji: '' }).jackettIndexers, []);
  assert.deepEqual(normalize({ ji: [] }).jackettIndexers, []);
  assert.deepEqual(normalize({ ji: ' , , ' }).jackettIndexers, []);
  // Ausente no overlay mantém o default do operador, não zera a lista.
  assert.deepEqual(normalize({}).jackettIndexers, config.jackett.indexers);
});

test('roundtrip encode/decode preserva as opções novas e rejeita segmento inválido', () => {
  const decoded = (decode(encode({ a: true, c: false, z: 42 })) as DecodedOptions);
  assert.equal(decoded.preferDubbed, true);
  assert.equal(decoded.excludeCam, false);
  assert.equal(decoded.maxSizeGb, 42);
  // Segmento fora do charset base64url ou vazio não é config.
  assert.equal(decode('@nao-base64url@'), null);
  assert.equal(decode(null), null);
  assert.equal(decode(''), null);
});

test('roundtrip encode/decode preserva os limites por qualidade', () => {
  const decoded = (decode(encode({ q4: 0, q1: 25, q7: 50, q5: 75, qs: 100 })) as DecodedOptions);
  assert.equal(decoded.max2160p, 0);
  assert.equal(decoded.max1080p, 25);
  assert.equal(decoded.max720p, 50);
  assert.equal(decoded.max480p, 75);
  assert.equal(decoded.maxSd, 100);
});

test('roundtrip encode/decode preserva brFirst e jackettIndexers normalizados', () => {
  const decoded = (decode(encode({ bf: false, ji: ['ComandoTorrents', ' NERDFILMES '] })) as DecodedOptions);
  assert.equal(decoded.brFirst, false);
  assert.deepEqual(decoded.jackettIndexers, ['comandotorrents', 'nerdfilmes']);
  // bf ausente cai no default true; ji ausente cai no default do operador.
  const fallback = (decode(encode({})) as DecodedOptions);
  assert.equal(fallback.brFirst, true);
  assert.deepEqual(fallback.jackettIndexers, config.jackett.indexers);
});

test('segmento comporta catálogo Jackett grande e mantém teto defensivo', () => {
  const ids = Array.from({ length: 80 }, (_, index) =>
    `indexador-brasileiro-${String(index).padStart(3, '0')}`,
  );
  const segment = encode({ ji: ids, dk: 'x'.repeat(80) });
  assert.ok(segment.length > 2048);
  assert.ok(segment.length < MAX_CONFIG_SEGMENT);
  assert.deepEqual((decode(segment) as DecodedOptions).jackettIndexers, ids);
  assert.equal(decode('a'.repeat(MAX_CONFIG_SEGMENT + 1)), null);
});

test('roundtrip dos defaults é estável', () => {
  // O objeto normalizado já tem as chaves longas; re-encodar e decodificar
  // devolve os mesmos defaults (chaves desconhecidas são ignoradas).
  const d = defaults();
  assert.deepEqual(decode(encode(d)), d);
});


test('SCHEMA declara o limite individual por indexador como intmap 0..20', () => {
  assert.deepEqual(SCHEMA.indexerLimits, { type: 'intmap', key: 'jl', min: 0, max: 20 });
  // Sem override o limite fica por conta do maxPerIndexer global.
  assert.deepEqual(defaults().indexerLimits, {});
});

test('DEBRID_ALLOW_ENV_KEY veda só a chave herdada, nunca dk explícito', () => {
  const original = config.debrid.allowEnvKey;
  const originalKey = config.debrid.apiKey;
  try {
    config.debrid.allowEnvKey = false;
    config.debrid.apiKey = 'chave-do-operador';
    assert.equal(defaults().debridApiKey, '');
    assert.equal(normalize({}).debridApiKey, '');
    assert.equal(normalize({ dk: 'chave-do-usuario' }).debridApiKey, 'chave-do-usuario');
  } finally {
    config.debrid.allowEnvKey = original;
    config.debrid.apiKey = originalKey;
  }
});

test('normalize lê jl em CSV com IDs seguros lowercase e clamp 0..20', () => {
  const out = normalize({ jl: 'YTS:3, bludv:0, rarbg: 150, invalido!id:5, yts:7' });
  // `invalido!id` falha no SAFE_INDEXER_ID e é descartado; `rarbg` clampa em
  // 20; a última ocorrência de um id vence na ordem de chegada (yts:7).
  assert.deepEqual(out.indexerLimits, { bludv: 0, rarbg: 20, yts: 7 });
  // Negativo clampa em 0; entrada sem ":" ou sem número é descartada.
  assert.deepEqual(normalize({ jl: 'nerdfilmes:-3,sozinho,comandotorrents:abc' }).indexerLimits, {
    nerdfilmes: 0,
  });
});

test('normalize lê jl em array e em objeto', () => {
  assert.deepEqual(
    normalize({ jl: ['YTS:3', 'bludv:0'] }).indexerLimits,
    { bludv: 0, yts: 3 },
  );
  assert.deepEqual(
    normalize({ jl: { YTS: 3, bludv: 0 } }).indexerLimits,
    { bludv: 0, yts: 3 },
  );
  // Ausente no overlay mantém o default vazio, não zera a lista inteira.
  assert.deepEqual(normalize({}).indexerLimits, {});
});

test('roundtrip encode/decode preserva os limites por indexador, inclusive o 0', () => {
  const decoded = (decode(encode({ jl: { yts: 3, bludv: 0 } })) as DecodedOptions);
  // 0 é override explícito de "sem limite" e não pode sumir no caminho.
  assert.deepEqual(decoded.indexerLimits, { bludv: 0, yts: 3 });
  assert.deepEqual((decode(encode({ jl: {} })) as DecodedOptions).indexerLimits, {});
});

test('SCHEMA e roundtrip para streamNameStyle (ns) e streamNameShowSource (st)', () => {
  assert.deepEqual(SCHEMA.streamNameStyle, { type: 'string', key: 'ns' });
  assert.deepEqual(SCHEMA.streamNameShowSource, { type: 'bool', key: 'st' });

  const d = defaults();
  assert.equal(d.streamNameStyle, config.streamNameStyle);
  assert.equal(d.streamNameShowSource, config.streamNameShowSource);

  const custom = { ns: 'full', st: 0 };
  const decoded = decode(encode(custom)) as DecodedOptions;
  assert.equal(decoded.streamNameStyle, 'full');
  assert.equal(decoded.streamNameShowSource, false);
});

