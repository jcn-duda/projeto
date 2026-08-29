'use strict';

// Regras de release dos cinco perfis de resolver (PLANO_MELHORIAS §5.8, item 9,
// passo 4). Classificadores de qualidade/fonte, hooks de áudio, padrões de
// episódio/pack, a máquina de estados da âncora e o resolver de href de
// protetor viviam copiados nos cinco perfis — cada cópia era um lugar a mais
// para divergirem sem ninguém perceber. Tudo aqui é factory ou função pura; as
// diferenças vivas entre os sites entram como PARÂMETRO, nunca como "conserto":
//   R-2 — sem estado de módulo. Regex com /g só circula via matchAll (que
//   itera num CLONE e não move o lastIndex do original), o packPatternG é
//   clonado por factory e o regex de âncora é recriado por chamada de
//   parseDownloadLinks — senão um throw no meio do laço (o TypeError latente
//   do desempate, preservado de propósito) deixaria lastIndex sujo.
//   R-4 — diferenças vivas são preservadas: o matcher de fonte do vaca mantém
//   o typo BLRAY (o rótulo "BLRAY" casa o matcher e cai em null no
//   classificador) e o nerd/tdf têm classificadores de qualidade/fonte
//   próprios, FORA da factory comum; o pack do vaca aceita \bbatch\b e a faixa
//   dele usa [.\-s]* (com "s" literal) como os cards publicam hoje.
//   R-7 — regex de caminho quente nasce no closure da factory ou no topo do
//   módulo, fora do laço: o challenger-m2 tem orçamento de 100-200ms por vetor.
//
// Títulos, feeds, normalizeQuery e o laço de fallback do resolve vivem no
// release-format.js (irmão, sem ciclo).

// O site publica "UHD"/"Full HD"/"HD"/"SD" sem o sufixo p. Vale o ÚLTIMO token
// do contexto (segmento + âncora) — o mais próximo do botão.
const QUALITY_MATCH_RE = /\b(2160\s*P|4K|UHD|1080\s*P|FULL\s*HD|720\s*P|\bHD\b(?!\s*TV)|576\s*P|480\s*P|\bSD\b|\d{3,4}\s*P)\b/gi;
const DEFAULT_SOURCE_MATCH_RE = /\b(BDREMUX|REMUX|BLU[- ]?RAY|BLURAY|BD\b|BDRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM)\b/gi;
// R-4: o typo BLRAY é comportamento vivo do card vacatorrent — não corrigir
// sem revalidar os cards, pois muda o resultado ao vivo.
const VACA_SOURCE_MATCH_RE = /\b(BDREMUX|REMUX|BLU[- ]?RAY|BLRAY|BD\b|BDRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM)\b/gi;

// `matchPattern` é o regex de DESCOBERTA do token no contexto; a classificação
// (strings de saída) é a mesma nos três perfis que usam a factory. O
// nerdfilmes/tdf têm strings de saída próprias e NÃO passam por aqui (R-4).
function createSourceRules({ matchPattern = DEFAULT_SOURCE_MATCH_RE } = {}) {
  function extractSourceToken(raw) {
    const token = String(raw || '').toUpperCase().trim();
    if (/\b(?:BDREMUX|REMUX)\b/.test(token)) return 'REMUX';
    if (/\b(?:BLU[- ]?RAY|BLURAY|BD\b|BDRIP)\b/.test(token)) return 'BLU-RAY';
    if (/\b(?:WEB[-. ]?DL)\b/.test(token)) return 'WEB-DL';
    if (/\b(?:WEB[-. ]?RIP|WEBRIP)\b/.test(token)) return 'WEBRIP';
    if (/\bHDTV\b/.test(token)) return 'HDTV';
    if (/\b(?:CAMRIP|CAM)\b/.test(token)) return 'CAM';
    return null;
  }

  function normalizeSource(context) {
    const matches = [...String(context || '').toUpperCase().matchAll(matchPattern)];
    if (!matches.length) return null;
    return extractSourceToken(matches[matches.length - 1][0]);
  }

  return { extractSourceToken, normalizeSource };
}

