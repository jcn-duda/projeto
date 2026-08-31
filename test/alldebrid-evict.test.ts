// Fase 8, item 8.16 — Evicção por busca ("cada busca paga a própria conta").
//
// A busca que deposita ~23 magnets remove os mais antigos PROVADAMENTE
// estrangeiros, tornando a ocupação estacionária. Este arquivo fixa o contrato
// de comportamento: default OFF e clamp dos knobs; escopo B-2 (só a conta do
// operador); piso de ocupação; seleção em CONJUNÇÃO (condena/ativo/protegido/
// preexistente/atual/sem data); ordem dos mais antigos; alvo = min(consultados,
// max, ocupação−piso); fire-and-forget; e anti-reentrada busy. As provas de
// segurança (marca adrm, fail-open, gate B-4) estão em alldebrid-delete-gate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { debrid } from '../src/config/debrid.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope } from '../src/utils/request-key.js';
import * as held from '../src/debrid/protected.js';
import { scheduleEvict } from '../src/debrid/alldebrid-evict.js';
import { checkCached } from '../src/debrid/alldebrid-check.js';
import {
  adrmKey, counter, mag, mockAd, withDebrid, inventario, soltaInventario, assenta, esperaMetrica, gate,
} from './helpers/alldebrid-mock.js';

// Knobs do 8.14/8.15 pinados: o mark do anti-reenchimento precisa estar vivo
// e o config lê o .env do operador — o verde da suíte não pode depender de
// quem roda.
config.debrid.reuploadBlock = true;
config.debrid.alldebridReuploadBlockTtlMs = 3 * 24 * 3600 * 1000;
config.debrid.autoFetchProtectBr = true;

const KEY = 'chave-operador-816';
const ACCOUNT = accountScope(KEY);

const GRINGO = 'aa'.repeat(20); // estrangeiro provado (TrueFrench), o mais antigo
const PRE = 'bb'.repeat(20); // preexistente do usuário (knownBefore)
const ATIVO = 'cc'.repeat(20); // download em curso
const HELD_H = 'dd'.repeat(20); // hold volátil do autofetch
const ADPROT_H = 'ee'.repeat(20); // retenção durável (adprot)
const ATUAL = 'ff'.repeat(20); // hash que a própria busca consultou

const OPERADOR = { evictPerSearch: true, apiKey: KEY, harvestEvictFloor: 0, harvestEvictMaxPerSearch: 25 } as const;

let keepAlive: NodeJS.Timeout;
before(() => { keepAlive = setInterval(() => {}, 1000); });
after(() => clearInterval(keepAlive));

// --- 1. Default OFF e clamp dos knobs ---------------------------------------

test('8.16: default OFF (fábrica) e knobs com clamp 0..25 / piso >=0', () => {
  delete process.env.DEBRID_EVICT_PER_SEARCH;
  delete process.env.HARVEST_EVICT_MAX_PER_SEARCH;
  delete process.env.HARVEST_EVICT_FLOOR;
  try {
    const fabrica = debrid();
    assert.equal(fabrica.evictPerSearch, false, 'default OFF: rollback é uma linha');
    assert.equal(fabrica.harvestEvictMaxPerSearch, 25, 'teto default conservador');
    assert.equal(fabrica.harvestEvictFloor, 600, 'piso default');
    process.env.HARVEST_EVICT_MAX_PER_SEARCH = '999';
    assert.equal(debrid().harvestEvictMaxPerSearch, 25, 'clamp superior 0..25');
    process.env.HARVEST_EVICT_MAX_PER_SEARCH = '-3';
    assert.equal(debrid().harvestEvictMaxPerSearch, 0, 'clamp inferior: 0 desliga');
    process.env.HARVEST_EVICT_FLOOR = '-10';
    assert.equal(debrid().harvestEvictFloor, 0, 'piso nunca negativo');
  } finally {
    delete process.env.HARVEST_EVICT_MAX_PER_SEARCH;
    delete process.env.HARVEST_EVICT_FLOOR;
  }
});

