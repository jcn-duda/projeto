// Card "Banco de Magnets Vivo" da aba Magnets (Etapa 5). O banco é o clone
// permanente do que o Jackett já devolveu (SQLite `data/magnets.db`, sem cota e
// sem TTL), separado do `magnetdb` (estoque alive/bad/lie por conta).
//
// Duas leituras:
//   - status (bloco `magnetBank` do poll): totais, engine/fila e último visto
//     por indexer;
//   - busca (ação `magnet-bank-search`, só no clique): hash OU substring de
//     título, com a URI completa copiável, fontes e obras.
//
// O corpo é `MagnetBankView` (PRESENTACIONAL, sem hooks): recebe query/estado
// por props e é testável direto. `ViewMagnetBank` é só a casca que guarda o
// estado e chama a ação — a separação evita invocar hooks fora de um render.
import { html, useState } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';
import { useAction, actionError } from './action.js';
import { formatBytes } from './fmt.js';
import {
  BANK_SEARCH_RESULT_MAX,
  magnetBankSummary,
  bankEngineNotice,
  bankLastSeenLabel,
  bankSearchView,
  bankSearchCountLabel,
  workLabel,
  type BankSearchItemView,
} from './bank-model.js';

export interface ViewMagnetBankProps {
  magnetBank?: Record<string, any>;
}

function copyText(text: string): void {
  if (!text) return;
  try {
    // A Promise do clipboard pode REJEITAR (contexto não-seguro/permissão):
    // consumir a rejeição evita `unhandledrejection` no painel.
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* clipboard indisponível (contexto não-seguro): o operador copia à mão */
  }
}

function flags(item: BankSearchItemView) {
  return [
    item.isBr ? html`<span class="painel-badge painel-badge-neutral" title="origem BR">BR</span>` : null,
    item.dubbed ? html`<span class="painel-badge painel-badge-neutral" title="dublado">DUB</span>` : null,
    item.lied ? html`<span class="painel-badge painel-badge-warn" title="toca, mas mentiu o áudio">MENTIU</span>` : null,
  ];
}

function SearchResult({ item }: { item: BankSearchItemView }) {
  const sources = item.sources.length > 0
    ? item.sources.map((s) => `${s.indexer}${s.tracker ? '/' + s.tracker : ''} (${s.seedersLast})`).join(' · ')
    : '—';
  const works = item.works.length > 0 ? item.works.map(workLabel).join(' | ') : '—';
  return html`
    <div class="painel-bank-item" style="border: 1px solid var(--border); border-radius: var(--radius-xs); padding: var(--space-3); margin-top: var(--space-2);">
      <div style="display: flex; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap;">
        <strong style="min-width: 12ch;">${item.title}</strong>
        <code style="font-family: var(--font-mono); font-size: var(--font-floor); color: var(--muted);">${item.hash}</code>
      </div>
      <p style="margin: var(--space-1) 0; color: var(--muted); font-size: var(--font-floor);">
        ${item.quality || 'sem resolução'} · ${formatBytes(item.size)} ·
        seeders ${item.seedersLast} (máx ${item.seedersMax}) · visto ${bankLastSeenLabel(item.lastSeen)}
      </p>
      <div style="display: flex; gap: var(--space-1); flex-wrap: wrap;">${flags(item)}</div>
      <div style="margin-top: var(--space-2); display: flex; gap: var(--space-2); align-items: flex-start;">
        <code style="font-family: var(--font-mono); font-size: var(--font-floor); word-break: break-all; flex: 1;">${item.uri || '(sem URI)'}</code>
        <button class="painel-btn painel-btn-small" disabled=${!item.uri} onClick=${() => copyText(item.uri)}>Copiar</button>
      </div>
      <p style="margin: var(--space-2) 0 0; font-size: var(--font-floor);">
        <span style="color: var(--muted);">Fontes:</span> ${sources}
      </p>
      <p style="margin: var(--space-1) 0 0; font-size: var(--font-floor);">
        <span style="color: var(--muted);">Obras:</span> ${works}
      </p>
    </div>
  `;
}

export interface MagnetBankViewProps {
  magnetBank?: Record<string, any>;
  query: string;
  onQuery: (value: string) => void;
  onSearch: () => void;
  pending: boolean;
  feedback: { text: string; ok: boolean } | null;
  result: Record<string, any> | null;
}

