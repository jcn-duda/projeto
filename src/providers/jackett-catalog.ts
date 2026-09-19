import config from '../config.js';
import * as indexerStatus from './indexer-status.js';
import * as log from '../utils/logger.js';

interface CatalogItem {
  id: string;
  label: string;
  language: string;
  isBr: boolean;
}

/** Procedência do catálogo: live = API Jackett respondeu; fallback = .env sem prova de rede. */
type CatalogSource = 'live' | 'fallback';

type CatalogList = ReturnType<typeof indexerStatus.decorate> & { source: CatalogSource };

let cached: CatalogItem[] | null = null;
let cachedSource: CatalogSource = 'fallback';
let cachedAt = 0;
let inFlight: Promise<{ items: CatalogItem[]; source: CatalogSource }> | null = null;

function attrs(text: string) {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
  let match;
  while ((match = re.exec(text))) out[match[1].toLowerCase()] = decodeXml(match[3]);
  return out;
}

function safeId(id: unknown) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(id || ''));
}

// `-cardigann` é detalhe de IMPLEMENTAÇÃO do id (card local do Jackett, para
// não disputar o nome com o indexer interno homônimo) e não pertence ao rótulo
// que o usuário lê: "Hdrtorrent Cardigann" vira "Hdrtorrent". Só o fallback do
// .env passa por aqui — no catálogo vivo o rótulo é o `name` do próprio Jackett
// ("HDR Torrents"), que nunca carregou o sufixo. O id, esse, não muda.
function labelFor(id: string) {
  return String(id)
    .replace(/-cardigann$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function decodeXml(text: string) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  // Uma passagem só evita decodificar duas vezes `&#38;amp;`. Entidade numérica
  // inválida fica literal em vez de derrubar todo o catálogo com RangeError.
  return String(text || '').replace(/&(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity) => {
    const body = entity.slice(1, -1).toLowerCase();
    if ((named as Record<string, string>)[body] != null) return (named as Record<string, string>)[body];
    const value = body.startsWith('#x') ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      return entity;
    }
    return String.fromCodePoint(value);
  });
}

function tag(body: string, name: string) {
  const match = String(body || '').match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, '').trim()) : '';
}

function parseXml(xml: string) {
  const items: CatalogItem[] = [];
  const re = /<(?:indexer|torznab:indexer)\b([^>]*)>([\s\S]*?)<\/(?:indexer|torznab:indexer)>/gi;
  let match;
  while ((match = re.exec(String(xml || '')))) {
    const a = attrs(match[1]);
    const id = String(a.id || a.identifier || '').toLowerCase();
    if (!safeId(id)) continue;
    const language = a.language || a.languages || tag(match[2], 'language');
    items.push({
      id,
      label: String(a.name || a.label || tag(match[2], 'title') || id),
      language: String(language),
      // A mesma lista governa query pt-BR, timeout e marca de origem. Inferir
      // por idioma aqui criaria uma classificação paralela e inconsistente.
      isBr: config.jackett.ptBrIndexers.includes(String(id)),
    });
  }
  return items;
}

function fallback() {
  const ids = [
    ...config.jackett.indexers,
    ...config.jackett.ptBrIndexers,
    ...config.jackett.slowIndexers,
  ];
  const seen = new Set();
  return ids.filter(safeId).filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((id) => ({
    id,
    label: labelFor(id),
    language: config.jackett.ptBrIndexers.includes(id) ? 'pt-BR' : '',
    isBr: config.jackett.ptBrIndexers.includes(id),
  }));
}

function attachSource(items: ReturnType<typeof indexerStatus.decorate>, source: CatalogSource): CatalogList {
  // Array continua Array: `.length`/`.map`/`.some` dos consumidores intactos;
  // `source` é aditivo para o painel (tri-estado do services.jackett).
  return Object.assign(items, { source });
}

// Fallback do .env por falha de rede vale pouco: no boot o addon pede o
// catálogo antes do Jackett terminar de subir, e com o TTL cheio a /configure
// passava 15 min sem os indexers que só existem no Jackett (LimeTorrents na
// VPS, 2026-09-18) — e quem gerava a URL nessa janela perdia o indexer.
const FALLBACK_RETRY_MS = 30_000;

