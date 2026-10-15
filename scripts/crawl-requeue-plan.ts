// Plano PURO do reenfileiramento de recuperação do `crawl.db` (extraído do CLI
// `crawl-recovery-requeue.ts` para ser testável SEM banco e SEM config): os
// critérios SQL das duas levas, a seleção em JS que os ESPELHA e o UPDATE de
// requeue. O CLI só abre o SQLite, alimenta `planRequeue` e executa o plano.
//
// As duas levas (diagnóstico VPS 2026-10):
//   1. `nerdfilmes`: páginas marcadas `done` SEM nenhuma release gravada — a
//      rota interna desistia por falta de IMDb e o motor as selou mesmo assim.
//      Critério: status='done' AND releases=0.
//   2. `mico`: páginas `error` com a recusa do motor Rust de ritmo próprio
//      (`page_engine.rs` devolve `"{site}: ritmo próprio exige adaptador
//      dedicado"`; o `mark_result` grava o texto verbatim no campo `error`).
//      Critério: status='error' AND error = <texto exato>.
//
// Semântica do reenqueue (DECISÃO DOCUMENTADA — há divergência TS × Rust):
//   - TS `requeueErrors` (`src/utils/crawl-store.ts`, stmt do "Reprocessar
//     erros"): status='pending', tries=0, next_at=0, error='', progress=''.
//   - Rust sidecar `requeue_errors` (`rust/crates/adom-crawl/src/store/ops.rs`):
//     status='pending', next_at=0, error='' — PRESERVA tries e progress.
//   Escolhemos a do TS (zerar tries/progress): as linhas do Mico estão no teto
//   de tentativas (`mark_result` faz tries=tries+1; esgotado → terminal), e
//   mantê-las re-terminalizaria na primeira falha — o requeue não valeria nada.
//   O TS declara o propósito ("recomeça do zero de propósito"). O `releases`
//   NÃO é tocado (critério garante 0; erro não acumula), nem `checked_at`/
//   `added_at` (histórico real do processamento).
//
// Janela temporal (--since-hours): marcador de conclusão é `checked_at`
// (`mark_result` Rust grava now; TS grava no claim e no mark) com fallback
// `added_at` para linha nunca marcada: COALESCE(NULLIF(checked_at,0), added_at).

export const NERDFILMES_SITE = 'nerdfilmes';
export const MICO_SITE = 'mico';

/** Texto EXATO gravado pelo motor Rust (`page_engine.rs` → `mark_result`). */
export const MICO_OWN_PACE_ERROR = 'mico: ritmo próprio exige adaptador dedicado';
/** Trecho do erro usado só como DIAGNÓSTICO (LIKE) — vítima é o exato. */
export const MICO_LOOSE_PATTERN = '%ritmo próprio%';
export const MICO_LOOSE_NEEDLE = 'ritmo próprio';

/** Marcador de conclusão da linha: última marcação (ou inserção, se nunca). */
export const COMPLETION_TS_SQL = 'COALESCE(NULLIF(checked_at, 0), added_at)';

/** Colunas lidas (ordem fixa; `rowFromSqlite` consome a linha inteira). */
export const CANDIDATE_SQL = 'SELECT * FROM crawl_url WHERE site IN (?, ?) ORDER BY site, url_key';

/** Critérios SQL exatos das vítimas (o `?` é o sinceMs — 0 desliga a janela). */
export const VICTIM_SQL = {
  nerdfilmes: `site = '${NERDFILMES_SITE}' AND status = 'done' AND releases = 0 AND ${COMPLETION_TS_SQL} >= ?`,
  mico: `site = '${MICO_SITE}' AND status = 'error' AND error = ? AND ${COMPLETION_TS_SQL} >= ?`,
  /** Só relato: erro de "ritmo próprio" com texto DIFERENTE do esperado. */
  micoLoose: `site = '${MICO_SITE}' AND status = 'error' AND error LIKE '${MICO_LOOSE_PATTERN}' AND error != ? AND ${COMPLETION_TS_SQL} >= ?`,
} as const;

/** Reenqueue por linha, com GUARDA de status: se a linha mudou de estado
 * entre a seleção e o update (sidecar reivindicou, discovery refrescou),
 * o UPDATE não toca — a contagem de `changes` é a verdade aplicada. */
