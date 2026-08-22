import config from '../config.js';
import { TRACKERS, normalizeTitle, parseTitleSeasonEpisode } from '../utils/format.js';
import * as log from '../utils/logger.js';

/** Arquivo dentro de um torrent, como cada serviço o reporta. */
export type DebridFile = { path?: string; size?: number; [k: string]: any };
/** Erro como ele chega aqui: Error, envelope da API ou nada. */
export type MaybeError = any;

function magnetFor(infoHash: string) {
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
  isAuthError = true;
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

// Códigos/mensagens de credencial recusada. AllDebrid usa AUTH_* no corpo com
// HTTP 200; Premiumize manda `authentication_failed` também com 200; os
// demais respondem 401/403.
const AUTH_MESSAGE = /AUTH_(?:BAD_APIKEY|MISSING_APIKEY|BLOCKED|USER_BANNED)|authentication_failed|apikey is invalid|invalid (?:api )?(?:key|token)|unauthor[iz]|forbidden|bad token/i;

function isAuthError(error: MaybeError) {
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
  isQuotaError = true;
  constructor(message: string) {
    super(message);
    this.name = 'QuotaError';
  }
}

const QUOTA_MESSAGE = /MAGNET_TOO_MANY_ACTIVE|magnets? limit reached|too many active|quota exceeded|limit reached/i;

function isQuotaError(error: MaybeError) {
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
  isRateLimitError = true;
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

const RATE_LIMIT_MESSAGE = /rate_limit_reached|too many (?:api )?requests|slow down/i;

function isRateLimitError(error: MaybeError) {
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
  code = 'WORK_PICK';
  constructor() {
    super('não foi possível identificar a obra dentro do pack');
    this.name = 'WorkPickError';
  }
}

function isWorkPickError(error: MaybeError) {
  return error?.code === 'WORK_PICK';
}

/**
 * Episódio não identificável dentro de um pack de série. Com vários vídeos,
 * cair no maior toca outro episódio em silêncio; o handler devolve 404 para o
 * cliente escolher outra fonte.
 */
class EpisodePickError extends Error {
  code = 'EPISODE_PICK';
  /** O que o(s) arquivo(s) declararam vs. o que foi pedido — quando a prova
   * existe (vídeo único com nome técnico). O throw multi-vídeo não tem. */
  evidence?: {
    wantedSeason: number;
    wantedEpisode: number;
    declaredSeasons: number[];
    declaredEpisodes: number[];
    sample?: string;
  };
  /**
   * Retrato do throw AMBÍGUO (multi-vídeo). Campo SEPARADO do `evidence` de
   * propósito: quem decide gravar prova testa `evidence`, e um contexto de
   * diagnóstico não pode ser confundido com prova de episódio errado. Existe
   * porque "não contém o episódio pedido" sem dizer o que havia dentro é um
   * 404 sem diagnóstico — o caso que motivou: pack cacheado que nunca toca e
   * cujo log não dizia por quê.
   */
  context?: { videoCount: number; samples: string[] };
  constructor(evidence?: {
    wantedSeason: number;
    wantedEpisode: number;
    declaredSeasons: number[];
    declaredEpisodes: number[];
    sample?: string;
  }, context?: { videoCount: number; samples: string[] }) {
    super('não foi possível identificar o episódio dentro do pack');
    this.name = 'EpisodePickError';
    this.evidence = evidence;
    this.context = context;
  }
}

function isEpisodePickError(error: MaybeError) {
  return error?.code === 'EPISODE_PICK';
}

/**
 * A listagem veio COM arquivos e NENHUM é vídeo — a única prova determinística
 * de magnet quebrado. Diferente do null: listagem VAZIA é transferência fria
 * ("ainda baixando") e prova nenhuma, então continua null. Quem lança é o
 * pickFile, porque é o único ponto que vê files e videos juntos — o null que os
 * adaptadores devolvem para "não pronto" não distingue nada, e condenar hash
 * por null era blacklistar torrent bom por até 24h (pior caso: o próprio
 * autofetch baixa o torrent e o banco esconde o resultado pronto por um dia).
 */
class NoVideoError extends Error {
  code = 'NO_VIDEO';
  constructor() {
    super('o torrent não contém nenhum arquivo de vídeo');
    this.name = 'NoVideoError';
  }
}

function isNoVideoError(error: MaybeError) {
  return error?.code === 'NO_VIDEO';
}

/** O post prometeu dublado, mas os paths dos vídeos provaram release EN. */
class DubLieError extends Error {
  code = 'DUB_LIE';
  evidence: { matchedGroup?: string; videoCount: number; sample?: string };
  constructor(evidence: { matchedGroup?: string; videoCount: number; sample?: string }) {
    super('o torrent anunciado como dublado contém release em inglês');
    this.name = 'DubLieError';
    this.evidence = evidence;
  }
}

function isDubLieError(error: MaybeError) {
  return error?.code === 'DUB_LIE';
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
async function json(
  url: string | URL,
  { method = 'GET', headers = {}, body, timeout }: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    timeout?: number;
  } = {},
) {
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
function baseName(p: string) {
  return String(p || '').split(/[/\\]/).pop() || '';
}

// Nome que é SÓ o domínio do site, com ou sem "www" e sem nada em volta:
// "COMANDOTORRENTS.COM.mp4", "WWW.BLUDV.TV.mp4", "[BAIXARTORRENT.COM].mp4".
// Estreito de propósito — o arquivo de conteúdo do mesmo torrent carrega o
// domínio NO MEIO ("True.Detective.S03E03…WWW.COMANDOTORRENTS.COM.mkv") e a
// âncora ^...$ o preserva.
const SITE_AD = /^(?:www[\s._-]+)?[a-z0-9][a-z0-9-]*\.(?:com|net|org|tv|to|me|cc|info|xyz|biz|br|io|se|ws)(?:\.[a-z]{2})?$/i;

/** Vídeo que é propaganda do site, não conteúdo. */
function isSiteAd(path: string) {
  const name = baseName(path).replace(/\.[a-z0-9]{2,4}$/i, '');
  return SITE_AD.test(name.replace(/^[\s[\](){}._-]+|[\s[\](){}._-]+$/g, ''));
}

// Cobertura mínima do nome no arquivo para o casamento contar como
// confiável. Abaixo disso o token solto da franquia ("Star") casaria tudo.
const WORK_COVERAGE_MIN = 0.7;

/** Fração dos tokens significativos do nome presentes no nome do arquivo. */
function workCoverage(fileName: string, name: string) {
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
function looksMultiWorkFiles(files: DebridFile[]) {
  const mains = files.filter(
    (f) => VIDEO_EXT.test(f.path || '') && !SAMPLE.test(f.path || '') && !EXTRA.test(f.path || ''),
  );
  if (mains.length <= 1) return false;
  const years = new Set();
  for (const file of mains) {
    // O ano que prova multi-obra vem do ARQUIVO, não da pasta: a raiz
    // "Trilogia (1985-1990)" contém 1985 em todos os arquivos e faria
    // qualquer pack de filme único parecer multi-obra.
    const match = String(baseName(file.path || '') || '').match(/(?:^|[^0-9])((?:19|20)\d{2})(?:$|[^0-9])/);
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
function pickWorkFile(files: DebridFile[], { names, year }: { names?: string[]; year?: number | string | null } = {}) {
  const cleanYear = Number(String(year || '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  const scored = files
    .map((f) => ({
      file: f,
      cov: Math.max(...(names || []).map((n) => workCoverage(f.path || '', n))),
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
function pickFile(files: DebridFile[], { season, episode, work }: { season?: number | null; episode?: number | null; work?: any } = {}) {
  let videos = files.filter((f) => VIDEO_EXT.test(f.path || '') && !SAMPLE.test(f.path || ''));
  if (videos.length === 0) {
    // Listagem COM arquivos e nenhum vídeo é prova; listagem vazia é
    // transferência fria, e prova nenhuma.
    if (files.length > 0) throw new NoVideoError();
    return null;
  }
  // Propaganda do site empacotada junto ("COMANDOTORRENTS.COM.mp4",
  // "WWW.BLUDV.TV.mp4"): é vídeo pela extensão, mas não é conteúdo. Contava na
  // contagem e transformava episódio SOLTO em "pack multi-vídeo" — medido no
  // 4014bd0d, cujo conteúdo real era "True.Detective.S03E03…mkv": a prova de
  // episódio errado existia e ficava escondida atrás do throw ambíguo, então a
  // fonte nunca saía da lista e nunca tocava.
  //
  // Só cai quando sobra conteúdo: torrent que só tem a propaganda continua
  // seguindo pelo caminho antigo, sem virar NoVideoError (que condena o hash).
  const semPropaganda = videos.filter((f) => !isSiteAd(f.path || ''));
  if (semPropaganda.length > 0 && semPropaganda.length < videos.length) videos = semPropaganda;

  if (season != null && episode != null) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const seasonForms = `(?:${s}|${season})`;
    // Alguns packs BR usam E006/E012. Até dois zeros à esquerda preservam os
    // formatos comuns sem aceitar o número como trecho de outro episódio.
    const episodeForms = `(?:0{0,2}${episode})`;
    // Temporada pedida no caminho, incluindo as formas pt-BR ("2ª Temporada",
    // "Temporada 2") que os packs locais usam de verdade.
    const pathHasSeason = (path: string) => new RegExp(
      `(?:\\bs${seasonForms}(?!\\d)|\\bt${seasonForms}(?!\\d)|\\bseason[\\s._-]*${seasonForms}(?!\\d)|\\b${seasonForms}x` +
      `|\\b(?:temp|temporada)[\\s._-]*${seasonForms}(?!\\d)|\\b${seasonForms}ª?[\\s._-]*(?:temp|temporada)\\b)`,
      'i',
    ).test(path);
    // Temporada QUALQUER (numerada) no caminho — não só a pedida. Serve para
    // medir ambiguidade: pack multi-temporada aplainado ("Season 1/EP09" +
    // "Season 4/EP09" no mesmo torrent) tem arquivo com temporada que não é a
    // pedida. Só o dígito marca; "Temporada Completa" sem número não declara
    // qual é e não ambigua por si só.
    const pathHasAnySeason = /(?:\b[st]\d{1,2}(?!\d)|\bseason[\s._-]*\d|\b\d{1,2}x\d{1,2}\b|\b(?:temp|temporada)[\s._-]*\d|\b\d{1,2}ª?[\s._-]*(?:temp|temporada)\b)/i;
    // Forte: o padrão carrega a temporada pedida (s01e05, t01e05, 1x05, 0105)
    // ou um padrão fraco em caminho que declara a temporada pedida. A forma
    // TxxEyy é comum em packs BR ("T01E01 - O Distante Brilho da Escuridão")
    // e não casa nos padrões fracos porque o \b não existe entre dígito e
    // letra dentro de "T01E01".
    const strongPatterns = [
      new RegExp(`\\bs${seasonForms}[\\s._-]*e${episodeForms}\\b`, 'i'),
      new RegExp(`\\bt${seasonForms}[\\s._-]*e${episodeForms}\\b`, 'i'),
      new RegExp(`\\b${seasonForms}x${episodeForms}\\b`, 'i'),
      new RegExp(`\\b${s}${e}\\b`),
    ];
    // Fraco: diz o episódio mas não a temporada ("Episodio 05", "E05", "05").
    const weakPatterns = [
      new RegExp(`\\b(?:epis[oó]dio|cap[ií]tulo|ep|cap)[\\s._-]*0{0,2}${episode}\\b`, 'i'),
      new RegExp(`\\be[\\s._-]*0{0,2}${episode}\\b`, 'i'),
    ];
    const bareEpisode = new RegExp(`(?:^|[\\s._-])0{0,2}${episode}(?:[\\s._-]|$|\\.[a-z0-9]+$)`, 'i');
    // O layout de canais de áudio ("DDP5.1", "TrueHD.7.1", "AAC2.0") deixa um
    // número NU delimitado no caminho, e o bareEpisode o lia como episódio:
    // medido em "True.Detective.S03E07…DDP5.1.H.264-NTb.mkv", que casava o
    // EPISÓDIO 1 — com "S03" ao lado satisfazendo o pathHasSeason, virava
    // escolha FORTE e o play do E01 recebia o E07. Vale para o episódio 1 de
    // qualquer série com áudio 5.1/7.1, que é a maioria dos WEB-DL.
    //
    // Só o par de canais sai, e o padrão é estreito de propósito: o primeiro
    // dígito de um layout real nunca é 3 ou 4, e o `s`/`t` à esquerda preserva
    // "S5.1"/"T3.1" (temporada com episódio), que são episódio de verdade.
    const epPath = (path: string) => path.replace(/(?<![\dst])[125678]\.[012](?!\d)/gi, ' ');
    const strong = videos.filter((f) => {
      const path = f.path || '';
      const clean = epPath(path);
      return strongPatterns.some((p) => p.test(path))
        || (pathHasSeason(path) && (weakPatterns.some((p) => p.test(clean)) || bareEpisode.test(clean)));
    });
    if (strong.length > 0) return strong[0];
    // Fraco só vale quando o pack não tem temporada numerada DIVERGENTE da
    // pedida: se algum arquivo declara outra temporada, o "EP09" solto pode
    // pertencer a ela — tocar o primeiro seria servir outro episódio em
    // silêncio. Marcadores que confirmam a temporada pedida não ambiguam.
    const ambiguousSeason = videos.some((file) => {
      const path = file.path || '';
      return pathHasAnySeason.test(path) && !pathHasSeason(path);
    });
    if (!ambiguousSeason) {
      // O número NU não entra aqui: sem a temporada no próprio caminho ele é
      // ambíguo por natureza ("Serie.05.Coisa") e já foi rejeitado acima.
      const weak = videos.find((f) => weakPatterns.some((p) => p.test(epPath(f.path || ''))));
      if (weak) return weak;
    }
    // Vídeo único continua compatível com torrents de episódio sem nome técnico.
    // Com pack, o maior arquivo é prova nenhuma de qual episódio foi pedido.
    if (videos.length > 1) {
      // Sem prova de qual episódio é (por isso `evidence` fica vazio), mas com
      // o retrato do que havia dentro: é a única forma de descobrir POR QUE um
      // pack cacheado nunca toca sem pedir a listagem ao debrid de novo.
      throw new EpisodePickError(undefined, {
        videoCount: videos.length,
        samples: videos.slice(0, 3).map((v) => baseName(v.path || '').slice(0, 70)),
      });
    }
    // Vídeo único que sobrou: se o NOME do arquivo declara s/e, confere com o
    // pedido. Caso real (True Detective S03E02): o pack anunciava a temporada
    // 3 mas continha só "S03E07" — sem esta checagem o fallback tocava o
    // episódio 7. Parse que não declara nada PASSA: torrent de episódio sem
    // nome técnico ("episodio-sem-nome.mkv") continua compatível.
    //
    // Dois ruídos saem ANTES do parse porque o parseTitleSeasonEpisode os lê
    // como temporada/episódio, e aqui isso vira recusa de play legítimo:
    // - "1920x1080" casa \d+x\d+ e vira S20/E108;
    // - "DTS5.1"/"Atmos5.1" casam o padrão de temporada `s(\d)`, que não exige
    //   fronteira à esquerda, e viram S05 — medido: um episódio sem marcador
    //   no nome ("Nome.do.Episodio.DTS5.1.mkv") era recusado pela dimensão de
    //   temporada. Só o `s` COLADO em letra é ruído; "S05" com separador antes
    //   continua sendo temporada de verdade.
    const singleName = baseName(videos[0].path || '')
      .replace(/\b\d{3,4}x\d{3,4}\b/g, ' ')
      .replace(/[a-z]s\d{1,2}(?![\de])/gi, ' ');
    const declared = parseTitleSeasonEpisode(singleName);
    // "complete" só é cobertura total quando NÃO há temporada explícita —
    // mesma semântica medida do seasonCoverageExcludes (format.ts): um nome
    // que declara "Todas as Temporadas" E uma temporada específica ainda
    // precisa conferir a temporada declarada.
    if (!declared.complete || declared.seasons.length > 0) {
      // As duas dimensões são INDEPENDENTES: um arquivo S02E05 casa o
      // episódio 5 pedido mas prova a temporada ERRADA — checar a temporada
      // só quando não há episódio declarado deixaria esse caso tocar.
      // Continua conservador: cada dimensão condena apenas quando declarada.
      const wrongEpisode = declared.episodes.length > 0 && !declared.episodes.includes(episode);
      const wrongSeason = declared.seasons.length > 0 && !declared.seasons.includes(season);
      if (wrongEpisode || wrongSeason) {
        throw new EpisodePickError({
          wantedSeason: season,
          wantedEpisode: episode,
          declaredSeasons: [...declared.seasons],
          declaredEpisodes: [...declared.episodes],
          sample: baseName(videos[0].path || '').slice(0, 60),
        });
      }
    }
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
async function batched(infoHashes: string[], size: number, fn: (batch: string[], ctx?: any) => Promise<any>, { timeoutMs }: { timeoutMs?: number } = {}) {
  const slices: any[][] = [];
  for (let i = 0; i < infoHashes.length; i += size) {
    slices.push(infoHashes.slice(i, i + size));
  }

  const settled = await Promise.allSettled(slices.map((slice) => fn(slice, { timeoutMs })));
  const cached = new Set<string>();
  let failures = 0;
  let authFailures = 0;
  let quotaFailures = 0;
  let rateFailures = 0;
  let lastCause = '';

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      result.value.forEach((hash: string) => cached.add(hash));
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
function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export {
  magnetFor, json, pickFile, pickWorkFile, looksMultiWorkFiles, workCoverage, batched, wait,
  AuthError, isAuthError, QuotaError, isQuotaError, RateLimitError, isRateLimitError,
  WorkPickError, isWorkPickError, EpisodePickError, isEpisodePickError,
  NoVideoError, isNoVideoError, DubLieError, isDubLieError,
  VIDEO_EXT, SAMPLE, EXTRA, isSiteAd, baseName,
};