function createQualityRules() {
  function extractQualityToken(raw) {
    const token = String(raw || '').toUpperCase().trim();
    if (/\b(?:2160\s*P|4K|UHD)\b/.test(token)) return 2160;
    if (/\b(?:1080\s*P|FULL\s*HD)\b/.test(token)) return 1080;
    if (/\b(?:720\s*P|\bHD\b(?!\s*TV))\b/.test(token)) return 720;
    if (/\b(?:576\s*P)\b/.test(token)) return 576;
    if (/\b(?:480\s*P|\bSD\b)\b/.test(token)) return 480;
    const m = token.match(/\b(\d{3,4})\s*P\b/);
    return m ? Number(m[1]) : null;
  }

  function normalizeQuality(context) {
    const matches = [...String(context || '').toUpperCase().matchAll(QUALITY_MATCH_RE)];
    if (!matches.length) return null;
    return extractQualityToken(matches[matches.length - 1][0]);
  }

  return { extractQualityToken, normalizeQuality };
}

// Marcadores de trilha: os posts usam DUAL ÁUDIO/DUBLADO/LEGENDADO, mas temas
// novos também publicam NACIONAL/PORTUGUÊS/[DUB]/[LEG]. O segmento aceita o
// prefixo "VERSÃO MKV/MP4"; a âncora não. NERD_* é o par estreito do
// nerd/tdf (sem NACIONAL nem variantes [LEG]).
const AUDIO_SEGMENT_RE = /(?:VERS[AÃ]O\s+)?(?:MKV\s+|MP4\s+)?(DUAL[-\s]+[AÁ]UDIO|AUDIO[-\s]+DUPLO|DUPLO[-\s]+AUDIO|DUBLAD\w*|LEGENDAD\w*|NACIONAL|PORTUGU[ÊE]S|PORTUGUES|\[\s*DUB\s*\]|\(\s*DUB\s*\)|\bDUB\b|\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b)/gi;
const AUDIO_ANCHOR_RE = /(DUAL[-\s]+[AÁ]UDIO|AUDIO[-\s]+DUPLO|DUPLO[-\s]+AUDIO|DUBLAD\w*|LEGENDAD\w*|NACIONAL|PORTUGU[ÊE]S|PORTUGUES|\[\s*DUB\s*\]|\(\s*DUB\s*\)|\bDUB\b|\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b)/gi;
const LEGENDADO_RE = /LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b/i;
const NERD_AUDIO_RE = /(DUAL\s+ÁUDIO|DUBLAD\w*|LEGENDAD\w*|PORTUGU[ÊE]S)/g;
const NERD_LEGENDADO_RE = /LEGENDAD/;

// matchAll itera num clone: o /g destas regex não vaza lastIndex entre chamadas.
function lastAudioMarker(text, re, legendadoRe) {
  const marker = [...String(text || '').matchAll(re)].pop();
  return marker ? (legendadoRe.test(marker[1]) ? 'legendado' : 'dublado') : null;
}

// Par de hooks de áudio do bludv/comandotorrents (regex idênticas nos dois).
function createBrAudioHooks() {
  return {
    audioFromSegment: (segment) => lastAudioMarker(segment, AUDIO_SEGMENT_RE, LEGENDADO_RE),
    audioFromAnchor: (anchorText) => lastAudioMarker(anchorText, AUDIO_ANCHOR_RE, LEGENDADO_RE),
  };
}

// Defaults = bludv/comandotorrents; o vacatorrent sobrescreve packPattern
// (\bbatch\b) e rangePattern ([.\-s]*) — diferenças vivas dos cards (R-4).
const DEFAULT_PACK_RESET_RE = /\b(?:TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA|PACK\s+COMPLETO|PACOTE\s+COMPLETO|\bPACK\b)\b/i;
const DEFAULT_EPISODE_RANGE_RE = /(?:EPIS[ÓO]DIOS?|EP|CAP[ÍI]TULOS?|CAP|E)[.\s-]*\d{1,3}[.\s-]*(?:A|AO|[-–—])[.\s-]*\d{1,3}\b/i;
const EPISODE_PATTERN_RE = /(?:EPIS[ÓO]DIO|EP|CAP[ÍI]TULO|CAP)[.\s-]*(\d{1,3})\b|\bS\d{1,2}E(\d{1,3})\b|\bE(\d{1,3})\b|\b\d{1,2}X(\d{1,3})\b/gi;
// Par estreito do nerd/tdf: pack manda sempre, sem faixa nem desempate.
const NARROW_PACK_RESET_RE = /TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA/i;
const NARROW_EPISODE_RE = /(?:EPIS[ÓO]DIO|EP)\s*(\d{1,3})\b/gi;

