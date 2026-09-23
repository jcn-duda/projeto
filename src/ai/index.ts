/**
 * Fachada ÚNICA do runtime TypeSafe shadow — o resto do `src/` importa só
 * ESTE arquivo (o teste de grafo, test/typesafe-shadow-graph.test.ts, reprova
 * qualquer outro import de `src/ai/` no caminho de resposta, e reprova por
 * completo `src/ai/` nos módulos de decisão: matching, limpeza, índice,
 * banco, autofetch).
 *
 * `shadowAudioJudgments` é o PRODUTOR do runtime geral: chamado depois do
 * filtro determinístico de título, deduplica por título, respeita um teto por
 * build (custo controlado; excedente vira métrica `build-capped` e o título
 * volta na próxima busca) e calcula o veredito determinístico do MOMENTO para
 * a comparação shadow — com a régua TRAVADA em `{overlay:false}`. Deliberado:
 * o `_br` corrente da listagem PODE incluir o overlay quando ligado, e o
 * baseline shadow não pode medir a IA contra a influência dela mesma.
 *
 * Fire-and-forget: nunca lança, nunca é awaited, não toca objeto algum.
 */
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import { looksPtBr } from '../utils/audio-quality.js';
import type { RawItem } from '../../types/domain.js';
import { isVersionedModel } from '../config/typesafe.js';
import {
  enqueueAudioJudgment,
  statusSnapshot,
  resetForTests as resetAudioForTests,
  flushForTests as flushAudioForTests,
  audioJudgmentCore,
} from './audio-judgment-queue.js';
import {
  enqueueDubLieJudgment,
  dubLieStatusSnapshot,
  resetDubLieForTests,
  flushDubLieForTests,
  dubLieCore,
} from './dub-lie-judgment-queue.js';
import { fingerprint, lookup } from './audio-judgment-cache.js';
import { PROMPT_VERSION } from './questions-audio.js';

// Teto de títulos NOVOS por build. É a trava contra custo descontrolado de um
// hook "geral": a fila (queueMax) e os orçamentos hora/dia limitam o TOTAL, e
// este teto limita o ESTOURO de uma única busca grande. Excedente não perde
// nada: reaparece na próxima busca (cache `tsj` evita re-chamada dos já vistos).
const SHADOW_PER_BUILD_MAX = 12;

function shadowAudioJudgments(items: RawItem[]): void {
  const cfg = config.typesafe;
  // Inativo: uma contagem por build e nada mais — sem varrer itens, sem
  // fingerprint, sem ler/escrever cache. Custo de runtime ~zero.
  if (!cfg.enabled || !cfg.apiKey) {
    metrics.count('typesafe.shadow.inactive-build');
    return;
  }
  const vistos = new Set<string>();
  let capped = 0;
  for (const item of items || []) {
    // `fromFallback` fica de fora pela mesma higiene do resto do pipeline: a
    // reserva não realimenta nada — aqui, nem a medição shadow.
    if (!item || item.fromFallback) continue;
    const title = String(item.title || item.Title || '').trim();
    if (!title) continue;
    const norm = title.toLowerCase();
    if (vistos.has(norm)) continue;
    if (vistos.size >= SHADOW_PER_BUILD_MAX) {
      capped += 1;
      continue;
    }
    vistos.add(norm);
    const det = deterministicLooksPtBr(item, title);
    try {
      // Origem NÃO é áudio: `origin-br` é o flag declarado do provider/índice
      // (`item.isBr`), a mesma evidência que reserva vaga BR — é ela que
      // permite ler a divergência shadow por origem. Sem o flag,
      // `origin-global` (lado fechado para "não sei a origem").
      enqueueAudioJudgment(title, det, item.isBr ? 'origin-br' : 'origin-global');
    } catch {
      // Fail-open: a fila não tem porque lançar, mas se lançar a busca segue.
    }
  }
  if (capped) metrics.count('typesafe.shadow.build-capped', capped);
}

