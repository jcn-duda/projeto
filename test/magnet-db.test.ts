// Banco de magnets (namespace `mag:`): memória durável por hash, escopada por
// serviço+conta. Só evidência medida entra — o positivo vem da checagem de
// cache do debrid ou do /resolve; o negativo, de falha determinística do play.
// Estes testes cobrem o módulo e os dois pontos de consumo da listagem:
// o descarte em `applyDebrid` e o desempate em `sortAndLimit`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as rdLedger from '../src/debrid/rd-ledger.js';
import * as runtime from '../src/runtime.js';
import * as metrics from '../src/utils/metrics.js';
import { magnetState, davailState } from '../src/utils/debrid-state-native.js';
import debrid from '../src/debrid/index.js';
import debridCheck from './helpers/pipeline-oracle/debrid-check.js';
import { applyDebrid } from './helpers/pipeline-oracle/index.js';
import { sortAndLimit } from './helpers/pipeline-oracle/format.js';
import { pickFile, NoVideoError } from '../src/debrid/common.js';
import { createStreamTrace } from '../src/utils/stream-trace.js';

const runWith = (patch: { opts: any; encoded: string }, fn: () => any) => runtime.run(patch, fn);

// Adaptador fake `cacheCheck: true` no registry real (mesmo padrão do
// debrid-avail). Por padrão nada está em cache: a lista passa inteira como
// torrent puro e o que decide o teste é o descarte PRÉ-checagem.
function makeFake(handler?: (apiKey: string, infoHashes: string[]) => any) {
  const calls: string[][] = [];
  const adapter = {
    id: 'premiumize',
    label: 'Premiumize fake',
    short: 'pm',
    cacheCheck: true,
    keyUrl: 'https://x.test',
    async checkCached(_apiKey: string, infoHashes: string[]) {
      calls.push([...infoHashes]);
      return handler ? handler(_apiKey, infoHashes) : { cached: new Set(), complete: true };
    },
    async resolveLink() {
      return null;
    },
  };
  return { adapter, calls };
}

function userOpts(apiKey: string) {
  return {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: apiKey,
  };
}

const stream = (hash: string) => ({ name: `filme ${hash}`, title: `Filme Teste ${hash}`, infoHash: hash });

test('alive/bad: leitura escopada por serviço e conta', () => {
  const hash = 'a'.repeat(40);
  // bad antes de alive: markBad apaga o alive do MESMO hash (política "bad
  // vence"), então a coexistência aqui só existe em hashes distintos.
  magnetdb.markBad('premiumize', 'conta-mag-x', hash);
  magnetdb.markAlive('premiumize', 'conta-mag-x', ['6'.repeat(40)]);
  assert.equal(magnetdb.isBad('premiumize', 'conta-mag-x', hash), true);
  assert.equal(magnetdb.isAlive('premiumize', 'conta-mag-x', '6'.repeat(40)), true);
  // Outra conta e outro serviço não veem o histórico — cache do debrid
  // pertence à conta, e "morto" num serviço não vale para outro.
  assert.equal(magnetdb.isAlive('premiumize', 'conta-mag-y', '6'.repeat(40)), false);
  assert.equal(magnetdb.isBad('torbox', 'conta-mag-x', hash), false);
  // Hash é normalizado: marcar em maiúsculas e ler em minúsculas casa.
  magnetdb.markAlive('premiumize', 'conta-mag-x', ['B'.repeat(40)]);
  assert.equal(magnetdb.isAlive('premiumize', 'conta-mag-x', 'b'.repeat(40)), true);
});

