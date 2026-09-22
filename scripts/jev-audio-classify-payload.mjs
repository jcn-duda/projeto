/**
 * Payload do probe Jev audio-classify (ETAPA 3): montagem por ALLOWLIST,
 * pergunta, fingerprint estável e validação do corpus.
 *
 * FORA DO CAMINHO CRÍTICO: nada daqui é importado por `src/`.
 *
 * Allowlist: o estado enviado ao modelo carrega SOMENTE o título do post
 * — nenhum indexer, nenhum arquivo, nenhum path. É por construção que a
 * pergunta é só sobre TÍTULO: `buildState` copia campo a campo (nunca
 * spread), então um caso contaminado com magnet/hash/indexer/arquivo não
 * vaza — o campo extra é descartado. `validateCorpus` reprova o corpus
 * inteiro se qualquer caso carregar campo fora do contrato.
 */
import { createHash } from 'node:crypto';

/** Único campo que atravessa a fronteira para o modelo. */
export const STATE_FIELDS = ['post_title'];

/** Versão da PERGUNTA: bumpar quando o texto/critério muda. */
export const PROMPT_VERSION = 'audio-classify-q1';

export const QUESTIONS = {
  is_ptbr_dub: {
    type: 'noul',
    instructions: {
      question:
        'Does this torrent post title genuinely indicate Brazilian Portuguese (pt-BR) dubbed audio for the release?',
      note:
        'Judge ONLY the title text — there is no file evidence here, only the claim. A plain generic dub marker ' +
        '(DUB, DUBBED, Dublado, Dublada, Dual Áudio, Dual Audio) with NO other language named is an honest pt-BR ' +
        'claim. But the SAME generic marker sitting next to a NAMED foreign language (Hindi, Tamil, French/MULTI ' +
        'VF/VFF, Russian, Ukrainian, Polish, Turkish, English/Eng) means the dub is in THAT language, not ' +
        'pt-BR — even when the post also says Dual/MULTI. Transliterated rutracker-style release blocks ' +
        '(`[YEAR, Country, genre, format] Dub`) and actual Cyrillic script in the title are the same guard: ' +
        'a generic Dub marker under those signals is NOT proven pt-BR. An explicit PT-BR/DUBLADO/Dublada mark ' +
        'ALWAYS wins over a foreign-language signal elsewhere in the same title — the two are not mutually ' +
        'exclusive markers, and the explicit one settles it. LEGENDADO (subtitle only) or no dub claim at all ' +
        'is not pt-BR dub either.',
    },
    criteria: {
      true: 'Title genuinely claims/indicates pt-BR dubbed audio (plain dub marker with no contradicting foreign-language signal, or an explicit PT-BR/DUBLADO mark alongside one)',
      false: 'Not pt-BR dub: foreign-language dub named or implied without a PT mark, subtitle-only, or no dub claim at all',
    },
  },
};

/** Campos proibidos no CORPUS (BTIH 40-hex solto, magnet, credencial). */
const FORBIDDEN_IN_CASE =
  /magnet|xt=urn:btih|apikey|api_key|bearer|password|secret|signature|\b[0-9a-f]{40}\b/i;
const ALLOWED_CASE_FIELDS = new Set(['id', 'group', 'expectPtBr', 'title']);

/**
 * Estado do modelo: allowlist campo a campo. Campos extras do caso
 * (indexer, arquivos, o que for) NUNCA atravessam.
 */
export function buildState(c) {
  return {
    post_title: c.title,
  };
}

/**
 * Valida o corpus: ids únicos, campos só do contrato, tipos corretos e
 * nenhum texto com magnet/credencial. Devolve a lista de erros (vazia =
 * corpus íntegro); não lança.
 */
export function validateCorpus(cases) {
  const errors = [];
  const seen = new Set();
  for (const c of cases) {
    const where = c?.id ?? JSON.stringify(c)?.slice(0, 60) ?? '<caso sem id>';
    for (const key of Object.keys(c)) {
      if (!ALLOWED_CASE_FIELDS.has(key)) errors.push(`${where}: campo fora do contrato: ${key}`);
    }
    if (typeof c.id !== 'string' || c.id.length === 0) errors.push(`${where}: id ausente`);
    else if (seen.has(c.id)) errors.push(`${c.id}: id duplicado`);
    else seen.add(c.id);
    if (typeof c.expectPtBr !== 'boolean') errors.push(`${where}: expectPtBr não é boolean`);
    if (typeof c.title !== 'string' || c.title.length === 0) errors.push(`${where}: title ausente`);
    if (typeof c.group !== 'string' || c.group.length === 0) errors.push(`${where}: grupo ausente`);
    if (typeof c.title === 'string' && FORBIDDEN_IN_CASE.test(c.title)) {
      errors.push(`${where}: texto contém conteúdo proibido (magnet/credencial): ${c.title.slice(0, 40)}`);
    }
  }
  return errors;
}

/** JSON canônico (chaves ordenadas, recursivo) para hash estável. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Fingerprint estável da versão de pergunta + corpus: mesmo conteúdo →
 * mesmo hash. Mudou pergunta ou qualquer caso → hash diferente, e
 * relatórios de corridas distintas deixam de ser comparáveis por engano.
 */
export function corpusFingerprint(cases, { promptVersion = PROMPT_VERSION, questions = QUESTIONS } = {}) {
  const material = stableStringify({
    promptVersion,
    questions,
    cases: cases.map((c) => ({ id: c.id, group: c.group, expectPtBr: c.expectPtBr, title: c.title })),
  });
  const sha256 = createHash('sha256').update(material).digest('hex');
  return { sha256, short: sha256.slice(0, 12) };
}
