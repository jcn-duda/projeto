/**
 * Espelho TS da pergunta validada ONLINE pelo probe dub-lie
 * (scripts/jev-dub-lie-payload.mjs, ETAPA 2 — 38/38 em 2026-09-22).
 *
 * O texto/critério abaixo é CÓPIA LITERAL do probe: mudar aqui sem mudar lá
 * (ou vice-versa) quebra o teste de paridade (test/typesafe-dublie.test.ts),
 * porque o wire só é válido para a pergunta que o corpus online exercitou.
 * Bumpar `PROMPT_VERSION` quando o texto/critério mudar — o fingerprint do
 * cache inclui a versão, então julgamentos antigos expiram sozinhos sem
 * re-pagá-los.
 *
 * Allowlist do ESTADO enviado ao modelo: SOMENTE `post_title`, `indexer` e
 * `video_files`, copiados campo a campo (nunca spread) — magnet, hash, chave,
 * sig e config nunca atravessam a fronteira. Mesma política medida dos probes
 * (o campo extra de um caso contaminado é simplesmente descartado).
 */

/** Versão da PERGUNTA: bumpar quando o texto/critério muda. */
export const PROMPT_VERSION = 'dub-lie-q3';

/** Id da pergunta no envelope de resposta (`answers.<id>.noul`). */
export const QUESTION_ID = 'is_dub_lie';

/** Únicos campos que atravessam a fronteira para o modelo. */
export const STATE_FIELDS = ['post_title', 'indexer', 'video_files'] as const;

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
} as const;

/**
 * Estado do modelo: allowlist campo a campo. Recebe o trio desacoplado
 * (post/indexer/files) e devolve o estado EXATAMENTE com os três campos da
 * fronteira — mesmo formato do probe, que recebe o caso inteiro.
 */
export function buildState(c: { post: string; indexer: string; files: string[] }): {
  post_title: string;
  indexer: string;
  video_files: string[];
} {
  return {
    post_title: c.post,
    indexer: c.indexer,
    video_files: [...c.files],
  };
}
