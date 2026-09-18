/**
 * URI de magnet por hash — namespace `muri:v1:<hash>`.
 *
 * Guarda a URI original do post (com `dn=` e trackers do tracker) para
 * reutilizar no play/enqueue do debrid. A URI é do TORRENT, não da
 * credencial — a chave NÃO leva conta/adapter. O `mag` (evidência
 * alive/bad/lie) segue intacto e separado.
 *
 * Contrato de segurança e qualidade:
 * - Só aceita `magnet:?` cujo btih bate com o hash da chave. A normalização
 *   (hex 40 / base32 32) vem do MESMO `extractInfoHash` do resto do código,
 *   então a chave guardada casa com a que o play consulta.
 * - Rejeita trackers que carreguem credencial: parâmetros conhecidos
 *   (passkey/authkey/auth/torrent_pass/pid/key/uid/secure) e QUALQUER
 *   segmento de caminho ou valor de query alfanumérico de 16+ chars — cobre
 *   a passkey tanto DEPOIS (`/announce/<token>`) quanto ANTES
 *   (`/<token>/announce`) do announce. O host é ignorado.
 * - Remonta a URI só com `xt`, `dn` e `tr`; `xs`/`as`/`ws` nunca são lidos,
 *   então ficam de fora sem precisar descartar o resto do magnet.
 * - Mantém o conjunto padrão de `TRACKERS` como PISO (a URI guardada nunca
 *   fica abaixo do que `magnetFor` mandaria) e põe os trackers do post À
 *   FRENTE no corte de 2048 bytes: o que se perde no teto é público (o
 *   `magnetFor` recoloca no play), nunca o tracker específico do post — que
 *   é justamente a razão de existir do `muri`.
 * - Devolve `null` se o resultado equivale ao `magnetFor(hash)` (não vale
 *   guardar o que dá para recalcular).
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

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Um tracker carrega credencial se nomeia um parâmetro de chave privado ou
 * traz, em qualquer segmento de caminho ou valor de query, uma palavra
 * alfanumérica de 16+ chars (o formato usual de passkey, antes OU depois do
 * /announce). O host é ignorado: rótulos de domínio legítimos não são segredo.
 * Falso-positivo custa só um tracker público a mais cortado, e o piso de
 * TRACKERS garante que nunca ficamos abaixo do magnetFor.
 */
function trackerHasCredential(tr: string): boolean {
  const decoded = safeDecode(tr);
  if (/[?&](passkey|authkey|auth|torrent_pass|pid|key|uid|secure)=/i.test(decoded)) return true;
  const pathAndQuery = decoded.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, ''); // fora scheme://host[:porta]
  const [path, query = ''] = pathAndQuery.split(/[?#]/);
  const longToken = /^[a-zA-Z0-9]{16,}$/;
  for (const seg of path.split('/')) if (longToken.test(seg)) return true;
  for (const kv of query.split('&')) {
    const eq = kv.indexOf('=');
    if (longToken.test(eq < 0 ? kv : kv.slice(eq + 1))) return true;
  }
  return false;
}

/**
 * Sanitiza a URI de magnet: valida o hash, remove credenciais, deduplica e
 * remonta com xt/dn/tr (piso de TRACKERS garantido, trackers do post à frente
 * no corte). Devolve null se equivaler ao magnet padrão.
 */
function sanitizeMagnet(uri: string, hash: string): string | null {
  const raw = String(uri || '').trim();
  if (!raw.startsWith('magnet:?')) return null;

  // Hash canônico (40 hex) pelo MESMO extrator do resto do código.
  const btih = extractInfoHash(raw);
  if (!btih || btih !== String(hash).toLowerCase()) return null;

  const dnMatch = raw.match(/[?&]dn=([^&]*)/i);
  const dn = dnMatch ? `&dn=${dnMatch[1]}` : '';

  // Trackers do post: sem credencial, deduplicados, e sem os que já estão no
  // piso (o piso é acrescentado por inteiro no fim, então um tracker igual a
  // ele aqui seria só ruído).
  const floorSet = new Set(TRACKERS);
  const seen = new Set<string>();
  const postTrackers: string[] = [];
  for (const m of raw.matchAll(/[?&]tr=([^&]+)/gi)) {
    const tr = m[1];
    if (trackerHasCredential(tr)) continue;
    const decoded = safeDecode(tr);
    if (floorSet.has(decoded) || seen.has(decoded)) continue;
    seen.add(decoded);
    postTrackers.push(`tr=${tr}`);
  }

  // Piso garantido: reserva os bytes do floor (poucos, todos /announce) e
  // preenche o resto do teto com os trackers do post. Se algum não couber, é
  // ele que sai — o floor entra por inteiro e sempre igual ao defaultMagnet.
  const head = `magnet:?xt=urn:btih:${btih}${dn}`;
  const floor = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  const budget = MAX_URI_BYTES - byteLength(head) - byteLength(floor);
  let extra = '';
  for (const tr of postTrackers) {
    const piece = `&${tr}`;
    if (byteLength(extra) + byteLength(piece) > budget) break;
    extra += piece;
  }
  const result = `${head}${extra}${floor}`;

  // Equivale ao que magnetFor já mandaria (nenhum dn, nenhum tracker extra)?
  // Então não vale guardar.
  if (result === defaultMagnet(btih)) return null;
  return result;
}

/**
 * Grava URIs sanitizadas em lote. Entradas sem magnet válido são ignoradas.
 * Renovação barata: pula a escrita quando a URI guardada já é exatamente esta
 * e o TTL restante ainda passa da metade — evita tocar o cache.db a cada busca
 * pelo mesmo título. Só regrava quando o valor mudou ou o TTL azedou.
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
    const key = `${base}${hash.toLowerCase()}`;
    if (cache.peek(key) === sanitized) {
      const remaining = cache.peekRemaining(key);
      if (remaining != null && remaining > ttl / 2) continue;
    }
    toSet.push({ key, value: sanitized, ttlSeconds: ttl });
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
 * infoHash/magnet/MagnetUri/Guid). Existe para o chamador só precisar de uma
 * linha — a coleta por item e o `rememberMagnets` em lote ficam aqui. Item sem
 * hash ou sem magnet utilizável é ignorado.
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
