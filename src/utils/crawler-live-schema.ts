// Contrato e validação da config ao vivo do CRAWLER (Fase 4 do plano
// "Raspagem total"). Separado do estado (crawler-live.ts) pelo mesmo motivo do
// irmão harvester-live-schema.ts: o schema é a ÚNICA fonte dos limites — os
// clamps do sanitizePatch aparecem nos campos min/max, e manter os dois juntos
// impede que um ajuste de teto escape da validação. Módulo puro: nenhuma
// mutação de estado, nenhuma escrita em cache.
//
// Molde do colhedor (boolean|number): `sites` NÃO é campo ao vivo de propósito
// — é lista, e o `LiveConfigCard` do painel dirige-se pelo schema (fora de
// escopo tocar o cliente). Sites continuam vindo do `.env` (`CRAWL_SITES`).
//
// Fase 8: o override POR SITE mora no irmão `crawler-live-site.ts` (é mapa, não
// escalar — tem subset fechado, clamps próprios e trava de segurança); aqui
// ficam só os escalares globais, inclusive o `requireProbe` (gate da sonda),
// que é decisão da FASE e não de um site.
import config from '../config.js';

import type { CrawlSeriesLimits } from '../providers/crawl-types.js';
import { sanitizeSitePatch, type CrawlerSiteOverrides } from './crawler-live-site.js';

export type { CrawlerSiteConfig, CrawlerSiteOverride, CrawlerSiteOverrideKey, CrawlerSiteOverrides } from './crawler-live-site.js';
export { SITE_OVERRIDE_KEYS, cadenceDelayMs, knownSites, sanitizeSitePatch, siteConfigOf, withCadence } from './crawler-live-site.js';

/** Limites da Fase 7 (séries) a partir da config efetiva (snapshot do tick).
 * Aceita a config global E a config por site (Fase 8): os três campos são os
 * mesmos nos dois, e o motor sempre os repassa do snapshot do tick. */
export function seriesLimitsOf(live: {
  seriesEnabled: boolean; seriesMaxCards: number; seriesMaxButtons: number;
}): CrawlSeriesLimits {
  return { enabled: live.seriesEnabled === true, maxCards: live.seriesMaxCards, maxButtons: live.seriesMaxButtons };
}

export interface CrawlerLiveConfig {
  // Kill-switch geral (CRAWL_ENABLED): ligar/desligar a raspagem sem restart.
  // Contrato de segurança: o default do `.env` é `false` (desligado), mas o
  // painel PODE habilitar ao vivo (requisito da Fase 4) e o override persiste
  // em `cfg:v1:crawler` como decisão explícita do operador — sobrevive ao
  // restart até um `crawl-config-reset`. Não é um bypass: a rota segue atrás do
  // `X-Indexer-Test-Token`.
  enabled: boolean;
  // Modo simulação (CRAWL_DRY_RUN): raspa e conta, sem gravar acervo.
  dryRun: boolean;
  // Pausa entre páginas (ritmo) e cadência do timer.
  delayMs: number;
  // Teto de REQUISIÇÕES por hora (educação com o site). Desde a Fase 7 o
  // custo é REAL: página de série com N cards e M saltos de protetor custa
  // N+M+2, não 1 — o nome da chave (`maxPerHour`) é legado por compatibilidade.
  maxPerHour: number;
  // Janela de ociosidade da janela deslizante de tráfego.
  idleWindowMs: number;
  // Tentativas por URL antes de dormir até o "Reprocessar erros".
  maxTries: number;
  // Erros de site SEGUIDOS que pausam automaticamente.
  errorPauseStreak: number;
  // Páginas SEGUIDAS sem botão (com torrent prévio) que pausam ("layout?").
  layoutCanary: number;
  // Ciclo incremental em minutos.
  incrementalIntervalMin: number;
  // Fase 7: descoberta de séries (tv_show-sitemap) ligada.
  seriesEnabled: boolean;
  // Teto de cards de temporada por página de série.
  seriesMaxCards: number;
  // Teto de botões de download seguidos por página de série.
  seriesMaxButtons: number;
  // Fase 8: gate da sonda — com `true`, site sem veredito GO não entra na
  // rotação. Vem do `.env` (`CRAWL_REQUIRE_PROBE`) e NÃO é sobrescritível por
  // site: é decisão do operador sobre a fase, não do site.
  requireProbe: boolean;
  // Sites ligados (ids de card do Jackett). Vem do `.env` (`CRAWL_SITES`) e
  // NÃO é editável ao vivo — o schema do painel é boolean|number e o cliente
  // está fora do escopo desta fase; por isso `sites` não entra em `ALL_KEYS`.
  sites: string[];
  // Fase 8: overrides por site (`siteOverrides[id]`), gravados pelo painel.
  // É MAPA, não escalar: por isso também não entra em `ALL_KEYS` — o caminho
  // de escrita é `sanitizeSitePatch` (valida o subconjunto fechado do site).
  siteOverrides: CrawlerSiteOverrides;
}

