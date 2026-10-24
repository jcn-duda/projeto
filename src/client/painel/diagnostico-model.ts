// Modelo puro do diagnóstico: normaliza o resultado de `test-all-indexers` e
// expõe linhas estáveis de tabela para conta/debrid e stream-trace. Sem DOM,
// sem preact — só dado → dado, testável direto.
//
// A defesa de segredo mora AQUI: as linhas carregam apenas campos de allowlist,
// e todo texto que possa ter vindo de terceiro (erro de rede, rótulo de
// release, resumo do Chupim) passa por `scrubDiagnosticText`, que remove
// magnet/hash e redige parâmetro de credencial em URL (o erro do Jackett pode
// ecoar a própria query com `apikey=`). Chave, hash e magnet nunca são lidos
// para a linha — não há como vazarem por um campo esquecido.

export type DiagnosticStatus = 'ok' | 'warn' | 'err' | 'neutral';

export interface DiagnosticRow { key: string; label: string; value: string; status: DiagnosticStatus; }

const DIAGNOSTIC_TEXT_MAX = 160;
const MAGNET_URI = /magnet:\?\S*/gi;
const HEX40 = /[a-fA-F0-9]{40}/g;
// A ordem importa: o magnet consome a URI inteira (inclusive `dn=`) antes do
// 40-hex; por último a credencial — que pode ter sobrado como `<hash>`.
const CREDENTIAL_PARAM = /([?&](?:apikey|api_key|token|key|password|passkey|auth)=)[^&\s"'<>]*/gi;

/** Higiene de texto de terceiro: magnet, hash e credencial de URL fora, com
 * teto curto para o payload não crescer com release inteira. */
export function scrubDiagnosticText(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value);
  if (!text) return '';
  text = text.replace(MAGNET_URI, '<magnet>').replace(HEX40, '<hash>').replace(CREDENTIAL_PARAM, '$1<redacted>');
  return text.length > DIAGNOSTIC_TEXT_MAX ? `${text.slice(0, DIAGNOSTIC_TEXT_MAX - 1)}…` : text;
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}
function plainText(value: unknown): string { return value === undefined || value === null ? '' : String(value); }
/** `now` do recompute é `{ state }` (contrato do trace-recompute); entradas
 * antigas podem trazer string. Objeto sem `state` legível vira `null` — nunca
 * `[object Object]`, que era exibido como estado do item. */
function nowText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const state = (value as Record<string, unknown>).state;
    return state === undefined || state === null ? null : plainText(state) || null;
  }
  return plainText(value) || null;
}
function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function compareId(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** Timestamp/serial em ISO estável (ao contrário de `toLocaleString`, que
 * dependeria de timezone e tornaria a linha não determinística no teste). */
function isoText(value: unknown): string {
  const n = toFiniteNumber(value);
  if (n != null) {
    const date = new Date(n > 1e11 ? n : n * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '—';
  }
  return plainText(value) || '—';
}

// ---------------------------------------------------------------------------
// Teste de todos os indexadores
// ---------------------------------------------------------------------------

export interface IndexerTestRow {
  id: string; ok: boolean; hasError: boolean; error: string | null;
  ms: number | null; results: number | null; withMagnet: number | null;
  overBudget: boolean | null; budgetMs: number | null;
  sample: string | null; query: string | null; type: string | null;
  br: boolean;
  /** `error` = falhou de verdade; `empty` = respondeu sem magnet (inútil pro
   * addon); `ok` = tem magnet. É a ordem do sort. */
  state: 'error' | 'empty' | 'ok';
}

export interface IndexerTestSummary {
  total: number; okCount: number; downCount: number; errorCount: number;
  emptyCount: number; overBudgetCount: number; slowestId: string | null;
}

function normalizeIndexerResult(raw: any): IndexerTestRow | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const id = plainText(obj.id ?? obj.indexer).trim();
  if (!id) return null;
  const ok = obj.ok === true;
  const error = obj.error != null ? scrubDiagnosticText(obj.error) : '';
  const ms = toFiniteNumber(obj.ms);
  const budgetMs = toFiniteNumber(obj.budgetMs);
  const overBudget = typeof obj.overBudget === 'boolean'
    ? obj.overBudget
    : ms != null && budgetMs != null ? ms > budgetMs : null;
  return {
    id, ok, hasError: error !== '', error: error || null, ms, budgetMs, overBudget,
    results: toFiniteNumber(obj.results),
    withMagnet: toFiniteNumber(obj.withMagnet),
    sample: obj.sample != null ? scrubDiagnosticText(obj.sample) || null : null,
    query: obj.query != null ? scrubDiagnosticText(obj.query) || null : null,
    type: obj.type != null ? plainText(obj.type) : null,
    br: obj.br === true,
    state: ok ? 'ok' : error !== '' ? 'error' : 'empty',
  };
}

/** Falha primeiro: erro duro, depois "respondeu sem magnet", depois os que
 * tocaram. Dentro de cada faixa a ordem é por id, determinística. */
export function sortIndexerRows(rows: IndexerTestRow[] | null | undefined): IndexerTestRow[] {
  const rank = (row: IndexerTestRow) => (row.state === 'error' ? 0 : row.state === 'empty' ? 1 : 2);
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : compareId(a.id, b.id);
  });
}

