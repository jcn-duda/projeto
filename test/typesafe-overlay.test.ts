/**
 * ETAPA C — overlay GATEADO do Jev (`TYPESAFE_OVERLAY_ENABLED`, DEFAULT ON —
 * kill-switch para desligar):
 *   1. DEFAULT: a fábrica de config nasce ligada; `=false` é o kill-switch
 *      explícito (e a baseline determinística dos testes de inércia);
 *   2. INÉRCIA OFF: com a flag explicitamente desligada, `overlayDropsDub`
 *      devolve false ANTES de fingerprint/cache (nenhuma métrica, nenhuma
 *      leitura) e os classificadores ficam idênticos ao legado em corpus
 *      sintético — os testes que precisam da baseline DESLIGAM a flag;
 *   3. CACHE-ONLY: com ON, `overlayDropsDub` NUNCA faz fetch, enqueue ou
 *      escrita — só lê `tsj` (dublê de fetch registra ZERO chamadas);
 *   4. APLICAÇÃO/MONOTONICIDADE: negativa confiante (noul <= 0.15) derruba
 *      `true`->`false` SOMENTE no generic DUB isolado; marca PT forte é imune;
 *      ausência de cache preserva true; nunca há false->true; caminhos
 *      destrutivos (hasExplicitForeignAudio/foreignVerdict) ficam idênticos;
 *   5. MEMO: hit é memoizado; miss NUNCA congelado (escrita posterior do
 *      shadow é vista na hora); reset de teste limpa o memo.
 *
 * O import de `audio-quality` vem PRIMEIRO de propósito: força a avaliação do
 * ciclo ESM `audio-quality -> ai/index -> audio-quality` pelo lado do módulo de
 * decisão, e as chamadas abaixo provam que o uso é em RUNTIME (funções), não
 * na avaliação de módulo.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { typesafe as typesafeFactory } from '../src/config/typesafe.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { explicitPtAudio, audioFromTitle, looksPtBr, hasExplicitForeignAudio, foreignVerdict } from '../src/utils/audio-quality.js';
import { overlayDropsDub, resetTypesafeForTests } from '../src/ai/index.js';
import { fingerprint, store, judgmentKey } from '../src/ai/audio-judgment-cache.js';
import { stubFetch, type FetchStub } from './helpers/stub.js';

const SAVED = { ...config.typesafe };
const MODEL = 'jev-ov-test';

/** Corpus sintético com o valor LEGADO (OFF) — trava a semântica do refactor. */
const CORPUS: Array<[string, boolean]> = [
  ['Interstellar 2014 Dublado 1080p', true],
  ['Movie Name 2023 [DUB] 1080p', true],
  ['Movie Name 2023 Dubbed 1080p', true],
  ['Serie X DUBLAGEM Completa 720p', true],
  ['Filme Y AUDIO PT-BR 1080p', true],
  ['Filme Z PT-BR 1080p', true],
  ['Movie Name Hindi Dubbed 1080p', false],
  ['Во все тяжкие [DUB] 720p', false],
  ['Coyote Ugly [2000, USA, drama, BDRip] Dub', false],
  ['Anime Title English Dubbed 1080p', false],
  ['Movie Plain 2019 BluRay x264', false],
  ['Interestelar Dual Áudio 2014 1080p', false],
];

/** Títulos com MARCA PT FORTE (não dependem do termo fraco generic DUB). */
const FORTE = CORPUS.filter(([t, v]) => v && !/\[\s*DUB\s*\]|\bDubbed\b/i.test(t)).map(([t]) => t);

/** Semeia o MESMO noul para todo o corpus no cache `tsj`. */
function seedCorpus(noul: number) {
  for (const [title] of CORPUS) {
    store(fingerprint(title, MODEL), { n: noul, m: MODEL, at: 1 }, 600);
  }
}

const counter = (name: string) => Number(metrics.snapshot().counters[name] || 0);

function cfgOn(over: Record<string, unknown> = {}) {
  Object.assign(config.typesafe, { overlayEnabled: true, model: MODEL, ...over });
}

beforeEach(() => {
  resetTypesafeForTests();
  cache.clearNamespace('tsj');
  metrics.reset();
  Object.assign(config.typesafe, SAVED); // baseline = default do .env (overlay ON)
  // Todo teste que precisa da baseline determinística DESLIGA a flag nele
  // (cfgOn({ overlayEnabled: false })) — nada depende do estado anterior.
});

after(() => {
  Object.assign(config.typesafe, SAVED);
  resetTypesafeForTests();
});

