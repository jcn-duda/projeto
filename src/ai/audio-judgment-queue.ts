/**
 * Fila do julgamento TypeSafe da PERGUNTA 1 (`is_ptbr_dub`) — wrapper fino.
 *
 * Toda a lógica (fila deduplicada, orçamento, breaker, drain e comparação
 * shadow) mora no motor genérico `judgment-queue-core.ts`; aqui fica só a
 * ligação da pergunta validada online (questions-audio.ts, espelho EXATO do
 * probe audio-classify) com o contrato histórico exportado —
 * `enqueueAudioJudgment`/`statusSnapshot`/`resetForTests`/`flushForTests`
 * mantêm nome e semântica (test/typesafe-queue.test.ts tranca isso), e as
 * métricas continuam exatamente `typesafe.*` / `typesafe.shadow.*`.
 *
 * Contratos que NÃO mudaram com a extração:
 * - `enqueueAudioJudgment` é SÍNCRONO, nunca lança e NUNCA é awaited pela
 *   resposta; o drain lê SÓ `config.typesafe` (knob de operador) — nunca
 *   `opts()`;
 * - fingerprint = sha256(título NORMALIZADO | model | promptVersion) — a
 *   normalização fica aqui, no material da pergunta;
 * - a comparação shadow (`looksPtBr`/`_br` vs noul) produz SÓ MÉTRICA e
 *   nenhum consumidor de decisão lê este módulo (tranca o teste de grafo).
 */
import { normalizeTitle } from '../utils/title-normalization.js';
import { PROMPT_VERSION, QUESTION_ID, QUESTIONS, buildState } from './questions-audio.js';
import { createJudgmentCore } from './judgment-queue-core.js';
import { sharedJudgmentBudget } from './judgment-shared-budget.js';
import type { EnqueueResult } from './types.js';

const core = createJudgmentCore<string>({
  question: {
    questionId: QUESTION_ID,
    promptVersion: PROMPT_VERSION,
    questions: QUESTIONS,
    // Allowlist da pergunta: só `post_title` atravessa a fronteira.
    buildState: (title: string) => buildState(title),
    // Mesma normalização do matching: caixa/acentos não mudam a chave.
    fingerprintMaterial: (title: string) => normalizeTitle(String(title || '')),
  },
  // Orçamento/breaker COMPARTILHADOS com a pergunta 2 (mesma chave/limite do
  // provedor): a falha de uma arma o cooldown das duas.
  budget: sharedJudgmentBudget,
  basePrefix: 'typesafe',
  shadowPrefix: 'typesafe.shadow',
  detLabels: { ai: 'ai-pt', rule: 'rule-pt' },
});

function enqueueAudioJudgment(title: string, det: boolean): EnqueueResult {
  return core.enqueue({ state: String(title || ''), det: Boolean(det) });
}

function statusSnapshot() {
  return core.statusSnapshot();
}

/** Só para teste: zera todo o estado do módulo (fila, janelas, breaker). */
function resetForTests() {
  core.resetForTests();
}

/** Só para teste: espera a fila esvaziar (teto de ticks para não pendurar). */
function flushForTests(): Promise<void> {
  return core.flushForTests();
}

export {
  enqueueAudioJudgment,
  statusSnapshot,
  resetForTests,
  flushForTests,
  // Controles de operador do motor (pause efêmero, cooldown, drain manual) —
  // reexportados pela fachada quando o painel passar a consumi-los.
  core as audioJudgmentCore,
};