/** Aceita o corpo de `dashboard-action.json` (`{ results }`) ou o array cru. */
export function indexerTestRows(payload: any): IndexerTestRow[] {
  const list = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  const rows: IndexerTestRow[] = [];
  for (const item of list) {
    const row = normalizeIndexerResult(item);
    if (row) rows.push(row);
  }
  return sortIndexerRows(rows);
}

/** Contagens derivadas das linhas (não das do payload, que podem divergir). */
export function indexerTestSummary(rows: IndexerTestRow[] | null | undefined): IndexerTestSummary {
  const list = Array.isArray(rows) ? rows : [];
  let okCount = 0; let errorCount = 0; let emptyCount = 0; let overBudgetCount = 0;
  let slowestId: string | null = null; let slowestMs = -1;
  for (const row of list) {
    if (row.ok) okCount += 1;
    else if (row.hasError) errorCount += 1;
    else emptyCount += 1;
    if (row.ok && row.overBudget === true) overBudgetCount += 1;
    if (row.ms != null && row.ms > slowestMs) { slowestMs = row.ms; slowestId = row.id; }
  }
  return { total: list.length, okCount, downCount: list.length - okCount, errorCount, emptyCount, overBudgetCount, slowestId };
}

// ---------------------------------------------------------------------------
// Conta / debrid
// ---------------------------------------------------------------------------

function addCountRow(rows: DiagnosticRow[], key: string, label: string, value: unknown): void {
  const n = toFiniteNumber(value);
  if (n == null) return; // ausente não vira 0
  rows.push({ key, label, value: String(Math.trunc(n)), status: 'neutral' });
}

/**
 * Linhas de UMA conta. O campo `error` do `AccountStatus` é CONTAGEM de magnets
 * em erro quando numérico, mas em falha de conta o MESMO nome carrega a
 * mensagem crua do terceiro — que pode ecoar a credencial. Só o número entra;
 * string nunca é exibida. `reason`/`fix` passam pela higiene por precaução.
 */
export function debridAccountRows(account: any): DiagnosticRow[] {
  const a = asObject(account) ?? {};
  const ok = a.ok === true;
  const rows: DiagnosticRow[] = [
    { key: 'service', label: 'Serviço', value: plainText(a.label || a.service) || '—', status: 'neutral' },
    { key: 'state', label: 'Estado', value: ok ? 'Conectado' : 'Indisponível', status: ok ? 'ok' : 'err' },
  ];
  addCountRow(rows, 'magnets', 'Magnets na conta', a.magnets);
  addCountRow(rows, 'ready', 'Prontos', a.ready);
  addCountRow(rows, 'active', 'Baixando', a.active);
  if (typeof a.error === 'number' && Number.isFinite(a.error)) {
    rows.push({ key: 'error', label: 'Com erro', value: String(Math.trunc(a.error)), status: a.error > 0 ? 'warn' : 'neutral' });
  }
  const limitUsed = toFiniteNumber(a.limitUsed);
  if (limitUsed != null) {
    const percent = Math.round(limitUsed * 100);
    rows.push({ key: 'limitUsed', label: 'Fair-use', value: `${percent}%`, status: percent >= 80 ? 'warn' : 'neutral' });
  }
  if (a.premiumUntil != null) rows.push({ key: 'premiumUntil', label: 'Premium até', value: isoText(a.premiumUntil), status: 'neutral' });
  if (a.oldestAt != null) rows.push({ key: 'oldestAt', label: 'Magnet mais antigo', value: isoText(a.oldestAt), status: 'neutral' });
  if (a.reason != null) rows.push({ key: 'reason', label: 'Motivo', value: scrubDiagnosticText(a.reason), status: ok ? 'neutral' : 'warn' });
  if (a.fix != null) rows.push({ key: 'fix', label: 'Conserto', value: scrubDiagnosticText(a.fix), status: 'neutral' });
  if (typeof a.cached === 'boolean') rows.push({ key: 'cached', label: 'Leitura', value: a.cached ? 'memo' : 'ao vivo', status: 'neutral' });
  const fetchedAt = toFiniteNumber(a.fetchedAt);
  if (fetchedAt != null) rows.push({ key: 'fetchedAt', label: 'Leitura em', value: isoText(fetchedAt), status: 'neutral' });
  if (a.warn === true) {
    const limiar = a.warnAt != null ? `limiar ${plainText(a.warnAt)} ${plainText(a.warnAtUnit)}`.trim() : 'acima do limiar';
    rows.push({ key: 'warn', label: 'Aviso de ocupação', value: limiar, status: 'warn' });
  }
  return rows;
}

