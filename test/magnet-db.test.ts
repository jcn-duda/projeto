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
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import debrid from '../src/debrid/index.js';
import { applyDebrid, buildStreams } from '../src/providers/index.js';
import * as autofetch from '../src/providers/autofetch.js';
import { accountScope } from '../src/utils/request-key.js';
import { sortAndLimit } from '../src/utils/format.js';
import { pickFile, NoVideoError } from '../src/debrid/common.js';

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
  magnetdb.markAlive('premiumize', conta, [hash]);
  assert.equal(magnetdb.isAlive('premiumize', conta, hash), true);
  magnetdb.markBad('premiumize', conta, hash);
  assert.equal(magnetdb.isBad('premiumize', conta, hash), true);
  assert.equal(magnetdb.isAlive('premiumize', conta, hash), false, 'alive não sobrevive ao bad no mesmo hash');
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
  assert.equal(JSON.stringify(snapshot).includes(secretAccount), false, 'o diagnóstico não vaza chave nem digest de conta');
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
  const aliveKey = `${prefix('mag')}alive:premiumize:${accountScope(key)}:${hash}`;
  try {
    await runWith({ opts: userOpts(key), encoded: '' }, () => debrid.checkCached([hash]));
    assert.equal(calls.length, 1, 'primeira passada vai à rede');
    assert.equal(magnetdb.isAlive('premiumize', key, hash), true);
    // Simula o alive expirando enquanto o davail (TTL curto) ainda cobre:
    // sem a renovação no atalho, quanto mais buscado o título, mais cedo o
    // desempate instant morria no meio do TTL de 7 dias.
    cache.forget(aliveKey);
    assert.equal(magnetdb.isAlive('premiumize', key, hash), false);
    await runWith({ opts: userOpts(key), encoded: '' }, () => debrid.checkCached([hash]));
    assert.equal(calls.length, 1, 'segunda passada é servida pelo L1 do davail, sem rede');
    assert.equal(magnetdb.isAlive('premiumize', key, hash), true, 'mesma evidência confirmada, servida da memória, renova o TTL');
    // Renovação ECONÔMICA: com o alive recém-regravado (TTL cheio pela frente),
    // um novo hit do atalho NÃO regrava — o hit do L1 não é evidência nova.
    metrics.reset();
    await runWith({ opts: userOpts(key), encoded: '' }, () => debrid.checkCached([hash]));
    assert.equal(calls.length, 1, 'continua sem rede');
    assert.equal(magnetdb.isAlive('premiumize', key, hash), true);
    const counters = (metrics.snapshot() as any).counters;
    assert.equal(counters['magnetdb.alive.set'] == null, true, 'alive fresco não é regravado no hit do atalho');
  } finally {
    metrics.reset();
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
    await runWith({ opts: userOpts(key), encoded: '' }, () => debrid.checkCached(['c1'.repeat(20)]));
    assert.equal(
      magnetdb.isAlive('premiumize', key, 'c1'.repeat(20)),
      true,
      'positivo medido vira histórico durável, independente do TTL curto do davail',
    );
  } finally {
    debrid.BY_ID.set('premiumize', original as any);
  }
});

test('applyDebrid descarta hash ruim no banco e morto no autofetch, antes da checagem', async () => {
  const { adapter, calls } = makeFake();
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  const key = 'chave-mag-drop';
  const badHash = 'd'.repeat(40);
  const deadHash = 'e'.repeat(40);
  const goodHash = 'f'.repeat(40);
  magnetdb.markBad('premiumize', key, badHash);
  autofetch.blacklist('premiumize', accountScope(key), deadHash);
  metrics.reset();
  try {
    const out = await runWith({ opts: userOpts(key), encoded: '' }, () =>
      applyDebrid([stream(badHash), stream(deadHash), stream(goodHash)] as any, {
        season: null,
        episode: null,
        imdbId: 'tt0000001',
        searchKey: 'magnet-db-drop',
        deadlineAt: Date.now() + 8000,
        onCacheResult: null,
        workHint: null,
      } as any),
    );
    assert.equal(out.length, 1, 'só o hash sem histórico sobrevive');
    // O sobrevivente é identificável por hash na URL de /resolve ou no
    // infoHash puro (depende de DEBRID_RESOLVE_UNCACHED); o que importa é o
    // conjunto: o bom fica, os ruins somem.
    const dump = JSON.stringify(out);
    assert.ok(dump.includes(goodHash), 'o hash limpo permanece na lista');
    assert.ok(!dump.includes(badHash), 'o hash ruim no banco saiu da lista');
    assert.ok(!dump.includes(deadHash), 'o hash morto no autofetch saiu da lista');
    // O lote enviado ao debrid não carrega o lixo: não se gasta checagem
    // (nem upload, na AllDebrid) com o que já provou estar quebrado.
    assert.deepEqual(calls[0], [goodHash]);
    assert.equal((metrics.snapshot() as any).counters['magnetdb.dropped'], 2);
  } finally {
    metrics.reset();
    debrid.BY_ID.set('premiumize', original as any);
  }
});