test('bad vence sobre alive: markBad apaga o histórico vivo do mesmo hash', () => {
  // As janelas de TTL são distintas (24h contra 7 dias), então os dois podem
  // coexistir — e aí o instantSet empurraria ao topo um hash que o filtro
  // pré-checagem ia cortar, gastando vaga do pool de candidatos.
  const hash = '8'.repeat(40);
  const conta = 'conta-bad-vence';
  // L2 residual de rodada anterior (CACHE_PERSIST) deixaria isBad=true e
  // markAlive recusaria — limpa o lado bad antes de provar a política.
  magnetdb.forgetBad('premiumize', conta, hash);
  magnetdb.markAlive('premiumize', conta, [hash]);
  assert.equal(magnetdb.isAlive('premiumize', conta, hash), true);
  magnetdb.markBad('premiumize', conta, hash);
  assert.equal(magnetdb.isBad('premiumize', conta, hash), true);
  assert.equal(magnetdb.isAlive('premiumize', conta, hash), false, 'alive não sobrevive ao bad no mesmo hash');
});

test('markAlive recusa hash bad: não ressuscita o alive', () => {
  // Sem o filtro, a checagem seguinte regravava alive e desfazia o forget do markBad.
  const hash = '3'.repeat(40);
  const conta = 'conta-alive-refused-bad';
  magnetdb.markBad('premiumize', conta, hash);
  metrics.reset();
  magnetdb.markAlive('premiumize', conta, [hash]);
  assert.equal(magnetdb.isAlive('premiumize', conta, hash), false, 'markAlive não ressuscita hash bad');
  assert.equal((metrics.snapshot() as any).counters['magnetdb.alive.refused-bad'], 1);
  metrics.reset();
});

test('lie é evidência própria, escopada por conta, sem virar bad', () => {
  const hash = '9'.repeat(40);
  magnetdb.markLie('premiumize', 'conta-lie', hash);
  assert.equal(magnetdb.isLie('premiumize', 'conta-lie', hash), true);
  assert.equal(magnetdb.isLie('premiumize', 'outra-conta', hash), false);
  assert.equal(magnetdb.isBad('premiumize', 'conta-lie', hash), false);
});

test('status observa por adaptador e TTL sem expor o escopo da conta', () => {
  const secretAccount = 'conta-que-nao-pode-vazar';
  magnetdb.markAlive('premiumize', secretAccount, ['a1'.repeat(20)]);
  magnetdb.markBad('torbox', secretAccount, 'b1'.repeat(20));
  magnetdb.markLie('torbox', secretAccount, 'c1'.repeat(20));

  const snapshot = magnetdb.status();
  assert.ok(snapshot.sizeAlive >= 1);
  assert.ok(snapshot.sizeBad >= 1);
  assert.ok(snapshot.sizeLie >= 1);
  assert.ok(snapshot.ttlRemainingSeconds.alive !== null);
  assert.ok(snapshot.byAdapter.premiumize.sizeAlive >= 1);
  assert.ok(snapshot.byAdapter.torbox.sizeBad >= 1);
  assert.ok(snapshot.byAdapter.torbox.ttlRemainingSeconds.lie !== null);
  assert.equal(typeof snapshot.l1Entries, 'number');
  assert.equal(typeof snapshot.l1Max, 'number');
  assert.equal(typeof snapshot.evictedQuota, 'number');
  assert.ok(snapshot.l1Max >= snapshot.l1Entries);
  assert.equal(JSON.stringify(snapshot).includes(secretAccount), false, 'o diagnóstico não vaza chave nem digest de conta');
  // Mecanismo A: contadores duráveis consolidados.
  assert.equal(snapshot._origem.l1Entries, 'duravel');
  assert.equal(snapshot._origem.sizeAlive, 'duravel');
  assert.equal(snapshot._origem.byAdapter, 'duravel');
  assert.equal(snapshot._origem.evictedQuota, 'duravel');
});