/** Corpo PRESENTACIONAL (sem hooks): toda a leitura sai das props. */
export function MagnetBankView({ magnetBank, query, onQuery, onSearch, pending, feedback, result }: MagnetBankViewProps) {
  const s = magnetBankSummary(magnetBank);
  const badge = s.enabled
    ? { text: s.engine.toUpperCase(), variant: s.engine === 'MEMÓRIA' ? ('warn' as const) : ('ok' as const) }
    : { text: 'DESLIGADO', variant: 'neutral' as const };
  const engineNotice = bankEngineNotice(s);
  const view = result ? bankSearchView(result) : null;

  return html`
    <div>
      <div class="painel-grid">
        <${Card} title="Banco de Magnets Vivo (Jackett)" badge=${badge}>
          <p style="color: var(--muted); margin: 0 0 var(--space-2); font-size: var(--font-floor);">
            Clone permanente do que o Jackett já devolveu — sem cota, sem TTL. Separado do estoque por conta.
          </p>
          ${engineNotice ? html`
            <p class=${'painel-bank-engine' + (engineNotice.warn ? ' painel-bank-engine-warn' : '')} role="status">
              ${engineNotice.text}
            </p>
          ` : null}
          <div style="display: flex; gap: var(--space-4); flex-wrap: wrap;">
            <${StatNumber} value=${s.magnets} label="magnets (torrents)" />
            <${StatNumber} value=${s.sources} label="fontes (indexer × hash)" />
            <${StatNumber} value=${s.works} label="obras (busca × hash)" />
          </div>
          <p style="color: var(--muted); margin: var(--space-3) 0 0; font-size: var(--font-floor);">
            Fila de captura: ${s.queue}/${s.queueMax || '—'} · Último visto: ${bankLastSeenLabel(s.lastSeen)}
          </p>
        </${Card}>

        <${Card} title="Por Indexador">
          ${s.byIndexer.length === 0 ? html`
            <div class="painel-empty painel-empty-sm">Nenhuma fonte capturada ainda.</div>
          ` : html`
            <table class="painel-table">
              <thead>
                <tr><th>Indexador</th><th>Hashes</th><th>Fontes</th><th>Último visto</th></tr>
              </thead>
              <tbody>
                ${s.byIndexer.map((row) => html`
                  <tr key=${row.indexer}>
                    <td>${row.indexer}</td>
                    <td>${row.hashes}</td>
                    <td>${row.sources}</td>
                    <td>${bankLastSeenLabel(row.lastSeen)}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
        </${Card}>
      </div>

      <div class="painel-grid" style="margin-top: var(--space-4);">
        <${Card} title="Buscar no Banco (hash ou título)">
          <p style="color: var(--muted); margin: 0 0 var(--space-2); font-size: var(--font-floor);">
            Informe um infoHash de 40 hex ou um trecho do título. Sem query, mostra os magnet(s) mais recentes.
            Busca de leitura: nada é gravado nem apagado.
          </p>
          <div style="display: flex; gap: var(--space-2); align-items: center;">
            <input
              type="text"
              class="painel-token-input"
              placeholder="infoHash (40 hex) ou trecho do título..."
              value=${query}
              onInput=${(e: any) => onQuery(e.target.value)}
            />
            <button class="painel-btn painel-btn-accent" disabled=${pending} onClick=${onSearch}>
              ${pending ? 'Buscando…' : 'Buscar'}
            </button>
          </div>

          ${feedback ? html`
            <div class=${'painel-feedback ' + (feedback.ok ? 'painel-feedback-ok' : 'painel-feedback-err')} role="status">
              ${feedback.text}
            </div>
          ` : null}

          ${view && view.items.length === 0 ? html`
            <p style="color: var(--muted); margin-top: var(--space-3); font-size: var(--font-floor);">
              Nenhum magnet encontrado para esta busca.
            </p>
          ` : null}

          ${view ? view.items.map((item) => html`<${SearchResult} key=${item.hash} item=${item} />`) : null}
        </${Card}>
      </div>
    </div>
  `;
}

/** Casca com estado: guarda a query/resultado e dispara a ação read-only. */
export function ViewMagnetBank({ magnetBank }: ViewMagnetBankProps) {
  const { pending, run } = useAction();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);

  const handleSearch = async () => {
    setFeedback(null);
    const outcome = await run({
      action: 'magnet-bank-search',
      body: { query: query.trim(), max: BANK_SEARCH_RESULT_MAX },
    });
    if (!outcome.ok) {
      const error = actionError(outcome);
      if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
      return;
    }
    const view = bankSearchView(outcome.data);
    setResult(outcome.data);
    // `matched` é `null` quando truncado (o backend não paga COUNT exato): a
    // contagem sai como "N+", honesta, em vez de um total que não foi medido.
    setFeedback({
      text: `${bankSearchCountLabel(view)} magnet(s) · ${view.modeLabel}${
        view.truncated ? ' · refine a busca para ver os demais' : ''
      }`,
      ok: true,
    });
  };

  return html`
    <${MagnetBankView}
      magnetBank=${magnetBank}
      query=${query}
      onQuery=${setQuery}
      onSearch=${handleSearch}
      pending=${pending}
      feedback=${feedback}
      result=${result}
    />
  `;
}
