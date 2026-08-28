import config from '../config.js';
import { normalizeTitle } from './title-normalization.js';
import { TECH_NOISE } from './release-matching.js';

// Resolução que o título não informa. Balde e cota próprios, separados do SD.
const UNKNOWN_QUALITY = 'sem resolução';

// Ruído de release: o mesmo vocabulário técnico do matching, mas aqui usado
// para achar o BLOB de tags no fim do título (ver stripQualityTagBlob). Derivado
// de TECH_NOISE (não de lista nova) para os dois vocabulários não divergirem.
const normalizeBlobTag = (tag: string) => tag.toLowerCase().replace(/[^a-z0-9+]/g, '');

// Recorte do TECH_NOISE com as tags de qualidade/fonte que aparecem no blob.
// tokens curtos não-técnicos ("h", "tv", "us", "gb") ficam de fora — cortar
// cauda por eles é convidar falso corte de título legítimo.
const TAG_BLOB_VOCAB = new Set(
  TECH_NOISE.filter((w) =>
    /^(?:\d{3,4}p|4k|uhd|sd|hd|hdrip|fullhd|webdl|webrip|bluray|bdrip|brrip|hdtv|remux|hybrid|x264|x265|h264|h265|avc|hevc|av1|xvid|divx|10bit|8bit|hdr|hdr10|imax|mkv|mp4|avi|web|dl|blu|ray)$/.test(w),
  ).map(normalizeBlobTag),
);

/**
 * Posts de site BR (hdrtorrent medido) anexam ao FIM do título um blob de tags
 * separadas por vírgula listando TODAS as qualidades do post:
 *
 *   "Fallout 1ª Temporada … LEGENDADA 720P 1080p, 2160p, 720p, HD, WEB-DL"
 *
 * Sem cortar essa cauda, `qualityFromTitle` varre a string inteira, casa o
 * "2160p" do blob e classifica um botão 720P como 4K — e o rótulo errado
 * alimenta cota de qualidade, reserva BR, autofetch e o índice (que persiste
 * por semanas). O corte exige 2+ tags do vocabulário de qualidade/fonte
 * separadas por vírgula NO FIM: título legítimo que termina em "1080p" (tag
 * única) não perde o sufixo.
 */
function stripQualityTagBlob(title = '') {
  const raw = String(title || '');
  if (!raw.includes(',')) return raw;
  let cut = raw.length;
  let tags = 0;
  for (;;) {
    // Consome uma tag por vez do fim; o índice do separador é onde a cauda
    // começa. Parar na primeira tag fora do vocabulário preserva o corpo.
    const m = raw.slice(0, cut).match(/[,;]\s*([A-Za-z0-9][A-Za-z0-9+.\-]*)\s*$/);
    if (!m) break;
    if (!TAG_BLOB_VOCAB.has(normalizeBlobTag(m[1]))) break;
    cut = m.index as number;
    tags += 1;
  }
  if (tags < 2) return raw;

  // O post cola a PRIMEIRA tag do blob direto na qualidade do botão, sem
  // vírgula ("… LEGENDADA 720P 1080p, 2160p, …"). Essa cabeça é enumeração do
  // post e sai com a cauda: se o mesmo valor já existe no corpo ("… Dual
  // 1080P 1080p, …"), o corpo o retém; se não existe, era só o blob repetindo
  // a lista — e mantê-la faria qualityFromTitle escolher a maior resolução da
  // enumeração em vez da qualidade do botão.
  const before = raw.slice(0, cut);
  const head = before.match(/(?:^|\s)([A-Za-z0-9][A-Za-z0-9+.\-]*)$/);
  if (head && TAG_BLOB_VOCAB.has(normalizeBlobTag(head[1]))) {
    return before.slice(0, before.length - head[1].length).trimEnd();
  }
  return before.trimEnd();
}

/**
 * "Não sei" é diferente de "é ruim". Título sem resolução vira UNKNOWN_QUALITY,
 * não SD: os sites BR quase nunca publicam resolução ("Nome (2026) [opção 3]"),
 * e enquanto isso caía no balde do SD, zerar a cota de SD desligava a
 * prioridade brasileira inteira — inclusive as vagas reservadas.
 * SD agora exige uma marca explícita de baixa qualidade.
 */
