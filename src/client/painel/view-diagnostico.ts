import { html, useState, useRef } from './vendor/preact.js';
import { Card, statusVariant } from './kit.js';
import { useAction, actionError } from './action.js';
import { fetchStreamTrace } from './api.js';
import { getPainelState } from './store.js';
import { Button, FormActions, SelectField, TextField, ToggleField } from './form.js';
import { ViewDiagnosticoIndexer, type IndexerRequest } from './view-diagnostico-indexer.js';
import {
  accountTestRows,
  traceStageRows,
  traceItemRows,
  recomputeItemRows,
  liveResultRows,
  traceSummaryRows,
  type DiagnosticRow,
  type TraceItemRow,
  type LiveResultRow,
} from './diagnostico-model.js';

// Aba Diagnóstico: teste sequencial de indexadores, validação de chave de
// debrid e leitura offline/live do funil por item. Toda a normalização e a
// higiene de texto de terceiro vivem em diagnostico-model.ts; aqui só há
// montagem de VNode, estado local e despacho de ação. O teste de indexador
// vive em view-diagnostico-indexer.ts (catraca de linhas).

export interface ViewDiagnosticoProps {
  debrid?: Record<string, any>;
  /** Pedido vindo do chip da aba Saúde: id já pré-preenchido no card de teste. */
  indexerRequest?: IndexerRequest | null;
}

const MUTED = 'margin: 0 0 var(--space-2); font-size: var(--font-floor); color: var(--muted);';
const TRACE_ID = /^tt\d+(?::\d+){0,2}$/;

/** Valor de linha com badge apenas quando o status é acionável (ok/warn/err).
 * `neutral` sai como texto puro para a tabela não virar uma parede de pills. */
function RowValue({ row }: { row: DiagnosticRow }) {
  if (row.status === 'neutral') return html`<span>${row.value}</span>`;
  return html`<span class=${'painel-badge painel-badge-' + statusVariant(row.status)}>${row.value}</span>`;
}