/**
 * Baseline determinística da comparação shadow — SÓ a leitura de ÁUDIO do
 * título, travada em `{overlay:false}`. NÃO é "a mesma fórmula do `_br`
 * corrente": com o overlay ligado, o `_br` da listagem pode derrubar o generic
 * DUB e divergir daqui DE PROPÓSITO — o baseline é a versão determinística,
 * para o overlay não alterar a régua contra a qual ele próprio é medido (com o
 * cache vivo ligado, o generic DUB podia ser derrubado na listagem e o
 * produtor passaria a comparar a IA contra a própria influência dela).
 *
 * A FÓRMULA LÊ SÓ ÁUDIO, de propósito — o `isBr`/`ptTitleDual` do `_br` NÃO
 * entra:
 *  - origem não é áudio. O `_br` corrente mistura os dois eixos (flag de origem
 *    do provider + prova de áudio); medi-los juntos faria a IA ser comparada
 *    contra um proxy de ORIGEM, não contra a leitura de idioma que a pergunta
 *    `is_ptbr_dub` de fato responde. O eixo de origem vira a dimensão separada
 *    (`origin-br`/`origin-global` no enqueue) — medido ao lado, não fundido.
 *  - `ptTitleDual` AINDA NÃO EXISTE neste ponto: a extensão contextual é
 *    aplicada no stream-builder (`applyPtTitleDual`), DEPOIS do produtor
 *    shadow; lê-lo aqui sempre daria `undefined` e sugeriria uma cobertura que
 *    não há.
 * Extraída como função pura para o teste provar a imunidade com cache negativo
 * semeado.
 */
function deterministicLooksPtBr(item: RawItem, title = ''): boolean {
  const t = String(title || item.title || item.Title || '').trim();
  return looksPtBr(t, { overlay: false });
}

// --- Overlay GATEADO (ETAPA C) -------------------------------------------------
// O Jev influencia SOMENTE o termo fraco `genericDubProvesPt` dentro de
// `explicitPtAudio` (src/utils/audio-quality.ts): marcador PT forte continua
// true sem IA; sem generic DUB continua false; no generic DUB ISOLADO, um
// julgamento NEGATIVO CONFIANTE em cache (`is_ptbr_dub`, noul <= 0.15) derruba
// `true`->`false`. Ausência de cache preserva true — a IA nunca PROMOVE nada,
// só retira uma promessa genérica fraca. Monotônico por construção.

/** Noul <= 0.15 é NEGATIVA CONFIANTE (pergunta 1, `is_ptbr_dub`). Piso alto
 * demais arriscaria FP de condenação (derrubar dublado de verdade); o limiar
 * é deliberadamente estreito — o overlay é o uso mais conservador possível do
 * pior lado do modelo (os 4 FN medidos estavam no lado positivo). */
const OVERLAY_NOUL_DROP_MAX = 0.15;

// SEM memo global de decisão (P1 da revisão final): o memo anterior expirava
// pelo MOMENTO DE CONSULTA (`R + judgmentTtlS`) enquanto o cache `tsj` expira
// pelo momento de GRAVAÇÃO (`S + judgmentTtlS`) — como R >= S, a decisão
// sobrevivia R-S além do julgamento; pior, a cota do `tsj` (20.000) pode EVICTAR
// a entrada antes do TTL, e o memo que sobrevive à eviction vira AUTORIDADE,
// mascarando julgamento NOVO do mesmo fingerprint (inclusive mudança do
// `noul` na reescrita). A autoridade é sempre `lookup(fp)` — O(1) e síncrono,
// o mesmo custo do memo: cache miss preserva `true`, e eviction/reescrita são
// vistas IMEDIATAMENTE. Memo POR BUILD não há lifecycle disponível (a leitura
// não sabe onde a build começa/termina); `consulted` conta o lookup real.