export interface AccountTableRow { id: string; label: string; ok: boolean; rows: DiagnosticRow[]; }

/**
 * Tabela de contas. Aceita o bloco `debrid` do `/dashboard-status.json`
 * (`{ account, accounts }`), o corpo do `/debrid-status.json` ou uma conta
 * solta. Falha primeiro, como no teste de indexadores.
 */
export function accountTable(payload: any): AccountTableRow[] {
  const out: AccountTableRow[] = [];
  const accounts = asObject(payload?.accounts);
  if (accounts) {
    for (const [id, value] of Object.entries(accounts)) {
      const account = asObject(value) ?? {};
      out.push({
        id, label: plainText(account.label || account.service || id) || id,
        ok: account.ok === true, rows: debridAccountRows(account),
      });
    }
  } else {
    const single = asObject(payload?.account) ?? asObject(payload);
    if (single) {
      const id = plainText(single.service || 'conta') || 'conta';
      out.push({
        id, label: plainText(single.label || single.service || 'Conta') || 'Conta',
        ok: single.ok === true, rows: debridAccountRows(single),
      });
    }
  }
  return out.sort((a, b) => (a.ok === b.ok ? compareId(a.id, b.id) : a.ok ? 1 : -1));
}

const CAPABILITY_LABELS: Record<string, string> = {
  cacheCheck: 'Checagem de cache', abortSafeCacheCheck: 'Checagem abortável',
  accountStatus: 'Status da conta', inventory: 'Inventário', autofetch: 'Autofetch',
  torrentStatus: 'Status de torrent', catalogCleanup: 'Catálogo / limpeza',
};

/** Linhas de `debrid-account-test`. A chave testada NUNCA é lida: o payload do
 * backend só traz `last4`/`fingerprint` (identidade segura por contrato) e a
 * conta num allowlist. O `error` cru do terceiro fica de fora de propósito. */
