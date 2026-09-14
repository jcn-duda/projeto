/**
 * Recupera DUAL em tracker global cujo título COMEÇA com o nome pt-BR do TMDB.
 *
 * Sem acento nem marca PT (`Lanternas…DUAL`, `A.Rocha…DUAL`), `looksPtBr` falha:
 * Dual sozinho é ambíguo (EN+qualquer idioma). O contexto da obra — título pt
 * distinto do original/en — é a prova de origem BR que o acento não trouxe.
 * MULTI sozinho NÃO entra: é faixa multiidioma de cena, não dublagem BR.
 */
import type { RawItem } from '../../types/domain.js';
import {
  looksPtBr,
  audioFromTitle,
  explicitPtAudio,
  hasExplicitForeignAudio,
} from '../utils/audio-quality.js';
import { namesForeignDubLanguage } from '../utils/audio-cleanup.js';
import { normalizeTitle } from '../utils/title-normalization.js';
import { LEADING_ARTICLES } from '../utils/matching-vocabulary.js';
import * as metrics from '../utils/metrics.js';
import { stageTrace } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';

const DUAL_LITERAL_RE = /\bDUAL\b|DUAL[- ]?AUDIO|AUDIO[- ]?DUPLO/i;
// LEGENDADO+DUAL: audioFromTitle devolve Dual (DUAL vence), mas o botão
// anunciado como legendado não pode virar vaga BR pela recuperação de título.
const LEGENDADO_RE =
  /\b(LEGENDAD[OA]|LEGENDAS?|LEG[-.]?PT[-.]?BR|SUB[-.]?PT[-.]?BR|SOFT[- ]?SUB)\b/i;
// Após o prefixo pt, o próximo token tem que ser ano/episódio/marca de
// release — senão "A Rocha Queimada Dual" herdaria a obra "A Rocha".
const AFTER_PT_OK_RE = /^(?:\d{4}|s\d{1,2}(?:e\d{1,3})?|\d{3,4}p|dual|audio|duplo|bluray|bdrip|webdl|web|hdtv|hdrip|remux|proper|repack|extended|complete|uhd|hdr|x264|x265|h264|h265|hevc|avc|aac|dts|atmos|truehd|ac3|eac3)$/;

type TitlesCtx = {
  original?: string | null;
  pt?: string | null;
  en?: string | null;
} | null | undefined;

function stripLeadingArticle(norm: string): string {
  const tokens = norm.split(' ').filter(Boolean);
  if (tokens.length >= 2 && LEADING_ARTICLES.has(tokens[0])) {
    return tokens.slice(1).join(' ');
  }
  return norm;
}

function prefixThenRelease(normTitle: string, prefix: string): boolean {
  if (!prefix) return false;
  if (normTitle === prefix) return true;
  if (!normTitle.startsWith(`${prefix} `)) return false;
  const first = normTitle.slice(prefix.length + 1).split(' ')[0] || '';
  return AFTER_PT_OK_RE.test(first);
}

function titleMatchesPt(normTitle: string, normPt: string): boolean {
  if (prefixThenRelease(normTitle, normPt)) return true;
  const withoutArticle = stripLeadingArticle(normPt);
  return withoutArticle !== normPt && prefixThenRelease(normTitle, withoutArticle);
}

function foreignDubTitle(title: string): boolean {
  // Mínima OR ampla: VF/SUBITA/NL não podem regredir; LAT/ESP/MULTI/cirílico
  // também negam. PT explícito absolve nos dois lados.
  return hasExplicitForeignAudio(title)
    || (!explicitPtAudio(title) && namesForeignDubLanguage(title));
}

function shouldMark(item: RawItem, titles: TitlesCtx): boolean {
  if (!titles?.pt) return false;
  if (item.isBr || item.lied || item._lied) return false;

  const title = String(item.title || item.Title || '');
  if (!title || looksPtBr(title)) return false;
  if (!DUAL_LITERAL_RE.test(title)) return false;
  if (audioFromTitle(title) === 'Legendado') return false;
  if (LEGENDADO_RE.test(title) && !explicitPtAudio(title)) return false;
  if (foreignDubTitle(title)) return false;

  const normPt = normalizeTitle(titles.pt);
  if (!normPt) return false;
  // original/en ausentes viram '' — pt não-vazio e distinto "difere" dos dois.
  const normOriginal = normalizeTitle(titles.original || '');
  const normEn = normalizeTitle(titles.en || '');
  if (normPt === normOriginal || normPt === normEn) return false;

  return titleMatchesPt(normalizeTitle(title), normPt);
}

function applyPtTitleDual(
  items: RawItem[],
  { titles, trace }: { titles?: TitlesCtx; trace?: StreamTraceState | null } = {},
): RawItem[] {
  let marked = 0;
  const out = items.map((item) => {
    if (!shouldMark(item, titles)) return item;
    marked += 1;
    return { ...item, ptTitleDual: true };
  });
  if (marked > 0) {
    metrics.count('search.dual.ptTitle', marked);
    stageTrace(trace, 'dual.ptTitle', marked);
  }
  return out;
}

export { applyPtTitleDual };
