/**
 * Payload do probe Jev dub-lie (ETAPA 2): montagem por ALLOWLIST, perguntas,
 * fingerprint estável de pergunta/corpus e plano de fan-out.
 *
 * FORA DO CAMINHO CRÍTICO: nada daqui é importado por `src/`.
 *
 * Allowlist (requisito 7): o estado enviado ao modelo carrega SOMENTE
 * título do post, indexer e nomes/paths de arquivos — `buildState` copia
 * campo a campo (nunca spread), então um caso contaminado com magnet,
 * hash, config, conta, apiKey ou sig não vaza: o campo extra é
 * simplesmente descartado. `validateCorpus` rejeita o corpus inteiro se
 * qualquer caso carregar campo fora do contrato.
 */
import { createHash } from 'node:crypto';

/** Únicos campos que atravessam a fronteira para o modelo. */
export const STATE_FIELDS = ['post_title', 'indexer', 'video_files'];

/** Versão da PERGUNTA: bumpar quando o texto/critério muda. */
export const PROMPT_VERSION = 'dub-lie-q3';

export const QUESTIONS = {
  is_dub_lie: {
    type: 'noul',
    instructions: {
      question:
        'Did the torrent post promise Brazilian Portuguese dubbed audio, while the actual video file names indicate a release WITHOUT Brazilian Portuguese audio (English-only scene release, or another named language like Hindi/Tamil/French/Russian)?',
      note:
        'Post title and indexer are the claim. File paths are the evidence after debrid lists the torrent. ' +
        'The evidence is the actual VIDEO FILE own name, NOT its parent folder: a DUAL/DUBLADO mark on the ' +
        'folder path does not prove the audio of the file inside — judge each video file by its own name. ' +
        'Dual/Dublado/Dual Audio/PT-BR in the video file name is honest BR dub. English scene groups (RARBG, ' +
        'KILLERS, SPARKS, METCON, ETHEL, ION10, afm72, ToVaR, YTS, FLUX) without PT marks are English. ' +
        'Named non-PT languages in filenames (Hindi, Tamil, French, VFF/VF, Rus, Cyrillic script, ' +
        'transliterated Russian) are NOT Brazilian Portuguese, even when the post says Dual/MULTI. ' +
        'A .srt subtitle file is not dubbed audio. If the post only says LEGENDADO, or does not claim ' +
        'Brazilian Portuguese dub at all (even a foreign-language post), that is not a lie.',
    },
    criteria: {
      true: 'Post claims DUBLADO/Dual Áudio/PT dub; files have no Brazilian Portuguese audio evidence (English scene release or another named language)',
      false: 'Honest: files match the dub claim, or the post never claimed Brazilian Portuguese dub',
    },
  },
};

/** Campos proibidos no CORPUS (o allowlist do buildState já conteria, mas o
 * corpus sujo é bug de fonte — melhor reprovar na validação). O hex de 40
 * pega hash BTIH solto em qualquer texto (identidade de torrent não é
 * evidência de áudio e nunca deveria estar aqui). */
const FORBIDDEN_IN_CASE =
  /magnet|xt=urn:btih|apikey|api_key|bearer|password|secret|signature|\b[0-9a-f]{40}\b/i;
const ALLOWED_CASE_FIELDS = new Set(['id', 'group', 'expectLie', 'post', 'indexer', 'files']);

/**
 * Estado do modelo:allowlist campo a campo. Campos extras do caso
 * (magnet, hash, o que for) NUNCA atravessam.
 */
export function buildState(c) {
  return {
    post_title: c.post,
    indexer: c.indexer,
    video_files: [...c.files],
  };
}

/**
 * Valida o corpus: ids únicos, campos só do contrato, tipos corretos,
 * arquivos presentes e nenhum texto com magnet/credencial. Devolve a
 * lista de erros (vazia = corpus íntegro); não lança.
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
    if (typeof c.expectLie !== 'boolean') errors.push(`${where}: expectLie não é boolean`);
    if (typeof c.post !== 'string' || c.post.length === 0) errors.push(`${where}: post ausente`);
    if (typeof c.indexer !== 'string' || c.indexer.length === 0) errors.push(`${where}: indexer ausente`);
    if (!Array.isArray(c.files) || c.files.length === 0) errors.push(`${where}: files vazio`);
    else if (!c.files.every((f) => typeof f === 'string' && f.length > 0)) errors.push(`${where}: file inválido`);
    if (typeof c.group !== 'string' || c.group.length === 0) errors.push(`${where}: grupo ausente`);
    for (const text of [c.post, c.indexer, ...(Array.isArray(c.files) ? c.files : [])]) {
      if (typeof text === 'string' && FORBIDDEN_IN_CASE.test(text)) {
        errors.push(`${where}: texto contém conteúdo proibido (magnet/credencial): ${text.slice(0, 40)}`);
      }
    }
  }
  return errors;
}

/**
 * Plano de fan-out: divide os casos em lotes de no máximo `size`
 * (requisito 4). Nenhum caso se perde, nenhum se duplica, a ordem do
 * corpus se preserva; o último lote pode ser parcial.
 */
export function planBatches(cases, size) {
  const n = Number(size);
  if (!Number.isInteger(n) || n < 1) throw new Error(`tamanho de lote inválido: ${size}`);
  const batches = [];
  for (let i = 0; i < cases.length; i += n) batches.push(cases.slice(i, i + n));
  return batches;
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
 * Fingerprint estável da versão de pergunta + corpus (requisito 6):
 * mesmo conteúdo → mesmo hash, sem relógio envolvido. Mudou pergunta ou
 * qualquer caso → hash diferente, e relatórios de corridas distintas
 * deixam de ser comparáveis por engano.
 */
export function corpusFingerprint(cases, { promptVersion = PROMPT_VERSION, questions = QUESTIONS } = {}) {
  const material = stableStringify({
    promptVersion,
    questions,
    cases: cases.map((c) => ({ id: c.id, group: c.group, expectLie: c.expectLie, post: c.post, indexer: c.indexer, files: c.files })),
  });
  const sha256 = createHash('sha256').update(material).digest('hex');
  return { sha256, short: sha256.slice(0, 12) };
}
