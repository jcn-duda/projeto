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
import { dedupeByHash, sortAndLimit } from '../src/utils/format.js';
import { prepareCandidateStreams } from '../src/providers/stream-builder-pipeline.js';
import { pickFile, NoVideoError } from '../src/debrid/common.js';
import { noteAvailable } from '../src/debrid/cache-check.js';

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
      () => buildStreams(raw as any, { season: 2, episode: 1, imdbId: 'tt0000002', searchKey: 'magnet-db-null', deadlineAt: Date.now() + 8000 } as any),
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
      () => buildStreams(
        [
          // Formato já normalizado (minúsculo): `InfoHash` maiúsculo de Jackett cru viraria null antes do filtro.
          { title: `Filme Ruim ${badHash}`, infoHash: badHash, seeders: 10 },
          { title: `Filme Morto ${deadHash}`, infoHash: deadHash, seeders: 20 },
        ] as any,
        { season: null, episode: null, imdbId: 'tt0000003', searchKey: 'magnet-db-aviso', deadlineAt: Date.now() + 8000 } as any,
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
      () => applyDebrid([stream(blockedHash), stream(noVideoHash)] as any, { season: null, episode: null, imdbId: null, searchKey: 'magnet-rd-heal', deadlineAt: Date.now() + 8000, onCacheResult: null, workHint: null } as any),
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
      () => applyDebrid([stream(blockedHash)] as any, { season: null, episode: null, imdbId: null, searchKey: 'magnet-rd-heal-cached-only', deadlineAt: Date.now() + 8000, onCacheResult: null, workHint: null } as any),
    );
    assert.equal(cachedOnlyOut.length, 0, 'cachedOnly continua cortando o blocked pelo ledger');
    assert.equal(magnetdb.isBad('realdebrid', key, blockedHash), false, 'self-healing também limpa antes do corte cachedOnly');
  } finally {
    metrics.reset();
    config.debrid.rdLedger.enabled = priorLedgerEnabled;
    debrid.BY_ID.set('realdebrid', original as any);
  }
});

test('applyDebrid: blocked RD recém-gravado NUNCA sai pelo /resolve mesmo voltando como cacheado', async () => {
  // O /resolve descobriu o 451 e gravou noteBlocked, mas o magnet NÃO é bad
  // (recusa legal não é magnet quebrado). A checagem de cache ainda o devolve
  // como cacheado (memo/avaliador não sabem do bloqueio) — sem a purga ele
  // ressuscitaria como [RD⚡]/[RD download] e o play morreria em 451 de novo.
  const blockedHash = 'd'.repeat(40);
  const liveHash = 'e'.repeat(40);
  const { adapter } = makeFake((_apiKey, infoHashes) => ({
    cached: new Set(infoHashes.filter((h) => h === blockedHash || h === liveHash)),
    complete: true,
  }));
  const original = debrid.BY_ID.get('realdebrid');
  debrid.BY_ID.set('realdebrid', { ...adapter, id: 'realdebrid' } as any);
  const key = 'chave-rd-blocked-fresh';
  rdLedger.noteBlocked(blockedHash);
  const priorLedgerEnabled = config.debrid.rdLedger.enabled;
  config.debrid.rdLedger.enabled = true;
  metrics.reset();
  try {
    // Fora do cachedOnly: o bloqueado volta como P2P puro (infoHash intacto,
    // sem URL de /resolve e sem ⚡); o saudável segue com o link assinado.
    const out = await runWith(
      { opts: { ...userOpts(key), debridService: 'realdebrid', debridCachedOnly: false }, encoded: 'seg' },
      () => {
        // A purga só tem o que remover se ALGUM vetor de ressurreição tiver
        // devolvido o bloqueado como cacheado — é exatamente isso que o teste
        // quer provar. O vetor é semeado aqui, explícito: o memo `davail`
        // positivo (o primeiro da lista do comentário acima), gravado pela via
        // pública e sem rede. Antes o cenário dependia de um vetor acidental
        // (o oráculo Torrentio ligado no `.env` de quem rodava a suíte), e no
        // CI, sem `.env`, o hash nunca chegava a `cached` e a métrica ficava
        // em zero — o teste passava por acidente de ambiente.
        noteAvailable(blockedHash);
        return applyDebrid([stream(blockedHash), stream(liveHash)] as any, { season: null, episode: null, imdbId: null, searchKey: 'magnet-rd-blocked-fresh', deadlineAt: Date.now() + 8000, onCacheResult: null, workHint: null } as any);
      },
    );
    assert.equal(out.length, 2, 'nenhum dos dois some da lista');
    const blockedOut = out.find((s: any) => s.infoHash === blockedHash) as any;
    assert.ok(blockedOut, 'hash bloqueado volta como P2P fora do cachedOnly');
    assert.equal(blockedOut.url, undefined, 'bloqueado não aponta para o /resolve');
    assert.doesNotMatch(String(blockedOut.name), /⚡/, 'bloqueado não leva ⚡');
    const liveOut = out.find((s: any) => (s as any).url && String((s as any).url).includes(liveHash)) as any;
    assert.ok(liveOut, 'hash saudável confirmado em cache sai pelo /resolve');
    const counters = (metrics.snapshot() as any).counters;
    assert.equal(counters['debrid.blocked.dropped'], 1, 'purga do blocked contada em métrica própria');

    // Sob cachedOnly o corte o remove por completo (sem raio não aparece).
    const cachedOnlyOut = await runWith(
      { opts: { ...userOpts(key), debridService: 'realdebrid', debridCachedOnly: true }, encoded: 'seg' },
      () => applyDebrid([stream(blockedHash)] as any, { season: null, episode: null, imdbId: null, searchKey: 'magnet-rd-blocked-fresh-cached-only', deadlineAt: Date.now() + 8000, onCacheResult: null, workHint: null } as any),
    );
    assert.equal(cachedOnlyOut.length, 0, 'cachedOnly remove o hash bloqueado da lista');
  } finally {
    metrics.reset();
    config.debrid.rdLedger.enabled = priorLedgerEnabled;
    debrid.BY_ID.set('realdebrid', original as any);
  }
});

