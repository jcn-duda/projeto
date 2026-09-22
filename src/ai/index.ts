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
 * volta na próxima busca) e calcula o veredito determinístico do MOMENTO — a
 * mesma fórmula do `_br` em `toStremioStream` — para a comparação shadow.
 *
 * Fire-and-forget: nunca lança, nunca é awaited, não toca objeto algum.
 */
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import { looksPtBr } from '../utils/audio-quality.js';
import type { RawItem } from '../../types/domain.js';
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
    const det = Boolean(item.isBr || item.ptTitleDual) || looksPtBr(title);
    try {
      enqueueAudioJudgment(title, det);
    } catch {
      // Fail-open: a fila não tem porque lançar, mas se lançar a busca segue.
    }
  }
  if (capped) metrics.count('typesafe.shadow.build-capped', capped);
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

// Memo curto SOMENTE de decisão vinda de HIT (chave = fingerprint, que já
// isola título normalizado + model + promptVersion). MISS nunca é memoizado:
// a escrita posterior do shadow tem que ser vista na próxima chamada — congelar
// miss transformaria o overlay num snapshot. Teto fixo; estourou, o mais antigo
// sai (Map mantém ordem de inserção).
const OVERLAY_MEMO_MAX = 512;
const overlayMemo = new Map<string, boolean>();

/**
 * Leitura CACHE-ONLY e SÍNCRONA do julgamento da pergunta 1: `true` significa
 * "derrube a prova genérica de DUB deste título". NUNCA faz fetch, enqueue,
 * escrita ou espera — quem popula o cache é o runtime shadow (fila assíncrona).
 * Com `TYPESAFE_OVERLAY_ENABLED` OFF devolve `false` ANTES de fingerprint e
 * cache: zero leitura quando desligado (inércia total, igual ao legado).
 */
function overlayDropsDub(title: string): boolean {
  const cfg = config.typesafe;
  // Flag OFF decide antes de qualquer trabalho — sem fingerprint, sem leitura,
  // sem métrica: o caminho é byte-a-byte o legado.
  if (!cfg.overlayEnabled) return false;
  metrics.count('typesafe.overlay.consulted');
  let fp: string;
  try {
    fp = fingerprint(String(title || ''), cfg.model, PROMPT_VERSION);
  } catch {
    return false;
  }
  const memo = overlayMemo.get(fp);
  if (memo !== undefined) {
    if (memo) metrics.count('typesafe.overlay.applied');
    return memo;
  }
  const judgment = lookup(fp);
  if (!judgment) {
    // MISS não memoiza (a escrita do shadow pode chegar a qualquer momento) e
    // NUNCA derruba: ausência de evidência preserva o `true` do legado.
    metrics.count('typesafe.overlay.cache-miss');
    return false;
  }
  const drop = judgment.n <= OVERLAY_NOUL_DROP_MAX;
  if (overlayMemo.size >= OVERLAY_MEMO_MAX) {
    const maisAntigo = overlayMemo.keys().next().value;
    if (maisAntigo !== undefined) overlayMemo.delete(maisAntigo);
  }
  overlayMemo.set(fp, drop);
  if (drop) {
    metrics.count('typesafe.overlay.applied');
    return true;
  }
  return false;
}

/** Estado do overlay para o painel (bloco `typesafe.overlay`). */
function overlayStatus() {
  const counters = metrics.snapshot().counters;
  const num = (name: string) => Number((counters as Record<string, unknown>)[name]) || 0;
  return {
    enabled: Boolean(config.typesafe.overlayEnabled),
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
 * memo do overlay — o cache `tsj` persiste (limpeza é responsabilidade de
 * quem o escreveu, `cache.clearNamespace('tsj')`). */
function resetForTests() {
  resetAudioForTests();
  resetDubLieForTests();
  overlayMemo.clear();
}

/** Só para teste: espera AS DUAS filas esvaziarem (teto de ticks cada). */
async function flushForTests(): Promise<void> {
  await Promise.all([flushAudioForTests(), flushDubLieForTests()]);
}

export {
  shadowAudioJudgments,
  aiStatus,
  aiControl,
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
