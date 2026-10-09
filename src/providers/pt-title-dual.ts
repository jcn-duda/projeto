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

// Contração inicial pt-BR do TMDB ("Na Hora da Zona Morta", "Da Colina
// Vermelha"): o post BR costuma escrever o mesmo nome com OUTRO determinante
// ("A Hora Da Zona Morta") e, sem tirar a primeira palavra dos DOIS lados, os
// prefixos nunca coincidem.
const LEADING_CONTRACTIONS = new Set(['na', 'no', 'nas', 'nos', 'da', 'do', 'das', 'dos', 'em', 'pela', 'pelo']);

type TitlesCtx = {
  original?: string | null;
  pt?: string | null;
  en?: string | null;
} | null | undefined;

// A guarda de tokens é PARAMETRIZADA pelo caminho que chama, porque o risco
// de mutilar o NOME é diferente em cada um:
// - Legado (default 2): só o pt do TMDB perde o determinante, então 2 tokens
//   bastam — "O Corvo" → "corvo" é o caso medido do post "Corvo 1994 … DUAL".
// - Dois lados (3): o TÍTULO também é mutilado; com 2 tokens, "A Rocha" →
//   "rocha" herdaria "Na Rocha Queimada Dual" pelo prefixo.
// As DUAS classes (artigos ∪ contrações) valem nas DUAS guardas: o post troca
// "Na"/"A" no nome da obra e o determinante cortado pode ser de qualquer uma.
function stripLeadingArticle(norm: string, minTokens = 2): string {
  const tokens = norm.split(' ').filter(Boolean);
  if (
    tokens.length >= minTokens
    && (LEADING_ARTICLES.has(tokens[0]) || LEADING_CONTRACTIONS.has(tokens[0]))
  ) {
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
  // Caminho legado: o post OMITE o determinante do pt do TMDB ("Grande Truque
  // (2006) …" para "O Grande Truque") — o pt sem o determinante casa sozinho.
  const withoutArticle = stripLeadingArticle(normPt);
  if (withoutArticle !== normPt && prefixThenRelease(normTitle, withoutArticle)) return true;
  // Determinantes DIFERENTES nas duas pontas ("Na Hora da Zona Morta" do TMDB
  // x "A Hora Da Zona Morta" do post): só tirando o primeiro token dos DOIS
  // lados os prefixos coincidem ("hora da zona morta"). A guarda aqui é de 3
  // tokens — MAIOR que a do legado — porque o título também é mutilado: "A
  // Rocha" (2 tokens) não pode virar "rocha" contra "Na Rocha Queimada". As
  // duas remoções continuam obrigatórias — um lado mutilado contra o outro
  // intacto deixaria o mesmo "A Rocha" herdar "Na Rocha X" pelo prefixo
  // "rocha".
  const strippedTitle = stripLeadingArticle(normTitle, 3);
  const strippedPt = stripLeadingArticle(normPt, 3);
  return strippedTitle !== normTitle && strippedPt !== normPt && prefixThenRelease(strippedTitle, strippedPt);
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
  // `_` é separador de fato nos posts BR ("… x264 DUAL_Misso"): é caractere de
  // palavra para o \b, então o marcador colado nele morre. O probe troca por
  // espaço só nos TESTES — o casamento por prefixo usa normalizeTitle, que já
  // trata `_` como separador.
  const probe = title.replace(/_/g, ' ');
  if (!title || looksPtBr(probe)) return false;
  if (!DUAL_LITERAL_RE.test(probe)) return false;
  if (audioFromTitle(probe) === 'Legendado') return false;
  if (LEGENDADO_RE.test(probe) && !explicitPtAudio(probe)) return false;
  if (foreignDubTitle(probe)) return false;

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