test('applyDebrid sem histórico não descarta nada (controle)', async () => {
  const { adapter } = makeFake();
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  try {
    const out = await runWith({ opts: userOpts('chave-mag-controle'), encoded: '' }, () =>
      applyDebrid([stream('1'.repeat(40)), stream('2'.repeat(40))] as any, {
        season: null,
        episode: null,
        imdbId: 'tt0000001',
        searchKey: 'magnet-db-controle',
        deadlineAt: Date.now() + 8000,
        onCacheResult: null,
        workHint: null,
      } as any),
    );
    assert.equal(out.length, 2, 'sem evidência, nada sai da lista');
  } finally {
    debrid.BY_ID.set('premiumize', original as any);
  }
});

test('sortAndLimit: histórico instantâneo desempata acima dos seeders', () => {
  const hot = '3'.repeat(40);
  const proven = '4'.repeat(40);
  const mk = (hash: string, seeders: number) => ({
    name: `filme ${hash}`,
    title: 'Filme Teste 1080p',
    infoHash: hash,
    _seeders: seeders,
    _quality: '1080p',
  });
  const semHistorico = sortAndLimit([mk(hot, 50), mk(proven, 5)] as any, {});
  assert.equal((semHistorico[0] as any).infoHash, hot, 'sem registro, seeders decidem');
  const comHistorico = sortAndLimit([mk(hot, 50), mk(proven, 5)] as any, {
    instant: (h: string) => h === proven,
  } as any);
  assert.equal((comHistorico[0] as any).infoHash, proven, 'magnet que já provou tocar na hora vence a aposta de seeders');
});

// Regressão medida no container (tt11198330:2:1, 520 resultados, lista vazia):
// `toStremioStream` devolve NULL para item sem infoHash — link que resolvedor
// nenhum abriu — e o desempate do banco de magnets lia `.infoHash` do buraco.
// Um único resultado assim derrubava a BUSCA INTEIRA com TypeError, e o usuário
// via zero stream num título com centenas de releases.
test('buildStreams sobrevive a item sem infoHash com banco de magnets ligado', async () => {
  const originalCheck = debrid.checkCached;
  debrid.checkCached = async () => ({ cached: new Set<string>(), known: true }) as any;
  try {
    const raw = [
      // Sem infoHash e sem magnet: vira null no mapeamento.
      { Title: 'Serie Sem Hash S02E01 1080p', Seeders: 9, Link: 'https://sem-hash.test/x' },
      { Title: 'Serie Boa S02E01 1080p DUAL', Seeders: 40, InfoHash: '5'.repeat(40) },
    ];
    const out = await runWith(
      { opts: { ...userOpts('chave-mag-null'), debridCachedOnly: false }, encoded: 'segcfg' },
      () =>
        buildStreams(raw as any, {
          season: 2,
          episode: 1,
          imdbId: 'tt0000002',
          searchKey: 'magnet-db-null',
          deadlineAt: Date.now() + 8000,
        } as any),
    );
    assert.ok(Array.isArray(out), 'a lista não pode morrer por causa do item sem hash');
    assert.ok(out.length >= 1, 'o resultado com hash continua entregue');
  } finally {
    debrid.checkCached = originalCheck;
  }
});

