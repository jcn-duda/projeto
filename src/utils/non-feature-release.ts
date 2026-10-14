// Releases que não são o filme pedido, por evidência do PRÓPRIO nome:
//
// 1. Fonte doméstica antes do lançamento doméstico. The Odyssey (Nolan,
//    2026-10-05): em cartaz, digital só em 15/11 no TMDB; as WEB-DL/WEBRip da
//    lista eram o outro "The Odyssey (2026)". Antes da data (menos a margem),
//    WEB/BluRay/HDTV/DVD não pode ser o filme; gravação de cinema (CAM/TS)
//    passa — quem não a quer tem o excludeCam. "TS-V2-WEB.DL" é TS: o marcador
//    de cinema vence o de fonte.
// 2. Trailer, teaser e trilha sonora: "The Odyssey (2026) Trailer 3 4k UHD"
//    saía com ⚡ como 4K do filme. Featurette não entra (vem junto do filme em
//    "BluRay + Featurettes"); nome da obra que contém a palavra ("The Trailer
//    Park") fica de fora.
import config from '../config.js';

const CINEMA_RE = /\b(?:HD[-. ]?)?(?:CAM(?:[-. ]?RIP)?|TS|TC|TELESYNC|TELECINE|PRE[-. ]?DVD)\b/i;
const HOME_SOURCE_RE = /\b(?:WEB(?:[-. ]?(?:DL|RIP))?|BLU[-. ]?RAY|BD(?:RIP|REMUX)?|BRRIP|REMUX|HDTV|DVD(?:RIP|R|5|9)?)\b/i;
const NON_FEATURE_RE = /\b(?:trailers?|teasers?|soundtrack|OST)\b/i;

const clean = (text: string) => String(text || '').replace(/_/g, ' ');

/** O nome declara fonte doméstica (e não gravação de cinema)? */
function isHomeSource(text: string): boolean {
  const t = clean(text);
  return !CINEMA_RE.test(t) && HOME_SOURCE_RE.test(t);
}

/** Fonte doméstica antes do 1º lançamento doméstico do TMDB (com margem). */
function preHomeReleaseContradicts(texts: string[], homeReleaseAt: number | null | undefined, now = Date.now()): boolean {
  if (!config.search.preHomeReleaseCut || !homeReleaseAt || !Number.isFinite(homeReleaseAt)) return false;
  if (homeReleaseAt - now <= config.search.preHomeReleaseMarginMs) return false;
  return texts.some((t) => t && isHomeSource(t));
}

/** Trailer/teaser/trilha que o nome da obra não explica. */
function isNonFeature(texts: string[], names: string[]): boolean {
  if (names.some((n) => NON_FEATURE_RE.test(clean(n)))) return false;
  return texts.some((t) => t && NON_FEATURE_RE.test(clean(t)));
}

export { isHomeSource, preHomeReleaseContradicts, isNonFeature };
