// @ts-check
const config = require('../config');
const { TRACKERS, normalizeTitle } = require('../utils/format');
const log = require('../utils/logger');

function magnetFor(infoHash) {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}${trackers}`;
}

/**
 * Credencial recusada pelo serviço — categoria à parte de "falhou".
 *
 * Erro transitório (timeout, 502) significa "não sei o que está em cache" e o
 * addon segue mandando tudo pelo debrid, porque no play pode dar certo. Chave
 * inválida significa que NADA vai dar certo: a lista inteira sai como
 * `[AD download]` e todo play morre no /resolve. Sem distinguir os dois, o
 * sintoma na tela é o mesmo (o ⚡ some) e a causa fica invisível.
 */
class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.isAuthError = true;
  }
}

// Códigos/mensagens de credencial recusada. AllDebrid usa AUTH_* no corpo com
// HTTP 200; Premiumize manda `authentication_failed` também com 200; os
// demais respondem 401/403.
const AUTH_MESSAGE = /AUTH_(?:BAD_APIKEY|MISSING_APIKEY|BLOCKED|USER_BANNED)|authentication_failed|apikey is invalid|invalid (?:api )?(?:key|token)|unauthor[iz]|forbidden|bad token/i;

function isAuthError(error) {
  if (!error) return false;
  if (error.isAuthError) return true;
  return AUTH_MESSAGE.test(String(error.message || ''));
}

/**
 * Conta no teto — a credencial está boa, o que acabou foi espaço.
 *
 * Caso real: "Magnets limit reached (1000 accross all tabs)" (o typo é da API).
 * A checagem de cache da AllDebrid é um /magnet/upload, então conta cheia
 * derruba a checagem inteira: o ⚡ some de todos os streams e a causa não
 * aparece em lugar nenhum. Pior, o play também passa por upload — mandar a
 * lista pelo debrid nessa situação entrega links que não resolvem.
 */
class QuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaError';
    this.isQuotaError = true;
  }
}

const QUOTA_MESSAGE = /MAGNET_TOO_MANY_ACTIVE|magnets? limit reached|too many active|quota exceeded|limit reached/i;

function isQuotaError(error) {
  if (!error) return false;
  // Rate limit também pode mencionar "limit reached". A marca tipada vence o
  // regex amplo: esperar é transitório, enquanto quota degrada a lista a P2P.
  if (error.isRateLimitError) return false;
  if (error.isQuotaError) return true;
  return QUOTA_MESSAGE.test(String(error.message || ''));
}

/**
 * Rajada demais — a credencial e a cota estão boas, o serviço pediu para
 * esperar. Diferente de quota: daqui a um minuto o mesmo pedido passa, então
 * a lista NÃO vira P2P (unusable). known:false e tenta de novo no passe tardio.
 *
 * Premiumize devolve `rate_limit_reached` com HTTP 200; tratar só o status
 * HTTP lia isso como "erro genérico" e o log não dizia o que esperar.
 */
class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
    this.isRateLimitError = true;
  }
}

const RATE_LIMIT_MESSAGE = /rate_limit_reached|too many (?:api )?requests|slow down/i;

function isRateLimitError(error) {
  if (!error) return false;
  if (error.isRateLimitError) return true;
  return RATE_LIMIT_MESSAGE.test(String(error.message || ''));
}

/**
 * Obra não identificável dentro de um pack multi-obra. Diferente de "null"
 * (nenhum vídeo no torrent), que continua significando torrent sem vídeo.
 * Lançada pelo pickFile quando a listagem marcou o stream como pack mas
 * nenhum arquivo individualmente casa com a obra pedida.
 */
class WorkPickError extends Error {
  constructor() {
    super('não foi possível identificar a obra dentro do pack');
    this.name = 'WorkPickError';
    this.code = 'WORK_PICK';
  }
}

function isWorkPickError(error) {
  return error?.code === 'WORK_PICK';
}

/**
 * Um fetch JSON com o timeout do debrid já aplicado. Cada serviço tem o seu
 * jeito de autenticar, então o header vai por fora.
 *
 * @param {string|URL} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {*} [options.body]
 * @param {number} [options.timeout]
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
    const message = `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
    if (res.status === 401 || res.status === 403) throw new AuthError(message);
    if (res.status === 429) throw new RateLimitError(message);
    throw new Error(message);
  }
  return res.json();
}

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i;
const SAMPLE = /(^|[^a-z])sample([^a-z]|$)/i;