// `applied` conta TÍTULO DISTINTO, não chamada: o mesmo `explicitPtAudio`
// re-consultado no build não pode inflar o contador do painel. Dedupe por
// fingerprint (hash de título normalizado + model + promptVersion) com o
// vencimento ALINHADO AO JULGAMENTO: `at + judgmentTtlS` é EXATAMENTE o
// vencimento da entrada no cache `tsj` (a fila grava `at: Date.now()`), então
// o dedupe nunca sobrevive ao julgamento que o originou — e um julgamento NOVO
// (novo `at`, ex.: reescrita após eviction da cota do `tsj`) depois do
// vencimento é nova ocorrência. Dentro do TTL, re-consultas do mesmo fp NÃO
// recontam. (O antecessor LRU teto 512 era o bug: recontava título cujo julgamento
// ainda podia estar decisório no `tsj` — evictado ANTES do TTL e re-aplicado,
// o contador inflava sem título novo.) Prune a partir do FRENTE do Map antes
// de contar fp novo: com o vencimento derivado de `at`, a ordem de expiração
// pode divergir da de inserção, então o break na primeira viva é só atalho —
// a correção do dedupe (não recontar enquanto o MESMO julgamento vive) vem do
// get abaixo, não do prune. Bound operacional: só entra fp que DERRUBOU de
// fato (subconjunto dos julgamentos do shadow, limitados pelos orçamentos
// TYPESAFE_HOURLY_CAP/TYPESAFE_DAILY_CAP — 10.000/dia no default compartilhado),
// e o acervo vivo é ≈ cap diário × TTL (10.000 × 14 d ≈ 140 mil ocorrências;
// a cota `tsj` limita quantos julgamentos seguem disponíveis para decidir)
// — depende de CAP × TTL, NUNCA do uptime, e zera no restart (deploy).
// Nenhum título ou chave crua em Map/label/log (o fp já é digest).
const appliedSeen = new Map<string, number>();
function countAppliedOnce(fp: string, julgadoEm: number): void {
  const agora = Date.now();
  // Prune das expiradas (prefixo do Map): barato e mantém o teto implícito.
  for (const [antigo, expira] of appliedSeen) {
    if (expira > agora) break;
    appliedSeen.delete(antigo);
  }
  const existente = appliedSeen.get(fp);
  if (existente !== undefined && existente > agora) return;
  // Vencimento pelo julgamento, não pela consulta — mesma âncora do `tsj`.
  appliedSeen.set(fp, Math.max(julgadoEm, 0) + config.typesafe.judgmentTtlS * 1000);
  metrics.count('typesafe.overlay.applied');
}

/**
 * Leitura CACHE-ONLY e SÍNCRONA do julgamento da pergunta 1: `true` significa
 * "derrube a prova genérica de DUB deste título". NUNCA faz fetch, enqueue,
 * escrita ou espera — quem popula o cache é o runtime shadow (fila assíncrona).
 * Portões independentes devolvem `false` ANTES de fingerprint e cache (zero
 * trabalho, zero métrica de consulta): kill-switch do overlay, runtime shadow
 * desligado, chave ausente (mesma exigência do produtor/drain — sem chave não
 * há fila a povoar o cache), Jev pausado global (o `jev-pause` do painel
 * desliga a DECISÃO, não só o drain; resume restaura) e modelo não versionado
 * — alias móvel (`jev-latest`/`jev-preview`) falha FECHADO mesmo com config
 * explícita. No CACHE, o eco do modelo também é portão (fail closed): só
 * decide julgamento cujo `m` é exatamente o ID versionado da config — cache
 * velho, malformado ou de outro modelo não vira influência.
 */
