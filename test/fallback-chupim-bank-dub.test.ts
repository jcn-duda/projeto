// Reserva do banco com ÁUDIO GRAVADO (2026-10-08). O classificador da captura
// marca `dubbed` mesmo quando o título do post não cita áudio — "Locke & Key
// 1ª e 2ª Temporada (2021) S01 [720p]" (tt3007572, apachetorrent) chegava ao
// Chupim com `_dubClaim:false` (o claim nasce só do TÍTULO) e o pool BR do
// autofetch ficava vazio: o pack dublado que o banco JÁ conhece nunca era
// baixado e a sonda br-probe girava à toa. `_bankDub` carrega a evidência do
// banco até os pools com as guardas do claim (lie, prova vazia, dn= de cena
// EN, origem da conta); chip e `_dubbed` (prova de arquivo) não mudam.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope } from '../src/utils/request-key.js';
import { applyDebrid } from '../src/providers/index.js';
import { drainNext } from '../src/providers/autofetch-runner.js';
import { toQueueCandidate } from '../src/providers/autofetch-fallback.js';
import { resetObraForTest } from '../src/providers/autofetch-obra.js';
import { verifyResolve } from '../src/utils/sign.js';
import { toRawItem } from '../src/providers/magnet-bank-fallback.js';
import { toStremioStream } from '../src/utils/search-names.js';
import { applyNoticeOrigin } from '../src/providers/stream-builder.js';
import { brDubbedPool } from '../src/utils/autofetch-pools.js';
import { uncachedBrHashes } from '../src/utils/autofetch-picks.js';
import type { DebridAdapter } from '../types/domain.js';

after(() => cache.clear());

const hex = (c: string) => c.repeat(40);

// Linha real do magnets.db (hash 0546becadff2): dubbed=1 do classificador,
// título SEM marca de áudio, apachetorrent (fonte do acervo raspado).
const bank = (over: Record<string, unknown> = {}) => ({
  magnet: {
    hash: hex('a'),
    uri: `magnet:?xt=urn:btih:${hex('a')}`,
    title: 'Locke & Key 1ª e 2ª Temporada (2021) S01 [720p]',
    size: 0,
    seedersLast: 1,
    dubbed: true,
    quality: '720p',
    isBr: true,
    ...over,
  },
  source: { indexer: 'apachetorrent', tracker: '' },
  work: { passedFilter: 1 },
}) as any;

test('áudio gravado no banco vira _bankDub e o pack dublado entra no pool BR', () => {
  const s = toStremioStream({ ...toRawItem(bank()), seeders: 1 }) as any;
  assert.equal(s._br, true);
  assert.equal(s._dubClaim, false, 'o título não cita áudio: claim do post não nasce');
  assert.equal(s._dubbed, false, 'não é prova de arquivo');
  assert.equal(s._bankDub, true, 'a evidência do classificador atravessa o build');
  assert.deepEqual(
    brDubbedPool([s], { season: 1 }).map((x: any) => x.infoHash),
    [hex('a')],
    'o Chupim pode baixar o pack que o banco sabe ser dublado',
  );
});

test('sem áudio gravado, o pack sem marca no título continua fora', () => {
  const s = toStremioStream({ ...toRawItem(bank({ dubbed: false })), seeders: 1 }) as any;
  assert.equal(s._bankDub, undefined);
  assert.equal(brDubbedPool([s]).length, 0);
});

test('título com marca de áudio segue pelo caminho antigo (_dubClaim), sem _bankDub', () => {
  const s = toStremioStream({
    ...toRawItem(bank({ title: 'Locke & Key 1ª e 2ª Temporada (2021) [720p WEB-DL DUBLADO]' })),
    seeders: 1,
  }) as any;
  assert.equal(s._dubClaim, true);
  assert.equal(s._bankDub, undefined, 'claim do título já basta: a marca é para o que só o banco sabe');
  assert.equal(brDubbedPool([s]).length, 1);
});

