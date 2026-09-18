/**
 * URI de magnet por hash — namespace `muri:v1:<hash>`.
 *
 * Guarda a URI original do post (com `dn=` e trackers do tracker) para
 * reutilizar no play/enqueue do debrid. A URI é do TORRENT, não da
 * credencial — a chave NÃO leva conta/adapter. O `mag` (evidência
 * alive/bad/lie) segue intacto e separado.
 *
 * Contrato de segurança:
 * - Só aceita `magnet:?` com `xt=urn:btih:` cujo btih bate com o hash
 *   (hex 40 ou base32 32 normalizado para hex).
 * - Remove trackers com credenciais (passkey, /announce/<token>=16 chars,
 *   ?auth=, uid=) e mantém SEMPRE o conjunto padrão de `TRACKERS` como piso —
 *   a URI guardada nunca fica abaixo do que `magnetFor` mandaria.
 * - Deduplica `tr=` e corta em 2048 bytes, preservando `xt=` e `dn=`.
 * - Rejeita `xs`/`as`/`ws` (podem carregar URLs adicionais indesejadas).
 * - Devolve `null` se o resultado for equivalente ao `magnetFor(hash)`
 *   (não vale guardar o que dá para recalcular).
 */
import * as cache from './cache.js';
import { prefix } from './cache-keys.js';
import config from '../config.js';
import { TRACKERS } from './search-names.js';
import { extractInfoHash } from './title-normalization.js';

const MAX_URI_BYTES = 2048;