test('prepareCandidateStreams: stream _lied tem _dubbed false e perde preferDubbed boost', () => {
  const liedHash = '1'.repeat(40);
  const cleanHash = '2'.repeat(40);
  const raw = [
    { title: 'Filme Dublado DUAL 1080p', infoHash: liedHash, lied: true, seeders: 100 },
    { title: 'Filme Legendado 1080p', infoHash: cleanHash, seeders: 10 },
  ];
  const res = runWith({ opts: { ...userOpts('k1'), dubbedOnly: false }, encoded: 'seg' }, () =>
    prepareCandidateStreams(raw as any, {})
  );
  const sLied = res.streams.find((s: any) => s.infoHash === liedHash) as any;
  const sClean = res.streams.find((s: any) => s.infoHash === cleanHash) as any;
  assert.ok(sLied && sClean);
  assert.equal(sLied._lied, true);
  assert.equal(sLied._dubbed, false, 'promessa de dublado anulada para release com mentira');
  assert.equal(res.streams[0].infoHash, cleanHash, 'release limpa fica à frente da lied mesmo com menos seeders');
});

test('sortAndLimit: release limpa precede release lied de mesma qualidade e seeders', () => {
  const hClean = '3'.repeat(40);
  const hLied = '4'.repeat(40);
  const streams = [
    { infoHash: hLied, name: 'Filme Lied', title: 'Filme 1080p', _quality: '1080p', _seeders: 50, _lied: true },
    { infoHash: hClean, name: 'Filme Clean', title: 'Filme 1080p', _quality: '1080p', _seeders: 50, _lied: false },
  ];
  const out = sortAndLimit(streams as any, { preferDubbed: true });
  assert.equal((out[0] as any).infoHash, hClean, 'stream limpo vence lied com mesma qualidade e seeders');
});

test('dedupeByHash: favorece release honesta sobre clone lied e limpa _dubbed', () => {
  const hash = '5'.repeat(40);
  const cloneLied = { infoHash: hash, name: 'Lied Clone DUAL\n👤 80', title: 'Filme DUAL 1080p', _seeders: 80, _lied: true, _dubbed: true, _quality: '1080p' };
  const cloneClean = { infoHash: hash, name: 'Clean EN\n👤 20', title: 'Filme EN 1080p', _seeders: 20, _lied: false, _dubbed: false, _quality: '1080p' };
  const out1 = dedupeByHash([cloneLied, cloneClean]);
  assert.equal(out1.length, 1);
  assert.equal(out1[0]._lied, true, 'marca de mentira preservada');
  assert.equal(out1[0]._dubbed, false, 'dublado anulado na fusão com lied');
  assert.match(String(out1[0].name), /Clean EN/, 'clone limpo escolhido como winner');

  const out2 = dedupeByHash([cloneClean, cloneLied]);
  assert.equal(out2.length, 1);
  assert.equal(out2[0]._lied, true);
  assert.equal(out2[0]._dubbed, false);
  assert.match(String(out2[0].name), /Clean EN/);
});