// Arquivo que não é a obra principal: extra/bônus/entrevista. Sem excluí-los
// da contagem, filme com extras pareceria "mais de um vídeo principal" e a
// escolha por obra falharia exatamente onde a regra do maior acertava.
const EXTRA = /(^|[^a-z])(extras?|b[oô]nus|bonus|featurettes?|interviews?|entrevistas?|behind[ ._-]?the[ ._-]?scenes|trailers?|deleted[ ._-]?scenes?|cenas[ ._-]?deletadas|bloopers?|gags?|making[ ._-]?of)([^a-z]|$)/i;

/** Nome do arquivo sem a pasta: "Trilogia (1985-1990)/video (1985).mkv" → "video (1985).mkv". */
function baseName(p) {
  return String(p || '').split(/[/\\]/).pop() || '';
}

// Cobertura mínima do nome no arquivo para o casamento contar como
// confiável. Abaixo disso o token solto da franquia ("Star") casaria tudo.
const WORK_COVERAGE_MIN = 0.7;

/** Fração dos tokens significativos do nome presentes no nome do arquivo. */
function workCoverage(fileName, name) {
  const tokens = normalizeTitle(name).split(' ').filter(Boolean);
  const longTokens = tokens.filter((w) => w.length > 2);
  // Títulos curtos ("It", "Us", "Ela") não podem virar cobertura zero:
  // nesses casos os tokens curtos são a única pista disponível.
  const wanted = longTokens.length > 0 ? longTokens : tokens;
  if (wanted.length === 0) return 0;
  // Casar contra o basename: a pasta raiz "Trilogia (1985-1990)" dá cobertura
  // falsa para todos os arquivos do pack. Fallback: se o basename não casa
  // nenhum token (pasta carrega a identidade), tentar o path completo.
  const bn = normalizeTitle(baseName(fileName));
  const bnGot = new Set(bn.split(' ').filter(Boolean));
  const bnHits = wanted.filter((w) => bnGot.has(w)).length;
  if (bnHits > 0) return bnHits / wanted.length;
  const fullGot = new Set(normalizeTitle(fileName).split(' ').filter(Boolean));
  return wanted.filter((w) => fullGot.has(w)).length / wanted.length;
}

/**
 * Só trata o conteúdo como pack multi-obra quando os próprios arquivos provam
 * isso. Dois ou mais anos distintos entre vídeos principais são evidência
 * suficiente; vários encodes do mesmo filme, ou nomes sem ano, seguem o
 * fallback permissivo do maior arquivo.
 */
function looksMultiWorkFiles(files) {
  const mains = files.filter(
    (f) => VIDEO_EXT.test(f.path || '') && !SAMPLE.test(f.path || '') && !EXTRA.test(f.path || ''),
  );
  if (mains.length <= 1) return false;
  const years = new Set();
  for (const file of mains) {
    // O ano que prova multi-obra vem do ARQUIVO, não da pasta: a raiz
    // "Trilogia (1985-1990)" contém 1985 em todos os arquivos e faria
    // qualquer pack de filme único parecer multi-obra.
    const match = String(baseName(file.path) || '').match(/(?:^|[^0-9])((?:19|20)\d{2})(?:$|[^0-9])/);
    if (match) years.add(Number(match[1]));
  }
  return years.size >= 2;
}

/**
 * Escolhe POR OBRA dentro de um pack multi-filme, pela dica (nomes + ano)
 * assinada na URL de play. Devolve null quando nenhum arquivo casa com
 * confiança — falha explícita em vez de devolver o maior, que num pack de 13
 * filmes toca o filme errado em silêncio.
 *
 * Títulos de franquia se contêm ("Jornada nas Estrelas" está em todos os
 * filmes), então cobertura alta sozinha não basta: o ano da obra pedida
 * desempata. Vários arquivos com o MESMO ano são encodes da mesma obra —
 * entre eles o maior é seguro.
 *
 * @param {Array<*>} files
 * @param {object} [options]
 * @param {string[]} [options.names]
 * @param {(number|string|null)} [options.year]
 */