test('status: ocupação do namespace mag ≠ tamanho da amostra (órfã sem track)', () => {
  // Linha escrita direto no núcleo não passa por mark*/track — o namespace
  // sobe, a amostra não. Prova que o painel não pode fundir os dois campos.
  const before = magnetdb.status();
  const sampleBefore = before.sizeAlive + before.sizeBad + before.sizeLie;
  const l1Before = before.l1Entries;
  magnetState().markAlive('orphan-l1', 'conta-orfa', ['f'.repeat(40)], 60, Date.now());
  try {
    const after = magnetdb.status();
    assert.equal(after.l1Entries, l1Before + 1, 'namespace conta a órfã');
    assert.equal(
      after.sizeAlive + after.sizeBad + after.sizeLie,
      sampleBefore,
      'amostra tracked não muda com a órfã',
    );
    assert.ok(after.l1Entries !== after.sizeAlive + after.sizeBad + after.sizeLie, 'namespace e amostra são campos distintos');
  } finally {
    // Relógio à frente do TTL da órfã: a varredura nativa apaga só ela.
    magnetState().sweep(0, Date.now() + 61_000);
  }
});

test('pickFile: listagem vazia é null (transferência fria), não prova de magnet quebrado', () => {
  // null significa "ainda baixando" — o /resolve NÃO grava bad para null.
  assert.equal(pickFile([], {}), null);
});

test('pickFile: arquivos presentes e nenhum vídeo lança NoVideoError', () => {
  // A única prova determinística de magnet quebrado: a listagem veio COM
  // arquivos e nenhum é vídeo (pack só de .rar, sample.mkv sozinho).
  assert.throws(() => pickFile([{ path: 'x.rar' }], {}), NoVideoError);
  assert.throws(() => pickFile([{ path: 'sample.mkv' }], {}), NoVideoError);
  // Com vídeo de verdade não lança: escolhe o maior e segue o play.
  const ok = pickFile([{ path: 'sample.mkv' }, { path: 'filme.mkv' }], {}) as any;
  assert.equal(ok.path, 'filme.mkv', 'sample sai do balde de vídeos, não condena o torrent');
});

test('atalho do davail renova o histórico alive sem rede', async () => {
  const { adapter, calls } = makeFake(async (_apiKey, infoHashes) => ({
    cached: new Set(infoHashes),
    complete: true,
  }));
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  const key = 'chave-mag-atalho';
  const hash = '7'.repeat(40);
  // Estado limpo dos dois lados: L2 residual (davail/alive) de rodada anterior
  // faria a 1ª passada pular a rede.
  magnetState().clear();
  davailState().clear();
  try {
    await runWith({ opts: userOpts(key), encoded: '' }, () => debridCheck.checkCached([hash]));
    assert.equal(calls.length, 1, 'primeira passada vai à rede');
    assert.equal(magnetdb.isAlive('premiumize', key, hash), true);
    // Simula o alive expirando enquanto o davail (TTL curto) ainda cobre: não há
    // `forgetAlive` na ponte, então esvaziar o namespace é o equivalente
    // observável — o davail fica intacto e a 2ª passada tem de renovar sem rede.
    magnetState().clear();
    assert.equal(magnetdb.isAlive('premiumize', key, hash), false);
    await runWith({ opts: userOpts(key), encoded: '' }, () => debridCheck.checkCached([hash]));
    assert.equal(calls.length, 1, 'segunda passada é servida pelo L1 do davail, sem rede');
    assert.equal(magnetdb.isAlive('premiumize', key, hash), true, 'mesma evidência confirmada, servida da memória, renova o TTL');
    // Renovação ECONÔMICA: com o alive recém-regravado (TTL cheio pela frente),
    // um novo hit do atalho NÃO regrava — o hit do L1 não é evidência nova.
    metrics.reset();
    await runWith({ opts: userOpts(key), encoded: '' }, () => debridCheck.checkCached([hash]));
    assert.equal(calls.length, 1, 'continua sem rede');
    assert.equal(magnetdb.isAlive('premiumize', key, hash), true);
    const counters = (metrics.snapshot() as any).counters;
    assert.equal(counters['magnetdb.alive.set'] == null, true, 'alive fresco não é regravado no hit do atalho');
  } finally {
    metrics.reset();
    magnetState().clear();
    davailState().clear();
    magnetdb.loadPersistentCounts();
    debrid.BY_ID.set('premiumize', original as any);
  }
});

