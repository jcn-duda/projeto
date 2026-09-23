/**
 * PRIORIDADE do produtor shadow (item C): `shadowAudioJudgments` ordena
 * ESTAVELMENTE weak → br → rest ANTES do teto de 12, e registra a camada de
 * cada candidato ACEITO em `typesafe.shadow.tier.{weak|br|rest}`.
 *
 * - `weak` é o generic DUB isolado (`weakGenericDubOnly`) — o ÚNICO caso que o
 *   overlay Jev pode derrubar; é o alvo de medição do slice, então entra
 *   primeiro;
 * - `br` é o flag de origem do provider (`item.isBr`) ou a régua determinística
 *   de áudio PT (`deterministicLooksPtBr`, `{overlay:false}`);
 * - `rest` é todo o resto. O teto corta a CAUDA do ranking, nunca o topo.
 *
 * O teste prova a ordem por DOIS lados: as métricas de camada (contagem por
 * aceito) e a ORDEM REAL dos títulos despachados na fila (concorrência 1,
 * FIFO), com os fracos no FIM da entrada — se não houvesse prioridade, eles
 * nem entrariam.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { shadowAudioJudgments, resetTypesafeForTests, flushTypesafeForTests } from '../src/ai/index.js';
import { weakGenericDubOnly, explicitPtAudio, looksPtBr, audioFromTitle } from '../src/utils/audio-quality.js';
import { stubFetch, type FetchStub } from './helpers/stub.js';
import type { RawItem } from '../types/domain.js';

const SAVED = { ...config.typesafe };
const MODEL = 'jev-9.9.9';
const MAX = 12; // SHADOW_PER_BUILD_MAX

const counter = (name: string) => Number(metrics.snapshot().counters[name] || 0);
const hex = (n: number) => String(n).padStart(2, '0').repeat(20).slice(0, 40);

function cfgOn() {
  Object.assign(config.typesafe, {
    enabled: true,
    apiKey: 'k-test',
    endpoint: 'https://ts.test/v1/systemone',
    model: MODEL,
    concurrency: 1, // FIFO: a ordem do fetch espelha a ordem de enqueue
    timeoutMs: 3000,
    queueMax: 64,
    hourlyCap: 120,
    dailyCap: 600,
  });
}

/** Responde um noul válido; o alvo é a ORDEM, não a concordância. */
function okStub(): FetchStub {
  return stubFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ answers: { is_ptbr_dub: { noul: 0.9 } } }),
  }));
}

/** Títulos despachados, na ordem em que a fila os enviou. */
function dispatchedOrder(stub: FetchStub): string[] {
  return stub.calls.map((c) => JSON.parse(c.options.body).state.post_title);
}

beforeEach(() => {
  resetTypesafeForTests();
  cache.clearNamespace('tsj');
  metrics.reset();
  Object.assign(config.typesafe, SAVED);
});

after(() => {
  Object.assign(config.typesafe, SAVED);
  resetTypesafeForTests();
});

test('weakGenericDubOnly espelha o ramo fraco após recortar convenções do post', () => {
  const fracos = ['Movie Name 2023 [DUB] 1080p', 'Movie Name 2023 Dubbed 1080p'];
  const fortes = ['Interestelar 2014 Dublado 1080p', 'Filme PT-BR 2018 1080p', 'Serie X DUBLAGEM 720p'];
  const rest = ['Movie Plain 2019 BluRay x264', 'Interestelar Dual Áudio 2014 1080p'];
  const estrangeiro = ['Movie Name Hindi Dubbed 1080p', 'Во все тяжкие [DUB] 720p'];
  for (const t of fracos) {
    assert.equal(weakGenericDubOnly(t), true, `fraco: ${t}`);
    // O ramo fraco é preservado no legado ({overlay:false}).
    assert.equal(explicitPtAudio(t, { overlay: false }), true, `legado preserva: ${t}`);
  }
  for (const t of [...fortes, ...rest, ...estrangeiro]) {
    assert.equal(weakGenericDubOnly(t), false, `não-fraco: ${t}`);
  }
  // Sempre que o fraco é true, `looksPtBr` no legado também é (mesma base).
  for (const t of fracos) assert.equal(looksPtBr(t, { overlay: false }), true);
});

