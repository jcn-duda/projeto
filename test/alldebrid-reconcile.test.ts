// Fase 8 — Reconcile da posse (`adsub`) com a conta real.
//
// Contrato: knobs (default OFF, clamp, intervalo, margem, piso de idade e piso
// de ocupação); seleção em CONJUNÇÃO (ready, não ativo, não preexistente, posse
// ativa, anti-re-add, idade mínima, não-consultado, held/adprot); snapshot `null`
// e ocupação <= piso pulam a rodada FECHADA; mais antigos/teto; purga adsub+adrm;
// intervalo; anti-reentrada; escopo B-2; gancho fire-and-forget na checagem.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { debrid } from '../src/config/debrid.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope } from '../src/utils/request-key.js';
import * as held from '../src/debrid/protected.js';
import { rememberSubmitted, resetSubmittedForTests, submittedAt, preexisting } from '../src/debrid/alldebrid-inventory.js';
import { scheduleReconcile } from '../src/debrid/alldebrid-reconcile.js';
import { checkCached } from '../src/debrid/alldebrid-check.js';
import {
  adrmKey, counter, mag, mockAd, withDebrid, inventario, soltaInventario, assenta, esperaMetrica, gate,
} from './helpers/alldebrid-mock.js';

const adsubKey = (account: string, hash: string) => `${prefix('adsub')}${account}:${hash}`;

// Timestamp único do arquivo: as janelas dos testes (600s × 24h) são largas
// demais para a duração da suíte deslocar qualquer limiar.
const AGORA_SEC = Math.floor(Date.now() / 1000);

// Knobs do 8.14/8.15 pinados: o mark do anti-reenchimento e a persistência da
// posse precisam estar vivos — o config lê o .env do operador e o verde da
// suíte não pode depender de quem roda (mesmo padrão do teste do 8.16).
config.debrid.reuploadBlock = true;
config.debrid.alldebridReuploadBlockTtlMs = 3 * 24 * 3600 * 1000;
config.debrid.alldebridSubmittedTtlMs = 7 * 24 * 3600 * 1000;
config.debrid.autoFetchProtectBr = true;

let keepAlive: NodeJS.Timeout;
before(() => { keepAlive = setInterval(() => {}, 1000); });
after(() => clearInterval(keepAlive));

/** Etiqueta o hash como nosso COM prova (snapshot vazio não o contém). */
function possui(KEY: string, hash: string) {
  const ACCOUNT = accountScope(KEY);
  inventario(ACCOUNT, []);
  rememberSubmitted(ACCOUNT, hash);
}

function limpa(KEY: string, hashes: string[]) {
  const ACCOUNT = accountScope(KEY);
  soltaInventario(ACCOUNT);
  resetSubmittedForTests();
  for (const hash of hashes) {
    cache.forget(adsubKey(ACCOUNT, hash));
    cache.forget(adrmKey(ACCOUNT, hash));
  }
}

type Api = ReturnType<typeof mockAd>;

/** Magnet nosso + rodada disparada; `verifica` roda antes do cleanup em finally. */
async function cenario(
  KEY: string, uploadDate: number, patch: Record<string, unknown>,
  verifica: (api: Api, account: string) => Promise<void> | void,
) {
  const HASH = 'a0'.repeat(20);
  const account = accountScope(KEY);
  const api = mockAd({ account: [mag(700, HASH, 'Cenario.2024.1080p', uploadDate)] });
  possui(KEY, HASH);
  const restore = withDebrid({ reconcile: true, reconcileMinIntervalMs: 0, apiKey: KEY, ...patch });
  try {
    scheduleReconcile(KEY);
    await assenta();
    await verifica(api, account);
  } finally {
    restore();
    api.restore();
    limpa(KEY, [HASH]);
    metrics.reset();
  }
}