function qualityFromTitle(title = '') {
  const t = stripQualityTagBlob(title).toUpperCase();
  if (/\b(2160P|4K|UHD)\b/.test(t)) return '2160p';
  if (/\b1080P\b/.test(t)) return '1080p';
  if (/\b720P\b/.test(t)) return '720p';
  if (/\b480P\b/.test(t)) return '480p';
  // 576p/540p são resoluções SD de verdade (PAL), não "não sei".
  if (/\b(576P|540P|360P|240P|SDTV|DVD[- ]?(?:RIP|SCR)|VHS[- ]?RIP|TS|TC|CAM[- ]?RIP|CAM)\b/.test(t)) return 'SD';
  return UNKNOWN_QUALITY;
}

function sourceFromTitle(title = '') {
  const t = title.toUpperCase();
  if (/\b(BLURAY|BLU-RAY|BDREMUX|BD\b)/.test(t)) return 'BluRay';
  if (/\bWEB[-. ]?DL\b/.test(t)) return 'WEB-DL';
  if (/\bWEB[-. ]?RIP\b/.test(t)) return 'WEBRip';
  if (/\bHDTV\b/.test(t)) return 'HDTV';
  // CAMRip e HDCAM não têm fronteira de palavra em volta de "CAM" e escapavam
  // do teste anterior (`\bCAM\b`): passavam como fonte desconhecida. Isso pesa
  // mais desde que o autofetch baixa por swarm — gravação de cinema é
  // justamente o que costuma ter o maior número de seeders num lançamento.
  if (/\b(?:HD[-. ]?)?CAM(?:[-. ]?RIP)?\b/.test(t)) return 'CAM';
  return '';
}

/**
 * Corte do filme, quando o release anuncia um. Não é firula: numa lista de
 * quatro 4K do mesmo filme, "Theatrical" e "Alternate Ending" são FILMES
 * DIFERENTES no fim, e a linha compacta não tinha como diferenciá-los — só o
 * número de seeders mudava. Escolher pelo maior seed levava ao corte errado.
 *
 * Rótulos curtos de propósito: isto divide a coluna estreita com qualidade,
 * fonte e áudio.
 */