test('weak cobre a convenção "DUBLADA E DUAL" recortada por audioFromTitle', () => {
  // Bug de cobertura (item C): `audioFromTitle` recorta a convenção de prefixo
  // ("DUBLADA E DUAL", presente mesmo no botão LEGENDADA) ANTES de consultar
  // `explicitPtAudio`. O generic DUB que sobra dela ([DUB]) É elegível ao
  // overlay — o tier tem que vê-lo; o "DUBLADA" do título CRU é só o prefixo do
  // post, não uma marca PT real do botão.
  const convencao = 'Foo DUBLADA E DUAL [DUB] 1080p';
  assert.equal(weakGenericDubOnly(convencao), true, 'convenção + [DUB] é termo fraco');
  // Classificação PÚBLICA inalterada: a marca forte do cru segue vencendo e o
  // overlay não altera áudio nem looksPtBr (o overlay só atua no termo fraco).
  assert.equal(explicitPtAudio(convencao, { overlay: false }), true);
  assert.equal(explicitPtAudio(convencao), true);
  assert.equal(audioFromTitle(convencao), 'Dual');
  assert.equal(looksPtBr(convencao, { overlay: false }), true);
  // Botão LEGENDADA com a MESMA convenção: o overlay pode virar o resultado —
  // exatamente o caso que precisa da prioridade `weak`.
  assert.equal(weakGenericDubOnly('Foo LEGENDADA DUBLADA E DUAL [DUB] 1080p'), true);

  // Controles: sem generic DUB sobrante, ou com marca forte REAL além da
  // convenção, continua NÃO-fraco — nada de falso positivo.
  for (const t of [
    'Foo DUBLADA E DUAL 1080p', // convenção sem generic DUB
    'Foo DUBLADA 1080p', // marca forte real, sem generic DUB
    'Foo DUBLADA E DUAL DUBLADO 1080p', // forte real sobrevive ao recorte
    'Foo DUBLADA E DUAL Hindi Dubbed 1080p', // idioma estrangeiro desmente o generic
    'Foo DUBLADA E DUAL Во все тяжкие [DUB] 720p', // cirílico desmente o generic
  ]) {
    assert.equal(weakGenericDubOnly(t), false, `não-fraco: ${t}`);
  }
});

test('prioridade tier: título com convenção "DUBLADA E DUAL" entra como weak', async () => {
  cfgOn();
  const stub = okStub();
  try {
    const convencao = 'Foo DUBLADA E DUAL [DUB] 1080p';
    const rest: RawItem = { title: 'Plain Rest 2019 BluRay x264', infoHash: hex(1) };
    shadowAudioJudgments([rest, { title: convencao, infoHash: hex(2) }]);
    await flushTypesafeForTests();
    assert.deepEqual(dispatchedOrder(stub), [convencao, rest.title], 'weak entra antes do rest');
    assert.equal(counter('typesafe.shadow.tier.weak'), 1);
    assert.equal(counter('typesafe.shadow.tier.rest'), 1);
  } finally {
    stub.restore();
  }
});

test('prioridade: fracos no FIM da entrada entram PRIMEIRO e ocupam o teto', async () => {
  cfgOn();
  const stub = okStub();
  try {
    const rest: RawItem[] = Array.from({ length: 18 }, (_v, i) => ({
      title: `Plain Rest ${i} 2019 BluRay x264`,
      infoHash: hex(i),
    }));
    const weak: RawItem[] = Array.from({ length: 12 }, (_v, i) => ({
      title: `Movie Name W${i} 2023 [DUB] 1080p`,
      infoHash: hex(100 + i),
    }));
    // 30 itens distintos, fracos por ÚLTIMO.
    shadowAudioJudgments([...rest, ...weak]);
    await flushTypesafeForTests();
    assert.deepEqual(dispatchedOrder(stub), weak.map((w) => w.title), 'os 12 fracos foram os aceitos, em ordem');
    assert.equal(counter('typesafe.shadow.tier.weak'), 12);
    assert.equal(counter('typesafe.shadow.tier.br'), 0);
    assert.equal(counter('typesafe.shadow.tier.rest'), 0);
    assert.equal(counter('typesafe.shadow.build-capped'), 18, 'a cauda (rest) ficou de fora');
  } finally {
    stub.restore();
  }
});

test('prioridade estável weak → br → rest com as três camadas', async () => {
  cfgOn();
  const stub = okStub();
  try {
    const rest: RawItem[] = Array.from({ length: 10 }, (_v, i) => ({
      title: `Plain Rest ${i} 2019 BluRay x264`,
      infoHash: hex(i),
    }));
    // Metade por prova de áudio no título, metade pelo flag de origem.
    const br: RawItem[] = Array.from({ length: 10 }, (_v, i) => ({
      title: `Serie BR ${i} 2022 Dublado 1080p`,
      infoHash: hex(200 + i),
    }));
    const weak: RawItem[] = Array.from({ length: 10 }, (_v, i) => ({
      title: `Movie Name W${i} 2023 [DUB] 1080p`,
      infoHash: hex(300 + i),
    }));
    shadowAudioJudgments([...rest, ...br, ...weak]);
    await flushTypesafeForTests();
    const ordem = dispatchedOrder(stub);
    // 10 fracos + 2 BR (teto 12); a ordem DENTRO da camada é a da entrada.
    assert.deepEqual(ordem.slice(0, 10), weak.map((w) => w.title));
    assert.deepEqual(ordem.slice(10), br.slice(0, 2).map((b) => b.title));
    assert.equal(counter('typesafe.shadow.tier.weak'), 10);
    assert.equal(counter('typesafe.shadow.tier.br'), 2);
    assert.equal(counter('typesafe.shadow.tier.rest'), 0);
    assert.equal(counter('typesafe.shadow.build-capped'), 18);
    assert.equal(ordem.length, MAX);
  } finally {
    stub.restore();
  }
});