test('prepareCandidateStreams: hashes em magnetdb.isLie são excluídos do instantSet', () => {
  const apiKey = 'test-key-lie-instant';
  const liedAliveHash = '6'.repeat(40);
  const cleanHash = '7'.repeat(40);
  const { adapter } = makeFake();
  const origAdapter = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  magnetdb.markAlive('premiumize', apiKey, [liedAliveHash]);
  magnetdb.markLie('premiumize', apiKey, liedAliveHash);
  try {
    const raw = [
      { title: 'Filme 1 1080p', infoHash: liedAliveHash, seeders: 5 },
      { title: 'Filme 2 1080p', infoHash: cleanHash, seeders: 10 },
    ];
    const res = runWith({ opts: { ...userOpts(apiKey), dubbedOnly: false }, encoded: 'seg' }, () =>
      prepareCandidateStreams(raw as any, {})
    );
    assert.equal(res.streams[0].infoHash, cleanHash, 'lied não recebe instant boost e fica atrás de clean');
    assert.equal((res.streams.find((s: any) => s.infoHash === liedAliveHash) as any)._lied, true);
  } finally {
    debrid.BY_ID.set('premiumize', origAdapter as any);
  }
});

test('sortAndLimit: dubbedOnly descarta streams _lied antecipadamente', () => {
  const hClean = '8'.repeat(40);
  const hLied = '9'.repeat(40);
  const streams = [
    { infoHash: hLied, name: 'Filme Lied', title: 'Filme 1080p', _quality: '1080p', _seeders: 100, _lied: true },
    { infoHash: hClean, name: 'Filme Clean', title: 'Filme 1080p', _quality: '1080p', _seeders: 50, _lied: false },
  ];
  const out = sortAndLimit(streams as any, { dubbedOnly: true });
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).infoHash, hClean, 'stream _lied foi expurgado pelo dubbedOnly');
});

test('sortAndLimit: preferDubbed demove stream _lied com 5000 seeders atras de stream EN com 1 seeder', () => {
  const hCleanEn = 'e'.repeat(40);
  const hLied = 'f'.repeat(40);
  const streams = [
    { infoHash: hLied, name: 'Filme Lied DUAL\n👤 5000', title: 'Filme 1080p DUAL', _quality: '1080p', _seeders: 5000, _lied: true, _dubbed: true },
    { infoHash: hCleanEn, name: 'Filme Clean EN\n👤 1', title: 'Filme 1080p EN', _quality: '1080p', _seeders: 1, _lied: false, _dubbed: false },
  ];
  const out = sortAndLimit(streams as any, { preferDubbed: true });
  assert.equal((out[0] as any).infoHash, hCleanEn, 'stream EN com 1 seeder supera stream lied com 5000 seeders');
  assert.equal((out[1] as any).infoHash, hLied);
});

test('dedupeByHash: permutações de 3 clones preservam título honesto e 500 seeders do enxame', () => {
  const hash = 'a'.repeat(40);
  const clean = { infoHash: hash, name: 'Honest YTS EN\n👤 50', title: 'Honest YTS EN', _seeders: 50, _lied: false, _dubbed: false, _quality: '1080p' };
  const fake1 = { infoHash: hash, name: 'Fake BluDV DUAL\n👤 500', title: 'Fake BluDV DUAL', _seeders: 500, _lied: true, _dubbed: true, _quality: '1080p' };
  const fake2 = { infoHash: hash, name: 'Fake Comando DUAL\n👤 200', title: 'Fake Comando DUAL', _seeders: 200, _lied: true, _dubbed: true, _quality: '1080p' };
  const perms = [
    [clean, fake1, fake2], [clean, fake2, fake1],
    [fake1, clean, fake2], [fake2, clean, fake1],
    [fake1, fake2, clean], [fake2, fake1, clean],
  ];
  for (const p of perms) {
    const out = dedupeByHash(p);
    assert.equal(out.length, 1);
    assert.match(String(out[0].name), /Honest YTS EN/, 'título limpo preservado em todas as permutações');
    assert.equal(out[0]._seeders, 500, 'max seeders do enxame preservado');
    assert.equal(out[0]._lied, true);
    assert.equal(out[0]._dubbed, false);
  }
});

test('prepareCandidateStreams: release com lied: true em raw é excluída do instantSet mesmo marcada alive', () => {
  const apiKey = 'test-raw-lie-instant';
  const liedAliveHash = 'c'.repeat(40);
  const cleanHash = 'd'.repeat(40);
  const { adapter } = makeFake();
  const origAdapter = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', adapter as any);
  magnetdb.markAlive('premiumize', apiKey, [liedAliveHash]);
  try {
    const raw = [
      { title: 'Filme Fake 1080p', infoHash: liedAliveHash, lied: true, seeders: 1 },
      { title: 'Filme Clean 1080p', infoHash: cleanHash, lied: false, seeders: 100 },
    ];
    const res = runWith({ opts: { ...userOpts(apiKey), dubbedOnly: false }, encoded: 'seg' }, () =>
      prepareCandidateStreams(raw as any, {})
    );
    assert.equal(res.streams[0].infoHash, cleanHash, 'clean vence por seeders pois lied não entra no instantSet');
    assert.equal(res.streams[1].infoHash, liedAliveHash);
  } finally {
    debrid.BY_ID.set('premiumize', origAdapter as any);
  }
});