test('default do kill-switch é ON; `=false` desliga explicitamente', () => {
  // A fábrica é avaliada com o env corrente: sem a env, o default é LIGADO.
  const saved = process.env.TYPESAFE_OVERLAY_ENABLED;
  try {
    delete process.env.TYPESAFE_OVERLAY_ENABLED;
    assert.equal(typesafeFactory().overlayEnabled, true, 'overlay nasce LIGADO por padrão');
    // Com cache vazio isso é no-op honesto (miss preserva true) — provado pelo
    // teste de cache-only/monotonicidade abaixo.
    process.env.TYPESAFE_OVERLAY_ENABLED = 'false';
    assert.equal(typesafeFactory().overlayEnabled, false, 'kill-switch explícito desliga');
    process.env.TYPESAFE_OVERLAY_ENABLED = 'true';
    assert.equal(typesafeFactory().overlayEnabled, true);
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_OVERLAY_ENABLED;
    else process.env.TYPESAFE_OVERLAY_ENABLED = saved;
  }
});

test('OFF (kill-switch): devolve false ANTES de fingerprint/cache e os classificadores ficam legado', () => {
  // Cache SEMEADO com negativa confiante: se a flag OFF lesse cache antes de
  // decidir, derrubaria — e o contador consulted acusaria a passagem.
  cfgOn({ overlayEnabled: false });
  seedCorpus(0.02);
  for (const [title] of CORPUS) {
    assert.equal(overlayDropsDub(title), false, `OFF nunca derruba: ${title}`);
  }
  assert.equal(counter('typesafe.overlay.consulted'), 0, 'OFF não consulta nem conta');
  assert.equal(counter('typesafe.overlay.applied'), 0);
  // Classificação idêntica ao legado em todo o corpus.
  for (const [title, esperado] of CORPUS) {
    assert.equal(explicitPtAudio(title), esperado, `explicitPtAudio OFF legado: ${title}`);
    assert.equal(looksPtBr(title), esperado, `looksPtBr OFF legado: ${title}`);
  }
  assert.equal(audioFromTitle('Movie Name 2023 [DUB] 1080p'), 'Dublado');
  assert.equal(audioFromTitle('Movie Name Hindi Dubbed 1080p'), '');
  assert.equal(audioFromTitle('Interestelar Dual Áudio 2014 1080p'), 'Dual');
});

test('ON: cache-only — ZERO fetch, ZERO enqueue, ZERO escrita', () => {
  // Com o default ON, este teste é o estado de PRODUÇÃO; as asserções de
  // zero-rede/zero-escrita valem para a configuração que vai ao ar.
  cfgOn();
  const stub: FetchStub = stubFetch(() => ({ ok: true, status: 200, text: async () => '' }));
  try {
    // Miss e hit, muitas vezes: nenhuma chamada de rede pode existir.
    assert.equal(overlayDropsDub('Titulo Desconhecido 2024 [DUB]'), false);
    store(fingerprint('Titulo Com Cache [DUB]', MODEL), { n: 0.02, m: MODEL, at: 1 }, 600);
    assert.equal(overlayDropsDub('Titulo Com Cache [DUB]'), true);
    assert.equal(stub.calls.length, 0, 'overlay não abre socket');
    // Não enfileira nem chama: fila/rede do shadow é de OUTRO caminho.
    const chaves = Object.keys(metrics.snapshot().counters).filter(
      (k) => k.startsWith('typesafe.call.') || k.startsWith('typesafe.enqueue.'),
    );
    assert.deepEqual(chaves, [], 'nenhuma métrica de chamada/enfileiramento');
    // Não escreve: título só lido não ganha entrada no `tsj`.
    assert.equal(cache.has(judgmentKey('Titulo Desconhecido 2024 [DUB]', MODEL)), false, 'overlay não escreve cache');
    assert.ok(counter('typesafe.overlay.consulted') >= 2);
    assert.ok(counter('typesafe.overlay.cache-miss') >= 1);
    assert.equal(counter('typesafe.overlay.applied'), 1);
  } finally {
    stub.restore();
  }
});

test('ON: limiar 0.15 é <= (negativa CONFIANTE derruba; acima não)', () => {
  cfgOn();
  const t = (s: string) => `Filme Limiar ${s} 2024 [DUB]`;
  store(fingerprint(t('a'), MODEL), { n: 0.15, m: MODEL, at: 1 }, 600);
  store(fingerprint(t('b'), MODEL), { n: 0.150001, m: MODEL, at: 1 }, 600);
  store(fingerprint(t('c'), MODEL), { n: 0, m: MODEL, at: 1 }, 600);
  store(fingerprint(t('d'), MODEL), { n: 1, m: MODEL, at: 1 }, 600);
  assert.equal(overlayDropsDub(t('a')), true, '0.15 <= 0.15 derruba');
  assert.equal(overlayDropsDub(t('b')), false, '0.150001 não derruba');
  assert.equal(overlayDropsDub(t('c')), true, '0 derruba');
  assert.equal(overlayDropsDub(t('d')), false, 'positivo não derruba');
});

