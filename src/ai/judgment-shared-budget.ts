/**
 * Orçamento/breaker COMPARTILHADO das perguntas shadow do TypeSafe.
 *
 * O motor genérico (`judgment-queue-core.ts`) recebe a instância de orçamento
 * por `spec.budget`; esta é a instância ÚNICA do processo, usada pelas DUAS
 * perguntas (`is_ptbr_dub` e `is_dub_lie`). O motivo é o provedor: a mesma
 * chave, o mesmo limite e o mesmo 429/529 — a falha de uma pergunta diz
 * respeito à outra. Um rate/auth em QUALQUER pergunta arma o cooldown das
 * duas, e os contadores de hora/dia são um só.
 *
 * `createJudgmentBudget` reusado SEM mudança (`judgment-budget.ts`): a fábrica
 * é pura e o estado mora no closure. Métricas saem sob o prefixo `typesafe`
 * (`typesafe.budget.hour|day`, `typesafe.breaker.open`, `typesafe.auth.stop`)
 * — o prefixo histórico da pergunta 1; as métricas de fila/chamada/shadow
 * seguem separadas por pergunta (`typesafe.*` × `typesafe.dublie.*`).
 *
 * SEM persistência de contador: o teto protege o VOLUME enviado ao terceiro,
 * não dinheiro — reinicia no restart do processo.
 */
import config from '../config.js';
import { createJudgmentBudget, type JudgmentBudget } from './judgment-budget.js';

export const sharedJudgmentBudget: JudgmentBudget = createJudgmentBudget(
  () => config.typesafe,
  'typesafe',
);