function overlayDropsDub(title: string): boolean {
  const cfg = config.typesafe;
  if (!cfg.overlayEnabled || !cfg.enabled || !cfg.apiKey || aiControl.isPaused()) return false;
  // Sem ID versionado (`jev-x.y.z`) não há decisão: julgamento de alias móvel
  // não vira influência sobre a listagem. Contador fechado (sem título).
  if (!isVersionedModel(cfg.model)) {
    metrics.count('typesafe.overlay.model-blocked');
    return false;
  }
  metrics.count('typesafe.overlay.consulted');
  let fp: string;
  try {
    fp = fingerprint(String(title || ''), cfg.model, PROMPT_VERSION);
  } catch {
    return false;
  }
  // O lookup É a decisão: sem memo global (P1 da revisão — ver nota acima), o
  // cache `tsj` é a autoridade em TODA chamada. Eviction da cota antes do
  // TTL e reescrita do julgamento (novo `at`/`noul`) são vistos na hora; miss
  // NUNCA derruba: ausência de evidência preserva o `true` do legado.
  const judgment = lookup(fp);
  if (!judgment) {
    metrics.count('typesafe.overlay.cache-miss');
    return false;
  }
  // Eco do modelo é portão do VALOR, não só da chave: o fingerprint já isola
  // model, mas cache escrito por código antigo (sem eco) ou por eco divergente
  // não prova que AQUELE modelo disse isso — falha fechado, e a leitura rever
  // o eco a cada chamada (cache reescrito pelo client é visto na hora;
  // divergência congelada em memo viraria decisão errada).
  if (judgment.m !== cfg.model) {
    metrics.count('typesafe.overlay.model-mismatch');
    return false;
  }
  const drop = judgment.n <= OVERLAY_NOUL_DROP_MAX;
  if (drop) countAppliedOnce(fp, judgment.at);
  return drop;
}

/**
 * Motivo FECHADO de bloqueio do overlay (união fixa — nunca texto de config,
 * título ou credencial). `''` = portões todos abertos (`active`).
 */
type OverlayBlockedReason = '' | 'overlay-off' | 'runtime-off' | 'no-key' | 'paused' | 'model-alias';

function overlayBlockedReason(): OverlayBlockedReason {
  const cfg = config.typesafe;
  if (!cfg.overlayEnabled) return 'overlay-off';
  if (!cfg.enabled) return 'runtime-off';
  if (!cfg.apiKey) return 'no-key';
  if (aiControl.isPaused()) return 'paused';
  if (!isVersionedModel(cfg.model)) return 'model-alias';
  return '';
}

/** Estado do overlay para o painel (bloco `typesafe.overlay`). */
function overlayStatus() {
  const counters = metrics.snapshot().counters;
  const num = (name: string) => Number((counters as Record<string, unknown>)[name]) || 0;
  const blockedReason = overlayBlockedReason();
  return {
    enabled: Boolean(config.typesafe.overlayEnabled),
    // `active` é a verdade operacional: flag ligada NÃO basta — runtime off,
    // pausa, chave ausente ou modelo alias deixam o overlay gateado mas
    // bloqueado (o painel mostra o motivo em vez de "GATEADO ON" mentiroso).
    active: blockedReason === '',
    blockedReason,
    consulted: num('typesafe.overlay.consulted'),
    cacheMiss: num('typesafe.overlay.cache-miss'),
    applied: num('typesafe.overlay.applied'),
  };
}

/**
 * Resumo compacto para o painel (bloco `typesafe` do /dashboard-status.json).
 * Agrega as DUAS perguntas shadow: `audioClassify` (pergunta 1, histórica) e
 * `dubLie` (pergunta 2) — cada um com a própria fila, orçamento e métricas.
 * `enabled`/`model` sobem no topo por conveniência (a config é compartilhada,
 * então o valor é o mesmo nas duas).
 */
function aiStatus() {
  const audio = statusSnapshot();
  return {
    enabled: audio.enabled,
    model: audio.model,
    audioClassify: audio,
    dubLie: dubLieStatusSnapshot(),
    // Overlay GATEADO (ETAPA C): contadores de leitura do cache pela busca.
    overlay: overlayStatus(),
  };
}

