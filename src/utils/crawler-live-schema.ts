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
import config from '../config.js';

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
  // Teto de páginas por hora (educação com o site).
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
  // Sites ligados (ids de card do Jackett). Vem do `.env` (`CRAWL_SITES`) e
  // NÃO é editável ao vivo — o schema do painel é boolean|number e o cliente
  // está fora do escopo desta fase; por isso `sites` não entra em `ALL_KEYS`.
  sites: string[];
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

export const BOOLEAN_KEYS = new Set<string>(['enabled', 'dryRun']);

export const NUMBER_KEYS = new Set<string>([
  'delayMs',
  'maxPerHour',
  'idleWindowMs',
  'maxTries',
  'errorPauseStreak',
  'layoutCanary',
  'incrementalIntervalMin',
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
    sites: config.crawl.sites,
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
      label: 'Teto de Páginas por Hora',
      type: 'number',
      group: 'traffic',
      min: 1,
      max: 20_000,
      step: 100,
      unit: 'páginas/hora',
      envDefault: env.maxPerHour,
      description: 'Número máximo de páginas processadas por hora.',
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
      }
      clean[k as keyof CrawlerLiveConfig] = clamped as never;
      overriddenKeys.push(k);
    }
  }

  return { clean, errors, overriddenKeys };
}