test('guardas do claim: lie, prova vazia e dn= de cena EN anulam _bankDub', () => {
  const lied = toStremioStream({ ...toRawItem(bank()), seeders: 1, lied: true }) as any;
  assert.equal(lied._bankDub, undefined);
  assert.equal(brDubbedPool([lied]).length, 0);

  const proven = toStremioStream({ ...toRawItem(bank()), seeders: 1, provenAudio: '' }) as any;
  assert.equal(proven._bankDub, undefined, 'prova vazia de áudio é EN');

  const dnEn = toStremioStream({
    ...toRawItem(bank({ uri: `magnet:?xt=urn:btih:${hex('a')}&dn=Locke.and.Key.S01E01.HDTV.x264-KILLERS[ettv]` })),
    seeders: 1,
  }) as any;
  assert.equal(dnEn._bankDub, undefined, 'dn= de cena EN contradiz a promessa');
});

test('origem da conta nunca prova áudio (Zumbilândia): brOriginOnly anula', () => {
  const s = toStremioStream({ ...toRawItem(bank()), seeders: 1, brOriginOnly: true }) as any;
  assert.equal(s._bankDub, undefined);
});

test('reserva não elegível segue bloqueada e item fora do fallback não ganha a marca', () => {
  const blocked = toStremioStream(
    toRawItem({ ...bank(), source: { indexer: 'kickasstorrents-to', tracker: '' }, work: { passedFilter: 0 } }),
  ) as any;
  assert.equal(blocked._fallbackFetchable, undefined);
  assert.equal(brDubbedPool([blocked]).length, 0);

  // Item cru de indexer (não é reserva): a marca é exclusiva do fallback para
  // não ampliar o raio da evidência gravada.
  const raw = toStremioStream({
    title: 'Locke & Key 1ª e 2ª Temporada (2021) S01 [720p]',
    infoHash: hex('b'),
    seeders: 1,
    indexer: 'apachetorrent',
    isBr: true,
    dubbed: true,
  } as any) as any;
  assert.equal(raw._bankDub, undefined);
});

test('vaga P2P do showUncachedBr: a reserva com áudio gravado lista na 1ª abertura (d:1+bu)', () => {
  const s = toStremioStream({ ...toRawItem(bank()), seeders: 1 }) as any;
  assert.ok(uncachedBrHashes([s], new Set(), 1).has(hex('a')));
});

test('_bankDub sai antes do protocolo, como as outras marcas internas do fallback', () => {
  const s = toStremioStream({ ...toRawItem(bank()), seeders: 1 }) as any;
  assert.equal('_bankDub' in applyNoticeOrigin([s])[0], false);
});

// Guardas de contradição (2026-10-09): o banco guarda CLASSIFICAÇÃO de áudio
// da captura, não prova medida — quando o texto do post (título ou dn=) grita
// Legendado ou idioma estrangeiro, a marca não nasce.

test('caminho real do fallback (brSource:true): origem e _bankDub nascem juntos', () => {
  // collectFallbackItems SEMPRE traz brSource definido (fallbackIsBr = brSource
  // || looksPtBr); magnet.isBr sozinho é o caminho instantâneo, já coberto acima.
  const s = toStremioStream({
    ...toRawItem({ ...bank({ isBr: false }), brSource: true }),
    seeders: 1,
  }) as any;
  assert.equal(s._br, true, 'a origem vem do indexer BR da fonte');
  assert.equal(s._bankDub, true);
});

test('título LEGENDADO contradiz a classificação gravada: _bankDub não nasce', () => {
  const s = toStremioStream({
    ...toRawItem({ ...bank({ title: 'Locke & Key 1ª e 2ª Temporada (2021) S01 720p LEGENDADO', isBr: false }), brSource: true }),
    seeders: 1,
  }) as any;
  assert.equal(s._br, true);
  assert.equal(s._dubClaim, false);
  assert.equal(s._dubbed, false);
  assert.equal(s._bankDub, undefined, 'LEGENDADO explícito no post vence o dubbed=1 do banco');
  assert.equal(brDubbedPool([s], { season: 1 }).length, 0);
});