/**
 * Últimas discordâncias das DUAS perguntas (anel em memória, teto 50 por
 * pergunta). NÃO entra no `aiStatus`/poll do painel de propósito: o `sample`
 * carrega o título, que só pode sair na resposta autenticada da ação
 * `jev-disagreements` — o polling público nunca o vê. As métricas continuam
 * com labels FECHADOS. `at` mais recente por ÚLTIMO em cada lista.
 */
function jevDisagreements() {
  return {
    audioClassify: audioJudgmentCore.disagreements(),
    dubLie: dubLieCore.disagreements(),
  };
}

/**
 * Controle de OPERADOR sobre as DUAS filas — a pausa é global (ambas as
 * cores), porque o knob existe para cortar custo/instabilidade do serviço de
 * uma vez. `pause` é EFÊMERO (memória): a fila sobrevive para o `drainNow()`
 * pós-`resume` processar o que já estava enfileirado. `status()` expõe o
 * estado por pergunta (uma pausa feita direto num core aparece ali).
 */
const aiControl = {
  pause() {
    audioJudgmentCore.pause();
    dubLieCore.pause();
  },
  resume() {
    audioJudgmentCore.resume();
    dubLieCore.resume();
  },
  /** Leitura booleana da pausa GLOBAL: só é `true` com as duas pausadas. */
  isPaused(): boolean {
    return audioJudgmentCore.isPaused() && dubLieCore.isPaused();
  },
  drainNow() {
    audioJudgmentCore.drainNow();
    dubLieCore.drainNow();
  },
  resetCooldown() {
    audioJudgmentCore.resetCooldown();
    dubLieCore.resetCooldown();
  },
  status() {
    return { audioClassify: audioJudgmentCore.isPaused(), dubLie: dubLieCore.isPaused() };
  },
};

/** Só para teste: zera o estado das DUAS filas (fila, janelas, breaker) e o
 * dedupe de `applied` — não há memo de overlay para limpar (a decisão é sempre
 * `lookup`); o cache `tsj` persiste (limpeza é responsabilidade de quem o
 * escreveu, `cache.clearNamespace('tsj')`). */
function resetForTests() {
  resetAudioForTests();
  resetDubLieForTests();
  appliedSeen.clear();
}

/** Só para teste: espera AS DUAS filas esvaziarem (teto de ticks cada). */
async function flushForTests(): Promise<void> {
  await Promise.all([flushAudioForTests(), flushDubLieForTests()]);
}

export {
  shadowAudioJudgments,
  // Baseline determinística do produtor shadow ({overlay:false} travado),
  // exposta para o teste provar que o overlay ligado + cache negativo não
  // alteram a régua contra a qual a IA é medida. NÃO é o `_br` corrente da
  // listagem (que pode incluir o overlay quando ligado) — é a versão
  // determinística dele, de propósito.
  deterministicLooksPtBr,
  aiStatus,
  aiControl,
  // Anel em memória das últimas discordâncias (teto 50 por pergunta): só a
  // ação autenticada `jev-disagreements` o devolve — nunca o poll do painel,
  // porque o `sample` carrega título. O produtor shadow segue só-métrica.
  jevDisagreements,
  // Produtor da pergunta 2 (`is_dub_lie`): o único consumidor fora de src/ai/
  // é o tail audit do play (`src/debrid/audio-audit.ts`), que só pode importar
  // ESTA fachada (grafo travado por teste). Shadow: só métrica, nunca decisão.
  enqueueDubLieJudgment,
  // ETAPA C — overlay GATEADO: leitura cache-only que `audio-quality.ts` usa no
  // termo fraco de `explicitPtAudio`. ÚNICO caminho de influência da IA numa
  // decisão; cache-only (nunca fetch/escrita), monotônico (só derruba
  // true->false no generic DUB isolado). Grafo: audio-quality é o ÚNICO módulo
  // de decisão liberado a esta fachada (test/typesafe-shadow-graph.test.ts).
  overlayDropsDub,
  resetForTests as resetTypesafeForTests,
  flushForTests as flushTypesafeForTests,
};
