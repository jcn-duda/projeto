import config from '../config.js';
import type { RawItem } from '../../types/domain.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';

/**
 * Pool GLOBAL Torrentio (Fase 1).
 *
 * Consulta a API pública do Torrentio (sem config nem credencial de debrid —
 * nada do usuário sai do processo) para trazer releases já indexadas no acervo
 * global do serviço. É uma fonte extra no mesmo balde dos indexers, sujeita ao
 * orçamento da coleta e ao dedupe por hash; falha NUNCA derruba a busca —
 * devolve `[]`.
 *
 * Como a chave é pública, nada de `apiKey`/debrid aqui. O `fileIdx` que o
 * Torrentio propaga por stream é preservado inteiro no item cru para uma fase
 * posterior poder escolher o arquivo exato no play; hoje ele atravessa o
 * pipeline como campo, sem tocar file-selector/HMAC.
 */
interface SearchArgs {
  type: string;
  imdbId: string;
  season?: number | null;
  episode?: number | null;
}

const INFO_HASH = /^[0-9a-f]{40}$/i;
// Linha de metadados no `title` do Torrentio: `👤 seeders 💾 X IB ⚙️ fonte`.
// O ⚙️ pode terminar em "| Torrentio"; o source é tudo que vem depois do ⚙️.
const METADATA_LINE = /^\s*👤\s*([\d.,]+)\s*💾\s*([\d.]+)\s*(TB|GB|MB|KB)\s*⚙️\s*(.+)$/i;
const SIZE_MULT: Record<'TB' | 'GB' | 'MB' | 'KB', number> = {
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

/** "1,234" → 1234 (removendo separador de milhar); ponto decimal preservado. */
function toNumber(text: string): number {
  const n = Number(String(text).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function parseSizeBytes(value: number, unit: string): number {
  const mult = SIZE_MULT[unit.toUpperCase() as keyof typeof SIZE_MULT];
  return mult ? Math.round(value * mult) : 0;
}

/** Extrai a linha de metadados do `title` e devolve o texto DEPOIS de removê-la
 * (linhas de arquivo e anotações como `[RD+]` preservadas). */
function parseMetadata(title: string) {
  const lines = String(title || '').split('\n');
  let seeders: number | null = null;
  let sizeBytes = 0;
  let source = '';
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(METADATA_LINE);
    if (m) {
      seeders = toNumber(m[1]);
      sizeBytes = parseSizeBytes(toNumber(m[2]), m[3]);
      source = String(m[4]).trim();
      continue;
    }
    if (line) kept.push(line);
  }
  return { title: kept.join('\n'), seeders, sizeBytes, source };
}

/* ---------------- Circuit breaker local (não é o do Jackett) ---------------- */

let breakerFailures = 0;
let breakerOpenedAt = 0;

function breakerOpen(): boolean {
  if (!config.torrentio.breakerFailures) return false;
  if (breakerFailures < config.torrentio.breakerFailures) return false;
  // Cooldown expirou -> half-open: uma tentativa é permitida; falha reabre.
  return Date.now() - breakerOpenedAt < config.torrentio.breakerCooldown;
}

function noteFailure() {
  breakerFailures += 1;
  if (breakerFailures >= config.torrentio.breakerFailures) {
    breakerOpenedAt = Date.now();
    if (breakerFailures === config.torrentio.breakerFailures) {
      metrics.count('torrentio.breaker.open');
      log.warn(`[torrentio] circuito aberto após ${breakerFailures} falha(s) seguidas`);
    }
  }
}

function noteSuccess() {
  if (breakerFailures === 0) return;
  breakerFailures = 0;
  breakerOpenedAt = 0;
}

/** Reset do circuito para testes (o estado é singleton do processo). */
function _resetBreaker() {
  breakerFailures = 0;
  breakerOpenedAt = 0;
}

/* ---------------- Busca ---------------- */

function endpointUrl({ type, imdbId, season, episode }: SearchArgs): string | null {
  const base = config.torrentio.url;
  if (type === 'movie') {
    if (!imdbId) return null;
    return `${base}/stream/${type}/${imdbId}.json`;
  }
  if (type !== 'series' || !imdbId || season == null || episode == null) return null;
  return `${base}/stream/series/${imdbId}:${season}:${episode}.json`;
}

function mapStream(s: any): RawItem | null {
  const infoHash = String(s?.infoHash || '').trim();
  if (!INFO_HASH.test(infoHash)) return null;
  const parsed = parseMetadata(s?.title);
  const titleText = parsed.title || String(s?.name || s?.title || '').trim();
  if (!titleText) return null;
  const fileIdx = s?.fileIdx == null || !Number.isFinite(Number(s.fileIdx))
    ? undefined
    : Math.trunc(Number(s.fileIdx));
  return {
    title: titleText,
    infoHash: infoHash.toLowerCase(),
    seeders: parsed.seeders ?? 0,
    size: parsed.sizeBytes > 0 ? parsed.sizeBytes : undefined,
    // O rótulo depois do ⚙️ alimenta o chip de origem como nos demais providers.
    tracker: parsed.source,
    // `tracker` é a origem indexada pelo Torrentio; `indexer` identifica quem
    // entregou o dado, para cota/prioridade não tratarem o agregador como uma
    // consulta direta ao TPB/1337x/TorrentGalaxy.
    indexer: 'torrentio',
    fileIdx,
  };
}

async function query(args: SearchArgs): Promise<RawItem[]> {
  if (!config.torrentio.enabled) return [];
  const url = endpointUrl(args);
  if (!url || breakerOpen()) return [];
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(config.torrentio.timeout),
    });
    if (!res.ok) {
      // 4xx (salvo rate limit) pertence à requisição/obra e não prova que o
      // host caiu. Só 429 e 5xx alimentam o breaker global da fonte.
      if (res.status < 500 && res.status !== 429) {
        log.warn(`[torrentio] HTTP ${res.status} para ${args.imdbId}`);
        return [];
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const data: any = await res.json();
    const raw = Array.isArray(data?.streams) ? data.streams : [];
    const seen = new Set<string>();
    const out: RawItem[] = [];
    for (const item of raw) {
      const parsed = mapStream(item);
      if (!parsed?.infoHash) continue;
      if (seen.has(parsed.infoHash)) continue;
      seen.add(parsed.infoHash);
      out.push(parsed);
    }
    noteSuccess();
    metrics.count('torrentio.streams', out.length);
    if (out.length) log.debug(`[torrentio] ${out.length} release(s) para ${args.imdbId}`);
    return out;
  } catch (err: any) {
    // Timeout/aborto são falha transitória; o breaker protege o host público.
    noteFailure();
    log.warn(`[torrentio] falha na consulta de ${args.imdbId}:`, err?.message || String(err));
    return [];
  }
}

async function search(args: SearchArgs): Promise<RawItem[]> {
  return query(args);
}

export { search, _resetBreaker };