function createEpisodeRules(overrides = {}) {
  const packPattern = overrides.packPattern || DEFAULT_PACK_RESET_RE;
  const rangePattern = overrides.rangePattern || DEFAULT_EPISODE_RANGE_RE;
  // Clone global: matchAll exige a flag /g e o original é /i apenas (test()).
  const packPatternG = new RegExp(packPattern.source, 'gi');

  // Faixa "Episódios 01 ao 10" é PACK: quem casa por episódio no addon precisa
  // ver episode null, não o 10 (senão vira um episódio de temporada inteira).
  function extractEpisode(text) {
    if (!text) return null;
    if (rangePattern.test(text)) return null;
    const matches = [...text.matchAll(EPISODE_PATTERN_RE)];
    if (matches.length === 0) return null;
    const last = matches[matches.length - 1];
    const num = Number(last[1] || last[2] || last[3] || last[4]);
    return Number.isFinite(num) ? num : null;
  }

  return { packPattern, packPatternG, rangePattern, episodePattern: EPISODE_PATTERN_RE, extractEpisode };
}

/**
 * Passo de episódio da máquina de estados, parametrizado pelo escopo da
 * âncora de cada perfil: 'anchor-local' (bludv/nerd — o sinal da âncora vale
 * SÓ para o botão), 'anchor-writes' (comando/vaca — a âncora ESCREVE no
 * estado) e 'segment-only' (tdf — a âncora nunca interfere). No modo completo
 * (tieBreak) os dois sinais convivendo no MESMO segmento desempatam pela
 * posição do último marcador — "PACK ... EPISÓDIO 05" vale 5, "EPISÓDIO 05
 * ... TEMPORADA COMPLETA" vale null. O packMatchAll de comando/vaca é o padrão
 * CRU /i: o matchAll lança TypeError nesse ramo e isso é comportamento vivo
 * preservado — não troque pelo clone /g do bludv.
 */
function createEpisodeStep(cfg) {
  const {
    scope, packRe, rangeRe = null, epRe, extract = null, packMatchAll = null, tieBreak = false,
  } = cfg;

  const isPack = (text) => packRe.test(text) || (rangeRe ? rangeRe.test(text) : false);
  const lastMatch = (text, re) => [...String(text || '').matchAll(re)].pop();
  const extractOf = extract || ((text) => {
    const m = lastMatch(text, epRe);
    return m ? Number(m[1]) : null;
  });

  function segmentState(segment, state) {
    if (!tieBreak) {
      // Par estreito (nerd/tdf): pack manda sempre, sem desempate.
      if (packRe.test(segment)) return null;
      const m = lastMatch(segment, epRe);
      return m ? Number(m[1]) : state;
    }
    const segEp = extractOf(segment);
    const segIsPack = isPack(segment);
    if (segEp !== null && segIsPack) {
      const lastEp = lastMatch(segment, epRe);
      const lastPack = lastMatch(segment, packMatchAll);
      const lastEpIdx = lastEp ? lastEp.index : -1;
      const lastPackIdx = lastPack ? lastPack.index : -1;
      return lastEpIdx > lastPackIdx ? segEp : null;
    }
    if (segEp !== null) return segEp;
    if (segIsPack) return null;
    return state;
  }

  return function episodeStep(segment, anchorText, state) {
    if (scope === 'anchor-writes') {
      const anchorEp = extractOf(anchorText);
      if (anchorEp !== null) return { state: anchorEp, episode: anchorEp };
      if (isPack(anchorText)) return { state: null, episode: null };
      const next = segmentState(segment, state);
      return { state: next, episode: next };
    }
    const next = segmentState(segment, state);
    if (scope === 'segment-only') return { state: next, episode: next };
    // anchor-local: âncora com pack zera; âncora com episódio vence; senão
    // vale o estado do segmento. Nada do botão contamina os seguintes.
    const selfEp = extractOf(anchorText);
    return { state: next, episode: isPack(anchorText) ? null : (selfEp ?? next) };
  };
}

