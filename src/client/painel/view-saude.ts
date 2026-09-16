import { html } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';
import { formatDurationMs } from './fmt.js';
import { indexerRows, indexerSummary, indexerCardBadge, type SaudeIndexerRow } from './saude-model.js';

export interface ViewSaudeProps {
  general?: Record<string, any>;
  debrid?: Record<string, any>;
  conta?: Record<string, any>;
  searchFirst?: Record<string, any>;
  indexers?: Record<string, any>[];
  /** Clique no chip: leva à aba Diagnóstico com o id pré-preenchido. */
  onSelectIndexer?: (id: string) => void;
}

// Chip de um indexador. O breaker aberto é o único destaque de borda (o
// indexer está fora do orçamento de busca); o resto da leitura vem dos badges
// de estado, com o rótulo fiel (degradado ≠ offline).
function IndexerChip({ row, onSelect }: { row: SaudeIndexerRow; onSelect?: (id: string) => void }) {
  const title = [
    row.id,
    row.stateLabel,
    row.ms != null ? `${row.ms} ms` : null,
    row.breakerOpen ? 'circuito aberto' : null,
  ].filter(Boolean).join(' · ');
  return html`
    <button
      type="button"
      class=${'painel-chip' + (row.breakerOpen ? ' painel-chip-open' : '')}
      title=${title}
      onClick=${() => onSelect?.(row.id)}
    >
      <span class="painel-chip-label">${row.label}</span>
      ${row.isBr ? html`<span class="painel-badge painel-badge-neutral">BR</span>` : null}
      <span class=${'painel-badge painel-badge-' + row.variant}>${row.stateLabel}</span>
      ${row.ms != null ? html`<span class="painel-chip-ms">${row.ms} ms</span>` : null}
      ${row.breakerOpen ? html`<span class="painel-badge painel-badge-err">CIRCUITO</span>` : null}
    </button>
  `;
}

function IndexadoresCard({ indexers, onSelectIndexer }: { indexers?: Record<string, any>[]; onSelectIndexer?: (id: string) => void }) {
  const rows = indexerRows(indexers);
  const summary = indexerSummary(rows);
  const parts = [
    `${summary.total} indexador(es)`,
    `${summary.online} online`,
    `${summary.slow} lento`,
    `${summary.degraded} degradado`,
    `${summary.offline} offline`,
  ];
  if (summary.unknown > 0) parts.push(`${summary.unknown} desconhecido`);

  return html`
    <${Card} title="Indexadores (Jackett)" badge=${indexerCardBadge(summary)}>
      ${rows.length === 0 ? html`
        <div class="painel-empty painel-empty-sm">Catálogo de indexadores ainda não carregado.</div>
      ` : html`
        <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">${parts.join(' · ')}</p>
        ${summary.breakerOpen > 0 ? html`
          <p style="color: var(--red); margin: 0; font-size: var(--font-floor);">
            ${summary.breakerOpen} com o circuito aberto — fora do orçamento de busca
          </p>
        ` : null}
        ${summary.brOffline > 0 ? html`
          <p style="color: var(--amber); margin: 0; font-size: var(--font-floor);">
            ${summary.brOffline} fonte(s) BR offline — o dublado pode faltar
          </p>
        ` : null}
        <div class="painel-chip-list">
          ${rows.map((row) => html`<${IndexerChip} key=${row.id} row=${row} onSelect=${onSelectIndexer} />`)}
        </div>
      `}
    </${Card}>
  `;
}

export function ViewSaude({ general, debrid, conta, searchFirst, indexers, onSelectIndexer }: ViewSaudeProps) {
  const isOk = general?.ok && (conta?.ok || debrid?.account?.ok);
  const verdictVariant = isOk ? 'ok' : 'err';
  const verdictText = isOk ? 'SISTEMA OPERACIONAL' : 'ATENÇÃO REQUERIDA';

  const services = general?.services || {};
  const uptime = general?.uptimeS != null ? formatDurationMs(general.uptimeS * 1000) : '—';

  return html`
    <div class="painel-grid">
      <${Card}
        title="Veredito do Sistema"
        badge=${{ text: verdictText, variant: verdictVariant }}
      >
        <div class="painel-stat-group">
          <span class="painel-stat-num">${isOk ? 'Tudo certo' : 'Verifique alertas'}</span>
        </div>
        <p style="color: var(--muted); margin: 0;">Uptime do processo: ${uptime}</p>
      </${Card}>

      <${Card} title="Serviços Essenciais">
        <div style="display: flex; flex-direction: column; gap: var(--space-2);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Adom Addon</span>
            <span class="painel-badge painel-badge-ok">ONLINE</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Jackett</span>
            <span class=${'painel-badge ' + (services.jackett === true ? 'painel-badge-ok' : services.jackett === 'naomedido' ? 'painel-badge-neutral' : 'painel-badge-err')}>
              ${services.jackett === true ? 'ONLINE' : services.jackett === 'naomedido' ? 'NÃO MEDIDO' : 'OFFLINE'}
            </span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Debrid (${debrid?.active || conta?.service || '—'})</span>
            <span class=${'painel-badge ' + (conta?.ok || debrid?.account?.ok ? 'painel-badge-ok' : 'painel-badge-err')}>
              ${conta?.ok || debrid?.account?.ok ? 'CONECTADO' : 'DESCONECTADO'}
            </span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Resolvers BR Embutidos</span>
            <span class="painel-badge painel-badge-ok">${services.resolvers || 0} ATIVOS</span>
          </div>
        </div>
      </${Card}>

      <${IndexadoresCard} indexers=${indexers} onSelectIndexer=${onSelectIndexer} />

      <${Card} title="Primeira Resposta (I0)">
        <${StatNumber}
          value=${searchFirst?.brVisible ?? 0}
          target=${searchFirst?.responses ?? 0}
          label="BR entregues no cold"
        />
        <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
          BR encontrado: ${searchFirst?.brFound ?? 0} · Em cache: ${searchFirst?.brCached ?? 0}
        </p>
      </${Card}>
    </div>
  `;
}
