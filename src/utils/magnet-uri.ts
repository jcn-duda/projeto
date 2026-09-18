/**
 * URI de magnet por hash — namespace `muri:v1:<hash>`.
 *
 * Guarda a URI original do post (com `dn=` e trackers do tracker) para
 * reutilizar no play/enqueue do debrid. A URI é do TORRENT, não da
 * credencial — a chave NÃO leva conta/adapter. O `mag` (evidência
 * alive/bad/lie) segue intacto e separado.
 *
 * Contrato de segurança e qualidade:
 * - Só aceita `magnet:?` cujo `xt=urn:btih:` bate com o hash da chave. A
 *   fonte é SÓ o `xt=`: hash que apareça em `dn`/`xs`/outro parâmetro não
 *   forja a identidade (o `extractInfoHash` genérico aceitava `btih:` em
 *   qualquer ponto da string). A normalização (hex 40 / base32 32) vem do
 *   MESMO `extractInfoHash` do resto do código.
 * - Rejeita trackers que carreguem credencial: parâmetros nomeados
 *   (passkey/authkey/auth_key/token/auth/torrent_pass/apikey/pid/key/uid/
 *   secure) com QUALQUER valor — curto ou não alfanumérico inclusive — e
 *   QUALQUER segmento de caminho ou valor de query com 16+ chars de
 *   `[A-Za-z0-9_-]`. O `-`/`_` cobre passkey/token reais e UUID, tanto
 *   DEPOIS (`/announce/<token>`) quanto ANTES (`/<token>/announce`) do
 *   announce. O host é ignorado: rótulo de domínio não é segredo.
 * - Remonta a URI só com `xt`, `dn` e `tr`; `xs`/`as`/`ws` nunca são lidos,
 *   então ficam de fora sem precisar descartar o resto do magnet.
 * - Mantém o conjunto padrão de `TRACKERS` como PISO (a URI guardada nunca
 *   fica abaixo do que `magnetFor` mandaria) e impõe um teto REAL de
 *   `MAX_URI_BYTES`: `xt` e o piso entram por inteiro, o `dn` que não couber
 *   é truncado em limite de code point (re-codificado, sem partir `%XX` nem
 *   UTF-8) ou omitido, e os trackers do post preenchem o resto — um tracker
 *   grande demais é pulado para tentar um menor adiante.
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

// Nomes de parâmetro que carregam credencial. O valor não importa: a
// presença do nome já é a prova, então `token=x` e `passkey=!@#` saem igual.
// `token`/`auth_key` são tão comuns quanto `passkey` em tracker privado.
const CREDENTIAL_PARAM = /[?&](?:passkey|pass_key|authkey|auth_key|token|torrent_pass|apikey|api_key|auth|pid|key|uid|secure)=/i;

// Segredo genérico: 16+ chars de [A-Za-z0-9_-]. O `-`/`_` são essenciais —
// passkey/token reais e UUID usam ambos; sem eles o segredo escapava.
const LONG_TOKEN = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Um tracker carrega credencial se nomeia um parâmetro privado conhecido ou
 * traz, em qualquer segmento de caminho ou valor de query, 16+ chars de
 * [A-Za-z0-9_-] (formato usual de passkey/UUID, antes OU depois do
 * /announce). O host é ignorado: rótulo de domínio legítimo não é segredo.
 * Falso-positivo custa só um tracker público a mais cortado, e o piso de
 * TRACKERS garante que nunca ficamos abaixo do magnetFor.
 */
function trackerHasCredential(tr: string): boolean {
  const decoded = safeDecode(tr);
  if (CREDENTIAL_PARAM.test(decoded)) return true;
  const pathAndQuery = decoded.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, ''); // fora scheme://host[:porta]
  const [path, query = ''] = pathAndQuery.split(/[?#]/);
  for (const seg of path.split('/')) if (LONG_TOKEN.test(seg)) return true;
  for (const kv of query.split('&')) {
    const eq = kv.indexOf('=');
    if (LONG_TOKEN.test(eq < 0 ? kv : kv.slice(eq + 1))) return true;
  }
  return false;
}

/**
 * Extrai o hash SÓ de `xt=urn:btih:`. O `extractInfoHash` aceita `btih:` em
 * qualquer ponto da string, o que deixava `dn=btih:<hash>` forjar a
 * identidade; aqui o parâmetro `xt` é a única fonte, e um `xt` de outro
 * esquema (ed2k, sha1) não conta.
 */
function btihFromXt(raw: string): string | null {
  for (const m of raw.matchAll(/[?&]xt=([^&]+)/gi)) {
    const value = safeDecode(m[1]);
    if (!/^urn:btih:/i.test(value)) continue;
    const hash = extractInfoHash(value);
    if (hash) return hash;
  }
  return null;
}

/**
 * Ajusta o `dn=` (já percent-encoded na URI crua) ao teto de bytes. Se cabe
 * inteiro, mantém o encoding original. Se não, decodifica e re-codifica por
 * code point até o limite — assim o corte nunca parte um `%XX` nem um
 * caractere multibyte, e o `decodeURIComponent` do resultado continua
 * válido. `dn` com escape quebrado é omitido: melhor sem o nome do que com
 * uma URI inválida.
 */
function fitDn(encoded: string, maxBytes: number): string {
  if (byteLength(encoded) <= maxBytes) return encoded;
  if (maxBytes <= 0) return '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return '';
  }
  let out = '';
  let used = 0;
  for (const cp of decoded) {
    const piece = encodeURIComponent(cp);
    const bytes = byteLength(piece);
    if (used + bytes > maxBytes) break;
    out += piece;
    used += bytes;
  }
  return out;
}

/**
 * Sanitiza a URI de magnet: valida o hash pelo `xt`, remove credenciais,
 * deduplica e remonta com xt/dn/tr sob teto real de `MAX_URI_BYTES` (piso de
 * TRACKERS garantido, trackers do post preenchendo o resto). Devolve null se
 * equivaler ao magnet padrão.
 */
function sanitizeMagnet(uri: string, hash: string): string | null {
  const raw = String(uri || '').trim();
  if (!raw.startsWith('magnet:?')) return null;

  // Hash canônico (40 hex) lido SÓ do xt, pelo MESMO extrator do resto do código.
  const btih = btihFromXt(raw);
  if (!btih || btih !== String(hash).toLowerCase()) return null;

  const dnMatch = raw.match(/[?&]dn=([^&]*)/i);

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
  // divide o resto do teto entre `dn` e trackers do post. O corte é por BYTE
  // (o teto é real, não contagem de chars) e o `dn` é o primeiro a ceder.
  const xt = `magnet:?xt=urn:btih:${btih}`;
  const floor = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  let available = MAX_URI_BYTES - byteLength(xt) - byteLength(floor);

  let dn = '';
  if (dnMatch) {
    const value = fitDn(dnMatch[1], Math.max(0, available - '&dn='.length));
    // `dn=` vazio original é preservado; truncado até zero vira omissão.
    if (value.length > 0 || dnMatch[1].length === 0) {
      dn = `&dn=${value}`;
      available -= byteLength(dn);
    }
  }

  let extra = '';
  for (const tr of postTrackers) {
    const piece = `&${tr}`;
    // Tracker grande demais não bloqueia um menor depois: segue tentando.
    if (byteLength(piece) > available) continue;
    extra += piece;
    available -= byteLength(piece);
  }

  const result = `${xt}${dn}${extra}${floor}`;

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