test('checkCached com positivo confirmado grava o histórico alive', async () => {
  const { adapter } = makeFake(async (_apiKey, infoHashes) => ({
    cached: new Set(infoHashes),
    complete: true,
  }));
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  const key = 'chave-mag-confirm';
  try {
    await runWith({ opts: userOpts(key), encoded: '' }, () => debridCheck.checkCached(['c1'.repeat(20)]));
    assert.equal(
      magnetdb.isAlive('premiumize', key, 'c1'.repeat(20)),
      true,
      'positivo medido vira histórico durável, independente do TTL curto do davail',
    );
  } finally {
    debrid.BY_ID.set('premiumize', original as any);
  }
});

test('applyDebrid sem adapter: stream _lied some da lista (pre-debrid)', async () => {
  // P2P puro (sem serviço/chave) early-returna antes do pruneKnownBroken; o
  // corte de _lied tem que acontecer ANTES, senão o mentiroso chega ao cliente.
  // O dropTrace com motivo 'lie' é o que o P5 usa para saber QUAL sumiu.
  const good = 'a'.repeat(40);
  const lied = 'b'.repeat(40);
  const trace = createStreamTrace();
  metrics.reset();
  try {
    const out = await runWith(
      { opts: { ...runtime.defaults(), debridService: '', debridApiKey: '' }, encoded: '' },
      () => applyDebrid([
        stream(good),
        { ...stream(lied), _lied: true },
      ] as any, {
        season: null,
        episode: null,
        imdbId: 'tt0000001',
        searchKey: 'magnet-db-pre-lie',
        deadlineAt: Date.now() + 8000,
        onCacheResult: null,
        workHint: null,
        trace,
      } as any),
    );
    assert.equal(out.length, 1, 'só o stream sem _lied sobrevive');
    assert.equal(out[0].infoHash, good);
    assert.equal((metrics.snapshot() as any).counters['search.lie.pre-debrid'], 1);
    assert.equal((metrics.snapshot() as any).counters['magnetdb.dropped.lie'], undefined,
      'sem adapter não passa pelo pruneKnownBroken — métrica distinta');
    assert.equal(trace.items.length, 1, 'um drop no P5');
    assert.equal(trace.items[0].reason, 'lie', 'pre-debrid registra o mesmo motivo do pruneKnownBroken');
    assert.match(String(trace.items[0].label), new RegExp(lied.slice(0, 8)));
  } finally {
    metrics.reset();
  }
});

// Regressão: `bad` vencido que ainda espera a poda continua no store. O
// forgetBadOf APAGA essa entrada, então precisa reportar que existia — com
// uma leitura de `peek` ele devolvia false e o magnet-clear-bad dizia
// "cleared: 0" logo depois de limpar de verdade.
test('forgetBadOf reporta remoção de bad vencido ainda não podado', async () => {
  const apiKey = 'chave-forget-vencido';
  const h = 'b'.repeat(40);
  const originalTtl = config.magnetDb.badTtl;
  try {
    config.magnetDb.badTtl = 1;
    magnetdb.markBad('premiumize', apiKey, h);
    await new Promise((r) => setTimeout(r, 1100));
    // `entries` ignora a vencida sem apagá-la (quem apaga é `state`/`sweep`),
    // então esta é a prova de que a linha física ainda existe. Filtra pelo
    // hash: outros testes deste arquivo já deixaram `bad` de premiumize com o
    // TTL cheio e apareceriam na página.
    const page = magnetState().entries('premiumize', 'bad', h, 0, Date.now());
    assert.equal(page.matched, 0, 'precondição: vencida para a enumeração');
    assert.equal(magnetdb.forgetBadOf('premiumize', h), true, 'a remoção é reportada ao operador');
    assert.equal(magnetdb.forgetBadOf('premiumize', h), false, 'segunda passada é idempotente');
  } finally {
    config.magnetDb.badTtl = originalTtl;
  }
});
