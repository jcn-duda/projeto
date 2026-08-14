const config = require('../config');
const { TRACKERS } = require('../utils/format');

function magnetFor(infoHash) {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}${trackers}`;
}

/**
 * Um fetch JSON com o timeout do debrid já aplicado. Cada serviço tem o seu
 * jeito de autenticar, então o header vai por fora.
 */
async function json(url, { method = 'GET', headers = {}, body, timeout } = {}) {
  const res = await fetch(url, {
    method,
    body,
    headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0', ...headers },
    signal: AbortSignal.timeout(timeout || config.debrid.timeout),
  });
  // 4xx costuma trazer o motivo no corpo; vale mais que só o status.
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* corpo ilegível: o status já basta */
    }
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return res.json();
}

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i;
const SAMPLE = /(^|[^a-z])sample([^a-z]|$)/i;

/**
 * Escolhe o arquivo a tocar dentro do torrent. `files` é normalizado para
 * { path, size, ...resto } antes de chegar aqui — cada serviço nomeia esses
 * campos de um jeito.
 */
function pickFile(files, { season, episode } = {}) {
  const videos = files.filter((f) => VIDEO_EXT.test(f.path || '') && !SAMPLE.test(f.path || ''));
  if (videos.length === 0) return null;

  if (season != null && episode != null) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const patterns = [
      new RegExp(`s${s}[\\s._-]*e${e}`, 'i'),
      new RegExp(`\\b${season}x${e}\\b`, 'i'),
      new RegExp(`\\b${s}${e}\\b`),
    ];
    const match = videos.find((f) => patterns.some((p) => p.test(f.path)));
    if (match) return match;
  }

  // Sem episódio pedido (ou sem casar): o maior arquivo é o filme/o conteúdo principal.
  return videos.reduce((a, b) => (Number(b.size || 0) > Number(a.size || 0) ? b : a));
}

/**
 * Percorre os hashes em lotes, acumulando os que estiverem em cache.
 *
 * Devolve `{ cached, complete }`. `complete: false` significa "não perguntei por
 * todos", NÃO "os que faltam não estão em cache" — a diferença é o que separa
 * uma lista completa de uma lista com 100 streams a menos. Um lote que estoura o
 * timeout deixava os hashes dele fora do Set e, com `cachedOnly`, o orquestrador
 * os apagava como se o serviço tivesse dito "não tenho" (medido: 6 fontes BR
 * cacheadas no Premiumize sumindo por causa de UM lote perdido). Quem chama
 * decide o que fazer com a resposta incompleta; aqui só relatamos.
 *
 * Se TODOS falharem — token inválido, serviço fora — o erro sobe.
 *
 * Os lotes vão em paralelo: em série, dois lotes de 100 hashes somavam dois
 * timeouts inteiros (12s) contra um REPLY_DEADLINE de 8,5s, e a busca voltava
 * vazia mesmo com tudo coletado.
 *
 * @param {object} [opts.timeoutMs] Teto compartilhado por lote (dinâmico, do
 *   passo de resposta). Ausente = cada adaptador usa o próprio teto
 *   (config.debrid.cacheCheckTimeout).
 */
async function batched(infoHashes, size, fn, { timeoutMs } = {}) {
  const slices = [];
  for (let i = 0; i < infoHashes.length; i += size) {
    slices.push(infoHashes.slice(i, i + size));
  }

  const settled = await Promise.allSettled(slices.map((slice) => fn(slice, { timeoutMs })));
  const cached = new Set();
  let failures = 0;

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      result.value.forEach((hash) => cached.add(hash));
    } else {
      failures += 1;
      console.warn('[debrid] lote de cache falhou:', result.reason?.message || result.reason);
    }
  }

  if (slices.length > 0 && failures === slices.length) {
    throw new Error('nenhum lote de checagem de cache respondeu');
  }
  return { cached, complete: failures === 0 };
}

/** Espera curta entre polls — o serviço acabou de receber o magnet. */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

module.exports = { magnetFor, json, pickFile, batched, wait, VIDEO_EXT, SAMPLE };