/** Constrói o magnet padrão (mesmo formato de common.ts, sem importar). */
function defaultMagnet(infoHash: string): string {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}${trackers}`;
}

/**
 * Normaliza btih para 40 hex. Aceita hex 40 ou base32 32; devolve null se
 * o formato for inválido.
 */
function normalizeBtih(raw: string): string | null {
  const s = String(raw).trim().toLowerCase();
  if (/^[a-f0-9]{40}$/.test(s)) return s;
  if (/^[a-z2-7]{32}$/.test(s)) return base32ToHex(s);
  return null;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32ToHex(input: string): string | null {
  const s = String(input).toUpperCase();
  let bits = '';
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= 160; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/**
 * Detecta se um tracker carrega credencial. Padrões reconhecidos:
 * - `passkey=` em qualquer posição da query
 * - `/announce/<token>=` com token de 16+ chars (passkey no caminho)
 * - `?auth=` ou `&auth=`
 * - `uid=` (identificador de usuário)
 */
function trackerHasCredential(tr: string): boolean {
  const decoded = safeDecode(tr);
  if (/passkey=/i.test(decoded)) return true;
  if (/\/announce\/[a-zA-Z0-9]{16,}/i.test(decoded)) return true;
  if (/[?&]auth=/i.test(decoded)) return true;
  if (/[?&]uid=/i.test(decoded)) return true;
  return false;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Sanitiza a URI de magnet: valida btih, remove trackers com credencial,
 * deduplica, corta em 2048 bytes preservando xt/dn. Devolve null se o
 * resultado for equivalente ao magnet padrão (não vale guardar).
 */
function sanitizeMagnet(uri: string, hash: string): string | null {
  const raw = String(uri || '').trim();
  if (!raw.startsWith('magnet:?')) return null;

  // Extrai btih do xt=
  const xtMatch = raw.match(/[?&]xt=urn:btih:([a-zA-Z0-9]{32,40})(?:&|$)/i);
  if (!xtMatch) return null;
  const btih = normalizeBtih(xtMatch[1]);
  if (!btih || btih !== hash.toLowerCase()) return null;

  // Rejeita xs/as/ws (podem carregar URLs adicionais)
  if (/[?&](xs|as|ws)=/i.test(raw)) return null;

  // Extrai dn= (preservar)
  const dnMatch = raw.match(/[?&]dn=([^&]*)/i);
  const dn = dnMatch ? `&dn=${dnMatch[1]}` : '';

  // Extrai e filtra trackers. O conjunto começa com os PADRÕES (o piso que
  // magnetFor já mandaria) e só então acrescenta os limpos do post. Assim a URI
  // guardada nunca fica ABAIXO do fallback: um post cujo único tracker carrega
  // passkey não pode tirar o raio público do torrent frio no play.
  const seenTrackers = new Set<string>();
  const cleanTrackers: string[] = [];
  for (const t of TRACKERS) {
    seenTrackers.add(t);
    cleanTrackers.push(`tr=${encodeURIComponent(t)}`);
  }
  const trMatches = raw.matchAll(/[?&]tr=([^&]+)/gi);
  for (const m of trMatches) {
    const tr = m[1];
    if (trackerHasCredential(tr)) continue;
    const decoded = safeDecode(tr);
    if (seenTrackers.has(decoded)) continue;
    seenTrackers.add(decoded);
    cleanTrackers.push(`tr=${tr}`);
  }

  // Monta a URI: xt + dn + trackers, respeitando o teto de bytes
  let result = `magnet:?xt=urn:btih:${btih}${dn}`;
  for (const tr of cleanTrackers) {
    const candidate = `${result}&${tr}`;
    if (byteLength(candidate) > MAX_URI_BYTES) break;
    result = candidate;
  }

  // Se ficou equivalente ao padrão, não vale guardar
  if (result === defaultMagnet(hash)) return null;

  return result;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Grava URIs sanitizadas em lote. Entradas sem magnet válido são ignoradas.
 * TTL do config (default 14 dias), renovado a cada chamada.
 */
function rememberMagnets(entries: Array<{ hash: string; magnet: string | undefined | null }>) {
  const ttl = config.magnetDb?.uriTtl ?? 14 * 24 * 3600;
  if (ttl <= 0) return;
  const base = prefix('muri');
  const toSet: Array<{ key: string; value: string; ttlSeconds: number }> = [];
  for (const { hash, magnet } of entries) {
    if (!hash || !magnet) continue;
    const sanitized = sanitizeMagnet(magnet, hash);
    if (!sanitized) continue;
    toSet.push({ key: `${base}${hash.toLowerCase()}`, value: sanitized, ttlSeconds: ttl });
  }
  if (toSet.length > 0) cache.setMany(toSet);
}

/**
 * Lê a URI guardada para o hash. Sem efeito colateral (não promove LRU,
 * não conta hit/miss). Devolve null se ausente ou expirada.
 */
function peekMagnet(hash: string): string | null {
  if (!hash) return null;
  const base = prefix('muri');
  const value = cache.peek(`${base}${hash.toLowerCase()}`);
  return typeof value === 'string' ? value : null;
}

/** Campos de um item bruto de post que carregam a URI de magnet. */
type MagnetCarrier = {
  infoHash?: string | null;
  magnet?: string | null;
  MagnetUri?: string | null;
  Guid?: unknown;
};

/**
 * Captura em lote as URIs de magnet de uma leva de itens brutos, chaveadas
 * pelo mesmo hash que `toStremioStream` usa (`extractInfoHash` sobre
 * infoHash/magnet/MagnetUri/Guid). Existe para o `stream-builder-pipeline` só
 * precisar de uma linha por passe — a coleta por item e o `rememberMagnets` em
 * lote ficam aqui. Item sem hash ou sem magnet utilizável é ignorado.
 */
function rememberMagnetsFromItems(items: readonly MagnetCarrier[]): void {
  const entries: Array<{ hash: string; magnet: string }> = [];
  for (const it of items) {
    const guidStr = typeof it.Guid === 'string' ? it.Guid : '';
    const hash = extractInfoHash(it.infoHash || it.magnet || it.MagnetUri || guidStr || '');
    const magnet = it.magnet || it.MagnetUri || (guidStr.startsWith('magnet:') ? guidStr : '');
    if (hash && magnet) entries.push({ hash: String(hash), magnet: String(magnet) });
  }
  if (entries.length > 0) rememberMagnets(entries);
}

export { sanitizeMagnet, rememberMagnets, rememberMagnetsFromItems, peekMagnet, defaultMagnet };
