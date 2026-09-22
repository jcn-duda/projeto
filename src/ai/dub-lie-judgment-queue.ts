/**
 * Fila do julgamento TypeSafe da PERGUNTA 2 (`is_dub_lie`) — wrapper fino.
 *
 * Toda a lógica (fila deduplicada, orçamento, breaker, drain e comparação
 * shadow) mora no motor genérico `judgment-queue-core.ts`; aqui fica só a
 * ligação da pergunta validada online (questions-dub-lie.ts, espelho EXATO do
 * probe dub-lie 38/38) com a instância própria. As métricas saem sob
 * `typesafe.dublie.*` / `typesafe.shadow.dublie.*` — NUNCA nas históricas
 * `typesafe.*` da pergunta 1 (instâncias e orçamentos separados de propósito:
 * a falha de uma não pune a outra e a concordância de uma não contamina a
 * outra).
 *
 * Contratos herdados do motor (idênticos aos da pergunta 1):
 * - `enqueueDubLieJudgment` é SÍNCRONO, nunca lança e NUNCA é awaited pela
 *   resposta; o drain roda em `setImmediate` e lê SÓ `config.typesafe` —
 *   nunca `opts()`;
 * - kill-switch OFF (sem enabled+chave) curto-circuita ANTES do fingerprint:
 *   zero fetch, zero leitura e zero escrita de cache;
 * - fingerprint = sha256(título NORMALIZADO | indexer | arquivos | model |
 *   promptVersion) — o julgamento depende do indexer e da lista de arquivos
 *   (a mesma promessa de título pode mentir para uma fonte e ser honesta para
 *   outra, e a evidência é o nome real do arquivo), então os três entram no
 *   material. O `questionId` NÃO entra: o `promptVersion` já isola pergunta.
 */
import { normalizeTitle } from '../utils/title-normalization.js';
import { PROMPT_VERSION, QUESTION_ID, QUESTIONS, buildState } from './questions-dub-lie.js';
import { createJudgmentCore, type JudgmentCore } from './judgment-queue-core.js';
import type { EnqueueResult } from './types.js';

/** Estado da pergunta 2: promessa (título+indexer) e evidência (arquivos). */
interface DubLieState {
  title: string;
  indexer: string;
  files: string[];
}

const core = createJudgmentCore<DubLieState>({
  question: {
    questionId: QUESTION_ID,
    promptVersion: PROMPT_VERSION,
    questions: QUESTIONS,
    // Allowlist da pergunta: título, indexer e arquivos atravessam — nada mais.
    buildState: (s) => buildState({ post: s.title, indexer: s.indexer, files: s.files }),
    // O material PRECISA incluir indexer e arquivos: o julgamento depende
    // deles. O mesmo post em indexers diferentes (e com arquivos diferentes)
    // são julgamentos distintos — a chave tem que separar.
    fingerprintMaterial: (s) =>
      [normalizeTitle(String(s.title || '')), String(s.indexer || ''), ...(s.files || []).map(String)].join('|'),
  },
  basePrefix: 'typesafe.dublie',
  shadowPrefix: 'typesafe.shadow.dublie',
  detLabels: { ai: 'ai-lie', rule: 'rule-lie' },
});

/**
 * Enfileira um caso dub-lie para julgamento shadow. `det` é o veredito
 * determinístico do momento (o `DubLieError`/`_lied` do pipeline capturado
 * pelo chamador) — a comparação produz SÓ métrica. Nunca lança.
 */
function enqueueDubLieJudgment(
  title: string,
  indexer: string,
  videoFiles: string[],
  det: boolean,
): EnqueueResult {
  return core.enqueue({
    state: {
      title: String(title || ''),
      indexer: String(indexer || ''),
      // Normaliza na fronteira: o spread de buildState exige array de verdade.
      files: Array.isArray(videoFiles) ? videoFiles.map(String) : [],
    },
    det: Boolean(det),
  });
}

/** Resumo compacto da instância da pergunta 2 (bloco `dubLie` do aiStatus). */
function dubLieStatusSnapshot() {
  return core.statusSnapshot();
}

/** Só para teste: zera todo o estado da instância (fila, janelas, breaker). */
function resetDubLieForTests() {
  core.resetForTests();
}

/** Só para teste: espera a fila esvaziar (teto de ticks para não pendurar). */
function flushDubLieForTests(): Promise<void> {
  return core.flushForTests();
}

export {
  enqueueDubLieJudgment,
  dubLieStatusSnapshot,
  resetDubLieForTests,
  flushDubLieForTests,
  // Controles de operador do motor (pause efêmero, cooldown, drain manual) —
  // a fachada agrega com os da pergunta 1 (aiControl).
  core as dubLieCore,
};
