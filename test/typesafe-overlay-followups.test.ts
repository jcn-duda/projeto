/**
 * Follow-ups da revisão adversarial do overlay Jev (ETAPA C) — o contrato
 * SEMÂNTICO mora em typesafe-overlay.test.ts; aqui são os fechamentos:
 *
 *   M1 — portão de CHAVE: a decisão exige `TYPESAFE_API_KEY` (a MESMA
 *        exigência do produtor e do drain — quem povoa o `tsj` é a fila);
 *   B4 — portão de ECO: o julgamento em cache só decide com `m` igual ao ID
 *        versionado da config; cache velho/malformado/divergente falha
 *        FECHADO com contador fechado (`typesafe.overlay.model-mismatch`);
 *   B1 — `applied` conta TÍTULO distinto por fingerprint com dedupe
 *        TTL-aware (dentro do `judgmentTtlS` não há recontagem nem duplicata
 *        — o LRU teto 512 recontava título cujo julgamento podia seguir
 *        decisório no `tsj` — cota 500, TTL de semanas);
 *   B1b — o dedupe vence ALINHADO AO JULGAMENTO (`at + judgmentTtlS`, o mesmo
 *        vencimento da entrada no `tsj` — a fila grava `at: Date.now()`):
 *        dentro do TTL não reconta; cache expirado é miss honesto; novo
 *        julgamento com `at` novo após o vencimento é nova ocorrência
 *        (relógio avançado no teste e restaurado em `finally`);
 *   B5 — AUTORIDADE do cache (P1 da revisão final): NÃO há memo global de
 *        decisão — o memo anterior expirava pelo momento de consulta e
 *        sobrevivia à eviction da cota 500 do `tsj`, mascarando julgamento
 *        NOVO do mesmo fp (inclusive mudança do `noul`). Cada chamada faz
 *        `lookup` síncrono: eviction antes do TTL vira miss (a decisão
 *        aplicada NÃO age como decisão) e reescrita do fp vale na hora, nos
 *        dois sentidos (drop->não-drop e não-drop->drop);
 *   M2 — writers que PERSISTEM classificação de áudio gravam com
 *        `{overlay:false}`: `recordFileEvidence` (idx) e `noteAudit`
 *        (catálogo) — o cache vivo não reescreve prova gravada;
 *   M3 — a trava de `isBr` persistido é no PONTO DE GRAVAÇÃO (idx e captura
 *        do banco), NÃO no produtor `mapResults`: pinar o produtor faria o
 *        `toStremioStream` herdar `isBr=true` e desfaria o efeito do overlay
 *        na vaga BR ao vivo;
 *   B3 — o bloco `typesafe.overlay` expõe `active`/`blockedReason` (união
 *        fechada): flag ligada com portão fechado é BLOQUEADO, não
 *        "GATEADO ON".
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { audioFromTitle } from '../src/utils/audio-quality.js';
import { overlayDropsDub, resetTypesafeForTests, aiControl, aiStatus } from '../src/ai/index.js';
import { fingerprint, store, judgmentKey } from '../src/ai/audio-judgment-cache.js';
import { mapResults } from '../src/providers/jackett-results.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { recordFileEvidence } from '../src/debrid/audio-audit.js';
import { inputFromItem } from '../src/utils/magnet-bank-merge.js';
import type { RawItem } from '../types/domain.js';

const SAVED = { ...config.typesafe };
// Modelo VERSIONADO: o portão de modelo recusa alias móvel.
const MODEL = 'jev-9.9.9';

const counter = (name: string) => Number(metrics.snapshot().counters[name] || 0);

function cfgOn(over: Record<string, unknown> = {}) {
  // `apiKey: 'k-test'` deixa o runtime hermético (CI não tem .env); o teste
  // do portão de chave o fecha explicitamente com `cfgOn({ apiKey: '' })`.
  Object.assign(config.typesafe, { overlayEnabled: true, enabled: true, apiKey: 'k-test', model: MODEL, ...over });
}

beforeEach(() => {
  resetTypesafeForTests();
  aiControl.resume();
  cache.clearNamespace('tsj');
  metrics.reset();
  Object.assign(config.typesafe, SAVED); // baseline = default do .env (overlay OFF)
});

after(() => {
  Object.assign(config.typesafe, SAVED);
  resetTypesafeForTests();
});

test('M1 — portão de chave: runtime ON + cache negativo + apiKey vazia não decide', () => {
  // A decisão é cache-only, mas quem POVOA o cache é a fila — que exige
  // enabled+apiKey. Overlay consultando sem chave era incoerente: produtor,
  // drain e doc já exigiam a chave. Falha fechado ANTES de fingerprint/cache.
  const titulo = 'Filme SemChave 2024 [DUB] 1080p';
  store(fingerprint(titulo, MODEL), { n: 0.01, m: MODEL, at: 1 }, 600);
  cfgOn({ apiKey: '' });
  assert.equal(overlayDropsDub(titulo), false, 'sem chave o overlay não decide');
  assert.equal(counter('typesafe.overlay.consulted'), 0, 'sem chave não consulta');
  assert.equal(counter('typesafe.overlay.applied'), 0);
  // Com a chave, o MESMO estado decide — prova que o fechamento é o portão.
  cfgOn({ apiKey: 'k-test' });
  assert.equal(overlayDropsDub(titulo), true);
  assert.equal(counter('typesafe.overlay.consulted'), 1);
});

test('B4 — portão de eco: julgamento com model divergente ou ausente falha FECHADO', () => {
  cfgOn();
  const titulo = 'Filme Eco 2024 [DUB] 1080p';
  const fp = fingerprint(titulo, MODEL);
  // Eco divergente: cache de outro modelo não vira influência.
  store(fp, { n: 0.01, m: 'jev-8.8.8', at: 1 }, 600);
  assert.equal(overlayDropsDub(titulo), false, 'eco divergente não decide');
  assert.ok(counter('typesafe.overlay.model-mismatch') >= 1, 'divergência é contador fechado');
  assert.equal(counter('typesafe.overlay.applied'), 0);
  // Cache velho/malformado sem eco: mesmo fechamento (o client grava o
  // fallback cfg.model quando o serviço não ecoa — vazio é legado antigo).
  store(fp, { n: 0.01, m: '', at: 1 }, 600);
  assert.equal(overlayDropsDub(titulo), false, 'sem eco não decide');
  // Eco igual ao ID versionado da config decide.
  store(fp, { n: 0.01, m: MODEL, at: 1 }, 600);
  assert.equal(overlayDropsDub(titulo), true, 'eco conferindo decide');
  assert.equal(counter('typesafe.overlay.applied'), 1);
});

test('B1 — applied: dedupe sem evicção; >512 títulos não recontam na reconsulta', () => {
  cfgOn();
  const TOTAL = 520; // acima do antigo teto LRU 512 do dedupe
  const titulos = Array.from({ length: TOTAL }, (_, i) => `Filme Dedupe ${i} 2024 [DUB] 1080p`);
  // Consulta logo após semear cada título: a cota do tsj (500) evicta os
  // primeiros do cache, mas cada um foi APLICADO no próprio momento — o dedupe
  // por processo guarda todos os fps. `at: Date.now()` é a âncora do dedupe
  // (vencimento = at + judgmentTtlS, o mesmo do cache; `at: 1` nasceria já
  // vencido e recontaria).
  for (const t of titulos) {
    store(fingerprint(t, MODEL), { n: 0.02, m: MODEL, at: Date.now() }, 600);
    assert.equal(overlayDropsDub(t), true);
  }
  assert.equal(counter('typesafe.overlay.applied'), TOTAL, 'cada título distinto contou exatamente uma vez');
  // Re-julga e reconsulta a cabeça (a faixa que o LRU antigo teria evictado):
  // com cache vivo de novo, o drop volta — mas o contador não pode inflar.
  for (const t of titulos.slice(0, 32)) store(fingerprint(t, MODEL), { n: 0.02, m: MODEL, at: Date.now() }, 600);
  for (const t of titulos.slice(0, 32)) {
    assert.equal(overlayDropsDub(t), true, `reconsulta com cache vivo decide de novo: ${t}`);
  }
  assert.equal(counter('typesafe.overlay.applied'), TOTAL, 'reconsulta NÃO re-incrementa (dedupe sem evicção)');
});

test('B1b — applied com TTL alinhado ao julgamento: dentro do judgmentTtlS não reconta; novo `at` após vencimento é nova ocorrência', () => {
  cfgOn({ judgmentTtlS: 60 });
  const titulo = 'Filme TTL Applied 2024 [DUB] 1080p';
  const fp = fingerprint(titulo, MODEL);
  const agora = Date.now();
  const realDateNow = Date.now;
  try {
    Date.now = () => agora;
    // `at: agora` (como a fila grava) + TTL do cache = TTL do julgamento: o
    // dedupe vence em `agora + 60s`, EXATAMENTE quando a entrada do `tsj`.
    store(fp, { n: 0.02, m: MODEL, at: agora }, 60);
    assert.equal(overlayDropsDub(titulo), true);
    // Repetição ANTES do TTL: dedupe vivo — zero recontagem.
    for (let i = 0; i < 3; i += 1) assert.equal(overlayDropsDub(titulo), true);
    assert.equal(counter('typesafe.overlay.applied'), 1, 'dentro do TTL não há recontagem');
    // Avança além do judgmentTtlS: o cache expirou (mesmo vencimento) — a
    // decisão expirada não é aplicada; a leitura vira miss honesto.
    Date.now = () => agora + 61_000;
    assert.equal(overlayDropsDub(titulo), false, 'sem cache vivo: miss, nunca decisão velha');
    assert.ok(counter('typesafe.overlay.cache-miss') >= 1, 'expiração vira cache-miss, não falso drop');
    // Novo julgamento válido com `at` NOVO (novo período de cache) decide e
    // conta de novo — é o contrato: novo `at` após o vencimento é nova
    // ocorrência.
    store(fp, { n: 0.02, m: MODEL, at: agora + 61_000 }, 60);
    assert.equal(overlayDropsDub(titulo), true, 'novo julgamento decide de novo');
    assert.equal(counter('typesafe.overlay.applied'), 2, 'após o vencimento a ocorrência nova conta');
  } finally {
    Date.now = realDateNow;
  }
});

test('B5 — o cache tsj é a AUTORIDADE (sem memo): eviction antes do TTL vira miss e reescrita do fp vale na hora', () => {
  cfgOn({ judgmentTtlS: 3600 });
  const titulo = 'Filme Autoridade 2024 [DUB] 1080p';
  const chave = judgmentKey(titulo, MODEL);
  const agora = Date.now();
  const realDateNow = Date.now;
  try {
    Date.now = () => agora;
    // Cache com TTL LONGO (o julgamento ainda bem vivo no `tsj`)...
    store(fingerprint(titulo, MODEL), { n: 0.02, m: MODEL, at: agora }, 3600);
    assert.equal(overlayDropsDub(titulo), true, 'primeira consulta aplica o drop via cache');
    assert.equal(counter('typesafe.overlay.applied'), 1);
    // ...e a COTA (500) evicta a entrada ANTES do TTL: sem memo global, a
    // próxima leitura é miss honesto — a decisão aplicada NÃO age como
    // decisão (não mascara a eviction).
    cache.forget(chave);
    const consultado = counter('typesafe.overlay.consulted');
    assert.equal(overlayDropsDub(titulo), false, 'evicted antes do TTL: miss, nunca decisão congelada');
    assert.equal(counter('typesafe.overlay.consulted'), consultado + 1, 'a chamada passou pelo lookup');
    assert.ok(counter('typesafe.overlay.cache-miss') >= 1, 'eviction é visível como cache-miss');
    // REESCRITA do MESMO fp com noul ALTO (julgamento novo, `at` novo): a
    // mudança vale IMEDIATAMENTE — não fica presa a decisão antiga.
    store(fingerprint(titulo, MODEL), { n: 0.9, m: MODEL, at: agora }, 3600);
    assert.equal(overlayDropsDub(titulo), false, 'noul alto do julgamento novo respeitado na hora');
    // E a direção oposta também: reescrita para negativa confiante derruba
    // de novo (nunca houve memo que congelasse nenhum dos dois lados).
    store(fingerprint(titulo, MODEL), { n: 0.01, m: MODEL, at: agora }, 3600);
    assert.equal(overlayDropsDub(titulo), true, 'reescrita para negativa confiante derruba na hora');
    // Dentro do TTL do MESMO julgamento (`at` constante) o dedupe não reconta.
    assert.equal(counter('typesafe.overlay.applied'), 1, 'dedupe segura o contador enquanto o mesmo `at` vive');
  } finally {
    Date.now = realDateNow;
  }
});

test('M2 — writer persistido: recordFileEvidence grava o áudio com {overlay:false}', () => {
  if (!releaseIndex.status().enabled) return;
  cfgOn();
  const titulo = 'Movie Name 2023 [DUB] 1080p';
  store(fingerprint(titulo, MODEL), { n: 0.05, m: MODEL, at: 1 }, 600);
  // Precondição: na LISTAGEM o overlay derruba o rótulo deste título...
  assert.equal(audioFromTitle(titulo), '', 'overlay vivo derruba o rótulo');
  // ...mas a evidência de ARQUIVO persistida no idx nasce legado.
  const hash = 'ad'.repeat(20);
  recordFileEvidence(hash, [{ path: `pasta/${titulo}.mkv`, size: 2 * 1024 ** 3 }]);
  const ev = releaseIndex.fileEvidence(hash);
  assert.ok(ev, 'evidência gravada');
  assert.equal(ev!.a, 'Dublado', 'FileEvidence.a não segue o cache vivo (legado = Dublado)');
  // Desligar o overlay não muda o que foi gravado — o valor era o legado.
  config.typesafe.overlayEnabled = false;
  assert.equal(audioFromTitle(titulo), 'Dublado');
});

test('M3 — produtor Jackett: listagem derruba ao vivo, mas idx e banco persistem determinístico', () => {
  if (!releaseIndex.status().enabled) return;
  cfgOn();
  const titulo = 'Movie Name 2023 [DUB] 1080p';
  store(fingerprint(titulo, MODEL), { n: 0.05, m: MODEL, at: 1 }, 600);
  // LISTAGEM: o item cru do indexer global segue o overlay (vaga BR não é
  // concedida ao vivo) — pinar o produtor estragaria este comportamento.
  const [raw] = mapResults({ Results: [{ Title: titulo, InfoHash: 'bb'.repeat(20), Seeders: 3 }] });
  assert.equal(raw.isBr, false, 'listagem runtime segue o overlay');
  // IDX: o que o release-index PERSISTE é reclassificado com {overlay:false}.
  const imdb = 'tt9933551';
  releaseIndex.record(imdb, {}, [raw as RawItem]);
  const [rel] = releaseIndex.lookup(imdb);
  assert.ok(rel, 'release registrada no idx');
  assert.equal(rel!.isBr, true, 'isBr persistido no idx é o legado ({overlay:false})');
  // BANCO: a captura grava is_br permanente com a mesma trava.
  const input = inputFromItem(raw as RawItem, 'thepiratebay');
  assert.ok(input, 'item com hash gera captura');
  assert.equal(input!.magnet.isBr, true, 'is_br do banco é {overlay:false}');
  // Com overlay OFF, o produtor já nasce legado — nada muda no caminho antigo.
  config.typesafe.overlayEnabled = false;
  const [rawOff] = mapResults({ Results: [{ Title: titulo, InfoHash: 'cc'.repeat(20), Seeders: 3 }] });
  assert.equal(rawOff.isBr, true);
});

test('B3 — status do overlay: active/blockedReason refletem os portões (enum fechado)', () => {
  const titulo = 'Filme Status 2024 [DUB] 1080p';
  store(fingerprint(titulo, MODEL), { n: 0.01, m: MODEL, at: 1 }, 600);
  // Flag OFF (baseline do arquivo de teste): motivo é o kill-switch.
  const off = aiStatus().overlay;
  assert.equal(off.enabled, false);
  assert.equal(off.active, false);
  assert.equal(off.blockedReason, 'overlay-off');
  // Portões todos abertos: ativa, sem motivo.
  cfgOn({ apiKey: 'k-test' });
  const st = aiStatus().overlay;
  assert.equal(st.active, true, 'portões abertos => active');
  assert.equal(st.blockedReason, '');
  // Cada portão fechado tem motivo PRÓPRIO (união fechada, sem credencial).
  cfgOn({ enabled: false });
  assert.equal(aiStatus().overlay.blockedReason, 'runtime-off');
  cfgOn({ apiKey: '' });
  assert.equal(aiStatus().overlay.blockedReason, 'no-key');
  cfgOn({ apiKey: 'k-test' });
  aiControl.pause();
  assert.equal(aiStatus().overlay.blockedReason, 'paused');
  aiControl.resume();
  cfgOn({ model: 'jev-latest' });
  assert.equal(aiStatus().overlay.blockedReason, 'model-alias');
  assert.equal(aiStatus().overlay.active, false);
});