function RowsTable({ rows }: { rows: DiagnosticRow[] }) {
  if (rows.length === 0) return html`<div class="painel-empty painel-empty-sm">Sem dados.</div>`;
  return html`
    <table class="painel-table">
      <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
      <tbody>
        ${rows.map((row, index) => html`
          <tr key=${row.key + ':' + index}>
            <td>${row.label}</td>
            <td><${RowValue} row=${row} /></td>
          </tr>
        `)}
      </tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// Conta debrid (teste de chave + refresh do inventário)
// ---------------------------------------------------------------------------

function DiagnosticoConta({ debrid }: ViewDiagnosticoProps) {
  const { pending, run } = useAction();
  const services = Array.isArray(debrid?.services)
    ? (debrid!.services as any[])
        .filter((s) => s && typeof s.id === 'string')
        .map((s) => ({ value: String(s.id), label: String(s.label || s.id) }))
    : [];
  const [service, setService] = useState('');
  const [key, setKey] = useState('');
  const [rows, setRows] = useState<DiagnosticRow[] | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const effective = service || services[0]?.value || '';

  const handleTest = async () => {
    if (!effective) {
      setFeedback('Escolha o serviço da chave a testar.');
      return;
    }
    const trimmed = key.trim();
    if (!trimmed) {
      setFeedback('Cole a chave da conta para testar.');
      return;
    }
    setFeedback(null);
    const outcome = await run({
      action: 'debrid-account-test',
      body: { service: effective, key: trimmed },
      // A chave nunca entra em toast/log: o backend devolve só label/service.
      successToast: (data) => `Chave validada em ${String(data.label || data.service || effective)}`,
      failureFallback: 'teste de chave indisponível',
    });
    // Credencial não fica no DOM depois de um despacho real (aborto por trava
    // de reentrada não é despacho e preserva o que foi digitado).
    if (outcome.ok || outcome.aborted !== true) setKey('');
    if (!outcome.ok) {
      const error = actionError(outcome);
      if (error) setFeedback(error);
      return;
    }
    setRows(accountTestRows(outcome.data));
  };

  const handleRefresh = async () => {
    setFeedback(null);
    const outcome = await run({
      action: 'refresh-inventory',
      poll: ['conta', 'debrid', 'magnetdb'],
      successToast: (data) => `Inventário reavaliado (${Number(data.refreshed || 0)} conta(s))`,
    });
    const error = actionError(outcome);
    if (error) setFeedback(error);
  };

  return html`
    <${Card} title="Teste de Chave Debrid" badge=${pending ? { text: 'PROCESSANDO…', variant: 'warn' } : { text: 'NÃO PERSISTE', variant: 'neutral' }}>
      <p style=${MUTED}>Valida uma chave ANTES de salvar. O teste não altera a conta nem persiste a credencial.</p>
      <${SelectField}
        label="Serviço"
        value=${effective}
        options=${services}
        onChange=${setService}
        disabled=${pending}
      />
      <${TextField}
        label="Chave da API"
        type="password"
        value=${key}
        onChange=${setKey}
        placeholder="cole a chave da conta"
        hint="a chave sai do campo após o teste"
        disabled=${pending}
      />
      <${FormActions}>
        <${Button} variant="accent" pending=${pending} disabled=${!effective || !key.trim()} onClick=${handleTest}>
          Testar chave
        </${Button}>
        <${Button} pending=${pending} onClick=${handleRefresh}>
          Reavaliar inventário
        </${Button}>
      </${FormActions}>
      ${feedback ? html`<div class="painel-feedback painel-feedback-err" role="status">${feedback}</div>` : null}
      ${rows == null ? null : html`
        <h4 class="painel-action-group-title">Resultado do teste</h4>
        <${RowsTable} rows=${rows} />
      `}
    </${Card}>
  `;
}

// ---------------------------------------------------------------------------
// Stream trace
// ---------------------------------------------------------------------------

function traceItemTable(rows: TraceItemRow[], lastLabel: string): any {
  if (rows.length === 0) return null;
  return html`
    <table class="painel-table">
      <thead>
        <tr><th>#</th><th>Release</th><th>Qualidade</th><th>BR</th><th>Dublado</th><th>Indexer</th><th>Seeds</th><th>${lastLabel}</th></tr>
      </thead>
      <tbody>
        ${rows.map((row, index) => html`
          <tr key=${row.id + ':' + index}>
            <td>${row.id}</td>
            <td title=${row.label}><span class="painel-cell-release">${row.label}</span></td>
            <td>${row.quality || '—'}</td>
            <td>${row.br ? 'sim' : '—'}</td>
            <td>${row.dubbed == null ? '—' : row.dubbed ? 'sim' : 'não'}</td>
            <td>${row.indexer || '—'}</td>
            <td>${row.seeders != null ? row.seeders : '—'}</td>
            <td>${row.reason || row.now || '—'}</td>
          </tr>
        `)}
      </tbody>
    </table>
  `;
}

function liveTable(rows: LiveResultRow[]): any {
  if (rows.length === 0) return null;
  return html`
    <table class="painel-table">
      <thead><tr><th>#</th><th>Stream</th><th>Veredito</th></tr></thead>
      <tbody>
        ${rows.map((row, index) => html`
          <tr key=${row.id + ':' + index}>
            <td>${row.id}</td>
            <td>${row.label}</td>
            <td><span class=${'painel-badge painel-badge-' + statusVariant(row.verdict === 'hit' ? 'ok' : row.verdict === 'miss' ? 'warn' : 'neutral')}>${row.verdict.toUpperCase()}</span></td>
          </tr>
        `)}
      </tbody>
    </table>
  `;
}

function DiagnosticoTrace() {
  const [type, setType] = useState('movie');
  const [id, setId] = useState('');
  const [live, setLive] = useState(false);
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Trava de reentrada em ref (não estado): dois cliques no mesmo frame não
  // podem disparar dois GETs; o `loading` sozinho só desabilita no render
  // seguinte.
  const busy = useRef(false);

  const runTrace = async (modeLive: boolean) => {
    const cleanId = id.trim();
    if (type !== 'movie' && type !== 'series') {
      setFeedback('Escolha filme ou série.');
      return;
    }
    if (!TRACE_ID.test(cleanId)) {
      setFeedback('ID inválido: use tt… opcionalmente com :s:e (ex.: tt111:1:2).');
      return;
    }
    const token = getPainelState().token;
    if (!token) {
      setFeedback('Token de diagnóstico ausente — cole-o no cabeçalho.');
      return;
    }
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetchStreamTrace(token, type, cleanId, { live: modeLive });
      if (!res.ok) {
        setResult(null);
        setFeedback(res.error);
        return;
      }
      setResult(res.data);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  const stages = result == null ? [] : traceStageRows(result);
  const items = result == null ? [] : traceItemRows(result);
  const recompute = result == null ? [] : recomputeItemRows(result);
  const liveRows = result == null ? [] : liveResultRows(result);
  const found = result != null && result.found !== false;

  return html`
    <${Card} title="Funil por Item (stream-trace)" badge=${loading ? { text: 'CONSULTANDO…', variant: 'warn' } : { text: 'LEITURA', variant: 'neutral' }}>
      <p style=${MUTED}>
        Lê o ledger da última build da obra sem refazer a busca. A obra precisa ter passado pelo cache desta instalação.
      </p>
      <${SelectField}
        label="Tipo"
        value=${type}
        options=${[{ value: 'movie', label: 'Filme' }, { value: 'series', label: 'Série' }]}
        onChange=${setType}
        disabled=${loading}
      />
      <${TextField}
        label="ID (tt…)"
        value=${id}
        onChange=${setId}
        placeholder="tt111:1:2"
        hint="opcionalmente com temporada:episódio"
        disabled=${loading}
      />
      <${ToggleField}
        label="Incluir sonda live (TorBox/Premiumize)"
        checked=${live}
        onChange=${setLive}
        hint="consulta ao vivo só onde o serviço permite"
        disabled=${loading}
      />
      <${FormActions}>
        <${Button} variant="accent" pending=${loading} disabled=${!TRACE_ID.test(id.trim())} onClick=${() => runTrace(live)}>
          ${loading ? 'Consultando…' : 'Consultar'}
        </${Button}>
      </${FormActions}>
      ${feedback ? html`<div class="painel-feedback painel-feedback-err" role="status">${feedback}</div>` : null}
      ${result == null ? null : !found ? html`
        <div class="painel-empty painel-empty-sm">Obra não está no cache desta instalação.</div>
      ` : html`
        <${RowsTable} rows=${traceSummaryRows(result)} />
        ${stages.length === 0 ? null : html`
          <h4 class="painel-action-group-title">Funil</h4>
          <table class="painel-table">
            <thead><tr><th>Estágio</th><th>Itens</th></tr></thead>
            <tbody>
              ${stages.map((stage) => html`<tr key=${stage.stage}><td>${stage.stage}</td><td>${stage.count}</td></tr>`)}
            </tbody>
          </table>
        `}
        ${items.length === 0 ? null : html`<h4 class="painel-action-group-title">Itens cortados da build</h4>${traceItemTable(items, 'Motivo')}`}
        ${recompute.length === 0 ? null : html`<h4 class="painel-action-group-title">Recompute offline (estado atual)</h4>${traceItemTable(recompute, 'Agora')}`}
        ${liveRows.length === 0 ? null : html`<h4 class="painel-action-group-title">Sonda live</h4>${liveTable(liveRows)}`}
      `}
    </${Card}>
  `;
}

export function ViewDiagnostico({ debrid, indexerRequest }: ViewDiagnosticoProps) {
  return html`
    <div>
      <${ViewDiagnosticoIndexer} request=${indexerRequest} />
      <${DiagnosticoConta} debrid=${debrid} />
      <${DiagnosticoTrace} />
    </div>
  `;
}
