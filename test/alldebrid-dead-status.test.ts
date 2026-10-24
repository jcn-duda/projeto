// Terminal medido da AllDebrid (frase exata, statusCode 10) reconhecido por
// torrentStatus E sweepDead sem condenar por código isolado; a listagem
// autoritativa volta a `via:'hash'` (dead nativo/expired-unready sem
// DEBRID_REMOVE_BY_ID) e o progress-stalled segue represado. Sem rede real.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as held from '../src/debrid/protected.js';
import * as suppressed from '../src/providers/autofetch-suppressed.js';
import { collapseTerminal } from '../src/providers/autofetch-terminal.js';
import { runRecheck, recheckLots } from '../src/providers/autofetch-recheck.js';
import { accountScope } from '../src/utils/request-key.js';
import { prefix } from '../src/utils/cache-keys.js';
import { isDeadMagnet, DEAD } from '../src/debrid/alldebrid-api.js';
import { sweepDead } from '../src/debrid/alldebrid-cleanup.js';
import { scheduleSuppressedRevalidate } from '../src/debrid/alldebrid-suppressed-revalidate.js';
import { submittedAt } from '../src/debrid/alldebrid-inventory.js';
import { mockAd, withDebrid, assenta, counter, gate, mag, runSuppressed1b, BYO_1B_PATCH } from './helpers/alldebrid-mock.js';
import type { DebridAdapter } from '../types/domain.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hx = (seed: string) => seed.repeat(20);

