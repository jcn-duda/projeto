// Histórico do SITE na aba Raspagens: últimas obras, páginas sem obra e erros
// agrupados. Saiu de `view-raspagens.ts` pela catraca de 400 linhas — são três
// tabelas de leitura, sem hook e sem fetch, que o card do site compõe.
import { html } from './vendor/preact.js';
import { Card } from './kit.js';
import { formatAgeFromTimestamp } from './fmt.js';
import { workLabel, type CrawlSiteCard } from './raspagens-model.js';

function age(checkedAt: number): string {
  return checkedAt ? formatAgeFromTimestamp(checkedAt) : '—';
}

export interface SiteHistoryProps {
  card: CrawlSiteCard;
}

export function SiteHistory({ card }: SiteHistoryProps) {
  return html`
    <div class="painel-grid" style="margin-top: var(--space-4);">
      <${Card} title="Últimas Obras">
        ${card.recentWorks.length === 0 ? html`
          <p style="color: var(--muted); font-size: var(--font-floor);">Nenhuma obra recente registrada.</p>
        ` : html`
          <table class="painel-table">
            <thead><tr><th>Obra</th><th>Visto</th></tr></thead>
            <tbody>
              ${card.recentWorks.map((w) => html`
                <tr key=${w.url}>
                  <td title=${w.url}>${workLabel(w)}</td>
                  <td>${age(w.checkedAt)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      </${Card}>

      <${Card} title="Sem Obra Identificada">
        ${card.noWorkList.length === 0 ? html`
          <p style="color: var(--muted); font-size: var(--font-floor);">Nenhuma página sem obra.</p>
        ` : html`
          <table class="painel-table">
            <thead><tr><th>Página</th><th>Visto</th></tr></thead>
            <tbody>
              ${card.noWorkList.map((w) => html`
                <tr key=${w.url}>
                  <td title=${w.url}>${w.url}</td>
                  <td>${age(w.checkedAt)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      </${Card}>
    </div>

    <div style="margin-top: var(--space-4);">
      <${Card} title="Erros Agrupados">
        ${card.errorGroups.length === 0 ? html`
          <p style="color: var(--muted); font-size: var(--font-floor);">Nenhum erro no estado do site.</p>
        ` : html`
          <table class="painel-table">
            <thead><tr><th>Motivo</th><th>Ocorrências</th></tr></thead>
            <tbody>
              ${card.errorGroups.map((g) => html`
                <tr key=${g.reason}>
                  <td>${g.reason}</td>
                  <td>${g.count}</td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
        ${card.errors.length > 0 ? html`
          <details style="margin-top: var(--space-3);">
            <summary>${card.errors.length} erro(s) recente(s)</summary>
            <table class="painel-table">
              <thead><tr><th>URL</th><th>Erro</th><th>Tentativas</th><th>Visto</th></tr></thead>
              <tbody>
                ${card.errors.map((e) => html`
                  <tr key=${e.url}>
                    <td title=${e.url}>${e.url}</td>
                    <td>${e.error || '—'}</td>
                    <td>${e.tries}</td>
                    <td>${age(e.checkedAt)}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          </details>
        ` : null}
      </${Card}>
    </div>
  `;
}