function pickWorkFile(files, { names, year } = {}) {
  const cleanYear = Number(String(year || '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  const scored = files
    .map((f) => ({
      file: f,
      cov: Math.max(.../** @type {string[]} */ (names).map((n) => workCoverage(f.path || '', n))),
    }))
    .filter((x) => x.cov >= WORK_COVERAGE_MIN);
  if (scored.length === 0) return null;
  if (scored.length === 1) return scored[0].file;
  if (cleanYear) {
    const yearRe = new RegExp(`(?<!\\d)${cleanYear}(?!\\d)`);
    // Casar o ano contra o basename: a pasta "Trilogia (1985-1990)" contém
    // 1985 em TODOS os arquivos, e o desempate pelo maior toca o filme errado.
    const withYear = scored.filter((x) => yearRe.test(baseName(x.file.path || '')));
    if (withYear.length === 1) return withYear[0].file;
    if (withYear.length > 1) {
      return withYear.reduce(
        (a, b) => (Number(b.file.size || 0) > Number(a.file.size || 0) ? b : a),
      ).file;
    }
  }
  // Ambíguo sem ano: dois candidatos plausíveis e nenhuma pista para
  // escolher. Falhar é o comportamento projetado.
  return null;
}

/**
 * Escolhe o arquivo a tocar dentro do torrent. `files` é normalizado para
 * { path, size, ...resto } antes de chegar aqui — cada serviço nomeia esses
 * campos de um jeito.
 *
 * `work` é a dica de obra ({ names, year }) assinada na URL de play, usada
 * só em filme: série segue pelo s/e, e torrent de vídeo único não muda de
 * caminho com ou sem dica.
 *
 * @param {Array<*>} files
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
function pickFile(files, { season, episode, work } = {}) {
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

  // Filme com dica de obra: pack multi-filme exige casamento por nome.
  if (work?.names?.length) {
    const mains = videos.filter((f) => !EXTRA.test(f.path || ''));
    const pool = mains.length > 0 ? mains : videos;
    // Um único vídeo principal: a dica é só confirmatória — caminho antigo.
    if (pool.length === 1) return pool[0];
    // Estrito quando a LISTAGEM disse que é pack, ou quando os próprios
    // arquivos provam (anos distintos). Fora disso podem ser dois encodes do
    // mesmo filme, e falhar transformaria play legítimo em 404.
    if (!work.pack && !looksMultiWorkFiles(pool)) {
      return pool.reduce((a, b) => (Number(b.size || 0) > Number(a.size || 0) ? b : a));
    }
    const picked = pickWorkFile(pool, work);
    if (picked) return picked;
    // Nenhum arquivo casa com a obra pedida dentro de um pack provado.
    // null significaria "sem vídeo" — mas há vídeo, só não sabemos qual.
    throw new WorkPickError();
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
 * @param {Array<*>} infoHashes
 * @param {number} size
 * @param {Function} fn
 * @param {object} [options]
 * @param {number} [options.timeoutMs] Teto compartilhado por lote (dinâmico, do
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
  let authFailures = 0;
  let quotaFailures = 0;
  let rateFailures = 0;
  let lastCause = '';

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      result.value.forEach((hash) => cached.add(hash));
    } else {
      failures += 1;
      const message = result.reason?.message || String(result.reason);
      if (isAuthError(result.reason)) {
        authFailures += 1;
        lastCause = message;
      } else if (isQuotaError(result.reason)) {
        quotaFailures += 1;
        lastCause = message;
      } else if (isRateLimitError(result.reason)) {
        rateFailures += 1;
        lastCause = message;
      }
      log.warn('[debrid] lote de cache falhou:', message);
    }
  }

  if (slices.length > 0 && failures === slices.length) {
    // A causa não pode se perder aqui: com credencial recusada em TODOS os
    // lotes, quem chama precisa saber que não adianta mandar a lista pelo
    // debrid — e o usuário precisa ver o motivo em vez de um ⚡ que sumiu.
    // Todas as falhas com a MESMA causa estrutural: sobe classificada, para o
    // orquestrador degradar para P2P e o log dizer o que consertar. Causas
    // misturadas (uma de auth, outra de rede) não afirmam nada — genérico.
    if (authFailures === failures) throw new AuthError(lastCause);
    if (quotaFailures === failures) throw new QuotaError(lastCause);
    if (rateFailures === failures) throw new RateLimitError(lastCause);
    throw new Error('nenhum lote de checagem de cache respondeu');
  }
  return { cached, complete: failures === 0 };
}

/** Espera curta entre polls — o serviço acabou de receber o magnet. */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

module.exports = {
  magnetFor, json, pickFile, pickWorkFile, looksMultiWorkFiles, workCoverage, batched, wait,
  AuthError, isAuthError, QuotaError, isQuotaError, RateLimitError, isRateLimitError,
  WorkPickError, isWorkPickError,
  VIDEO_EXT, SAMPLE, EXTRA,
};