test('idioma estrangeiro nomeado no título anula a marca mesmo com origem BR', () => {
  const s = toStremioStream({
    ...toRawItem({ ...bank({ title: 'Locke & Key Season 1 Complete FRENCH 1080p WEB-DL', isBr: false }), brSource: true }),
    seeders: 1,
  }) as any;
  assert.equal(s._br, true, 'a origem segue BR — quem mata a marca aqui é o áudio');
  assert.equal(s._bankDub, undefined);
  assert.equal(brDubbedPool([s]).length, 0);
});

test('PT explícito absorve a menção estrangeira; sem PT o veto fica', () => {
  // "PT-BR.FRENCH" nomeia o PT: o FRENCH vira faixa extra (legenda/áudio 2),
  // não contradição — a marca nasce e o pack entra.
  const comPt = toStremioStream({
    ...toRawItem({ ...bank({ isBr: false, uri: `magnet:?xt=urn:btih:${hex('a')}&dn=Locke.and.Key.S01.PT-BR.FRENCH.1080p.WEB-DL` }), brSource: true }),
    seeders: 1,
  }) as any;
  assert.equal(comPt._br, true);
  assert.equal(comPt._bankDub, true, 'PT-BR nomeado no dn= absorve o FRENCH');
  assert.deepEqual(brDubbedPool([comPt], { season: 1 }).map((x: any) => x.infoHash), [hex('a')]);

  // Sem nenhum PT nomeado, o idioma estrangeiro no dn= (sem cena EN) veta.
  const semPt = toStremioStream({
    ...toRawItem({ ...bank({ hash: hex('b'), isBr: false, uri: `magnet:?xt=urn:btih:${hex('b')}&dn=Locke.and.Key.S01.COMPLETE.GERMAN.1080p.NF.WEB-DL` }), brSource: true }),
    seeders: 1,
  }) as any;
  assert.equal(semPt._bankDub, undefined, 'GERMAN sem PT nomeado segue vetando');
});

test('dn= LEGENDADO veta pelo parser; DUAL+LEGENDADO dual não veta', () => {
  // Título sem marca de áudio, dn= dizendo Legendado: o texto do próprio
  // magnet contradiz a classificação gravada — a marca não nasce.
  const leg = toStremioStream({
    ...toRawItem({ ...bank({ hash: hex('c'), isBr: false, uri: `magnet:?xt=urn:btih:${hex('c')}&dn=Locke.and.Key.S01.LEGENDADO.1080p.WEB-DL` }), brSource: true }),
    seeders: 1,
  }) as any;
  assert.equal(leg._br, true);
  assert.equal(leg._bankDub, undefined, 'dn= Legendado contradiz o dubbed=1 gravado');
  assert.equal(brDubbedPool([leg], { season: 1 }).length, 0);

  // Controle: DUAL+LEGENDADO é faixa dupla legítima (o parser dá 'Dual', não
  // 'Legendado') — sem veto indevido, a marca nasce e o pack entra.
  const dual = toStremioStream({
    ...toRawItem({ ...bank({ hash: hex('d'), isBr: false, uri: `magnet:?xt=urn:btih:${hex('d')}&dn=Locke.and.Key.S01.Completa.DUAL.LEGENDADO.1080p.WEB-DL` }), brSource: true }),
    seeders: 1,
  }) as any;
  assert.equal(dual._bankDub, true, 'DUAL+LEGENDADO é faixa dupla, não legenda');
  assert.deepEqual(brDubbedPool([dual], { season: 1 }).map((x: any) => x.infoHash), [hex('d')]);
});

test('dn= DUAL do COMANDO.TO é o caso legítimo: a marca nasce e o pack entra', () => {
  const s = toStremioStream({
    ...toRawItem({ ...bank({ isBr: false, uri: `magnet:?xt=urn:btih:${hex('a')}&dn=Locke.and.Key.S01.Completa.DUAL.1080p.WEB-DL` }), brSource: true }),
    seeders: 1,
  }) as any;
  assert.equal(s._bankDub, true, 'DUAL é faixa múltipla (pode ter PT), não idioma estrangeiro');
  assert.deepEqual(brDubbedPool([s], { season: 1 }).map((x: any) => x.infoHash), [hex('a')]);
});