function stubFetchJson(payload: unknown) {
  return (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof globalThis.fetch;
}

test('DEAD reconhece a mensagem exata e ignora statusCode isolado', () => {
  assert.equal(DEAD.test('Download took more than 3 days'), true);
  assert.equal(isDeadMagnet('Download took more than 3 days'), true);
  assert.equal(isDeadMagnet(undefined, 10), false, 'código 10 sozinho NÃO condena: o texto é a autoridade');
  assert.equal(isDeadMagnet('Downloading', 10), false, '10 com texto Downloading ainda baixa');
  assert.equal(isDeadMagnet('Downloading'), false);
  assert.equal(isDeadMagnet('Ready'), false);
  assert.equal(isDeadMagnet('queued', 1), false);
  assert.equal(isDeadMagnet('Ready', 4), false);
});

test('AllDebrid torrentStatus: frase terminal vira dead com via=hash; statusCode 10 não condena', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const ad = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const hMsg = hx('d1');
  const hCode = hx('d2');
  const hReady = hx('d3');
  try {
    AbortSignal.timeout = () => new AbortController().signal;
    globalThis.fetch = stubFetchJson({ status: 'success', data: { magnets: [
      { id: 1, hash: hMsg, status: 'Download took more than 3 days' },
      { id: 2, hash: hCode, status: 'Downloading', statusCode: 10 },
      { id: 3, hash: hReady, status: 'Ready', statusCode: 4 },
    ] } });
    const out = await ad.torrentStatus!('chave-de-teste', [hMsg, hCode, hReady]);
    assert.equal(out[hMsg].state, 'dead', 'frase exata é terminal');
    assert.equal(out[hCode].state, 'downloading', 'statusCode 10 com texto Downloading NÃO é dead');
    assert.equal(out[hReady].state, 'ready');
    assert.equal(out[hMsg].via, 'hash', 'listagem autoritativa por hash');
    assert.equal(out[hCode].via, 'hash');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('AllDebrid sweepDead remove o terminal (frase) e poupa Ready/Downloading mesmo com statusCode 10', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const apiKey = 'chave-sweep-dead';
  const hDead = hx('e1');
  const hCode = hx('e2');
  const hReady = hx('e3');
  const hReadyCode = hx('e5');
  const hAct = hx('e4');
  const deleted: string[] = [];
  try {
    AbortSignal.timeout = () => new AbortController().signal;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/magnet/delete')) {
        deleted.push(String(new URL(u).searchParams.get('id')));
        return { ok: true, status: 200, json: async () => ({ status: 'success', data: {} }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: { magnets: [
        { id: 11, hash: hDead, status: 'Download took more than 3 days', uploadDate: 1 },
        { id: 12, hash: hCode, status: 'Downloading', statusCode: 10, uploadDate: 1 },
        { id: 13, hash: hReady, status: 'Ready', uploadDate: 1 },
        { id: 14, hash: hAct, status: 'Downloading', uploadDate: 1 },
        { id: 15, hash: hReadyCode, status: 'Ready', statusCode: 10, uploadDate: 1 },
      ] } }) };
    }) as unknown as typeof globalThis.fetch;

    const r = await sweepDead(apiKey);
    assert.equal(r.varridos, 1, 'só o terminal por TEXTO sai');
    assert.deepEqual(deleted, ['11']);
    assert.ok(!deleted.includes('12'), 'statusCode 10 não condena sem a frase');
    assert.ok(!deleted.includes('13'), 'Ready é acervo');
    assert.ok(!deleted.includes('14'), 'download ativo não é lixo');
    assert.ok(!deleted.includes('15'), 'ready vence o DEAD: item pronto nunca é varrido');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('recheck dead nativo remove pelo hash com removeById=false (conta da instalação)', async () => {
  const ad = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const originalCheck = debrid.checkCached;
  const originalStatus = ad.torrentStatus;
  const originalRemove = ad.removeTorrent;
  const originalRemoveById = config.debrid.removeById;
  const chave = 'chave-byo-dead';
  const account = accountScope(chave);
  const searchKey = 'busca-byo-dead';
  const h = hx('f1');
  let removals = 0;
  try {
    config.debrid.removeById = false;
    // A listagem já vem `via:'hash'` do adaptador (correção A1).
    ad.torrentStatus = async () => ({ [h]: { state: 'dead', id: 42, via: 'hash' } });
    ad.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    recheckLots.set(searchKey, {
      hashes: new Set([h]), attempts: 1, timer: null, inFlight: false,
      ctx: { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: chave }, encoded: 'cfg-byo-dead' },
      deadStreak: new Map([[h, 1]]), stallStreak: new Map(), seasonHints: new Map(),
      createdAt: Date.now() - 1000, isSettle: false, refusals: 0, adapterId: 'alldebrid',
    });
    runRecheck(searchKey);
    await sleep(40);
    assert.equal(removals, 1, 'dead nativo via hash remove direto sem DEBRID_REMOVE_BY_ID');
    assert.equal(suppressed.listSuppressed('alldebrid', account).length, 0, 'nada represado quando a remoção acontece');
    assert.equal(recheckLots.has(searchKey), false, 'lote colapsado é descartado');
  } finally {
    config.debrid.removeById = originalRemoveById;
    debrid.checkCached = originalCheck;
    ad.torrentStatus = originalStatus;
    ad.removeTorrent = originalRemove;
    const lote = recheckLots.get(searchKey);
    if (lote?.timer) clearTimeout(lote.timer);
    recheckLots.delete(searchKey);
    autofetch.releaseSearch(searchKey);
    autofetch.dropQueue(searchKey);
    cache.forget(autofetch.markerKey('alldebrid', account, h));
    cache.forget(autofetch.deadKey('alldebrid', account, h));
    held.release(h, account);
    suppressed.forgetSuppressed('alldebrid', account, h);
  }
});

// Item 1b — revalidação de fundo dos represados da AllDebrid (conta BYO): a
// próxima busca da MESMA conta reavalia em fundo, sem persistir credencial, e
// só remove pelo TEXTO terminal; ready cura, downloading/unknown mantêm, erro
// preserva. Sem `sweepDead` (só a conta do operador) o represado ficava no TTL.

test('1b: colapso progress-stalled registra o represado SEM deletar na hora', () => {
  const account = 'conta-1b-progress';
  const h = hx('a1');
  const removidos: string[] = [];
  const adapter = {
    id: 'alldebrid', label: 'AD', short: 'AD', cacheCheck: true,
    removeTorrent: async () => { removidos.push('x'); return true; },
  } as unknown as DebridAdapter;
  const lot = { hashes: new Set([h]), deadStreak: new Map(), stallStreak: new Map(), seasonHints: new Map() };
  try {
    const removido = collapseTerminal(lot, {
      adapter, account, apiKey: 'k', hash: h, searchKey: 'sk-1b',
      statusInfo: { state: 'downloading', id: 600, via: 'hash' },
      streak: 3, mode: 'progress', reason: 'progress',
    });
    assert.equal(removido, false, 'a heurística não autoriza delete direto');
    assert.deepEqual(removidos, [], 'nenhum removeTorrent disparado');
    assert.equal(suppressed.countSuppressed('alldebrid', account), 1, 'o represado fica para revalidar');
  } finally {
    suppressed.forgetSuppressed('alldebrid', account, h);
    cache.forget(autofetch.deadKey('alldebrid', account, h));
    metrics.reset();
  }
});

test('1b BYO: status Downloading mantém o represado e não remove', async () => {
  const r = await runSuppressed1b({ key: 'byo-1b-downloading', seed: 'a2', id: 501, filename: 'Baixando.2024.1080p' });
  try {
    assert.deepEqual([...r.api.deleted], [], 'ativo não é lixo');
    assert.equal(suppressed.countSuppressed('alldebrid', r.account), 1, 'o registro permanece');
    assert.ok(counter('autofetch.suppressed.revalidate.stillActive') >= 1);
  } finally { r.cleanup(); }
});

test('1b BYO: status terminal por TEXTO remove via gate e limpa o represado', async () => {
  const r = await runSuppressed1b({
    key: 'byo-1b-terminal', seed: 'a3', id: 502, filename: 'Morto.2024.1080p',
    // Data REALISTA (1h atrás, em segundos — como a API crua): com a conversão
    // dupla s→ms o magnet seria classificado `readded` e NÃO sairia; o teste
    // reprovava no bug da conversão dupla.
    uploadDate: Math.floor((Date.now() - 3600_000) / 1000),
    status: 'Download took more than 3 days',
    before: ({ account, hash }) => {
      cache.set(`${prefix('adsub')}${account}:${hash}`, { at: Date.now() }, 3600);
      autofetch.blacklist('alldebrid', account, hash); // o que o collapseTerminal deixou
    },
  });
  try {
    assert.deepEqual([...r.api.deleted], [502], 'só o texto terminal autoriza o delete (gate B-4)');
    assert.equal(suppressed.countSuppressed('alldebrid', r.account), 0, 'o represado é liquidado');
    assert.equal(submittedAt(r.account, r.hash), null, 'delete confirmado purga a posse adsub');
    assert.equal(autofetch.isDead('alldebrid', r.account, r.hash), true, 'terminal CONFIRMADO mantém a blacklist');
    assert.ok(counter('autofetch.suppressed.revalidate.removed') >= 1, 'e não vira readded no diagnóstico');
  } finally { r.cleanup(); }
});

test('1b BYO: terminal SEM prova de posse (sem adsub/marker) não é removido', async () => {
  // A fila `sup:` também recebe `expired-unready` sem prova — pode ser acervo
  // do usuário. Sem `adsub`, o fail-safe 8.15 vale: ausência nunca autoriza.
  const r = await runSuppressed1b({
    key: 'byo-1b-sem-posse', seed: 'ae', id: 514, filename: 'Alheio.2024.1080p',
    uploadDate: Math.floor((Date.now() - 3 * 3600_000) / 1000),
    status: 'Download took more than 3 days',
  });
  try {
    assert.deepEqual([...r.api.deleted], [], 'sem prova de posse nada é apagado');
    assert.equal(suppressed.countSuppressed('alldebrid', r.account), 1, 'o registro fica para o sweepDead/painel');
  } finally { r.cleanup(); }
});

test('1b BYO: status Ready cura o represado e a blacklist, sem delete', async () => {
  const r = await runSuppressed1b({
    key: 'byo-1b-ready', seed: 'a4', id: 503, filename: 'Pronto.2024.1080p', status: 'Ready',
    before: ({ account, hash }) => autofetch.blacklist('alldebrid', account, hash),
  });
  try {
    assert.deepEqual([...r.api.deleted], [], 'ready é acervo, não lixo');
    assert.equal(suppressed.countSuppressed('alldebrid', r.account), 0, 'registro curado');
    assert.equal(autofetch.isDead('alldebrid', r.account, r.hash), false, 'blacklist indevida curada');
    assert.ok(counter('autofetch.dead.cleared') >= 1);
  } finally { r.cleanup(); }
});

test('1b knob OFF (default): zero rede — o represado segue para o knob/painel de sempre', async () => {
  const r = await runSuppressed1b({
    key: 'byo-1b-knob-off', seed: 'aa', id: 510, status: 'Download took more than 3 days',
    patch: { suppressedRevalidate: false },
  });
  try {
    assert.equal(r.api.statusCalls, 0, 'knob desligado não consulta a conta');
    assert.deepEqual([...r.api.deleted], []);
    assert.equal(suppressed.countSuppressed('alldebrid', r.account), 1, 'nada é liquidado');
  } finally { r.cleanup(); }
});

test('1b BYO: conta do OPERADOR não entra (ela já tem o sweepDead)', async () => {
  const r = await runSuppressed1b({
    key: 'operador-1b', seed: 'ab', id: 511, status: 'Download took more than 3 days',
    patch: { operatorEnvAccount: true },
  });
  try {
    assert.equal(r.api.statusCalls, 0, 'operador fica com a varredura periódica');
    assert.equal(suppressed.countSuppressed('alldebrid', r.account), 1);
  } finally { r.cleanup(); }
});

test('1b BYO: re-add do usuário (uploadDate > adsub+margem) não remove e liquida o registro', async () => {
  // uploadDate 1h DEPOIS da etiqueta: sinal clássico de re-add (margem 10min).
  const quando = Math.floor((Date.now() + 60 * 60_000) / 1000);
  const r = await runSuppressed1b({
    key: 'byo-1b-readd', seed: 'ac', id: 512, filename: 'Readd.2024.1080p', uploadDate: quando,
    status: 'Download took more than 3 days',
    before: ({ account, hash }) => cache.set(`${prefix('adsub')}${account}:${hash}`, { at: Date.now() }, 3600),
  });
  try {
    assert.deepEqual([...r.api.deleted], [], 'magnet readicionado pelo usuário nunca sai');
    assert.equal(suppressed.countSuppressed('alldebrid', r.account), 0, 'o registro deixou de ser nosso');
    assert.ok(counter('autofetch.suppressed.revalidate.readded') >= 1);
  } finally { r.cleanup(); }
});

test('1b BYO: terminal recém-chegado (idade < piso) não é removido', async () => {
  // Posse recente (adsub agora) + upload de 5min atrás: passa o anti-re-add
  // (upload ≤ etiqueta + margem) e bate o piso de 30min. Com a conversão dupla
  // s→ms o upload viraria futuro e o registro sumiria como `readded`; sem a
  // posse o fail-safe do 8.15 já o manteria por outro motivo.
  const r = await runSuppressed1b({
    key: 'byo-1b-jovem', seed: 'ad', id: 513, filename: 'Novo.2024.1080p',
    uploadDate: Math.floor((Date.now() - 5 * 60_000) / 1000),
    status: 'Download took more than 3 days',
    patch: { suppressedRevalidateMinAgeMs: 30 * 60_000 },
    before: ({ account, hash }) => cache.set(`${prefix('adsub')}${account}:${hash}`, { at: Date.now() }, 3600),
  });
  try {
    assert.deepEqual([...r.api.deleted], [], 'piso de idade protegendo o recém-aceito');
    assert.equal(suppressed.countSuppressed('alldebrid', r.account), 1, 'registro permanece para a próxima rodada');
  } finally { r.cleanup(); }
});

test('1b BYO: falha no status preserva o represado e conta erro (fail-safe)', async () => {
  const r = await runSuppressed1b({
    key: 'byo-1b-erro', seed: 'a5', id: 504, mockOpts: { failStatus: true },
  });
  try {
    assert.deepEqual([...r.api.deleted], [], 'erro nunca apaga');
    assert.equal(suppressed.countSuppressed('alldebrid', r.account), 1, 'prova preservada');
    assert.ok(counter('autofetch.suppressed.revalidate.error') >= 1);
  } finally { r.cleanup(); }
});

test('1b BYO: contas isoladas — a rodada de uma não alcança o represado da outra', async () => {
  const KEY_A = 'byo-1b-a';
  const KEY_B = 'byo-1b-b';
  const accA = accountScope(KEY_A);
  const accB = accountScope(KEY_B);
  const hA = hx('a6');
  const hB = hx('a7');
  const api = mockAd({ account: [
    mag(505, hA, 'A.2024.1080p', 1, 'Download took more than 3 days'),
    mag(506, hB, 'B.2024.1080p', 1, 'Download took more than 3 days'),
  ] });
  const restore = withDebrid({ ...BYO_1B_PATCH });
  try {
    // Prova de posse das DUAS contas: terminal só é removido com `adsub` (a
    // exigência nova do 1b). Sem ela nenhum delete aconteceria e o teste não
    // provaria o isolamento.
    cache.set(`${prefix('adsub')}${accA}:${hA}`, { at: Date.now() }, 3600);
    cache.set(`${prefix('adsub')}${accB}:${hB}`, { at: Date.now() }, 3600);
    suppressed.noteSuppressed('alldebrid', accA, hA, '505');
    suppressed.noteSuppressed('alldebrid', accB, hB, '506');
    scheduleSuppressedRevalidate(KEY_A);
    await assenta(); await assenta();
    assert.deepEqual([...api.deleted], [505], 'só a conta da rodada sai');
    assert.equal(suppressed.countSuppressed('alldebrid', accB), 1, 'a outra conta fica intocada');
  } finally {
    restore(); api.restore();
    suppressed.forgetSuppressed('alldebrid', accA, hA);
    suppressed.forgetSuppressed('alldebrid', accB, hB);
    cache.forget(`${prefix('adsub')}${accA}:${hA}`);
    cache.forget(`${prefix('adsub')}${accB}:${hB}`);
    metrics.reset();
  }
});

test('1b BYO: rodada concorrente conta busy e não empilha (coalescing)', async () => {
  const KEY = 'byo-1b-busy';
  const account = accountScope(KEY);
  const h = hx('a8');
  const statusGate = gate();
  const api = mockAd({ account: [mag(507, h, 'X.2024.1080p', 1, 'Downloading')], statusGate });
  const restore = withDebrid({ ...BYO_1B_PATCH });
  try {
    suppressed.noteSuppressed('alldebrid', account, h, '507');
    scheduleSuppressedRevalidate(KEY);
    await assenta();
    assert.equal(api.statusCalls, 1, 'primeira rodada em voo (presa no status)');
    scheduleSuppressedRevalidate(KEY);
    assert.ok(counter('autofetch.suppressed.revalidate.busy') >= 1, 'a concorrente conta busy e sai');
    statusGate.liberar();
    await assenta(); await assenta();
    assert.equal(api.statusCalls, 1, 'não há segunda leitura empilhada');
  } finally {
    statusGate.liberar(); restore(); api.restore();
    suppressed.forgetSuppressed('alldebrid', account, h); metrics.reset();
  }
});

test('1b BYO: o registro não guarda a chave e o boot reindexa sem credencial persistida', async () => {
  const KEY = 'byo-1b-persist';
  const account = accountScope(KEY);
  const h = hx('a9');
  const endereco = suppressed.suppressedKey('alldebrid', account, h);
  const api = mockAd({ account: [mag(509, h, 'X.2024.1080p', 1, 'Download took more than 3 days')] });
  const restore = withDebrid({ ...BYO_1B_PATCH });
  try {
    // Prova de posse (adsub) — sem ela o terminal não sai pelo fail-safe 8.15.
    cache.set(`${prefix('adsub')}${account}:${h}`, { at: Date.now() }, 3600);
    // Semeia DIRETO no cache (como o registro persistido de um processo antigo):
    // o índice de processo não o conhece — é o `reindexSuppressed` do boot que o
    // reencontra, sem nenhuma chave de API no endereço/valor.
    cache.set(endereco, { id: '509', at: Date.now(), fails: 0, nextAt: 0 }, 3600);
    assert.equal(endereco.includes(KEY), false, 'a chave crua não entra no endereço');
    assert.equal(JSON.stringify(cache.peek(endereco)).includes(KEY), false, 'nem no valor');
    assert.equal(suppressed.listSuppressedForAccount('alldebrid', account).length, 0, 'índice frio antes do boot');
    suppressed.reindexSuppressed();
    assert.equal(suppressed.listSuppressedForAccount('alldebrid', account).length, 1, 'o boot reindexa o persistido');
    scheduleSuppressedRevalidate(KEY);
    await assenta(); await assenta();
    assert.deepEqual([...api.deleted], [509], 'a próxima busca revalida e remove o terminal');
  } finally {
    restore(); api.restore();
    suppressed.forgetSuppressed('alldebrid', account, h);
    cache.forget(`${prefix('adsub')}${account}:${h}`);
    metrics.reset();
  }
});