function editionFromTitle(title = '') {
  const t = title.toUpperCase();
  if (/\bALTERNAT(E|IVO|IVA)\s+(ENDING|FINAL)\b/.test(t)) return 'Alt.End';
  // "Alternate Version" não diz QUAL é a diferença, mas diz que não é o corte
  // padrão — e isso já basta para o usuário não escolher por acidente.
  if (/\bALTERNAT(E|IVO|IVA)\s+(VERSION|VERS[AÃ]O|CUT)\b|\bVERS[AÃ]O\s+ALTERNATIVA\b/.test(t)) return 'Alt.Ver';
  if (/\b(DIRECTOR'?S\s+CUT|DIRECTORS\s+CUT)\b/.test(t)) return 'DC';
  if (/\b(EXTENDED|VERS[AÃ]O\s+ESTENDIDA)\b/.test(t)) return 'Extended';
  if (/\b(THEATRICAL|VERS[AÃ]O\s+DE\s+CINEMA)\b/.test(t)) return 'Cinema';
  if (/\b(REMASTER(ED)?|REMASTERIZAD[OA])\b/.test(t)) return 'Remaster';
  if (/\bIMAX\b/.test(t)) return 'IMAX';
  if (/\b(UNCUT|UNRATED|SEM\s+CORTES)\b/.test(t)) return 'Uncut';
  return '';
}

function explicitPtAudio(title = '') {
  const t = title.toUpperCase();
  const isExplicitSub =
    /\b(LEGENDAD[OA]|LEGENDAS?|LEG[-.]?PT[-.]?BR|SUB[-.]?PT[-.]?BR|SOFT[- ]?SUB)\b/.test(t) ||
    /\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b/.test(t);

  return (
    /\b(DUBLAD[OA]|DUBLAGEM|DUBBED|DUB[-.]?BR|AUDIO[- ]?PT[-.]?BR|DUBLADO[- ]?PT[-.]?BR)\b/.test(t) ||
    /\[\s*DUB\s*\]|\(\s*DUB\s*\)|\bDUB\b/.test(t) ||
    (/\b(PT[-.]?BR|PTBR|PORTUGU[EÊ]S|BRAZILIAN)\b/.test(t) && !isExplicitSub)
  );
}

/** Marcador de áudio PT no path real do arquivo, não no título do post. */
function hasPtAudioMark(path = '') {
  const tokens = normalizeTitle(path).split(' ').filter(Boolean);
  const joined = ` ${tokens.join(' ')} `;
  return config.audioAudit.ptMarkers.some((marker: string) => {
    const normalized = normalizeTitle(marker);
    return normalized && joined.includes(` ${normalized} `);
  });
}

/** Grupo/canal de cena EN forte. Nome sem marca continua ambíguo e passa. */
function strongEnSceneMark(path = '') {
  if (hasPtAudioMark(path)) return null;
  const tokens = new Set(normalizeTitle(path).split(' ').filter(Boolean));
  return config.audioAudit.enGroups.find((group: string) => tokens.has(normalizeTitle(group))) || null;
}

/**
 * Mentira só é provada quando TODOS os vídeos contradizem uma promessa PT com
 * sinal EN forte. Um único marcador PT preserva o item: falso negativo é pior.
 */
function dubbedLieVerdict(videoPaths: string[] = [], promisedDubbed = false) {
  const paths = videoPaths.map(String).filter(Boolean);
  if (!config.audioAudit.enabled || !promisedDubbed || paths.length === 0) {
    return { lie: false, videoCount: paths.length };
  }
  if (paths.some((path) => hasPtAudioMark(path))) return { lie: false, videoCount: paths.length };
  const matchedGroup = paths.map(strongEnSceneMark).find(Boolean);
  return matchedGroup
    ? { lie: true, matchedGroup, videoCount: paths.length }
    : { lie: false, videoCount: paths.length };
}

/**
 * Áudio é a informação que mais importa neste addon (foco em dublado) e os
 * sites BR a escrevem no título. Sem ela o usuário abre o torrent pra descobrir.
 */
function audioFromTitle(title = '') {
  // O blob de tags do fim não descreve áudio, mas pode citar "DUAL" entre as
  // tags — classifica sobre o título sem a cauda.
  const t = stripQualityTagBlob(title).toUpperCase();

  // Convenção de nome de post (hdrtorrent medido): o PREFIXO é sempre
  // "... Dublada e Dual", mesmo quando o botão é LEGENDADA. O marcador do
  // segmento do botão é mais específico e vence: se existe LEGENDADA/
  // LEGENDADO/SUBBED fora dessa frase e nenhum outro marcador de dublagem,
  // o título é legendado — o prefixo do post não pode mentir melhor que o
  // botão. Um DUBLADO/DUAL FORA da frase ("... COMPLETA DUBLADA Dual 1080P")
  // mantém o comportamento de sempre.
  const semConvencao = t.replace(/\bDUBLAD[OA]\s+E\s+DUAL\b/g, ' ');
  const isExplicitSub =
    /\b(LEGENDAD[OA]|LEGENDAS?|LEG[-.]?PT[-.]?BR|SUB[-.]?PT[-.]?BR|SOFT[- ]?SUB)\b/.test(semConvencao) ||
    /\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b/.test(semConvencao);
  const isExplicitDub = explicitPtAudio(semConvencao);

  if (isExplicitSub && explicitPtAudio(t) && !isExplicitDub) return 'Legendado';

  // Dual / Multi áudio. MULTI sozinho entra aqui: o comentário do
  // hasExplicitForeignAudio já dizia que MULTI carrega a faixa original e não
  // prova conteúdo estrangeiro — cair no balde `lixo` contradizia isso e
  // entregava o magnet à limpeza por ausência de marcador.
  if (/\b(DUAL|DOUBLE|MULTI|DUAL[- ]?AUDIO|AUDIO[- ]?DUPLO|DUPLO[- ]?AUDIO|MULTI[- ]?AUDIO|MULTIAUDIO)\b/.test(t)) {
    return 'Dual';
  }

  // Produções nacionais brasileiras (áudio original em PT-BR)
  if (/\b(NACIONAL|NAC)\b/.test(t) && !/\b(LEG|LEGENDAD[OA]|SUB|SUBBED)\b/.test(t)) {
    return 'Nacional';
  }

  if (isExplicitDub && isExplicitSub) return 'Dual';
  if (isExplicitDub) return 'Dublado';
  if (isExplicitSub) return 'Legendado';

  return '';
}

// Marcas estrangeiras explícitas não devem vencer por seeders quando o objetivo
// é aquecer um pack utilizável. MULTI/DUAL ficam fora desta lista: carregam a
// faixa original e não provam que o torrent não serve ao usuário.
function hasExplicitForeignAudio(title = '') {
  const t = String(title).toUpperCase();
  if (explicitPtAudio(title)) return false;
  return /\b(TRUEFRENCH|FRENCH|VOSTFR|VF|ITA|SUBITA|ESPANOL|CASTELLANO|RUS|GERMAN|NL)\b/.test(t);
}

/**
 * Dublado pt-BR visível no TÍTULO, independente do indexer. Tracker global
 * hospeda bastante release dublada titulada em português ("Jornada Nas
 * Estrelas … Dublado"); sem essa marca o resultado chegava com isBr=false,
 * era julgado contra o nome em inglês e morria antes das vagas BR.
 *
 * "Dual" sozinho não basta: em tracker global pode ser EN+qualquer idioma —
 * só conta com o PT explícito ao lado. Reusa os classificadores de áudio já
 * calibrados, em vez de uma segunda lista que divergiria.
 */
function looksPtBr(title = '') {
  const audio = audioFromTitle(title);
  if (audio === 'Dublado' || audio === 'Nacional') return true;
  return audio === 'Dual' && explicitPtAudio(title);
}

// Sinais de título em português para o balde "sem marca mas parece BR":
// acentos quase exclusivos do pt-BR, vocabulário de post BR e marcadores de
// site/grupo nacional. Sem nada disso e sem marca de áudio, é release
// estrangeira — o padrão do que entope a conta. Classificador COMPARTILHADO:
// a limpeza da conta (scripts/clean-undubbed.ts) usa a mesma lógica da busca —
// uma segunda lista divergiria.
const PT_VOCAB = /\b(temporadas?|epis[oó]dios?|dublad[oa]s?|dublagem|nacional|complet[oa]s?|cole[cç][aã]o|vers[oõ]es?|estendid[oa]s?|guerra|mundial|estreia|cap[ií]tulos?|caminho|cidade|noite|vingan[cç]a|cora[cç][aã]o|paix[aã]o|f[uú]ria|selvagem|assassino|assassina|maldi[cç][aã]o)\b/i;
// `de` entra aqui: é a preposição portuguesa mais comum e sua ausência era a
// maior causa isolada de títulos BR sem acento caírem no balde `lixo`
// (medido: 19 de 20 títulos de teste). Exige 2+ ocorrências, então título
// estrangeiro com um "de" solto não basta.
const PT_STOP_TWO = (t: string) => (t.match(/\b(das?|de|dos?|n[ao]s?|umas?|para|com|entre|sobre|atr[aá]s)\b/gi) || []).length >= 2;
const BR_MARK = /(comandotorrents|bludv|nerdfilmes|torrentdosfilmes|wolverdon|andretpf|lapumia|megatorrents|hdtorrent|torrentbr|bthd|www\.\w+\.org\s*-\s*)/i;

/** Sem marca de áudio, mas o título denuncia português (post BR sem marcação é o padrão). */
function hasPtSigns(title = ''): boolean {
  // Acentos case-insensitive: título TODO EM CAIXA ALTA ("OPERAÇÃO INVASÃO")
  // tem Ã/Ç maiúsculos e perdia o sinal — caía no balde 'lixo' e a varredura
  // destrutiva sweepUndubbed o apagava.
  return /[ãõ]/i.test(title) || /ç/i.test(title) || PT_VOCAB.test(title) || PT_STOP_TWO(title) || BR_MARK.test(title);
}

type AudioBucket = 'dub' | 'dual' | 'pt' | 'lixo';

/**
 * Balde de áudio por título:
 *   dub  — dublado/nacional/dual+PT explícito (looksPtBr);
 *   dual — Dual/Multi sem PT ao lado (ambíguo);
 *   pt   — sem marca de áudio, mas com sinal de português no título;
 *   lixo — legendado, áudio estrangeiro explícito, ou sem marca NEM sinal de PT.
 */
function audioBucket(title = ''): AudioBucket {
  if (looksPtBr(title)) return 'dub';
  if (audioFromTitle(title) === 'Dual') return 'dual';
  if (hasPtSigns(title)) return 'pt';
  return 'lixo';
}

/**
 * Veredito de ESTRANGEIRO com a assimetria do dubbedLieVerdict invertida para
 * o caminho da deleção: ausência de PT nunca condena — condenar exige prova
 * positiva de idioma estrangeiro. Um único marcador PT em qualquer lugar
 * (título do post OU path real de arquivo) absolve, porque falso positivo
 * aqui destrói acervo BR que custou horas de download.
 *
 *   absolve  — sinal PT em algum lugar;
 *   condena  — marca de áudio estrangeiro explícita OU grupo de cena EN
 *              reconhecido, e NENHUM sinal PT em lugar nenhum;
 *   unknown  — sem prova nos dois lados: nunca apaga (é o caso que o
 *              catálogo resolve com auditoria de arquivos, não com palpite).
 */
type ForeignVerdict = 'absolve' | 'condena' | 'unknown';

function foreignVerdict(filename = '', videoPaths: string[] = []): ForeignVerdict {
  const candidates = [String(filename || ''), ...videoPaths.map(String)].filter(Boolean);
  const temSinalPt = candidates.some((p) => looksPtBr(p) || hasPtSigns(p) || hasPtAudioMark(p));
  if (temSinalPt) return 'absolve';
  const provaEstrangeira = candidates.some(
    (p) => hasExplicitForeignAudio(p) || Boolean(strongEnSceneMark(p)),
  );
  return provaEstrangeira ? 'condena' : 'unknown';
}

function compactAudio(audio = '') {
  if (audio === 'Dublado') return 'DUB';
  if (audio === 'Legendado') return 'LEG';
  if (audio === 'Dual') return 'DUAL';
  if (audio === 'Nacional') return 'NAC';
  return '';
}

const TRACKER_LABEL_MAX = 14;

/**
 * Nome da fonte para a coluna estreita: o TLD não ajuda a reconhecer o site e,
 * passando de TRACKER_LABEL_MAX, o rótulo empurra o seeder para fora.
 *
 * A escada existe porque cortar seco parte a palavra no meio ("kickasstorrents"
 * virava "kickasstorrent"), e nome truncado assim é pior que nome curto: o
 * usuário lê como se fosse outra fonte.
 */
function compactTracker(tracker = '') {
  let label = String(tracker).trim().replace(/(?:\.[a-z]{2,})+$/i, '');
  if (label.length <= TRACKER_LABEL_MAX) return label;

  // Todos esses sites repetem "torrent(s)" no nome — é a parte que menos
  // identifica ("ComandoTorrents" → "Comando", como o Torrentio exibe).
  const withoutSuffix = label.replace(/[\s_-]*torrents?$/i, '');
  if (withoutSuffix.length >= 4) label = withoutSuffix;
  if (label.length <= TRACKER_LABEL_MAX) return label;

  // Última fronteira que ainda cabe: separador ou transição camelCase
  // ("NerdFilmesTorrent" → "NerdFilmes"). Sobrando menos de 4 chars o corte
  // não identifica mais nada, e aí o corte seco é menos ruim.
  const window = label.slice(0, TRACKER_LABEL_MAX + 1);
  const boundaries = [...window.matchAll(/[\s_-]+|(?<=[a-z0-9])(?=[A-Z])/g)]
    .map((m) => m.index)
    .filter((index) => index >= 4);
  if (boundaries.length) return label.slice(0, boundaries[boundaries.length - 1]);

  return label.slice(0, TRACKER_LABEL_MAX);
}

export {
  UNKNOWN_QUALITY,
  stripQualityTagBlob,
  qualityFromTitle,
  sourceFromTitle,
  editionFromTitle,
  explicitPtAudio,
  hasPtAudioMark,
  strongEnSceneMark,
  dubbedLieVerdict,
  audioFromTitle,
  hasExplicitForeignAudio,
  looksPtBr,
  hasPtSigns,
  audioBucket,
  foreignVerdict,
  compactAudio,
  compactTracker,
};
export type { AudioBucket, ForeignVerdict };
