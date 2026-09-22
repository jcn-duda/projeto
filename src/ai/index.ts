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
  dubLieStatusSnapshot,
  resetDubLieForTests,
  flushDubLieForTests,
  dubLieCore,
} from './dub-lie-judgment-queue.js';

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

/** Só para teste: zera o estado das DUAS filas (fila, janelas, breaker). */
function resetForTests() {
  resetAudioForTests();
  resetDubLieForTests();
}

/** Só para teste: espera AS DUAS filas esvaziarem (teto de ticks cada). */
async function flushForTests(): Promise<void> {
  await Promise.all([flushAudioForTests(), flushDubLieForTests()]);
}

export {
  shadowAudioJudgments,
  aiStatus,
  aiControl,
  resetForTests as resetTypesafeForTests,
  flushForTests as flushTypesafeForTests,
};
