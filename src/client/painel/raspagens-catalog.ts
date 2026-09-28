// Catálogo de sites da aba Raspagens: a tabela BR do backend (`crawl.catalog`)
// com um botão Ligar/Desligar por site. Substitui a lista "Sites na Rotação",
// que só mostrava `CRAWL_SITES` — um site com adaptador fora do `.env` nem
// aparecia, e ligá-lo exigia editar o `.env` da VPS e reiniciar.
//
// Ligar/desligar é o override `enabled` do site (`crawl-site-config-set`), o
// MESMO campo do cartão de ajuste; aqui é o atalho de um clique. O kill-switch
// do motor continua sendo o `enabled` global (cartão de configuração ao vivo).
import { html } from './vendor/preact.js';
import { Card } from './kit.js';
import { siteRotationLabel } from './raspagens-site.js';
import type { CrawlSummary, CrawlSiteCard } from './raspagens-model.js';

export interface CatalogEntry {
  id: string;
  label: string;
  adapter: boolean;
  note: string | null;
  inEnv: boolean;
  configured: boolean;
  enabled: boolean;
  enabledOverridden: boolean;
}

/** Normaliza `crawl.catalog`; backend antigo (sem o campo) vira lista vazia. */
export function crawlCatalog(crawl: Record<string, any> | null | undefined): CatalogEntry[] {
  const raw = crawl && Array.isArray(crawl.catalog) ? crawl.catalog : [];
  return raw
    .filter((e: any) => e && typeof e.id === 'string' && e.id)
    .map((e: any) => ({
      id: e.id,
      label: typeof e.label === 'string' && e.label ? e.label : e.id,
      adapter: e.adapter === true,
      note: typeof e.note === 'string' ? e.note : null,
      inEnv: e.inEnv === true,
      configured: e.configured === true,
      enabled: e.enabled === true,
      enabledOverridden: e.enabledOverridden === true,
    }));
}

/** De onde vem o liga/desliga — o operador precisa saber se o `.env` manda. */
export function catalogOrigin(entry: CatalogEntry): string {
  if (!entry.adapter) return entry.note || 'sem adaptador';
  if (entry.enabledOverridden) return entry.inEnv ? 'painel (sobrepõe o .env)' : 'ligado pelo painel';
  return entry.inEnv ? 'padrão do .env' : 'fora do .env';
}

export interface SitesCatalogCardProps {
  catalog: CatalogEntry[];
  cards: CrawlSiteCard[];
  summary: CrawlSummary;
  pending: boolean;
  onToggle: (entry: CatalogEntry) => void;
}

export function SitesCatalogCard({ catalog, cards, summary, pending, onToggle }: SitesCatalogCardProps) {
  // Backend sem catálogo: mantém a lista antiga (só `CRAWL_SITES`, sem botão).
  if (catalog.length === 0) {
    return html`
      <${Card} title="Sites da Raspagem">
        ${summary.sitesConfigured.length === 0
          ? html`<p style="color: var(--muted); font-size: var(--font-floor);">Nenhum site em CRAWL_SITES.</p>`
          : html`<ul class="painel-list">${summary.sitesConfigured.map((id) => html`<li key=${id}><code>${id}</code></li>`)}</ul>`}
      </${Card}>
    `;
  }
  return html`
    <${Card} title="Sites da Raspagem">
      <ul class="painel-list">
        ${catalog.map((entry) => {
          const card = cards.find((c) => c.id === entry.id);
          const state = !entry.adapter
            ? 'indisponível'
            : !entry.enabled
              ? 'desligado'
              : card ? siteRotationLabel(card.override, card.probe, card.active, card.total > 0) : 'ligado';
          return html`
            <li key=${entry.id} class="painel-raspagem-catalog-row" style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
              <span style="flex: 1; min-width: 12rem;">
                <strong>${entry.label}</strong> <code>${entry.id}</code>${entry.id === summary.site ? ' · ativo' : ''} · ${state}
                <span style="color: var(--muted); font-size: var(--font-floor);"> (${catalogOrigin(entry)})</span>
              </span>
              <button
                class="painel-btn ${entry.enabled ? 'painel-btn-danger' : 'painel-btn-accent'}"
                disabled=${pending || !entry.adapter}
                onClick=${() => onToggle(entry)}
              >
                ${entry.enabled ? 'Desligar' : 'Ligar'}
              </button>
            </li>
          `;
        })}
      </ul>
      <p class="painel-field-hint" style="margin-top: var(--space-2);">
        Liga/desliga por site, ao vivo e persistido. O motor inteiro continua dependendo da chave global
        ${summary.enabled === false ? html` — <strong>hoje desligada</strong>, então nenhum site raspa` : null}.
      </p>
    </${Card}>
  `;
}
