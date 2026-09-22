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
  resetForTests,
  flushForTests,
} from './audio-judgment-queue.js';

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

/** Resumo compacto para o painel (bloco `typesafe` do /dashboard-status.json). */
function aiStatus() {
  return statusSnapshot();
}

export {
  shadowAudioJudgments,
  aiStatus,
  resetForTests as resetTypesafeForTests,
  flushForTests as flushTypesafeForTests,
};