// Proteção durável e auditoria: a evidência do banco tem que atravessar o
// aceite imediato, a fila do dreno e o hint assinado do play.

test('protectBr reconhece _bankDub no aceite imediato e no dreno da fila', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalProtect = config.debrid.autoFetchProtectBr;
  const adAdapter = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const originalEnqueue = adAdapter.enqueue;
  const apiKey = 'chave-bankdub-adprot';
  const account = accountScope(apiKey);
  const h = 'bb'.repeat(20);
  const hq = 'cc'.repeat(20);
  const hSem = 'dd'.repeat(20);
  const hLied = 'a0'.repeat(20);
  // Predicado com prazo no lugar de sleep fixo: o sinal é o resultado real
  // (enfileirado/retido), não um chute de tempo.
  const esperar = async (ok: () => boolean, prazoMs = 2000) => {
    const fim = Date.now() + prazoMs;
    while (!ok()) {
      if (Date.now() > fim) throw new Error('condição do teste não atingida no prazo');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const enfileirados: string[] = [];
  cache.clearNamespace('adprot');
  metrics.reset();
  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchProtectBr = true;
    adAdapter.enqueue = async (_key, hash) => { enfileirados.push(String(hash).toLowerCase()); return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const userOpts = {
      ...runtime.defaults(),
      debridService: 'alldebrid', debridApiKey: apiKey, debridCachedOnly: true, autoFetchBr: true,
    };
    await runtime.run({ opts: userOpts, encoded: 'cfg-bankdub-imediato' }, () =>
      applyDebrid(
        [{ infoHash: h, name: 'Locke & Key S01', title: 'Locke & Key S01 720p', _br: true, _bankDub: true, _quality: '720p', _seeders: 1 } as any],
        { searchKey: 'busca-bankdub' } as any,
      ));
    await esperar(() => enfileirados.includes(h));
    assert.equal(held.isDurablyProtected('alldebrid', account, h), true, 'aceite do pack do banco retém na conta');

    // A marca atravessa a fila persistida e o dreno protege com ela; BR sem
    // evidência de áudio nenhuma e promessa stale (_lied) ficam fora.
    const qStream = { infoHash: hq, name: 'Locke & Key S01', title: 'Locke & Key S01 720p', _br: true, _bankDub: true, _quality: '720p', _seeders: 1 };
    assert.equal(toQueueCandidate(qStream as any, 'br', { season: 1, episode: null, seasonFill: false }).bankDub, true);
    autofetchLive.reset();
    autofetchLive.set({ autoFetchQueue: true, autoFetchQueueDepth: 4 });
    autofetch.writeQueue('fila-bankdub', [
      { infoHash: hq, pool: 'br', br: true, dubbed: false, bankDub: true, title: 'Locke & Key S01', quality: '720p', imdbId: 'tt3007572' },
      { infoHash: hSem, pool: 'br', br: true, dubbed: false, title: 'sem evidência de áudio', quality: '720p', imdbId: 'tt3007573' },
      { infoHash: hLied, pool: 'br', br: true, dubbed: false, bankDub: true, lied: true, title: 'promessa stale', quality: '720p', imdbId: 'tt3007574' },
    ], 3600, 'alldebrid', account);
    const drenar = () => runtime.run({ opts: userOpts, encoded: 'cfg-bankdub-dreno' }, () =>
      drainNext('fila-bankdub', { refusals: 0, hashes: new Set<string>(), seasonHints: new Map() }));
    await drenar();
    await esperar(() => enfileirados.includes(hq));
    assert.equal(held.isDurablyProtected('alldebrid', account, hq), true, 'dreno do pack do banco retém');
    await drenar();
    await esperar(() => enfileirados.includes(hSem));
    assert.equal(held.isDurablyProtected('alldebrid', account, hSem), false, 'br sem evidência de áudio não retém');
    await drenar();
    await esperar(() => enfileirados.includes(hLied));
    assert.equal(held.isDurablyProtected('alldebrid', account, hLied), false, 'promessa stale (_lied) não retém');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchProtectBr = originalProtect;
    adAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch('busca-bankdub');
    autofetch.dropQueue('fila-bankdub');
    autofetch.resetBudget('alldebrid', account);
    for (const x of [h, hq, hSem, hLied]) {
      cache.forget(autofetch.markerKey('alldebrid', account, x));
      held.release(x, account);
    }
    cache.clearNamespace('adprot');
    metrics.reset();
    autofetchLive.reset();
    resetObraForTest();
  }
});

test('dica assinada do play inclui _bankDub no d:1 (auditoria/markLie)', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const adAdapter = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const originalEnqueue = adAdapter.enqueue;
  debrid.checkCached = async () => ({ cached: new Set(), known: false });
  config.debrid.publicUrl = 'http://addon.test';
  adAdapter.enqueue = async () => true;
  try {
    const userOpts = {
      ...runtime.defaults(),
      debridService: 'alldebrid', debridApiKey: 'chave-bankdub-hint', debridCachedOnly: true, autoFetchBr: false,
    };
    const hb = 'ee'.repeat(20);
    const hb2 = 'ff'.repeat(20);
    const out = await runtime.run({ opts: userOpts, encoded: 'cfg-bankdub-hint' }, () =>
      applyDebrid([
        { infoHash: hb, name: 'Locke & Key S01', title: 'Locke & Key S01', _br: true, _bankDub: true, _quality: '720p', _seeders: 1 },
        { infoHash: hb2, name: 'Release', title: 'Release', _br: true, _quality: '720p', _seeders: 1 },
      ] as any[], { imdbId: 'tt3007572' } as any),
    ) as any[];
    const comMarca = new URL(String(out.find((s) => String(s.url || '').includes(hb))?.url), 'http://addon.test');
    const hintJson = String(comMarca.searchParams.get('w'));
    const sig = String(comMarca.searchParams.get('sig'));
    assert.deepEqual(JSON.parse(hintJson), { d: 1, i: 'tt3007572' });
    // A dica viaja ASSINADA e o /resolve verifica com o segredo da config da
    // própria requisição — por isso a verificação roda no contexto do runtime.
    const verificar = (hash: string, ep: string, assinatura: string, hint: string) =>
      runtime.run({ opts: userOpts, encoded: 'cfg-bankdub-hint' }, () => verifyResolve(hash, ep, assinatura, hint));
    assert.equal(verificar(hb, '', sig, hintJson), true, 'hint com d:1+obra verifica com a assinatura da URL');
    assert.equal(verificar(hb, '', sig, '{"d":0,"i":"tt3007572"}'), false, 'hint alterado no fio não verifica');
    const semMarca = new URL(String(out.find((s) => String(s.url || '').includes(hb2))?.url), 'http://addon.test');
    assert.deepEqual(
      JSON.parse(String(semMarca.searchParams.get('w'))),
      { i: 'tt3007572' },
      'o i da obra viaja sempre; o d:1 só existe com promessa de áudio',
    );

    // Sem obra na dica e sem imdb: só a promessa do banco justifica o hint — é
    // a condição externa que admite o `_bankDub`.
    const hb3 = '9a'.repeat(20);
    const semImdb = await runtime.run({ opts: userOpts, encoded: 'cfg-bankdub-hint2' }, () =>
      applyDebrid(
        [{ infoHash: hb3, name: 'Locke & Key S01', title: 'Locke & Key S01', _br: true, _bankDub: true, _quality: '720p', _seeders: 1 }] as any[],
        {} as any,
      )) as any[];
    const u3 = new URL(String(semImdb[0].url), 'http://addon.test');
    const hint3 = String(u3.searchParams.get('w'));
    assert.deepEqual(JSON.parse(hint3), { d: 1 }, '_bankDub sozinho produz o hint {d:1} sem imdb');
    assert.equal(verificar(hb3, '', String(u3.searchParams.get('sig')), hint3), true);
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    adAdapter.enqueue = originalEnqueue;
  }
});