test('reconcile: default OFF, intervalo 300s, teto 25 com clamp 0..50, margem 600s', () => {
  const ENVS = ['DEBRID_RECONCILE', 'DEBRID_RECONCILE_MIN_INTERVAL_MS', 'DEBRID_RECONCILE_MAX_PER_ROUND',
    'DEBRID_RECONCILE_AGE_MARGIN_MS', 'DEBRID_RECONCILE_MIN_AGE_MS', 'DEBRID_RECONCILE_FLOOR'];
  for (const k of ENVS) delete process.env[k];
  try {
    const f = debrid();
    assert.equal(f.reconcile, false, 'default OFF: remoção exige decisão explícita do operador');
    assert.equal(f.reconcileMinIntervalMs, 300_000);
    assert.equal(f.reconcileMaxPerRound, 25, 'teto default conservador');
    assert.equal(f.reconcileAgeMarginMs, 600_000);
    assert.equal(f.reconcileMinAgeMs, 86_400_000, 'piso de idade default 24h');
    assert.equal(f.reconcileFloor, 0, 'piso de ocupação default desligado');
    process.env.DEBRID_RECONCILE_MAX_PER_ROUND = '999';
    assert.equal(debrid().reconcileMaxPerRound, 50, 'clamp superior 0..50');
    process.env.DEBRID_RECONCILE_MAX_PER_ROUND = '-1';
    assert.equal(debrid().reconcileMaxPerRound, 0, 'clamp inferior: 0 desliga');
    process.env.DEBRID_RECONCILE_MIN_INTERVAL_MS = '-5';
    assert.equal(debrid().reconcileMinIntervalMs, 0, 'intervalo nunca negativo');
    process.env.DEBRID_RECONCILE_MIN_AGE_MS = '-1';
    assert.equal(debrid().reconcileMinAgeMs, 0, 'piso de idade nunca negativo');
    process.env.DEBRID_RECONCILE_FLOOR = '-5';
    assert.equal(debrid().reconcileFloor, 0, 'piso de ocupação nunca negativo');
  } finally {
    for (const k of ENVS) delete process.env[k];
  }
});