// --- 2. OFF / escopo B-2 -----------------------------------------------------

test('8.16: OFF não consulta nada; BYO e gate de operador fechado nunca sofrem evicção', async () => {
  metrics.reset();
  const api = mockAd({ account: [mag(501, GRINGO, 'Old.Movie.2019.TrueFrench.1080p', 1000)] });
  inventario(ACCOUNT, []);
  try {
    const off = withDebrid({ evictPerSearch: false, apiKey: KEY, harvestEvictFloor: 0 });
    scheduleEvict(KEY, [ATUAL]);
    await assenta();
    assert.equal(api.statusCalls, 0, 'OFF: zero rede de evicção, mesmo na conta do operador');
    off();

    const byo = withDebrid({ evictPerSearch: true, apiKey: KEY, harvestEvictFloor: 0 });
    scheduleEvict('chave-de-outro-usuario', [ATUAL]);
    await assenta();
    assert.equal(api.statusCalls, 0, 'chave de usuário (BYO): nunca evicta');
    byo();

    const fechado = withDebrid({
      evictPerSearch: true, apiKey: KEY, harvestEvictFloor: 0,
      allowEnvKey: false, operatorEnvAccount: false,
    });
    scheduleEvict(KEY, [ATUAL]);
    await assenta();
    assert.equal(api.statusCalls, 0, 'envOperatorAccount fechado: nunca evicta');
    fechado();

    const zero = withDebrid({ evictPerSearch: true, apiKey: KEY, harvestEvictMaxPerSearch: 0 });
    scheduleEvict(KEY, [ATUAL]);
    await assenta();
    assert.equal(api.statusCalls, 0, 'HARVEST_EVICT_MAX_PER_SEARCH=0 desliga');
    zero();

    assert.equal(api.ordem.length, 0);
    assert.equal(counter('debrid.evicted.busy'), 0);
  } finally {
    api.restore();
    soltaInventario(ACCOUNT);
    metrics.reset();
  }
});

// --- 3. Piso de ocupação ------------------------------------------------------

test('8.16: piso de ocupação — conta folgada não apaga nada (skippedFloor)', async () => {
  metrics.reset();
  const api = mockAd({ account: [mag(501, GRINGO, 'Old.Movie.2019.TrueFrench.1080p', 1000)] });
  inventario(ACCOUNT, []);
  const restore = withDebrid({ ...OPERADOR, harvestEvictFloor: 600 });
  try {
    scheduleEvict(KEY, [ATUAL]);
    await assenta();
    await assenta();
    assert.equal(api.ordem.length, 0, 'abaixo do piso ninguém sai da conta');
    assert.ok(counter('debrid.evicted.skippedFloor') >= 1, 'o piso conta o skip');
    assert.equal(counter('debrid.evicted.perSearch'), 0);
  } finally {
    restore();
    api.restore();
    soltaInventario(ACCOUNT);
    metrics.reset();
  }
});

// --- 4. Seleção em conjunção --------------------------------------------------

