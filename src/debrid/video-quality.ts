import config from '../config.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { call } from './alldebrid-api.js';
import { parseVideoResolution, parseMp4Tail, isMp4, qualityFromResolution } from '../utils/video-header.js';

// Resolução medida no cabeçalho do vídeo, por arquivo (`vres:v1:<hash>:<path>`).
// Serve o arquivo que o play tocaria quando nem o título nem o nome do arquivo
// dizem a resolução (ver `utils/video-header.ts`).
//
// Custa um /link/unlock na AllDebrid e até 8 MB baixados (4 MB do começo e, só
// num MP4 sem faststart, 4 MB do fim), UMA vez por arquivo: o resultado fica
// 30 dias no cache e o cabeçalho ilegível fica 1 dia, para não repetir a
// tentativa a cada busca. Roda em fila de um só, fora do caminho da resposta:
// a primeira listagem sai sem a resolução e a seguinte já a mostra.

const HEAD_BYTES = 4 * 1024 ** 2;
const TAIL_BYTES = 4 * 1024 ** 2;
const FETCH_TIMEOUT_MS = 15000;
const MEASURED_TTL_SECONDS = 30 * 86400;
const UNREADABLE_TTL_SECONDS = 86400;
const MAX_PENDING = 20;

interface VideoProbeJob {
  hash: string;
  path: string;
  link: string;
  apiKey: string;
  size: number;
}

const queue: VideoProbeJob[] = [];
const queued = new Set<string>();
let draining = false;

function pathDigest(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function videoQualityKey(infoHash: string, path: string) {
  return `${prefix('vres')}${String(infoHash || '').toLowerCase()}:${pathDigest(String(path || ''))}`;
}

/**
 * Qualidade medida do arquivo: string quando o cabeçalho foi lido, `null`
 * quando a leitura já foi tentada e não achou resolução, `undefined` quando
 * nunca foi medido.
 */
function peekVideoQuality(infoHash: string, path: string): string | null | undefined {
  const value = cache.peek(videoQualityKey(infoHash, path)) as { q?: string | null } | null;
  if (!value) return undefined;
  return value.q || null;
}

async function fetchRange(url: string, range: string, maxBytes: number): Promise<Uint8Array | null> {
  const res = await fetch(url, { headers: { Range: range }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if ((res.status !== 206 && res.status !== 200) || !res.body) return null;
  // Lê no máximo o pedaço pedido: servidor que ignora Range devolveria o
  // arquivo inteiro.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.length) break;
  }
  return out;
}

async function probeOne({ hash, path, link, apiKey, size }: VideoProbeJob) {
  const unlocked = await call(apiKey, '/link/unlock', { link });
  const url = typeof unlocked?.link === 'string' ? unlocked.link : '';
  if (!url) throw new Error('/link/unlock sem link');
  const total = Number(unlocked?.filesize) || size || 0;
  const head = await fetchRange(url, `bytes=0-${HEAD_BYTES - 1}`, HEAD_BYTES);
  let resolution = head ? parseVideoResolution(head) : null;
  if (!resolution && head && isMp4(head) && total > HEAD_BYTES) {
    const tail = await fetchRange(url, `bytes=${Math.max(0, total - TAIL_BYTES)}-${total - 1}`, TAIL_BYTES);
    resolution = tail ? parseMp4Tail(tail) : null;
  }
  const quality = resolution ? qualityFromResolution(resolution.width, resolution.height) : null;
  const name = String(path).split(/[/\\]/).pop()?.slice(0, 70) || '';
  if (quality && resolution) {
    cache.set(videoQualityKey(hash, path), { q: quality, w: resolution.width, h: resolution.height }, MEASURED_TTL_SECONDS);
    metrics.count('debrid.qualityProbe.measured');
    log.info(`[quality-probe] ${name}: ${resolution.width}x${resolution.height} → ${quality}`);
  } else {
    cache.set(videoQualityKey(hash, path), { q: null }, UNREADABLE_TTL_SECONDS);
    metrics.count('debrid.qualityProbe.unreadable');
    log.info(`[quality-probe] ${name}: cabeçalho sem resolução legível`);
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift() as VideoProbeJob;
      const key = videoQualityKey(job.hash, job.path);
      try {
        await probeOne(job);
      } catch (err) {
        // Falha de rede/unlock também fica marcada por um dia: tentar de novo a
        // cada busca só gastaria unlock numa conta que está recusando.
        cache.set(key, { q: null }, UNREADABLE_TTL_SECONDS);
        metrics.count('debrid.qualityProbe.error');
        log.warn('[quality-probe] leitura do cabeçalho falhou:', log.errorMessage(err));
      } finally {
        queued.delete(key);
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Enfileira a medição de um arquivo (só AllDebrid, que é quem entrega o link do
 * arquivo na lista). Devolve true quando enfileirou; arquivo já medido, já na
 * fila, sem link ou com a fila cheia não entra.
 */
function scheduleVideoProbe(job: VideoProbeJob): boolean {
  if (!config.debrid.qualityProbe) return false;
  if (!job.hash || !job.path || !job.link || !job.apiKey) return false;
  const key = videoQualityKey(job.hash, job.path);
  if (queued.has(key) || cache.peek(key)) return false;
  if (queue.length >= MAX_PENDING) {
    metrics.count('debrid.qualityProbe.dropped');
    return false;
  }
  queued.add(key);
  queue.push(job);
  metrics.count('debrid.qualityProbe.scheduled');
  void drain();
  return true;
}

export { peekVideoQuality, scheduleVideoProbe, videoQualityKey };
export type { VideoProbeJob };