// O aviso é o que o usuário vê quando o filtro pré-checagem esvazia a lista:
// sem texto próprio ele sairia como "fora do cache", culpando a checagem pelo
// que foi histórico ruim. As métricas separadas são o instrumento que valida a
// correção do markBad em produção (.bad deve despencar depois dela).
test('buildStreams: filtro pré-checagem esvaziando gera aviso próprio e métricas bad/dead separadas', async () => {
  const { adapter } = makeFake();
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  const originalCheck = debrid.checkCached;
  debrid.checkCached = async () => ({ cached: new Set<string>(), known: true }) as any;
  const key = 'chave-mag-aviso';
  const badHash = 'b'.repeat(40);
  const deadHash = 'e'.repeat(40);
  magnetdb.markBad('premiumize', key, badHash);
  autofetch.blacklist('premiumize', accountScope(key), deadHash);
  metrics.reset();
  try {
    const out = await runWith(
      { opts: { ...userOpts(key), debridCachedOnly: false }, encoded: 'segcfg' },
      () =>
        buildStreams(
          [
            // Formato já normalizado (minúsculo): `InfoHash` maiúsculo de
            // Jackett cru viraria null no toStremioStream antes do filtro.
            { title: `Filme Ruim ${badHash}`, infoHash: badHash, seeders: 10 },
            { title: `Filme Morto ${deadHash}`, infoHash: deadHash, seeders: 20 },
          ] as any,
          {
            season: null,
            episode: null,
            imdbId: 'tt0000003',
            searchKey: 'magnet-db-aviso',
            deadlineAt: Date.now() + 8000,
          } as any,
        ),
    );
    assert.equal(out.length, 1, 'sobra só o item de aviso');
    assert.match(String(out[0].name), /histórico ruim/, 'o aviso diz o motivo real, não "fora do cache"');
    const counters = (metrics.snapshot() as any).counters;
    assert.equal(counters['magnetdb.dropped'], 2);
    assert.equal(counters['magnetdb.dropped.bad'], 1, 'bad (banco de magnets) contado à parte');
    assert.equal(counters['magnetdb.dropped.dead'], 1, 'dead (blacklist do autofetch) contado à parte');
  } finally {
    metrics.reset();
    debrid.checkCached = originalCheck;
    debrid.BY_ID.set('premiumize', original as any);
  }
});

test('applyDebrid: bad+blocked RD é limpo e mantém o stream fora do cachedOnly; bad sem blocked continua descartado', async () => {
  const { adapter } = makeFake();
  const original = debrid.BY_ID.get('realdebrid');
  // Aplica o filtro para o adapter Real-Debrid sem rede na checagem (default do fake).
  debrid.BY_ID.set('realdebrid', { ...adapter, id: 'realdebrid' } as any);
  const key = 'chave-rd-heal';
  const blockedHash = 'a'.repeat(40); // dano antigo: bad + blocked
  const noVideoHash = 'b'.repeat(40); // NoVideo legítimo: bad, sem blocked
  magnetdb.markBad('realdebrid', key, blockedHash);
  magnetdb.markBad('realdebrid', key, noVideoHash);
  rdLedger.noteBlocked(blockedHash);
  const priorLedgerEnabled = config.debrid.rdLedger.enabled;
  config.debrid.rdLedger.enabled = true;
  metrics.reset();
  try {
    const out = await runWith(
      { opts: { ...userOpts(key), debridService: 'realdebrid', debridCachedOnly: false }, encoded: 'seg' },
      () =>
        applyDebrid([stream(blockedHash), stream(noVideoHash)] as any, {
          season: null,
          episode: null,
          imdbId: null,
          searchKey: 'magnet-rd-heal',
          deadlineAt: Date.now() + 8000,
          onCacheResult: null,
          workHint: null,
        } as any),
    );
    const dump = JSON.stringify(out);
    assert.ok(dump.includes(blockedHash), 'bad+blocked (fora do cachedOnly) volta como stream sem ⚡');
    assert.ok(!dump.includes(noVideoHash), 'bad deixado sem blocked continua descartado');

    assert.equal(magnetdb.isBad('realdebrid', key, blockedHash), false, 'bad+blocked foi limpo no self-heal');
    assert.equal(magnetdb.isBad('realdebrid', key, noVideoHash), true, 'bad legítimo preservado');

    const counters = (metrics.snapshot() as any).counters;
    assert.equal(counters['magnetdb.bad.clearedBlocked'], 1, 'métrica específica do reparo');
    assert.equal(counters['magnetdb.dropped.bad'], 1, 'bad legítimo conta como derrubado');
    assert.equal(counters['magnetdb.dropped'], 1, 'dropped agrega sem o recuperado');

    // O mesmo fingerprint em cachedOnly ainda se autocorrige no magnetdb, mas
    // o ledger blocked faz o corte ternário depois: não promete play instantâneo.
    magnetdb.markBad('realdebrid', key, blockedHash);
    const cachedOnlyOut = await runWith(
      { opts: { ...userOpts(key), debridService: 'realdebrid', debridCachedOnly: true }, encoded: 'seg' },
      () =>
        applyDebrid([stream(blockedHash)] as any, {
          season: null,
          episode: null,
          imdbId: null,
          searchKey: 'magnet-rd-heal-cached-only',
          deadlineAt: Date.now() + 8000,
          onCacheResult: null,
          workHint: null,
        } as any),
    );
    assert.equal(cachedOnlyOut.length, 0, 'cachedOnly continua cortando o blocked pelo ledger');
    assert.equal(magnetdb.isBad('realdebrid', key, blockedHash), false, 'self-healing também limpa antes do corte cachedOnly');
  } finally {
    metrics.reset();
    config.debrid.rdLedger.enabled = priorLedgerEnabled;
    debrid.BY_ID.set('realdebrid', original as any);
  }
});