test('8.16: seleção só do estrangeiro condenado — não-preexistente, não-ativo, não-protegido, não-atual; sem data fica', async () => {
  metrics.reset();
  const SEMDATA = 'ab'.repeat(20);
  const DESCONHECIDO = 'cd'.repeat(20);
  const BR_H = 'ef'.repeat(20);
  const api = mockAd({
    account: [
      mag(501, GRINGO, 'Old.Movie.2019.TrueFrench.1080p', 1000), // único elegível
      mag(502, PRE, 'Pre.User.2018.TrueFrench.1080p', 500), // preexistente, mais antigo ainda
      mag(503, ATIVO, 'Active.Movie.2017.TrueFrench.720p', 600, 'Downloading'),
      mag(504, HELD_H, 'Held.Movie.2016.TrueFrench.720p', 700),
      mag(505, ADPROT_H, 'Protected.Movie.2015.TrueFrench.720p', 800),
      mag(506, ATUAL, 'Current.Movie.2024.TrueFrench.1080p', 900), // hash da própria busca
      mag(507, SEMDATA, 'NoDate.Movie.TrueFrench.1080p', 0), // sem data a idade não é provada
      mag(508, DESCONHECIDO, 'Some.Random.Movie.2019.1080p.x264', 950), // unknown fica
      mag(509, BR_H, 'Coração de Vingança 2019 Dublado 1080p', 990), // BR nunca
    ],
  });
  inventario(ACCOUNT, [PRE]);
  held.hold(HELD_H, 3600, ACCOUNT);
  held.protectBr('alldebrid', ACCOUNT, ADPROT_H);
  const restore = withDebrid({ ...OPERADOR });
  try {
    scheduleEvict(KEY, [ATUAL]); // alvo = min(1, 25, 9) = 1
    await esperaMetrica('debrid.evicted.perSearch');
    await assenta();
    assert.deepEqual([...api.ordem], [501], 'só o gringo provado e desprotegido saiu');
    assert.deepEqual([...api.deleted], [501]);
    assert.equal(counter('debrid.evicted.perSearch'), 1);
    assert.ok(cache.peek(adrmKey(ACCOUNT, GRINGO)) != null, 'removido recebe adrm (8.14)');
    const ficam: Array<[string, number]> = [
      ['preexistente', 502], ['ativo', 503], ['held', 504], ['adprot', 505],
      ['atual', 506], ['sem data', 507], ['unknown', 508], ['BR', 509],
    ];
    for (const [nome, id] of ficam) {
      assert.equal(api.ordem.includes(id), false, `${nome} fica na conta`);
    }
  } finally {
    restore();
    held.release(HELD_H, ACCOUNT);
    held.unprotect('alldebrid', ACCOUNT, ADPROT_H);
    cache.forget(adrmKey(ACCOUNT, GRINGO));
    api.restore();
    soltaInventario(ACCOUNT);
    metrics.reset();
  }
});

// --- 5. Mais antigos primeiro + teto por busca --------------------------------

test('8.16: mais antigos primeiro e teto HARVEST_EVICT_MAX_PER_SEARCH', async () => {
  metrics.reset();
  const api = mockAd({
    account: [
      mag(511, '11'.repeat(20), 'Oldest.Movie.2010.TrueFrench.1080p', 1000),
      mag(512, '22'.repeat(20), 'Middle.Movie.2011.TrueFrench.1080p', 2000),
      mag(513, '33'.repeat(20), 'Newest.Movie.2012.TrueFrench.1080p', 3000),
    ],
  });
  inventario(ACCOUNT, []);
  const restore = withDebrid({ ...OPERADOR, harvestEvictMaxPerSearch: 2 });
  try {
    scheduleEvict(KEY, ['44'.repeat(20), '55'.repeat(20), '66'.repeat(20), '77'.repeat(20)]); // alvo = min(4, 2, 3)
    await esperaMetrica('debrid.evicted.perSearch');
    await assenta();
    assert.deepEqual([...api.deleted].sort(), [511, 512], 'sai o mais antigo primeiro, até o teto');
    assert.equal(api.ordem.includes(513), false, 'o mais novo fica para a próxima busca');
  } finally {
    restore();
    api.restore();
    soltaInventario(ACCOUNT);
    metrics.reset();
  }
});

// --- 6. Alvo = min(consultados, max, ocupação − piso) --------------------------