export const REQUEUE_UPDATE_SQL = "UPDATE crawl_url SET status = 'pending', tries = 0, next_at = 0, error = '', progress = '' WHERE site = ? AND url_key = ? AND status = ?";

/** Linha mínima para o plano (só o que a seleção e o log usam). */
export interface RequeueRow {
  site: string;
  url: string;
  urlKey: string;
  status: string;
  tries: number;
  nextAt: number;
  checkedAt: number;
  addedAt: number;
  releases: number;
  error: string;
  progress: string;
}

export interface RequeueVictim extends RequeueRow {
  /** Status GUARDA do UPDATE: o estado visto na seleção. */
  guardStatus: 'done' | 'error';
  /** Nome da leva que a capturou. */
  criterion: 'nerdfilmes' | 'mico';
}

export interface RequeueOptions {
  /** Piso do marcador de conclusão (epoch ms); 0 = sem janela. */
  sinceMs: number;
  /** Texto exato do erro do Mico (override do operador). */
  micoError: string;
}

export interface RequeuePlan {
  nerdfilmes: RequeueVictim[];
  mico: RequeueVictim[];
  /** Erro de "ritmo próprio" com texto diferente do esperado: só RELATO —
   * o operador decide (`--mico-error=`). Nunca vira vítima por conta própria. */
  micoLooseOnly: RequeueVictim[];
  /** Casados pelo critério, mas FORA da janela: contagem para o operador
   * alargar `--since-hours` com consciência (nunca viram vítima agora). */
  outsideWindow: { nerdfilmes: number; mico: number; micoLooseOnly: number };
}

/** Converte a linha crua do SQLite (colunas snake_case) para o plano. */
export function rowFromSqlite(raw: Record<string, unknown>): RequeueRow {
  return {
    site: String(raw.site ?? ''),
    url: String(raw.url ?? ''),
    urlKey: String(raw.url_key ?? ''),
    status: String(raw.status ?? ''),
    tries: Number(raw.tries ?? 0),
    nextAt: Number(raw.next_at ?? 0),
    checkedAt: Number(raw.checked_at ?? 0),
    addedAt: Number(raw.added_at ?? 0),
    releases: Number(raw.releases ?? 0),
    error: String(raw.error ?? ''),
    progress: String(raw.progress ?? ''),
  };
}

/** Espelho JS do `COMPLETION_TS_SQL`. */
export function completionMs(row: RequeueRow): number {
  return row.checkedAt !== 0 ? row.checkedAt : row.addedAt;
}

function inWindow(row: RequeueRow, sinceMs: number): boolean {
  return completionMs(row) >= sinceMs;
}

function victim(row: RequeueRow, criterion: RequeueVictim['criterion']): RequeueVictim {
  return { ...row, guardStatus: criterion === 'nerdfilmes' ? 'done' : 'error', criterion };
}

/** Seleção PURA das vítimas: espelha `VICTIM_SQL` exatamente (o teste de
 * paridade roda os dois lados sobre a mesma fixture e compara). */
export function planRequeue(rows: readonly RequeueRow[], opts: RequeueOptions): RequeuePlan {
  const plan: RequeuePlan = {
    nerdfilmes: [], mico: [], micoLooseOnly: [],
    outsideWindow: { nerdfilmes: 0, mico: 0, micoLooseOnly: 0 },
  };
  for (const row of rows) {
    if (row.site === NERDFILMES_SITE && row.status === 'done' && row.releases === 0) {
      if (inWindow(row, opts.sinceMs)) plan.nerdfilmes.push(victim(row, 'nerdfilmes'));
      else plan.outsideWindow.nerdfilmes += 1;
      continue;
    }
    if (row.site === MICO_SITE && row.status === 'error') {
      if (row.error === opts.micoError) {
        if (inWindow(row, opts.sinceMs)) plan.mico.push(victim(row, 'mico'));
        else plan.outsideWindow.mico += 1;
      } else if (row.error.includes(MICO_LOOSE_NEEDLE)) {
        if (inWindow(row, opts.sinceMs)) plan.micoLooseOnly.push(victim(row, 'mico'));
        else plan.outsideWindow.micoLooseOnly += 1;
      }
    }
  }
  return plan;
}
