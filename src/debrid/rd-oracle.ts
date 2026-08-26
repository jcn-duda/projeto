// Oráculo multi-fonte de disponibilidade do Real-Debrid.
//
// O CDN/cache do RD pertence ao SERVIÇO, não à conta: se um hash está
// cacheado para uma chave, está para todas. Este módulo despacha consultas
// às fontes habilitadas (StremThru, Torrentio) em paralelo e funde os
// resultados. Qualquer erro devolve Map vazio — nunca lança.
//
// Regra de fusão: true de qualquer fonte vence (evidência positiva). false
// só conta de fonte que enumera com autoridade: StremThru item presente sem
// 'cached'; Torrentio listado sem [RD+] com hash extraível. Hash NÃO
// listado pelo Torrentio é DESCONHECIDO, nunca miss — o acervo BR dublado
// que interessa é justamente o que ele não indexa.
import config from '../config.js';
import * as cache from '../utils/cache.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { prefix } from '../utils/cache-keys.js';
import * as rdLedger from './rd-ledger.js';

export type OracleQuery = {
  hashes: string[];
  type: 'movie' | 'series';
  id: string; // imdbId, com :S:E quando série
  timeoutMs: number;
};

type OracleSource = {
  name: string;
  check: (q: OracleQuery, apiKey?: string) => Promise<Map<string, boolean>>;
};

// ─── StremThru ───────────────────────────────────────────────────────────────

async function checkStremthru(q: OracleQuery, _apiKey?: string): Promise<Map<string, boolean>> {
  const { stremthruUrl, stremthruToken, stremthruStore, maxHashes } = config.debrid.rdOracle;
  if (!stremthruUrl) return new Map();

  const result = new Map<string, boolean>();
  const batchSize = Math.min(500, Math.max(1, maxHashes));
  const targetHashes = q.hashes.slice(0, 500);
  let totalBatches = 0;
  let failedBatches = 0;

  // Lotes de maxHashes; StremThru aceita até 500 por chamada.
  for (let i = 0; i < targetHashes.length; i += batchSize) {
    totalBatches += 1;
    const batch = targetHashes.slice(i, i + batchSize);
    const url = `${stremthruUrl}/v0/store/torz/check?hash=${batch.join(',')}`;
    const headers: Record<string, string> = {
      'X-StremThru-Store-Name': stremthruStore,
    };
    if (stremthruToken) {
      headers['X-StremThru-Store-Authorization'] = `Bearer ${stremthruToken}`;
    }
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(q.timeoutMs),
      });
      if (!res.ok) {
        failedBatches += 1;
        continue;
      }
      const body = await res.json() as any;
      const items: any[] = body?.data?.items || [];
      // StremThru enumera os hashes consultados; item presente = resposta
      // autoritativa. 'cached' é hit; qualquer outro status é miss.
      for (const item of items) {
        const hash = String(item?.hash || '').toLowerCase();
        if (!hash) continue;
        result.set(hash, item.status === 'cached');
      }
    } catch {
      failedBatches += 1;
      /* fail-open: timeout/rede → sem veredicto */
    }
  }
  if (totalBatches > 0 && failedBatches === totalBatches) {
    log.warn(`[rd-oracle] StremThru indisponível: todos os ${totalBatches} lote(s) falharam`);
  }
  return result;
}

// ─── Torrentio ───────────────────────────────────────────────────────────────

const HASH_RE = /^[a-f0-9]{40}$/;

function hashFromUrl(url: string): string {
  const match = url.match(/([a-f0-9]{40})/i);
  return match ? match[1].toLowerCase() : '';
}

function torrentioCacheKey(type: string, id: string) {
  return `${prefix('rdt')}trt:${type}:${id}`;
}