// A pausa manual NÃO entra aqui: é estado operacional do motor
// (`crawler.setPaused`), volátil por desenho — restart volta ao `.env`. O
// `cfg:v1:crawler` persiste só os knobs acima.
export type CrawlerEffectiveConfig = CrawlerLiveConfig;

export interface CrawlerSchemaField {
  key: keyof CrawlerLiveConfig;
  label: string;
  type: 'boolean' | 'number';
  group: 'engine' | 'traffic' | 'resilience';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  envDefault: boolean | number;
  description: string;
}

export const BOOLEAN_KEYS = new Set<string>(['enabled', 'dryRun', 'seriesEnabled', 'requireProbe']);

export const NUMBER_KEYS = new Set<string>([
  'delayMs',
  'maxPerHour',
  'idleWindowMs',
  'maxTries',
  'errorPauseStreak',
  'layoutCanary',
  'incrementalIntervalMin',
  'seriesMaxCards',
  'seriesMaxButtons',
]);

export const ALL_KEYS = new Set<string>([...BOOLEAN_KEYS, ...NUMBER_KEYS]);

export function envDefaults(): CrawlerLiveConfig {
  return {
    enabled: config.crawl.enabled,
    dryRun: config.crawl.dryRun,
    delayMs: config.crawl.delayMs,
    maxPerHour: config.crawl.maxPerHour,
    idleWindowMs: config.crawl.idleWindowMs,
    maxTries: config.crawl.maxTries,
    errorPauseStreak: config.crawl.errorPauseStreak,
    layoutCanary: config.crawl.layoutCanary,
    incrementalIntervalMin: config.crawl.incrementalIntervalMin,
    seriesEnabled: config.crawl.seriesEnabled,
    seriesMaxCards: config.crawl.seriesMaxCards,
    seriesMaxButtons: config.crawl.seriesMaxButtons,
    requireProbe: config.crawl.requireProbe,
    sites: config.crawl.sites,
    siteOverrides: {},
  };
}

