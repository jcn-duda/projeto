import { html, useState, useEffect, useRef } from './vendor/preact.js';
import { Card, statusVariant } from './kit.js';
import { useAction, actionError } from './action.js';
import { fetchTestIndexer } from './api.js';
import { getPainelState } from './store.js';
import { Button, FormActions, TextField } from './form.js';
import { indexerTestRows, indexerTestSummary, type IndexerTestRow } from './diagnostico-model.js';

// Card de teste de indexador, extraído de view-diagnostico.ts (catraca de
// linhas). Dois caminhos, de propósito:
//
// - UM indexador (`GET /test-indexer.json`): é o que o chip da aba Saúde
//   pré-preenche. O fetch é direto (não passa pelo `postAction`) porque a rota
//   é GET e devolve o mesmo dado do `jackett.test` — sem efeito colateral.
// - TODOS (`test-all-indexers` no `/dashboard-action.json`): o teste
//   sequencial que já existia, mantido porque é a visão de conjunto.
//
// Nenhum dos dois sonda sozinho: o teste só roda no clique.
export interface IndexerRequest {
  id: string;
  seq: number;
}

export interface ViewDiagnosticoIndexerProps {
  request?: IndexerRequest | null;
}

function indexerStateText(row: IndexerTestRow): string {
  return row.state === 'error' ? 'FALHA' : row.state === 'empty' ? 'SEM MAGNET' : 'OK';
}

function indexerDetail(row: IndexerTestRow): string {
  return row.error || row.sample || row.query || '';
}

export function ViewDiagnosticoIndexer({ request }: ViewDiagnosticoIndexerProps) {
  const { pending, run } = useAction();
  const [id, setId] = useState(request?.id ?? '');
  const [rows, setRows] = useState<IndexerTestRow[] | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Trava de reentrada em ref: dois cliques no mesmo frame não podem disparar
  // dois GETs (o `loading` só desabilita no render seguinte).
  const busy = useRef(false);
  const summary = indexerTestSummary(rows);

  // O clique no chip da Saúde remonta a aba com o pedido; um pedido novo na
  // mesma montagem (seq diferente) atualiza o campo sem apagar o que foi
  // digitado depois.
  useEffect(() => {
    if (request?.id) setId(request.id);
  }, [request?.seq]);

  const badge = loading || pending
    ? { text: 'TESTANDO…', variant: 'warn' as const }
    : rows == null
      ? { text: 'NÃO EXECUTADO', variant: 'neutral' as const }
      : { text: summary.downCount > 0 ? `${summary.downCount} FALHA(S)` : 'TODOS OK', variant: summary.downCount > 0 ? ('warn' as const) : ('ok' as const) };

  const handleTestOne = async () => {
    const clean = id.trim();
    if (!clean) {
      setFeedback('Informe o id do indexador.');
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
      const res = await fetchTestIndexer(token, clean);
      if (!res.ok) {
        setRows(null);
        setFeedback(res.error);
        return;
      }
      // A rota devolve UM resultado; normaliza pela mesma tabela do teste em
      // lote (aceita array ou envelope `{ results }`), então a leitura sai
      // idêntica nos dois caminhos.
      setRows(indexerTestRows([res.data]));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  const handleTestAll = async () => {
    setFeedback(null);
    const outcome = await run({
      action: 'test-all-indexers',
      successToast: (data) => `Teste concluído: ${Number(data.okCount || 0)} ok · ${Number(data.downCount || 0)} falha(s)`,
    });
    if (!outcome.ok) {
      const error = actionError(outcome);
      if (error) setFeedback(error);
      return;
    }
    setRows(indexerTestRows(outcome.data));
  };

  const busyNow = loading || pending;

  return html`
    <${Card} title="Testar um indexador" badge=${badge}>
      <p style="margin: 0 0 var(--space-2); font-size: var(--font-floor); color: var(--muted);">
        Executa o mesmo teste real da busca, um indexador por vez. Clique num chip da aba Saúde para pré-preencher.
      </p>
      <${TextField}
        label="Indexador (id)"
        value=${id}
        onChange=${setId}
        placeholder="ex.: bludv"
        hint="o id é o mesmo que aparece no catálogo do Jackett"
        disabled=${busyNow}
      />
      <${FormActions}>
        <${Button} variant="accent" pending=${busyNow} disabled=${!id.trim()} onClick=${handleTestOne}>
          ${loading ? 'Testando…' : 'Testar indexador'}
        </${Button}>
        <${Button} pending=${busyNow} onClick=${handleTestAll}>
          Testar todos
        </${Button}>
      </${FormActions}>
      ${feedback ? html`<div class="painel-feedback painel-feedback-err" role="status">${feedback}</div>` : null}
      ${busyNow ? html`
        <div class="painel-empty painel-empty-sm" role="status" aria-live="polite">
          Consultando os indexadores${rows == null ? '' : ' novamente'}…
        </div>
      ` : null}
      ${rows == null ? null : html`
        <p style="margin: 0 0 var(--space-2); font-size: var(--font-floor); color: var(--muted);">
          ${summary.total} testado(s) · ${summary.okCount} ok · ${summary.errorCount} erro(s) ·
          ${summary.emptyCount} sem magnet · ${summary.overBudgetCount} acima do orçamento${summary.slowestId ? ` · mais lento: ${summary.slowestId}` : ''}
        </p>
        <table class="painel-table">
          <thead>
            <tr><th>Indexador</th><th>Estado</th><th>Tempo</th><th>Resultados</th><th>Amostra / erro</th></tr>
          </thead>
          <tbody>
            ${rows.map((row) => html`
              <tr key=${row.id}>
                <td>
                  ${row.id}
                  ${row.br ? html` <span class="painel-badge painel-badge-neutral">BR</span>` : null}
                </td>
                <td><span class=${'painel-badge painel-badge-' + statusVariant(row.state === 'error' ? 'err' : row.state === 'empty' ? 'warn' : 'ok')}>${indexerStateText(row)}</span></td>
                <td>${row.ms == null ? '—' : `${row.ms} ms${row.overBudget ? ' ⚠' : ''}`}</td>
                <td>${row.results != null ? row.results : row.withMagnet != null ? row.withMagnet : '—'}</td>
                <td title=${indexerDetail(row)}>${indexerDetail(row) || '—'}</td>
              </tr>
            `)}
          </tbody>
        </table>
      `}
    </${Card}>
  `;
}
