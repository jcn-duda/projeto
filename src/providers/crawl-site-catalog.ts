// Catálogo de sites da raspagem para o painel: a tabela BR inteira (com e sem
// adaptador), cada linha com o estado de liga/desliga EFETIVO e de onde ele
// vem. É o que o painel usa para o botão Ligar/Desligar por site — inclusive
// para o site que NÃO está em `CRAWL_SITES` (ligar por override é o caminho
// sem editar o `.env` da VPS, que o deploy não toca).
//
// Leitura pura sobre a tabela estática do registro e a config ao vivo: não
// resolve adaptador (nenhum import dinâmico), não abre store.
import { SITE_TABLE } from './crawl-sites/registry.js';
import { knownSites, siteConfigOf, type CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';

export interface CrawlCatalogEntry {
  id: string;
  label: string;
  /** Há adaptador nesta rodada (sem ele o painel não oferece ligar). */
  adapter: boolean;
  note: string | null;
  /** Está em `CRAWL_SITES` (default do `.env`: ligado). */
  inEnv: boolean;
  /** Tem card no motor (`.env` ou override do painel). */
  configured: boolean;
  /** Liga/desliga EFETIVO do site (override do painel vence o `.env`). */
  enabled: boolean;
  /** O `enabled` veio de override do painel, não do `.env`. */
  enabledOverridden: boolean;
}

export function siteCatalog(live: CrawlerEffectiveConfig): CrawlCatalogEntry[] {
  const configured = new Set(knownSites(live));
  const inEnv = new Set(live.sites.map((s) => String(s || '').trim()));
  return SITE_TABLE.map((entry) => {
    const adapter = Boolean(entry.module && entry.exportName);
    const cfg = siteConfigOf(live, entry.id);
    return {
      id: entry.id,
      label: entry.label,
      adapter,
      note: adapter ? null : (entry.note ?? 'sem adaptador'),
      inEnv: inEnv.has(entry.id),
      configured: configured.has(entry.id),
      // Sem card no motor o site não trabalha, mesmo que a fusão diga `true`.
      enabled: configured.has(entry.id) && cfg.enabled,
      enabledOverridden: cfg.overridden.includes('enabled'),
    };
  });
}