test('ON: monotonicidade — nunca false->true; PT forte imune; generic DUB isolado derruba', () => {
  // Estado legado capturado com a flag OFF...
  cfgOn({ overlayEnabled: false });
  const legado = new Map(
    CORPUS.map(([t]) => [t, { ex: explicitPtAudio(t), looks: looksPtBr(t), audio: audioFromTitle(t) }]),
  );
  // ...negativa CONFIANTE para TODOS, flag ON.
  seedCorpus(0.01);
  config.typesafe.overlayEnabled = true;
  for (const [title, off] of legado) {
    const onEx = explicitPtAudio(title);
    const onLooks = looksPtBr(title);
    if (!off.ex) assert.equal(onEx, false, `explicit nunca false->true: ${title}`);
    if (!off.looks) assert.equal(onLooks, false, `looks nunca false->true: ${title}`);
    if (FORTE.includes(title)) assert.equal(onEx, true, `PT forte imune ao overlay: ${title}`);
  }
  // Caso NOMINAL: generic DUB isolado derrubado na listagem inteira.
  assert.equal(explicitPtAudio('Movie Name 2023 [DUB] 1080p'), false);
  assert.equal(looksPtBr('Movie Name 2023 [DUB] 1080p'), false);
  assert.equal(audioFromTitle('Movie Name 2023 [DUB] 1080p'), '');
  // Pin {overlay:false} trava o legado MESMO com flag ON e cache negativo.
  assert.equal(explicitPtAudio('Movie Name 2023 [DUB] 1080p', { overlay: false }), true);
});

test('ON: caminhos destrutivos ficam idênticos ao OFF (assimetria da condenação)', () => {
  cfgOn();
  seedCorpus(0.01); // negativa confiante para todos
  for (const [title] of CORPUS) {
    const onForeign = hasExplicitForeignAudio(title);
    const onVerdict = foreignVerdict(title);
    config.typesafe.overlayEnabled = false;
    const offForeign = hasExplicitForeignAudio(title);
    const offVerdict = foreignVerdict(title);
    config.typesafe.overlayEnabled = true;
    assert.equal(onForeign, offForeign, `hasExplicitForeignAudio imune ao overlay: ${title}`);
    assert.equal(onVerdict, offVerdict, `foreignVerdict imune ao overlay: ${title}`);
  }
  // Prova NOMINAL de imunidade: com o overlay derrubando o generic DUB na
  // listagem, o título que SÓ tinha [DUB] como sinal PT segue ABSOLVENDO no
  // veredito destrutivo — a IA não retira proteção de caminho que apaga.
  assert.equal(hasExplicitForeignAudio('Movie Name 2023 [DUB] 1080p'), false);
  assert.equal(foreignVerdict('Movie Name 2023 [DUB] 1080p'), 'absolve');
});

test('ON: miss não congelado — escrita posterior do shadow é vista na hora', () => {
  cfgOn();
  const t = 'Filme Tarde 2024 Dubbed 720p';
  assert.equal(overlayDropsDub(t), false, 'primeira leitura é miss');
  store(fingerprint(t, MODEL), { n: 0.05, m: MODEL, at: Date.now() }, 600);
  assert.equal(overlayDropsDub(t), true, 'o mesmo título vira drop após a escrita');
});

test('resetTypesafeForTests limpa o memo do overlay (decisão volta ao cache vivo)', () => {
  cfgOn();
  const t = 'Filme Memo 2024 [DUB] 1080p';
  store(fingerprint(t, MODEL), { n: 0.02, m: MODEL, at: 1 }, 600);
  assert.equal(overlayDropsDub(t), true, 'drop via cache');
  const consultado = counter('typesafe.overlay.consulted');
  assert.equal(overlayDropsDub(t), true, 'segunda chamada usa o memo');
  assert.equal(counter('typesafe.overlay.consulted'), consultado + 1, 'consulted conta toda chamada');
  cache.clearNamespace('tsj');
  resetTypesafeForTests(); // limpa o memo junto com as filas
  assert.equal(overlayDropsDub(t), false, 'sem cache nem memo: miss honesto');
  assert.ok(counter('typesafe.overlay.cache-miss') >= 1);
});

test('ciclo ESM em runtime: audio-quality carregado primeiro executa os dois lados', () => {
  // Este arquivo importa audio-quality ANTES da fachada (topo do arquivo): a
  // avaliação de módulo passou pelo ciclo `audio-quality -> ai/index ->
  // audio-quality` e as funções dos DOIS lados rodam em tempo de execução.
  cfgOn();
  assert.equal(typeof overlayDropsDub('Ciclo [DUB]'), 'boolean');
  assert.equal(explicitPtAudio('Ciclo Dublado 1080p'), true);
  assert.equal(looksPtBr('Ciclo Interstellar 2014 Dublado 1080p'), true);
});
