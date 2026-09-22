/**
 * Espelho TS da pergunta validada ONLINE pelo probe audio-classify
 * (scripts/jev-audio-classify-payload.mjs, ETAPA 3 — 26/30 em 2026-09-22).
 *
 * O texto/critério é CÓPIA EXATA do probe: mudar a pergunta aqui sem mudar lá
 * (ou vice-versa) quebra o teste de paridade (test/typesafe-cache.test.ts),
 * porque o wire só é válido para a pergunta que o corpus online exercitou.
 * Bumpar `PROMPT_VERSION` quando o texto/critério mudar — o fingerprint do
 * cache inclui a versão, então julgamentos antigos expiram sozinhos sem
 * re-pagá-los.
 *
 * Allowlist do ESTADO enviado ao modelo: SOMENTE `post_title`, copiado campo a
 * campo (nunca spread) — indexer, arquivo, magnet, hash, chave e config nunca
 * atravessam a fronteira. Mesma política medida dos probes.
 */

/** Versão da PERGUNTA: bumpar quando o texto/critério muda. */
export const PROMPT_VERSION = 'audio-classify-q1';

/** Id da pergunta no envelope de resposta (`answers.<id>.noul`). */
export const QUESTION_ID = 'is_ptbr_dub';

/** Único campo que atravessa a fronteira para o modelo. */
export const STATE_FIELDS = ['post_title'] as const;

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
} as const;

/**
 * Estado do modelo: allowlist campo a campo. Assinatura recebe TÍTULO (não um
 * caso inteiro como no probe) — é o contrato do runtime: quem chama só pode
 * mandar texto, então não existe campo extra para vazar.
 */
export function buildState(title: string): { post_title: string } {
  return {
    post_title: String(title || ''),
  };
}