async function checkTorrentio(q: OracleQuery, apiKey?: string): Promise<Map<string, boolean>> {
  const { torrentioUrl, torrentioKey, torrentioTtl } = config.debrid.rdOracle;
  if (!torrentioUrl) return new Map();

  // Cache por título: uma chamada por obra, TTL ~6h. É infra de terceiro;
  // não pode virar uma chamada por busca repetida.
  const cacheKey = torrentioCacheKey(q.type, q.id);
  const cached = cache.get(cacheKey) as Array<[string, boolean]> | Map<string, boolean> | null;
  if (cached instanceof Map) return cached;
  if (Array.isArray(cached)) return new Map<string, boolean>(cached);

  const effectiveKey = torrentioKey || apiKey || '';
  if (!effectiveKey) return new Map();

  // O segmento de config do Torrentio é base64url de "realdebrid=<key>".
  const configSegment = Buffer.from(`realdebrid=${effectiveKey}`)
    .toString('base64url')
    .replace(/=+$/, '');
  const url = `${torrentioUrl}/${configSegment}/stream/${q.type}/${q.id}.json`;

  const result = new Map<string, boolean>();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(q.timeoutMs) });
    if (!res.ok) return result;
    const body = await res.json() as any;
    const streams: any[] = body?.streams || [];

    // Conjunto de hashes que conhecemos para decidir "não listado" vs "listado
    // sem marcador". O Torrentio devolve infoHash OU url de resolve.
    const knownHashes = new Set<string>();

    for (const stream of streams) {
      const name: string = stream?.name || '';
      let hash = '';
      if (stream?.infoHash && HASH_RE.test(String(stream.infoHash).toLowerCase())) {
        hash = String(stream.infoHash).toLowerCase();
      } else if (stream?.url) {
        hash = hashFromUrl(stream.url);
      }
      if (!hash) continue;
      knownHashes.add(hash);

      // [RD+] no início do name = cacheado no RD.
      if (/^\[RD\+?\]/i.test(name)) {
        result.set(hash, true);
      } else {
        // Listado sem marcador = miss autoritativo (Torrentio sabe que não
        // está cacheado para esta chave).
        result.set(hash, false);
      }
    }

    // Hashes que pedimos mas o Torrentio NÃO listou ficam como DESCONHECIDOS
    // (não entram no Map). O acervo BR dublado que nos interessa é justamente
    // o que o Torrentio não indexa — tratar como miss envenenaria o ledger.
    // Os hashes pedidos que NÃO estão no knownHashes simplesmente não entram
    // no resultado, e o caller os trata como unknown.

    // Salva no cache para não repetir a chamada (armazenado como array para serializar no L2).
    if (torrentioTtl > 0) cache.set(cacheKey, Array.from(result.entries()), torrentioTtl);
  } catch { /* fail-open */ }
  return result;
}

// ─── Despachante ─────────────────────────────────────────────────────────────

const sources: OracleSource[] = [
  { name: 'stremthru', check: checkStremthru },
  { name: 'torrentio', check: checkTorrentio },
];

/** True se ao menos uma fonte está habilitada. */
export function available(): boolean {
  if (!config.debrid.rdOracle.enabled) return false;
  const { stremthruUrl, torrentio } = config.debrid.rdOracle;
  return Boolean(stremthruUrl) || torrentio;
}

/**
 * Consulta fontes habilitadas em paralelo e funde resultados.
 * true de qualquer fonte vence; false só de enumeração autoritativa.
 *
 * O retorno carrega APENAS os hashes com veredicto novo nesta chamada (fonte
 * externa ou cache por título). Estados que o ledger já sabe
 * (hit/miss/blocked) ficam de fora: o resultado alimenta
 * o loop de escrita do pipeline (noteHit/noteMiss), e ecoar um miss do próprio
 * ledger faria a pipeline reescrever o mesmo miss com evidência fantasma —
 * avançando `n`/`at` a cada reabertura da mesma lista. `blocked` também não é
 * ecoado, então segue dominante sem risco de ser tocado por um caminho atrasado.
 * Erro devolve Map vazio — nunca lança.
 */
export async function check(q: OracleQuery, apiKey?: string): Promise<Map<string, boolean>> {
  if (!config.debrid.rdOracle.enabled) return new Map();

  const started = Date.now();
  metrics.count('debrid.rd.oracle.called');

  // Só hashes que o ledger ainda não decidiu vão à rede. Já resolvidos
  // (hit/miss/blocked) não pagam chamada E não entram no resultado — o
  // pipeline não tem nada novo a gravar para eles.
  const unknownHashes: string[] = [];
  for (const raw of q.hashes) {
    const hash = String(raw || '').toLowerCase();
    if (!hash) continue;
    if (config.debrid.rdLedger.enabled && rdLedger.peek(hash) !== 'unknown') continue;
    unknownHashes.push(hash);
  }

  const enabledSources = sources.filter((source) => {
    if (source.name === 'stremthru') return Boolean(config.debrid.rdOracle.stremthruUrl);
    if (source.name === 'torrentio') return config.debrid.rdOracle.torrentio;
    return false;
  });

  if (enabledSources.length === 0 || unknownHashes.length === 0) {
    metrics.observe('debrid.rd.oracle.ms', Date.now() - started);
    return new Map();
  }

  const netQuery: OracleQuery = { ...q, hashes: unknownHashes };
  const results = await Promise.allSettled(
    enabledSources.map((source) => source.check(netQuery, apiKey)),
  );

  // Fusão: true de qualquer fonte vence; false só se autoritativo.
  const merged = new Map<string, boolean>();
  let hits = 0;
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      metrics.count('debrid.rd.oracle.fail');
      continue;
    }
    for (const [hash, cached] of result.value) {
      if (cached) {
        if (!merged.get(hash)) hits += 1;
        merged.set(hash, true);
      } else if (!merged.has(hash)) {
        // false autoritativo: a fonte enumerou e disse que não está cacheado.
        merged.set(hash, false);
      }
      // Se já tínhamos true de outra fonte, não sobrescreve com false.
    }
  }

  metrics.count('debrid.rd.oracle.hits', hits);
  metrics.observe('debrid.rd.oracle.ms', Date.now() - started);
  return merged;
}