/**
 * Máquina de estados da âncora, comum aos cinco perfis: percorre o post EM
 * ORDEM DE DOCUMENTO mantendo o estado da seção corrente (áudio do cabeçalho
 * e episódio do segmento) e extrai cada botão. O perfil aporta regex de
 * âncora, resolução de href (magnet direto vs protetor), texto da âncora,
 * classificadores de áudio, passo de episódio e de qualidade/fonte.
 * `resolveHref` devolve `{ url }` ou `{ skip: true, advance? }` — `advance`
 * diz se o cursor da seção avança mesmo descartando o botão (comando/vaca
 * avançam em falha de URL/rejeição; bludv/nerd/tdf nunca avançam),
 * preservando exatamente o corte do segmento de cada perfil.
 */
function createLinkCollector(cfg) {
  const {
    anchorRe, resolveHref, anchorTextOf, stripTags, initialAudio,
    audioFromSegment, audioFromAnchor, episodeStep, qualityFn, sourceFn,
    decodeHtml = null, extrasOf = null,
  } = cfg;
  const SIZE_RE = /([\d.,]+)\s*(TB|GB|MB|KB)\b/g;

  return function parseDownloadLinks(html, baseUrl, options = {}) {
    const links = [];
    const source = decodeHtml ? decodeHtml(html) : html;
    let audio = initialAudio;
    let currentEpisode = null;
    let cursor = 0;
    // Clone por chamada: /g carrega lastIndex e um throw no meio do laço
    // deixaria o cursor sujo para a chamada seguinte.
    const anchor = new RegExp(anchorRe.source, anchorRe.flags);
    let match;
    while ((match = anchor.exec(source))) {
      const resolved = resolveHref(match, source, baseUrl);
      if (resolved.skip) {
        if (resolved.advance) cursor = anchor.lastIndex;
        continue;
      }

      const segment = stripTags(source.slice(cursor, match.index)).toUpperCase();
      const anchorText = anchorTextOf(match).toUpperCase();
      cursor = anchor.lastIndex;

      // 1. Áudio: o marcador do segmento atualiza o estado (vale para os
      // botões seguintes até a próxima seção); o da âncora é local ao botão.
      const segAudio = audioFromSegment(segment);
      if (segAudio) audio = segAudio;
      const localAudio = audioFromAnchor ? audioFromAnchor(anchorText) : null;

      // 2. Episódio vs reset de pack (escopo definido pelo perfil).
      const step = episodeStep(segment, anchorText, currentEpisode);
      currentEpisode = step.state;

      // 3. Qualidade, fonte e tamanho do contexto (segmento + âncora).
      const context = `${segment} ${anchorText}`;
      const sizeHit = [...context.matchAll(SIZE_RE)].pop();
      const item = {
        url: resolved.url,
        quality: qualityFn(context),
        size: sizeHit ? `${sizeHit[1]} ${sizeHit[2]}` : null,
        audio: localAudio != null ? localAudio : audio,
        episode: step.episode,
        source: sourceFn(context),
      };
      if (extrasOf) Object.assign(item, extrasOf(options));
      links.push(item);
    }
    return links;
  };
}

// Resolver de href dos perfis "simples" (comandotorrents/vacatorrent): magnet
// cru por prefixo; http(s) só com host de protetor, resolvendo o param `to=`
// (que esconde o alvo real) antes da checagem.
function createProtectorHrefResolver({ isProtectorHost, decodeEntities, attribute }) {
  return function resolveHref(match, html, baseUrl) {
    const rawHref = (attribute(match[1], 'href') || '').trim();
    if (!rawHref) return { skip: true };
    if (/^magnet:\?/i.test(rawHref)) return { url: rawHref };
    let resolvedUrl;
    try {
      resolvedUrl = new URL(rawHref, baseUrl);
    } catch {
      return { skip: true, advance: true };
    }
    let targetHost = resolvedUrl.hostname;
    const toParam = resolvedUrl.searchParams.get('to');
    if (toParam) {
      try {
        targetHost = new URL(decodeEntities(toParam)).hostname;
      } catch {}
    }
    if (!isProtectorHost(targetHost)) return { skip: true, advance: true };
    return { url: resolvedUrl.href };
  };
}

module.exports = {
  VACA_SOURCE_MATCH_RE,
  NARROW_PACK_RESET_RE,
  NARROW_EPISODE_RE,
  NERD_AUDIO_RE,
  NERD_LEGENDADO_RE,
  lastAudioMarker,
  createQualityRules,
  createSourceRules,
  createBrAudioHooks,
  createEpisodeRules,
  createEpisodeStep,
  createLinkCollector,
  createProtectorHrefResolver,
};