export function accountTestRows(payload: any): DiagnosticRow[] {
  const p = asObject(payload) ?? {};
  const ok = p.ok === true;
  const rows: DiagnosticRow[] = [
    { key: 'service', label: 'Serviço', value: plainText(p.label || p.service) || '—', status: 'neutral' },
    { key: 'result', label: 'Resultado', value: ok ? 'Chave validada' : 'Falha na validação', status: ok ? 'ok' : 'err' },
  ];
  if (p.last4) rows.push({ key: 'last4', label: 'Chave (últimos 4)', value: `…${plainText(p.last4)}`, status: 'neutral' });
  if (p.fingerprint) rows.push({ key: 'fingerprint', label: 'Impressão digital', value: plainText(p.fingerprint).slice(0, 8), status: 'neutral' });
  if (p.reason) rows.push({ key: 'reason', label: 'Motivo', value: scrubDiagnosticText(p.reason), status: 'warn' });
  if (p.fix) rows.push({ key: 'fix', label: 'Conserto', value: scrubDiagnosticText(p.fix), status: 'neutral' });
  const account = asObject(p.account);
  if (account) {
    for (const row of debridAccountRows({ ...account, ok: true, service: p.service, label: p.label })) rows.push(row);
  }
  const capabilities = asObject(p.capabilities);
  if (capabilities) {
    for (const [key, value] of Object.entries(capabilities)) {
      if (typeof value !== 'boolean') continue;
      rows.push({ key: `cap:${key}`, label: CAPABILITY_LABELS[key] || key, value: value ? 'sim' : 'não', status: value ? 'ok' : 'neutral' });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Stream trace
// ---------------------------------------------------------------------------

export interface TraceStageRow { stage: string; count: number; }

export interface TraceItemRow {
  id: string;
  /** Motivo do corte; null no recompute (lá o estado é `now`, não causa). */
  reason: string | null;
  label: string; br: boolean; dubbed: boolean | null; quality: string | null;
  now: string | null; indexer: string | null; seeders: number | null;
}

export interface LiveResultRow { id: string; label: string; verdict: 'hit' | 'miss' | 'skipped' | 'unknown'; }

/** Funil por estágio, na ordem em que o servidor gravou. */
export function traceStageRows(payload: any): TraceStageRow[] {
  const stages = asObject(asObject(payload?.trace)?.stages);
  if (!stages) return [];
  return Object.entries(stages).map(([stage, count]) => ({ stage, count: toFiniteNumber(count) ?? 0 }));
}

function normalizeTraceItem(raw: any): TraceItemRow | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const label = scrubDiagnosticText(obj.label);
  if (!label) return null;
  return {
    id: plainText(obj.id) || 'item',
    reason: obj.reason != null ? plainText(obj.reason) : null,
    label, br: obj.br === true,
    dubbed: typeof obj.dubbed === 'boolean' ? obj.dubbed : null,
    quality: obj.quality != null ? plainText(obj.quality) : null,
    now: nowText(obj.now),
    indexer: obj.indexer != null ? plainText(obj.indexer) : null,
    seeders: toFiniteNumber(obj.seeders),
  };
}

function mapTraceItems(items: unknown): TraceItemRow[] {
  if (!Array.isArray(items)) return [];
  const out: TraceItemRow[] = [];
  for (const item of items) {
    const row = normalizeTraceItem(item);
    if (row) out.push(row);
  }
  return out;
}

/** Itens cortados da build (ledger do trace). */
export function traceItemRows(payload: any): TraceItemRow[] {
  return mapTraceItems(asObject(payload?.trace)?.items);
}

/** Itens reconstruídos offline (`recompute`) — trazem `now` em vez de `reason`. */
export function recomputeItemRows(payload: any): TraceItemRow[] {
  return mapTraceItems(asObject(payload?.recompute)?.items);
}

const LIVE_VERDICTS = new Set(['hit', 'miss', 'skipped']);

/** Sonda live: só id/rótulo/veredito — o hash que o backend usa para consultar
 * o serviço não é lido aqui e não entra na resposta. */
export function liveResultRows(payload: any): LiveResultRow[] {
  const live = asObject(payload?.live);
  const results = Array.isArray(live?.results) ? live.results : [];
  const out: LiveResultRow[] = [];
  for (const raw of results) {
    const verdict = String(raw?.verdict);
    out.push({
      id: plainText(raw?.id) || 'item',
      label: scrubDiagnosticText(raw?.name) || '<hash>',
      verdict: LIVE_VERDICTS.has(verdict) ? (verdict as LiveResultRow['verdict']) : 'unknown',
    });
  }
  return out;
}

/** Resumo do trace (cache/meta/live) em linhas de tabela. */
export function traceSummaryRows(payload: any): DiagnosticRow[] {
  const p = asObject(payload) ?? {};
  const rows: DiagnosticRow[] = [
    { key: 'found', label: 'Encontrado', value: p.found === true ? 'sim' : 'não', status: p.found === true ? 'ok' : 'warn' },
  ];
  if (p.origin != null) rows.push({ key: 'origin', label: 'Origem', value: plainText(p.origin), status: 'neutral' });

  const cache = asObject(p.cache);
  if (cache) {
    if (typeof cache.partial === 'boolean') rows.push({ key: 'partial', label: 'Parcial', value: cache.partial ? 'sim' : 'não', status: cache.partial ? 'warn' : 'ok' });
    if (typeof cache.debridKnown === 'boolean') rows.push({ key: 'debridKnown', label: 'Debrid conhecido', value: cache.debridKnown ? 'sim' : 'não', status: cache.debridKnown ? 'ok' : 'warn' });
    if (typeof cache.stale === 'boolean') rows.push({ key: 'stale', label: 'SWR (expirado)', value: cache.stale ? 'sim' : 'não', status: cache.stale ? 'warn' : 'neutral' });
    const remaining = toFiniteNumber(cache.remainingS);
    if (remaining != null) rows.push({ key: 'remainingS', label: 'TTL restante', value: `${Math.trunc(remaining)}s`, status: 'neutral' });
  }

  const trace = asObject(p.trace);
  if (trace) {
    const startedAt = toFiniteNumber(trace.startedAt);
    if (startedAt != null) rows.push({ key: 'startedAt', label: 'Início da build', value: isoText(startedAt), status: 'neutral' });
    const finishedAt = toFiniteNumber(trace.finishedAt);
    if (finishedAt != null) rows.push({ key: 'finishedAt', label: 'Fim da build', value: isoText(finishedAt), status: 'neutral' });
    if (trace.chupim != null) rows.push({ key: 'chupim', label: 'Chupim', value: scrubDiagnosticText(trace.chupim), status: 'neutral' });
  }

  const live = asObject(p.live);
  if (live) {
    if (typeof live.allowed === 'boolean') rows.push({ key: 'liveAllowed', label: 'Sonda live', value: live.allowed ? 'permitida' : 'recusada', status: live.allowed ? 'ok' : 'warn' });
    if (live.reason != null) rows.push({ key: 'liveReason', label: 'Motivo do live', value: plainText(live.reason), status: 'neutral' });
  }
  return rows;
}
