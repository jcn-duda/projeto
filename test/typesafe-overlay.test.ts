/**
 * ETAPA C — overlay GATEADO do Jev (`TYPESAFE_OVERLAY_ENABLED`, DEFAULT OFF —
 * ligar é opt-in explícito; o portão formal de >=200 julgamentos + revisão
 * humana ainda não foi cumprido):
 *   1. DEFAULT: a fábrica de config nasce DESLIGADA; `=true` é o opt-in
 *      explícito do operador;
 *   2. PORTÕES: com ligado, a decisão ainda exige runtime shadow ON, chave
 *      presente (mesma exigência do produtor/drain), Jev não pausado global
 *      (o `jev-pause` do painel desliga a DECISÃO; resume restaura) e modelo
 *      versionado (`jev-x.y.z` — alias móvel como `jev-latest`/`jev-preview`
 *      falha FECHADO); no cache, o eco do modelo (`m`) tem que conferir com o
 *      ID da config — cache velho/divergente falha fechado. Os portões fecham
 *      ANTES de fingerprint/leitura, sem métrica de consulta;
 *   3. INÉRCIA OFF: com qualquer portão fechado, `overlayDropsDub` devolve
 *      false e os classificadores ficam idênticos ao legado em corpus
 *      sintético — os testes que precisam da baseline DESLIGAM a flag;
 *   4. CACHE-ONLY: com ON e portões abertos, `overlayDropsDub` NUNCA faz
 *      fetch, enqueue ou escrita — só lê `tsj` (dublê de fetch registra ZERO
 *      chamadas);
 *   5. APLICAÇÃO/MONOTONICIDADE: negativa confiante (noul <= 0.15) derruba
 *      `true`->`false` SOMENTE no generic DUB isolado; marca PT forte é imune;
 *      ausência de cache preserva true; nunca há false->true; caminhos
 *      destrutivos E o balde do catálogo (`audioBucket`, {overlay:false})
 *      ficam idênticos;
 *   6. BASELINE SHADOW: `deterministicLooksPtBr` (régua do produtor) fica
 *      travada em {overlay:false} — o overlay não altera a régua contra a
 *      qual ele próprio é medido;
 *   7. MÉTRICA: `applied` conta TÍTULO distinto (dedupe por fingerprint com
 *      vencimento ALINHADO AO JULGAMENTO — `at + judgmentTtlS`, exatamente o
 *      vencimento da entrada no `tsj`: dentro do TTL não há recontagem; o LRU
 *      teto 512 que recontava título cujo julgamento segue decisório no cache
 *      não volta), `consulted` conta chamada;
 *   8. AUTORIDADE: NÃO há memo global de decisão (P1 da revisão — o memo que
 *      expira pelo momento de consulta sobrevive à eviction da cota do
 *      `tsj` e mascara julgamento NOVO do mesmo fp, inclusive mudança do
 *      `noul`): cada chamada faz `lookup` síncrono — miss NUNCA congelado
 *      (escrita posterior do shadow é vista na hora), eviction antes do TTL
 *      vira miss honesto e reescrita vale imediatamente; reset de teste limpa
 *      o dedupe (não há memo para limpar).
 *
 * O import de `audio-quality` vem PRIMEIRO de propósito: força a avaliação do
 * ciclo ESM `audio-quality -> ai/index -> audio-quality` pelo lado do módulo de
 * decisão, e as chamadas abaixo provam que o uso é em RUNTIME (funções), não
 * na avaliação de módulo.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { typesafe as typesafeFactory, isVersionedModel } from '../src/config/typesafe.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { explicitPtAudio, audioFromTitle, looksPtBr, audioBucket, hasExplicitForeignAudio, foreignVerdict } from '../src/utils/audio-quality.js';
import { overlayDropsDub, deterministicLooksPtBr, resetTypesafeForTests, aiControl } from '../src/ai/index.js';
import { fingerprint, store, judgmentKey } from '../src/ai/audio-judgment-cache.js';
import { stubFetch, type FetchStub } from './helpers/stub.js';
import type { RawItem } from '../types/domain.js';

const SAVED = { ...config.typesafe };
// Modelo VERSIONADO (`jev-x.y.z`): o portão de modelo recusa alias móvel, então
// os testes de comportamento usam ID com versão válida.
const MODEL = 'jev-9.9.9';

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
  // `enabled: true` é portão próprio (runtime shadow ligado) e `apiKey`
  // TAMBÉM é portão do overlay (mesma exigência do produtor/drain) — os
  // testes de comportamento rodem herméticos (CI não tem .env); o teste do
  // portão de chave o fecha explicitamente com `cfgOn({ apiKey: '' })`.
  Object.assign(config.typesafe, { overlayEnabled: true, enabled: true, apiKey: 'k-test', model: MODEL, ...over });
}

beforeEach(() => {
  resetTypesafeForTests();
  aiControl.resume(); // portão de pausa aberto (o teste de portões o fecha)
  cache.clearNamespace('tsj');
  metrics.reset();
  Object.assign(config.typesafe, SAVED); // baseline = default do .env (overlay OFF)
  // Todo teste que liga o overlay o faz explicitamente (cfgOn) — nada depende
  // do estado anterior.
});

after(() => {
  Object.assign(config.typesafe, SAVED);
  resetTypesafeForTests();
});

test('default do overlay é OFF; `=true` liga por opt-in explícito', () => {
  // A fábrica é avaliada com o env corrente: sem a env, o default é DESLIGADO
  // (o portão formal de >=200 julgamentos + revisão humana não foi cumprido).
  const saved = process.env.TYPESAFE_OVERLAY_ENABLED;
  try {
    delete process.env.TYPESAFE_OVERLAY_ENABLED;
    assert.equal(typesafeFactory().overlayEnabled, false, 'overlay nasce DESLIGADO por padrão');
    process.env.TYPESAFE_OVERLAY_ENABLED = 'true';
    assert.equal(typesafeFactory().overlayEnabled, true, 'opt-in explícito liga');
    process.env.TYPESAFE_OVERLAY_ENABLED = 'false';
    assert.equal(typesafeFactory().overlayEnabled, false, 'kill-switch explícito desliga');
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_OVERLAY_ENABLED;
    else process.env.TYPESAFE_OVERLAY_ENABLED = saved;
  }
});

test('helper de modelo versionado: `jev-x.y.z` estrito; alias móvel recusado', () => {
  assert.equal(isVersionedModel('jev-1.13.0'), true);
  assert.equal(isVersionedModel('jev-9.9.9'), true);
  assert.equal(isVersionedModel('jev-latest'), false, 'alias móvel não é versionado');
  assert.equal(isVersionedModel('jev-preview'), false);
  assert.equal(isVersionedModel('jev-1.13'), false, 'versão incompleta não passa');
  assert.equal(isVersionedModel('jev-1.13.0-rc1'), false, 'sufixo extra não passa');
  assert.equal(isVersionedModel(''), false);
});

test('portões independentes: runtime OFF, Jev pausado e resume restauram a decisão', () => {
  // Cache NEGATIVO semeado: se algum portão deixar passar, o título é derrubado
  // e `consulted` acusa a leitura.
  const titulo = 'Filme Portao 2024 [DUB] 1080p';
  store(fingerprint(titulo, MODEL), { n: 0.01, m: MODEL, at: 1 }, 600);
  // Portão 2 — runtime shadow desligado: overlay ligado, mas sem runtime não
  // há fila povoando o cache e o overlay não decide.
  cfgOn({ enabled: false });
  assert.equal(overlayDropsDub(titulo), false, 'runtime OFF não decide');
  assert.equal(counter('typesafe.overlay.consulted'), 0, 'runtime OFF não consulta');
  // Portão 3 — pausa global: o botão jev-pause desliga a DECISÃO do overlay
  // enquanto pausado (não só as filas); o resume restaura.
  cfgOn();
  aiControl.pause();
  assert.equal(overlayDropsDub(titulo), false, 'pausado não decide');
  assert.equal(counter('typesafe.overlay.consulted'), 0, 'pausado não consulta');
  aiControl.resume();
  assert.equal(overlayDropsDub(titulo), true, 'resume restaura a decisão');
  assert.equal(counter('typesafe.overlay.consulted'), 1, 'só a chamada pós-resume consultou');
});

test('portão de modelo: alias móvel falha FECHADO; ID versionado decide', () => {
  const titulo = 'Filme Modelo 2024 [DUB] 1080p';
  store(fingerprint(titulo, 'jev-latest'), { n: 0.01, m: 'jev-latest', at: 1 }, 600);
  store(fingerprint(titulo, 'jev-1.13.0'), { n: 0.01, m: 'jev-1.13.0', at: 1 }, 600);
  cfgOn({ model: 'jev-latest' });
  assert.equal(overlayDropsDub(titulo), false, 'jev-latest (alias) não derruba mesmo com cache negativo');
  assert.equal(counter('typesafe.overlay.consulted'), 0, 'alias não chega a consultar');
  assert.ok(counter('typesafe.overlay.model-blocked') >= 1, 'bloqueio de modelo é visível em métrica');
  cfgOn({ model: 'jev-preview' });
  assert.equal(overlayDropsDub(titulo), false, 'jev-preview também falha fechado');
  cfgOn({ model: 'jev-1.13.0' });
  assert.equal(overlayDropsDub(titulo), true, 'ID versionado com negativa confiante derruba');
  assert.equal(counter('typesafe.overlay.consulted'), 1, 'só o modelo versionado consultou');
});

test('catálogo: audioBucket é determinístico ({overlay:false}) — cache negativo não muda o balde', () => {
  // Reprodução do relato: `Movie Name 2023 [DUB] 1080p` com overlay + julgamento
  // negativo (n=0.05) mudava o balde do catálogo de `dub` para `lixo` — o
  // balde PERSISTIDO da revisão manual da Limpeza não pode seguir o cache vivo.
  cfgOn();
  const titulo = 'Movie Name 2023 [DUB] 1080p';
  store(fingerprint(titulo, MODEL), { n: 0.05, m: MODEL, at: 1 }, 600);
  // Na LISTAGEM o overlay derruba o generic DUB (efeito desejado)…
  assert.equal(explicitPtAudio(titulo), false);
  assert.equal(looksPtBr(titulo), false);
  // …mas o balde do catálogo continua `dub`, com overlay ligado…
  assert.equal(audioBucket(titulo), 'dub', 'balde persistido não é reescrito pelo cache vivo');
  // …após desligar, e no veredito destrutivo (que nunca foi influenciado).
  assert.equal(foreignVerdict(titulo), 'absolve', 'veredito destrutivo segue absolvendo');
  config.typesafe.overlayEnabled = false;
  assert.equal(audioBucket(titulo), 'dub', 'desligar o overlay não muda o balde');
  assert.equal(foreignVerdict(titulo), 'absolve');
});

test('métrica applied conta TÍTULO distinto, não cada chamada', () => {
  cfgOn();
  const titulo = 'Filme Repetido 2024 [DUB] 1080p';
  // `at: Date.now()` é a âncora do dedupe (idêntica à gravação da fila em
  // produção): o vencimento é `at + judgmentTtlS`, o mesmo do cache.
  store(fingerprint(titulo, MODEL), { n: 0.02, m: MODEL, at: Date.now() }, 600);
  for (let i = 0; i < 5; i += 1) assert.equal(overlayDropsDub(titulo), true);
  assert.equal(counter('typesafe.overlay.applied'), 1, 'mesmo título re-consultado não re-incrementa');
  assert.equal(counter('typesafe.overlay.consulted'), 5, 'consulted segue contando chamada (cada uma faz lookup)');
  const outro = 'Filme Distinto 2025 [DUB] 1080p';
  store(fingerprint(outro, MODEL), { n: 0.02, m: MODEL, at: Date.now() }, 600);
  assert.equal(overlayDropsDub(outro), true);
  assert.equal(counter('typesafe.overlay.applied'), 2, 'título distinto incrementa');
});

test('baseline shadow: overlay ligado + cache negativo NÃO muda a régua determinística', () => {
  // A régua do produtor shadow é {overlay:false} travado: a IA não pode
  // alterar o baseline contra o qual ela própria é medida.
  cfgOn();
  const titulo = 'Movie Name 2023 [DUB] 1080p';
  store(fingerprint(titulo, MODEL), { n: 0.01, m: MODEL, at: 1 }, 600);
  const item: RawItem = { title: titulo };
  // O overlay (mesma config, mesmo cache) DERRUBA o generic DUB na listagem…
  assert.equal(overlayDropsDub(titulo), true);
  // …e ainda assim a baseline que o produtor calcula continua true.
  assert.equal(deterministicLooksPtBr(item), true, 'baseline imune ao overlay');
  // E continua true com o overlay desligado — a régua não depende da flag.
  config.typesafe.overlayEnabled = false;
  assert.equal(deterministicLooksPtBr(item), true, 'baseline idêntica com overlay OFF');
  assert.equal(looksPtBr(titulo), true, 'com OFF, o caminho default volta ao legado');
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
  // A fábrica nasce OFF; `cfgOn()` é o opt-in que ativa o overlay neste teste.
  // As asserções de zero-rede/zero-escrita valem exatamente para a
  // configuração que vai ao ar quando o operador liga.
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

test('decisão sempre deriva do lookup — sem memo; reset limpa só o dedupe de applied', () => {
  cfgOn();
  const t = 'Filme SemMemo 2024 [DUB] 1080p';
  store(fingerprint(t, MODEL), { n: 0.02, m: MODEL, at: Date.now() }, 600);
  assert.equal(overlayDropsDub(t), true, 'drop via cache');
  const consultado = counter('typesafe.overlay.consulted');
  const aplicado = counter('typesafe.overlay.applied');
  // Sem memo global: a segunda chamada consulta o cache DE NOVO (consulted
  // sobe) e o dedupe segura o applied — decisão idêntica, sem atalho.
  assert.equal(overlayDropsDub(t), true, 'segunda chamada decide de novo via lookup');
  assert.equal(counter('typesafe.overlay.consulted'), consultado + 1, 'cada chamada consulta');
  assert.equal(counter('typesafe.overlay.applied'), aplicado, 'dedupe de applied segura dentro do TTL');
  // Cache apagado: miss honesto — a decisão aplicada NÃO age como decisão
  // (não há memo para mascarar a eviction).
  cache.clearNamespace('tsj');
  assert.equal(overlayDropsDub(t), false, 'sem cache: miss honesto, applied não decide');
  assert.ok(counter('typesafe.overlay.cache-miss') >= 1);
  // Reset zera o dedupe: re-semeando o cache, o applied re-incrementa.
  resetTypesafeForTests();
  store(fingerprint(t, MODEL), { n: 0.02, m: MODEL, at: Date.now() }, 600);
  assert.equal(overlayDropsDub(t), true);
  assert.equal(counter('typesafe.overlay.applied'), aplicado + 1, 'reset limpou o dedupe de applied');
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

// Os follow-ups da revisão adversarial (portão de chave M1, eco do modelo B4,
// dedupe sem evicção B1, writers persistidos M2, produtor/idx M3 e o status
// active/blockedReason B3) moram em test/typesafe-overlay-followups.test.ts —
// este arquivo é o contrato SEMÂNTICO do overlay; este, os portões e a régua.