function cacheTtlMs(): number {
  const full = config.jackett.catalogTtl * 1000;
  return cachedSource === 'fallback' && config.jackett.apiKey ? Math.min(full, FALLBACK_RETRY_MS) : full;
}

async function load(): Promise<CatalogList> {
  if (cached && Date.now() - cachedAt < cacheTtlMs()) {
    return attachSource(indexerStatus.decorate(cached), cachedSource);
  }
  if (inFlight) {
    return inFlight.then(({ items, source }) => attachSource(indexerStatus.decorate(items), source));
  }
  const promise = (async (): Promise<{ items: CatalogItem[]; source: CatalogSource }> => {
    try {
      if (!config.jackett.apiKey) return { items: fallback(), source: 'fallback' };
      const endpoint = new URL(`${config.jackett.url}/api/v2.0/indexers/all/results/torznab/api`);
      endpoint.searchParams.set('apikey', config.jackett.apiKey);
      endpoint.searchParams.set('t', 'indexers');
      endpoint.searchParams.set('configured', 'true');
      const res = await fetch(endpoint, {
        headers: { Accept: 'application/xml,text/xml', 'User-Agent': 'stremio-adom/1.0' },
        signal: AbortSignal.timeout(config.jackett.indexerTimeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // API respondeu: medição real mesmo se o XML veio vazio. Antes caía no
      // fallback do .env e o painel pintava Jackett "vivo" sem prova de rede.
      return { items: parseXml(await res.text()), source: 'live' };
    } catch (err) {
      log.warn('[jackett] catálogo indisponível:', (err as Error)?.message || err);
      return { items: fallback(), source: 'fallback' };
    }
  })().then((result) => {
    cached = result.items;
    cachedSource = result.source;
    cachedAt = Date.now();
    if (result.source === 'live') syncAutoIndexers(result.items);
    return result;
  }).finally(() => { inFlight = null; });
  inFlight = promise;
  return promise.then(({ items, source }) => attachSource(indexerStatus.decorate(items), source));
}

/**
 * Modo automático (sem JACKETT_INDEXERS no .env): a lista padrão passa a ser
 * todo indexer configurado no Jackett. Troca o CONTEÚDO do array no lugar —
 * runtime, busca, warmup e colhedor leem a mesma referência. Catálogo vivo
 * vazio não apaga a lista anterior (Jackett reiniciando não zera a busca).
 */
function syncAutoIndexers(items: readonly CatalogItem[]): boolean {
  if (!config.jackett.indexersAuto || items.length === 0) return false;
  const ids = [...new Set(items.map((item) => item.id))];
  const current = config.jackett.indexers;
  if (ids.length === current.length && ids.every((id, i) => current[i] === id)) return false;
  current.splice(0, current.length, ...ids);
  log.info(`[jackett] indexers automáticos pelo Jackett: ${ids.length} (${ids.join(', ')})`);
  return true;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Mantém o catálogo (e a lista automática) em dia: no boot o Jackett costuma
 * subir DEPOIS do addon, então tenta a cada 30s até a API responder e, dali
 * em diante, a cada JACKETT_CATALOG_TTL. Resolve quando o primeiro catálogo
 * vivo chega (ou desiste do await após `waitMs`, seguindo em fundo).
 */
function startAutoRefresh(waitMs = 60_000): Promise<void> {
  if (!config.jackett.apiKey) return Promise.resolve();
  let settle: () => void = () => {};
  const firstLive = new Promise<void>((resolve) => { settle = resolve; });
  const tick = async () => {
    let live = false;
    try { live = (await load()).source === 'live'; } catch { live = false; }
    if (live) settle();
    const next = live ? Math.max(60_000, config.jackett.catalogTtl * 1000) : FALLBACK_RETRY_MS;
    refreshTimer = setTimeout(tick, next);
    refreshTimer.unref?.();
  };
  if (!refreshTimer) void tick();
  const giveUp = setTimeout(() => settle(), waitMs);
  giveUp.unref?.();
  return firstLive;
}

/** Testes: esvazia memo do catálogo (cada teste decide live vs fallback). */
function resetCatalogCache() {
  cached = null;
  cachedSource = 'fallback';
  cachedAt = 0;
  inFlight = null;
}

export { load, parseXml, fallback, resetCatalogCache, syncAutoIndexers, startAutoRefresh };
export type { CatalogSource, CatalogList };
