// Catálogo de sites da aba Raspagens: a tabela BR do backend (`crawl.catalog`)
// com um toggle por site (rótulo = ligado/desligado, cor = saúde do site). Substitui a lista "Sites na Rotação",
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
  /** Saúde do site (backend): `online` no ar, `offline` caído. */
  health: CatalogHealth;
  healthDetail: string;
}

export type CatalogHealth = 'online' | 'instavel' | 'offline' | 'unknown';
const HEALTHS: CatalogHealth[] = ['online', 'instavel', 'offline', 'unknown'];

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
      // Backend sem o campo: desconhecido, nunca "no ar" por omissão.
      health: HEALTHS.includes(e.health) ? e.health : 'unknown',
      healthDetail: typeof e.healthDetail === 'string' ? e.healthDetail : 'sem medição',
    }));
}

/** De onde vem o liga/desliga — o operador precisa saber se o `.env` manda. */
export function catalogOrigin(entry: CatalogEntry): string {
  if (!entry.adapter) return entry.note || 'sem adaptador';
  if (entry.enabledOverridden) return entry.inEnv ? 'painel (sobrepõe o .env)' : 'painel';
  return entry.inEnv ? 'padrão do .env' : 'fora do .env';
}

/** Rótulo do toggle: o estado de liga/desliga (a COR é a saúde). */
export function toggleLabel(entry: CatalogEntry): string {
  if (!entry.adapter) return 'Indisponível';
  return entry.enabled ? '● Ligado' : '○ Desligado';
}

/** Texto curto da saúde na linha do site. */
export function healthText(entry: CatalogEntry): string {
  const word = { online: 'no ar', instavel: 'instável', offline: 'caído', unknown: 'sem medição' }[entry.health];
  return entry.health === 'unknown' ? word : `${word} — ${entry.healthDetail}`;
}

/**
 * Cor do toggle = SAÚDE do site (pedido do operador: verde é "online", não
 * "ligado"): verde no ar, âmbar instável, vermelho caído, neutro sem medição.
 * Inline porque o `painel.css` está no teto de linhas — os tokens são os
 * mesmos dos pills de status do painel.
 */
export function toggleStyle(entry: CatalogEntry): string {
  const base = 'min-width: 8.5rem;';
  const tone = { online: 'green', instavel: 'amber', offline: 'red', unknown: '' }[entry.health];
  if (!entry.adapter || !tone) return base;
  return `${base} background: var(--${tone}-soft); color: var(--${tone}); border-color: var(--${tone});`;
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
                ${entry.adapter ? html`<br /><span class="painel-raspagem-health" style="font-size: var(--font-floor);">${healthText(entry)}</span>` : null}
              </span>
              <button
                class="painel-btn painel-raspagem-toggle"
                style=${toggleStyle(entry)}
                aria-pressed=${entry.enabled ? 'true' : 'false'}
                title=${!entry.adapter ? 'sem adaptador' : entry.enabled ? 'clique para desligar' : 'clique para ligar'}
                disabled=${pending || !entry.adapter}
                onClick=${() => onToggle(entry)}
              >
                ${toggleLabel(entry)}
              </button>
            </li>
          `;
        })}
      </ul>
      <p class="painel-field-hint" style="margin-top: var(--space-2);">
        Clique alterna ligado/desligado (ao vivo e persistido); a cor é a saúde do site — verde no ar,
        âmbar instável, vermelho caído. O motor inteiro continua dependendo da chave global
        ${summary.enabled === false ? html` — <strong>hoje desligada</strong>, então nenhum site raspa` : null}.
      </p>
    </${Card}>
  `;
}
