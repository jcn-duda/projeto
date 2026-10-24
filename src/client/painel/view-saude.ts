import { html } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';
import { formatDurationMs } from './fmt.js';
import {
  indexerRows, indexerSummary, indexerCardBadge, debridInfo, saudeVerdict, indexerMemoryLabel,
  type SaudeIndexerRow,
} from './saude-model.js';

export interface ViewSaudeProps {
  general?: Record<string, any>;
  debrid?: Record<string, any>;
  conta?: Record<string, any>;
  searchFirst?: Record<string, any>;
  indexers?: Record<string, any>[];
  /** Clique no chip: leva à aba Diagnóstico com o id pré-preenchido. */
  onSelectIndexer?: (id: string) => void;
}

// Linha de um indexador. Colunas FIXAS (estado · nome · BR · ms · badge ·
// extras) para as linhas alinharem entre si; o nome longo corta com reticências
// e o id completo fica no title. O breaker aberto é o único destaque de borda
// (o indexer está fora do orçamento de busca); o resto vem do badge de estado,
// com o rótulo fiel (degradado ≠ offline).
function IndexerChip({ row, onSelect, memoryMeasured }: {
  row: SaudeIndexerRow;
  onSelect?: (id: string) => void;
  /** Algum indexer tem o contador de memória? Sem nenhum, a lacuna vai UMA vez
   * na legenda do card em vez de repetir "não medido" em toda linha. */
  memoryMeasured: boolean;
}) {
  // O indicador de memória é HISTÓRICO de cobertura (contador desde o boot) e
  // entra no title com a ressalva explícita — não é o estado online, que
  // continua no badge de estado. `null` com outros medidos vira "MEM —": sumir
  // esconderia a lacuna e 0 passaria por medida.
  const memoryTitle = indexerMemoryLabel(row);
  const memoryBadge = row.servedFromMemory == null
    ? memoryMeasured
      ? html`<span class="painel-badge painel-badge-neutral" title=${memoryTitle || ''}>MEM —</span>`
      : null
    : row.servedFromMemory > 0
      ? html`<span class="painel-badge painel-badge-neutral" title=${memoryTitle || ''}>MEM ${row.servedFromMemory}</span>`
      : null;
  const title = [
    row.id,
    row.stateLabel,
    row.ms != null ? `${row.ms} ms` : null,
    row.breakerOpen ? 'circuito aberto' : null,
    memoryTitle,
  ].filter(Boolean).join(' · ');
  return html`
    <button
      type="button"
      class=${'painel-chip painel-ix' + (row.breakerOpen ? ' painel-chip-open' : '')}
      title=${title}
      onClick=${() => onSelect?.(row.id)}
    >
      <span class=${'painel-ix-dot painel-ix-dot-' + row.variant} aria-hidden="true"></span>
      <span class="painel-ix-main">
        <span class="painel-chip-label painel-ix-name">${row.label}</span>
        ${row.breakerOpen ? html`<span class="painel-badge painel-badge-err">CIRCUITO</span>` : null}
        ${memoryBadge}
      </span>
      <span class="painel-ix-br">${row.isBr ? html`<span class="painel-ix-tag">BR</span>` : null}</span>
      <span class="painel-chip-ms painel-ix-ms">${row.ms != null ? `${row.ms} ms` : '—'}</span>
      <span class="painel-ix-state">
        <span class=${'painel-badge painel-badge-' + row.variant}>${row.stateLabel}</span>
      </span>
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
  const memoryMeasured = rows.some((row) => row.servedFromMemory != null);
  // Nenhum contador de memória: a lacuna aparece uma vez, com o porquê.
  if (rows.length > 0 && !memoryMeasured) parts.push('MEM NÃO MEDIDO');

  return html`
    <${Card} title="Indexadores (Jackett)" badge=${indexerCardBadge(summary)} className="painel-card-full">
      ${rows.length === 0 ? html`
        <div class="painel-empty painel-empty-sm">Catálogo de indexadores ainda não carregado.</div>
      ` : html`
        <p
          style="color: var(--muted); margin: 0; font-size: var(--font-floor);"
          title=${memoryMeasured ? '' : 'cobertura de memória não medida — o contador fallback.indexer.<id> não tem produtor'}
        >${parts.join(' · ')}</p>
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
        <div class="painel-ix-list">
          ${rows.map((row) => html`<${IndexerChip} key=${row.id} row=${row} onSelect=${onSelectIndexer} memoryMeasured=${memoryMeasured} />`)}
        </div>
      `}
    </${Card}>
  `;
}

export function ViewSaude({ general, debrid, conta, searchFirst, indexers, onSelectIndexer }: ViewSaudeProps) {
  const verdict = saudeVerdict(general, debrid, conta);
  const dbrd = debridInfo(debrid, conta);

  const services = general?.services || {};
  const uptime = general?.uptimeS != null ? formatDurationMs(general.uptimeS * 1000) : '—';

  return html`
    <div class="painel-grid">
      <${Card}
        title="Veredito do Sistema"
        badge=${{ text: verdict.text, variant: verdict.variant }}
      >
        <div class="painel-stat-group">
          <span class="painel-stat-num">${verdict.headline}</span>
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
            <span>Debrid (${dbrd.service})</span>
            <span class=${'painel-badge painel-badge-' + dbrd.variant}>${dbrd.label}</span>
          </div>
          ${dbrd.state === 'por-instalacao' || dbrd.state === 'operador' ? html`
            <p class="painel-action-note" style="margin: 0;">
              A chave do .env não é emprestada por padrão: cada instalação traz a sua.
              ${dbrd.operatorAccount ? ' A conta do operador (Chupim, Limpeza, varreduras) está verificada no servidor.' : ''}
            </p>
          ` : null}
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Resolvers BR Embutidos</span>
            <span class="painel-badge painel-badge-ok">${services.resolvers || 0} ATIVOS</span>
          </div>
        </div>
      </${Card}>

      <${IndexadoresCard} indexers=${indexers} onSelectIndexer=${onSelectIndexer} />

      <${Card} title="Primeira Resposta (I0)">
        ${searchFirst?.available === false ? html`
          <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
            NÃO MEDIDO — ${searchFirst?.reason || 'sem fonte nativa para o primeiro resultado'}
          </p>
        ` : html`
          <${StatNumber}
            value=${searchFirst?.brVisible ?? 0}
            target=${searchFirst?.responses ?? 0}
            label="BR entregues no cold"
          />
          <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
            BR encontrado: ${searchFirst?.brFound ?? 0} · Em cache: ${searchFirst?.brCached ?? 0}
          </p>
        `}
      </${Card}>
    </div>
  `;
}