test('8.16: a vaga do piso limita o alvo (ocupação − HARVEST_EVICT_FLOOR)', async () => {
  metrics.reset();
  const api = mockAd({
    account: [
      mag(521, PRE, 'Acervo1.Usuario.2010.TrueFrench.1080p', 100),
      mag(522, '88'.repeat(20), 'Acervo2.Usuario.2011.TrueFrench.1080p', 200),
      mag(523, '12'.repeat(20), 'G1.Movie.2012.TrueFrench.1080p', 1000),
      mag(524, '34'.repeat(20), 'G2.Movie.2013.TrueFrench.1080p', 2000),
      mag(525, '56'.repeat(20), 'G3.Movie.2014.TrueFrench.1080p', 3000),
    ],
  });
  inventario(ACCOUNT, [PRE, '88'.repeat(20)]); // ocupação 5, piso 2 → vaga 3
  const restore = withDebrid({ ...OPERADOR, harvestEvictFloor: 2 });
  try {
    scheduleEvict(KEY, ['9a'.repeat(20), '9b'.repeat(20), '9c'.repeat(20), '9d'.repeat(20), '9e'.repeat(20)]); // alvo = min(5, 25, 3)
    await esperaMetrica('debrid.evicted.perSearch');
    await assenta();
    assert.deepEqual([...api.deleted].sort(), [523, 524, 525], 'evicta a vaga, não tudo que se qualifica');
    assert.ok(api.ordem.every((id) => Number(id) >= 523), 'o acervo do usuário (preexistente) nunca sai');
  } finally {
    restore();
    api.restore();
    soltaInventario(ACCOUNT);
    metrics.reset();
  }
});

// --- 7. Fire-and-forget --------------------------------------------------------

test('8.16: evicção é fire-and-forget — checkCached não espera seleção nem rede', async () => {
  metrics.reset();
  const statusGate = gate();
  const api = mockAd({
    ready: [],
    account: [
      mag(531, GRINGO, 'Old.Movie.2019.TrueFrench.1080p', 1000),
      mag(532, ATUAL, 'Current.Movie.2024.TrueFrench.1080p', 5000),
    ],
    statusGate,
  });
  inventario(ACCOUNT, []);
  // Drops desligados para isolar a evicção como ÚNICA deleção do teste.
  const restore = withDebrid({ ...OPERADOR, dropReady: false, dropUncached: false });
  try {
    const inicio = Date.now();
    await Promise.race([
      checkCached(KEY, [ATUAL]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('checkCached travou esperando a evicção')), 1000)),
    ]);
    const gasto = Date.now() - inicio;
    assert.ok(gasto < 800, `checkCached devolveu em ${gasto}ms com o status da evicção ainda preso`);
    assert.deepEqual([...api.ordem], [], 'nenhum delete no prazo da resposta');
    statusGate.liberar();
    await assenta();
    await assenta();
    assert.equal(api.statusCalls, 1, 'a evicção rodou uma rodada, em fundo');
    assert.deepEqual([...api.deleted], [531], 'o hash que a própria busca consultou fica; o gringo antigo sai');
  } finally {
    statusGate.liberar();
    restore();
    api.restore();
    soltaInventario(ACCOUNT);
    metrics.reset();
  }
});

// --- 8. Anti-reentrada ----------------------------------------------------------

test('8.16: anti-reentrada — concorrente conta busy e não empilha rodada', async () => {
  metrics.reset();
  const statusGate = gate();
  const api = mockAd({ account: [mag(541, GRINGO, 'Old.Movie.2019.TrueFrench.1080p', 1000)], statusGate });
  inventario(ACCOUNT, []);
  const restore = withDebrid({ ...OPERADOR });
  try {
    scheduleEvict(KEY, ['9f'.repeat(20)]);
    await assenta();
    assert.equal(api.statusCalls, 1, 'primeira rodada em voo (presa no status)');
    scheduleEvict(KEY, ['9g'.repeat(20)]);
    assert.equal(counter('debrid.evicted.busy'), 1, 'a concorrente conta busy e sai');
    statusGate.liberar();
    await assenta();
    await assenta();
    assert.equal(api.statusCalls, 1, 'não há segunda rodada empilhada');
    assert.deepEqual([...api.deleted], [541]);
    assert.equal(counter('debrid.evicted.perSearch'), 1);
  } finally {
    statusGate.liberar();
    restore();
    api.restore();
    soltaInventario(ACCOUNT);
    metrics.reset();
  }
});