test('reconcile: ready com posse remanescente sai, é purgado do adsub e marcado no adrm', async () => {
  const KEY = 'chave-reconcile-basico';
  const ACCOUNT = accountScope(KEY);
  const NOSSO = 'a1'.repeat(20);
  // Upload de 3 dias: acima do piso de idade default (24h) — resíduo de
  // verdade, não conteúdo recém-esquentado (prova que o piso não trava o resto).
  const api = mockAd({ account: [mag(601, NOSSO, 'Stale.Upload.2024.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600)] });
  possui(KEY, NOSSO);
  const restore = withDebrid({ reconcile: true, reconcileMinIntervalMs: 0, apiKey: KEY });
  try {
    scheduleReconcile(KEY);
    await esperaMetrica('debrid.reconcile.removed');
    await assenta();
    assert.deepEqual([...api.deleted], [601], 'o magnet com posse remanescente saiu da conta');
    assert.equal(submittedAt(ACCOUNT, NOSSO), null, 'posse purgada em memória');
    assert.equal(cache.peek(adsubKey(ACCOUNT, NOSSO)), null, 'registro adsub purgado');
    assert.ok(cache.peek(adrmKey(ACCOUNT, NOSSO)) != null, 'adrm marcado (8.14)');
  } finally {
    restore();
    api.restore();
    limpa(KEY, [NOSSO]);
    metrics.reset();
  }
});

test('reconcile: upload POSTERIOR à etiqueta é re-add do usuário e NUNCA sai', async () => {
  const KEY = 'chave-reconcile-read';
  const ACCOUNT = accountScope(KEY);
  const VELHO_NOSSO = 'b1'.repeat(20);
  const READICIONADO = 'b2'.repeat(20);
  const api = mockAd({
    account: [
      // Dentro da margem: upload quase contemporâneo à etiqueta (nosso), já
      // acima do piso de idade default.
      mag(611, VELHO_NOSSO, 'Old.Upload.2023.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600),
      // Posterior à etiqueta + margem: o usuário re-adicionou por conta própria.
      mag(612, READICIONADO, 'ReAdded.By.User.2024.TrueFrench.1080p', AGORA_SEC + 60),
    ],
  });
  possui(KEY, VELHO_NOSSO);
  possui(KEY, READICIONADO);
  // Margem de 1s: qualquer upload mais novo que a etiqueta já é re-add.
  const restore = withDebrid({ reconcile: true, reconcileMinIntervalMs: 0, reconcileAgeMarginMs: 1_000, apiKey: KEY });
  try {
    scheduleReconcile(KEY);
    await esperaMetrica('debrid.reconcile.removed');
    await assenta();
    assert.deepEqual([...api.deleted], [611], 'só o upload contemporâneo à etiqueta sai');
    assert.equal(api.ordem.includes(612), false, 'o re-add do usuário nunca é removido');
    assert.notEqual(submittedAt(ACCOUNT, READICIONADO), null, 'a posse do re-add permanece intacta');
  } finally {
    restore();
    api.restore();
    limpa(KEY, [VELHO_NOSSO, READICIONADO]);
    metrics.reset();
  }
});

test('reconcile: preexistente, ativo, held e adprot ficam mesmo com posse e idade elegíveis', async () => {
  const KEY = 'chave-reconcile-exclusoes';
  const ACCOUNT = accountScope(KEY);
  const PRE = 'c1'.repeat(20);
  const ATIVO = 'c2'.repeat(20);
  const HELD_H = 'c3'.repeat(20);
  const ADPROT_H = 'c4'.repeat(20);
  const api = mockAd({
    account: [
      mag(621, PRE, 'Pre.User.2018.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600),
      mag(622, ATIVO, 'Active.Movie.2024.TrueFrench.720p', AGORA_SEC - 3 * 24 * 3600, 'Downloading'),
      mag(623, HELD_H, 'Held.Movie.2024.TrueFrench.720p', AGORA_SEC - 3 * 24 * 3600),
      mag(624, ADPROT_H, 'Protected.BR.2024.Dublado.1080p', AGORA_SEC - 3 * 24 * 3600),
    ],
  });
  inventario(ACCOUNT, [PRE]);
  for (const hash of [PRE, ATIVO, HELD_H, ADPROT_H]) rememberSubmitted(ACCOUNT, hash);
  held.hold(HELD_H, 3600, ACCOUNT);
  held.protectBr('alldebrid', ACCOUNT, ADPROT_H);
  const restore = withDebrid({ reconcile: true, reconcileMinIntervalMs: 0, apiKey: KEY });
  try {
    scheduleReconcile(KEY);
    await assenta();
    await assenta();
    assert.deepEqual([...api.deleted], [], 'nenhum protegido sai');
    assert.ok(counter('debrid.reconcile.none') >= 1, 'rodada sem candidatos conta none');
  } finally {
    restore();
    held.release(HELD_H, ACCOUNT);
    held.unprotect('alldebrid', ACCOUNT, ADPROT_H);
    api.restore();
    limpa(KEY, [PRE, ATIVO, HELD_H, ADPROT_H]);
    metrics.reset();
  }
});

test('reconcile: inventário null pula a rodada FECHADA — nada sai sem prova de proveniência', async () => {
  const KEY = 'chave-reconcile-failsafe';
  const ACCOUNT = accountScope(KEY);
  const NOSSO = 'd1'.repeat(20);
  const api = mockAd({ account: [mag(631, NOSSO, 'Stale.Upload.2024.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600)], failStatus: true });
  possui(KEY, NOSSO);
  // Envelhece o snapshot: com a referência vencida, o knownBefore dispara o
  // refresh (que falha com 500) e o reconcile recebe `null` — o fail-safe
  // fechado é exercitado de verdade, não contornado pelo snapshot fresco.
  const entry = preexisting.get(ACCOUNT)!;
  entry.loadedAt = 0;
  const restore = withDebrid({ reconcile: true, reconcileMinIntervalMs: 0, apiKey: KEY });
  try {
    scheduleReconcile(KEY);
    await assenta();
    await assenta();
    assert.deepEqual([...api.deleted], [], 'sem inventário ninguém sai (N1)');
    assert.equal(counter('debrid.reconcile.removed'), 0);
  } finally {
    restore();
    api.restore();
    limpa(KEY, [NOSSO]);
    metrics.reset();
  }
});

test('reconcile: BYO e gate de operador fechado nunca disparam rodada', async () => {
  const KEY = 'chave-reconcile-operador';
  const api = mockAd({ account: [mag(641, 'e1'.repeat(20), 'Stale.Upload.2024.TrueFrench.1080p', 1000)] });
  const byo = withDebrid({ reconcile: true, apiKey: KEY });
  try {
    scheduleReconcile('chave-de-outro-usuario');
    await assenta();
    assert.equal(api.statusCalls, 0, 'chave de usuário (BYO): nunca reconcile');
    const fechado = withDebrid({ reconcile: true, apiKey: KEY, allowEnvKey: false, operatorEnvAccount: false });
    scheduleReconcile(KEY);
    await assenta();
    assert.equal(api.statusCalls, 0, 'envOperatorAccount fechado: nunca reconcile');
    fechado();
    const off = withDebrid({ reconcile: false, apiKey: KEY });
    scheduleReconcile(KEY);
    await assenta();
    assert.equal(api.statusCalls, 0, 'DEBRID_RECONCILE=false desliga');
    off();
  } finally {
    byo();
    api.restore();
    metrics.reset();
  }
});

test('reconcile: mais antigos primeiro e teto DEBRID_RECONCILE_MAX_PER_ROUND', async () => {
  const KEY = 'chave-reconcile-teto';
  const api = mockAd({
    account: [
      // Todos acima do piso de idade default: o que decide a ordem aqui é a
      // idade relativa (e o teto), não o piso.
      mag(651, '11'.repeat(20), 'Oldest.Upload.2022.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600 - 7200),
      mag(652, '22'.repeat(20), 'Middle.Upload.2023.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600 - 3600),
      mag(653, '33'.repeat(20), 'Newest.Upload.2024.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600 - 60),
    ],
  });
  for (const hash of ['11'.repeat(20), '22'.repeat(20), '33'.repeat(20)]) possui(KEY, hash);
  const restore = withDebrid({ reconcile: true, reconcileMinIntervalMs: 0, reconcileMaxPerRound: 2, apiKey: KEY });
  try {
    scheduleReconcile(KEY);
    await esperaMetrica('debrid.reconcile.removed');
    await assenta();
    assert.deepEqual([...api.deleted].sort(), [651, 652], 'sai o mais antigo primeiro, até o teto');
    assert.equal(api.ordem.includes(653), false, 'o mais novo fica para a próxima rodada');
  } finally {
    restore();
    api.restore();
    limpa(KEY, ['11'.repeat(20), '22'.repeat(20), '33'.repeat(20)]);
    metrics.reset();
  }
});

test('reconcile: rodada dentro do intervalo mínimo é pulada (skippedInterval)', async () => {
  const KEY = 'chave-reconcile-intervalo';
  const NOSSO = 'f1'.repeat(20);
  const api = mockAd({ account: [mag(661, NOSSO, 'Stale.Upload.2024.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600)] });
  possui(KEY, NOSSO);
  // Intervalo alto: a segunda rodada chega antes do intervalo vencer.
  const restore = withDebrid({ reconcile: true, reconcileMinIntervalMs: 3_600_000, apiKey: KEY });
  try {
    scheduleReconcile(KEY);
    await esperaMetrica('debrid.reconcile.removed');
    await assenta();
    scheduleReconcile(KEY);
    assert.ok(counter('debrid.reconcile.skippedInterval') >= 1, 'a rodada próxima é pulada e conta o skip');
    assert.equal(api.statusCalls, 1, 'não houve segunda varredura');
  } finally {
    restore();
    api.restore();
    limpa(KEY, [NOSSO]);
    metrics.reset();
  }
});

test('reconcile: anti-reentrada — concorrente conta busy e não empilha rodada', async () => {
  const KEY = 'chave-reconcile-busy';
  const NOSSO = 'g1'.repeat(20);
  const statusGate = gate();
  const api = mockAd({ account: [mag(671, NOSSO, 'Stale.Upload.2024.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600)], statusGate });
  possui(KEY, NOSSO);
  const restore = withDebrid({ reconcile: true, reconcileMinIntervalMs: 0, apiKey: KEY });
  try {
    scheduleReconcile(KEY);
    await assenta();
    assert.equal(api.statusCalls, 1, 'primeira rodada em voo (presa no status)');
    scheduleReconcile(KEY);
    assert.equal(counter('debrid.reconcile.busy'), 1, 'a concorrente conta busy e sai');
    statusGate.liberar();
    await esperaMetrica('debrid.reconcile.removed');
    await assenta();
    assert.equal(api.statusCalls, 1, 'não há segunda rodada empilhada');
    assert.deepEqual([...api.deleted], [671]);
  } finally {
    statusGate.liberar();
    restore();
    api.restore();
    limpa(KEY, [NOSSO]);
    metrics.reset();
  }
});

test('reconcile: com o marcador 8.14 desligado, ainda remove e purga — só não grava adrm', async () => {
  const KEY = 'chave-reconcile-sem-adrm';
  const ACCOUNT = accountScope(KEY);
  const NOSSO = 'h1'.repeat(20);
  const api = mockAd({ account: [mag(681, NOSSO, 'Stale.Upload.2024.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600)] });
  possui(KEY, NOSSO);
  const restore = withDebrid({ reconcile: true, reconcileMinIntervalMs: 0, apiKey: KEY, reuploadBlock: false });
  try {
    scheduleReconcile(KEY);
    await esperaMetrica('debrid.reconcile.removed');
    await assenta();
    assert.deepEqual([...api.deleted], [681], 'a remoção não depende do reuploadBlock');
    assert.equal(submittedAt(ACCOUNT, NOSSO), null, 'a purga da posse também não depende');
    assert.equal(cache.peek(adrmKey(ACCOUNT, NOSSO)), null, 'sem marcador com o kill-switch desligado');
  } finally {
    restore();
    api.restore();
    limpa(KEY, [NOSSO]);
    metrics.reset();
  }
});

test('reconcile: checkCached dispara a rodada em fundo (fire-and-forget, irmão do evictor)', async () => {
  const KEY = 'chave-reconcile-gancho';
  const ACCOUNT = accountScope(KEY);
  const NOSSO = 'i1'.repeat(20);
  const OUTRO = 'i2'.repeat(20);
  const api = mockAd({ account: [mag(691, NOSSO, 'Stale.Upload.2024.TrueFrench.1080p', AGORA_SEC - 3 * 24 * 3600)] });
  possui(KEY, NOSSO);
  const restore = withDebrid({ reconcile: true, reconcileMinIntervalMs: 0, apiKey: KEY, dropReady: true, dropUncached: true });
  try {
    // A checagem consulta OUTRO (não o NOSSO): o reconcile roda depois, em
    // fundo, e remove o que a limpeza por busca não alcançou.
    await checkCached(KEY, [OUTRO]);
    await esperaMetrica('debrid.reconcile.removed');
    await assenta();
    assert.ok(api.deleted.includes(691), 'a checagem disparou o reconcile, que removeu o remanescente');
    assert.equal(submittedAt(ACCOUNT, NOSSO), null, 'posse do remanescente purgada');
  } finally {
    restore();
    api.restore();
    limpa(KEY, [NOSSO, OUTRO]);
    metrics.reset();
  }
});

test('reconcile: posse recente (< minAge) fica e conta skippedAge', () =>
  cenario('chave-reconcile-minage', AGORA_SEC - 600, { reconcileMinAgeMs: 24 * 3600 * 1000 }, async (api, account) => {
    // 10 minutos: exatamente o pack que o autofetch acabou de esquentar.
    await esperaMetrica('debrid.reconcile.skippedAge');
    assert.deepEqual([...api.deleted], [], 'conteúdo recém-esquentado não é resíduo');
    assert.equal(counter('debrid.reconcile.removed'), 0, 'nada é removido');
    assert.notEqual(submittedAt(account, 'a0'.repeat(20)), null, 'a posse do pack recente permanece');
  }));

test('reconcile: reconcileMinAgeMs=0 restaura o comportamento anterior (remove recente)', () =>
  cenario('chave-reconcile-minage-off', AGORA_SEC - 600, { reconcileMinAgeMs: 0 }, async (api) => {
    await esperaMetrica('debrid.reconcile.removed');
    assert.deepEqual([...api.deleted], [700], 'piso 0 desliga a trava de idade');
    assert.equal(counter('debrid.reconcile.skippedAge'), 0, 'sem piso, ninguém é barrado pela idade');
  }));

test('reconcile: ocupação <= DEBRID_RECONCILE_FLOOR desiste a rodada (skippedFloor)', () =>
  cenario('chave-reconcile-floor', AGORA_SEC - 3 * 24 * 3600, { reconcileFloor: 5 }, async (api) => {
    // Conta com 1 magnet e piso 5 (o incidente estava a ~75% = sem pressão).
    await esperaMetrica('debrid.reconcile.skippedFloor');
    assert.deepEqual([...api.deleted], [], 'conta folgada não apaga nada');
    assert.equal(counter('debrid.reconcile.removed'), 0, 'nenhuma remoção');
    assert.equal(api.statusCalls, 1, 'a leitura de status aconteceu; só a seleção foi barrada');
  }));