export function schema(): CrawlerSchemaField[] {
  const env = envDefaults();
  return [
    {
      key: 'enabled',
      label: 'Raspagem Ativa',
      type: 'boolean',
      group: 'engine',
      envDefault: env.enabled,
      description: 'Liga ou desliga o motor da raspagem em segundo plano.',
    },
    {
      key: 'dryRun',
      label: 'Modo Simulação',
      type: 'boolean',
      group: 'engine',
      envDefault: env.dryRun,
      description: 'Raspa e conta sem gravar no banco vivo nem no índice (nenhum magnet é gravado).',
    },
    {
      key: 'incrementalIntervalMin',
      label: 'Intervalo Incremental',
      type: 'number',
      group: 'engine',
      min: 1,
      max: 1440,
      step: 1,
      unit: 'min',
      envDefault: env.incrementalIntervalMin,
      description: 'Frequência do ciclo que relê o sitemap e reprocessa só URL nova ou com lastmod novo.',
    },
    {
      key: 'seriesEnabled',
      label: 'Descoberta de Séries',
      type: 'boolean',
      group: 'engine',
      envDefault: env.seriesEnabled,
      description: 'Descobre séries pelo tv_show-sitemap (Fase 7). Desligada, a raspagem cobre só filmes.',
    },
    {
      key: 'seriesMaxCards',
      label: 'Teto de Temporadas por Série',
      type: 'number',
      group: 'traffic',
      min: 1,
      max: 50,
      step: 1,
      unit: 'cards',
      envDefault: env.seriesMaxCards,
      description: 'Cards de temporada/batch visitados no máximo por página de série (cada card é uma requisição).',
    },
    {
      key: 'seriesMaxButtons',
      label: 'Teto de Botões por Série',
      type: 'number',
      group: 'traffic',
      min: 1,
      max: 200,
      step: 5,
      unit: 'botões',
      envDefault: env.seriesMaxButtons,
      description: 'Botões de download seguidos (cadeia do protetor) no máximo por página de série.',
    },
    {
      key: 'delayMs',
      label: 'Pausa entre Páginas',
      type: 'number',
      group: 'traffic',
      min: 0,
      max: 60_000,
      step: 500,
      unit: 'ms',
      envDefault: env.delayMs,
      description: 'Intervalo entre requisições ao site (educação: bloqueio de IP custa dias).',
    },
    {
      key: 'maxPerHour',
      label: 'Teto de Requisições por Hora',
      type: 'number',
      group: 'traffic',
      min: 1,
      max: 20_000,
      step: 100,
      unit: 'requisições/h',
      envDefault: env.maxPerHour,
      description: 'Número máximo de requisições HTTP cobradas por hora (Fase 7: página, card e cada salto de protetor contam pelo custo REAL medido, não 1 por página).',
    },
    {
      key: 'idleWindowMs',
      label: 'Janela de Ociosidade',
      type: 'number',
      group: 'traffic',
      min: 0,
      max: 3_600_000,
      step: 10_000,
      unit: 'ms',
      envDefault: env.idleWindowMs,
      description: 'Tempo sem tráfego de usuário necessário para a raspagem rodar (tráfego preempta).',
    },
    {
      key: 'maxTries',
      label: 'Tentativas por URL',
      type: 'number',
      group: 'resilience',
      min: 1,
      max: 10,
      step: 1,
      unit: 'tentativas',
      envDefault: env.maxTries,
      description: 'Tentativas antes de a URL dormir até o "Reprocessar erros" do painel.',
    },
    {
      key: 'errorPauseStreak',
      label: 'Erros Seguidos p/ Pausar',
      type: 'number',
      group: 'resilience',
      min: 1,
      max: 100,
      step: 1,
      unit: 'erros',
      envDefault: env.errorPauseStreak,
      description: 'Erros de site seguidos (403/429/5xx/blocked_host/desafio) que pausam a raspagem.',
    },
    {
      key: 'layoutCanary',
      label: 'Canário de Layout',
      type: 'number',
      group: 'resilience',
      min: 1,
      max: 1000,
      step: 1,
      unit: 'páginas',
      envDefault: env.layoutCanary,
      description: 'Páginas seguidas que tinham torrent e voltaram sem botão que pausam com "layout mudou?".',
    },
    {
      key: 'requireProbe',
      label: 'Exigir Sonda (Fase 8)',
      type: 'boolean',
      group: 'resilience',
      envDefault: env.requireProbe,
      description: 'Com ligado, um site só entra na rotação depois do veredito GO da amostra de 40 páginas gravado pela sonda.',
    },
  ];
}

export function sanitizePatch(patch: Record<string, unknown>): {
  clean: Partial<CrawlerLiveConfig>;
  errors: string[];
  overriddenKeys: string[];
} {
  const clean: Partial<CrawlerLiveConfig> = {};
  const errors: string[] = [];
  const overriddenKeys: string[] = [];

  for (const [k, val] of Object.entries(patch)) {
    if (!ALL_KEYS.has(k)) {
      errors.push(`Chave desconhecida: "${k}"`);
      continue;
    }

    if (BOOLEAN_KEYS.has(k)) {
      if (typeof val === 'boolean') {
        clean[k as keyof CrawlerLiveConfig] = val as never;
        overriddenKeys.push(k);
      } else if (val === 'true' || val === 'false') {
        clean[k as keyof CrawlerLiveConfig] = (val === 'true') as never;
        overriddenKeys.push(k);
      } else {
        errors.push(`Valor inválido para "${k}": esperado boolean, recebido ${typeof val}`);
      }
      continue;
    }

    if (NUMBER_KEYS.has(k)) {
      const num = Number(val);
      if (!Number.isFinite(num)) {
        errors.push(`Valor inválido para "${k}": esperado número finito, recebido ${val}`);
        continue;
      }
      let clamped = num;
      // Os clamps são duplicados do schema de propósito: definem os MESMOS
      // min/max dos campos acima (mesma convenção do harvester-live-schema).
      switch (k) {
        case 'delayMs':
          clamped = Math.max(0, Math.min(60_000, Math.trunc(num)));
          break;
        case 'maxPerHour':
          clamped = Math.max(1, Math.min(20_000, Math.trunc(num)));
          break;
        case 'idleWindowMs':
          clamped = Math.max(0, Math.min(3_600_000, Math.trunc(num)));
          break;
        case 'maxTries':
          clamped = Math.max(1, Math.min(10, Math.trunc(num)));
          break;
        case 'errorPauseStreak':
          clamped = Math.max(1, Math.min(100, Math.trunc(num)));
          break;
        case 'layoutCanary':
          clamped = Math.max(1, Math.min(1000, Math.trunc(num)));
          break;
        case 'incrementalIntervalMin':
          clamped = Math.max(1, Math.min(1440, Math.trunc(num)));
          break;
        case 'seriesMaxCards':
          clamped = Math.max(1, Math.min(50, Math.trunc(num)));
          break;
        case 'seriesMaxButtons':
          clamped = Math.max(1, Math.min(200, Math.trunc(num)));
          break;
      }
      clean[k as keyof CrawlerLiveConfig] = clamped as never;
      overriddenKeys.push(k);
    }
  }

  return { clean, errors, overriddenKeys };
}

/**
 * Sanitiza o blob INTEIRO persistido em `cfg:v1:crawler` (Fase 8): escalares
 * pelo caminho global e `siteOverrides` pelo caminho de site (`sanitizeSitePatch`,
 * do módulo irmão). Site inválido é DESCARTADO (com aviso em `errors`) — um
 * override corrompido não pode derrubar o resto da config nem travar o motor
 * no boot.
 */
export function sanitizeStoredConfig(raw: Record<string, unknown>): {
  clean: Partial<CrawlerLiveConfig>;
  errors: string[];
} {
  // Os escalares vão SEM o mapa: o `sanitizePatch` não conhece `siteOverrides` e
  // logava "Chave desconhecida" a cada boot com ajuste de site gravado — aviso
  // falso (o mapa é lido logo abaixo) que ensinava a ignorar o aviso verdadeiro.
  const { siteOverrides: rawSites, ...scalars } = raw as Record<string, unknown> & { siteOverrides?: unknown };
  const { clean, errors } = sanitizePatch(scalars);
  const sites: CrawlerSiteOverrides = {};
  if (rawSites && typeof rawSites === 'object' && !Array.isArray(rawSites)) {
    for (const [siteId, value] of Object.entries(rawSites as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`Override de site inválido: "${siteId}"`);
        continue;
      }
      const site = sanitizeSitePatch(siteId, value as Record<string, unknown>);
      errors.push(...site.errors);
      if (Object.keys(site.clean).length > 0) sites[siteId.trim()] = site.clean;
    }
  }
  clean.siteOverrides = sites;
  return { clean, errors };
}
