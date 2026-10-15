/**
 * Portão de anúncio do BLUDV — a ÚNICA detecção do site (Fase 4).
 *
 * POR QUE EXISTE: o BLUDV trocou o protetor de link por um portão que exige
 * ver/clicar um anúncio. Com o portão ativo o post deixa de publicar os links
 * `systemads`/`videosad`; o raspador devolve 0 releases e o operador não tem
 * como distinguir "o site mudou de layout" de "o site não tem esse título".
 * A detecção converte esse silêncio em motivo.
 *
 * POR QUE MORA EM MÓDULO PRÓPRIO: a mesma assinatura é consumida por três
 * lados — o resolvedor standalone (`resolvers/profiles/bludv.ts`), o provider
 * em processo (`src/providers/bludv.ts`) e, espelhado, o port do Jackett. Uma
 * regex só evita que os lados divirjam em silêncio; `bludv-parsers.ts` era o
 * pior lugar porque já estava no teto de linhas.
 *
 * ASSINATURA (medida ao vivo em 2026-10-13 pelo FlareSolverr do container, em
 * `https://bludvfilmes1.xyz`; a medição direta sem solvedor é HTTP 403):
 *
 *   `<a href="https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609"`
 *   `class="customButton" rel="noopener noreferrer" target="_blank">`
 *   `Magnet-Link<div class="eas-video-overlay-wrapper"> ... </div></a>`
 *
 * Dois detalhes que a descrição do plano não tinha e quebravam o detector:
 * 1. O path é `/gate/go/<16 hex>?p=<id do post>`, não `/gate/go/?post=NNNN`.
 * 2. O rótulo `Magnet-Link` é seguido pelo overlay do player que o site injeta,
 *    não por `</a>`. Exigir o fechamento fazia o detector NUNCA casar o post
 *    real — 11/11 botões dos dois posts capturados têm o overlay dentro do `<a>`.
 *
 * Por isso a regex para no `\b` depois do rótulo. A fixture
 * `test/fixtures/bludv-gate-post.html` é trecho literal dessa captura. Mudou
 * aqui, muda no espelho Rust (`rust/crates/adom-resolvers/src/sites/bludv_gate.rs`).
 */

/**
 * Botão "Magnet-Link" cujo href leva ao hub de anúncio. O `[^"']*` depois de
 * `/gate/go/` come o hash e o `?p=` do post; o `\b` final tolera o overlay
 * injetado sem aceitar um rótulo colado em outra palavra.
 */
export const BLUDV_AD_GATE_RE = /<a\b[^>]*href\s*=\s*["'][^"']*\/gate\/go\/[^"']*["'][^>]*>\s*Magnet-Link\b/i;

/** Mensagem única do erro — é o que o perfil, o card do Jackett e o log mostram. */
export const BLUDV_AD_GATE_REASON = 'bludv: portão de anúncio';

/** Marca de erro que dispensa `instanceof` entre cópias do módulo. */
export const BLUDV_AD_GATE_CODE = 'bludv_ad_gate';

/** Erro do portão: distinguível de falha de rede por `code`, não por string. */
export class BludvAdGateError extends Error {
  readonly code = BLUDV_AD_GATE_CODE;

  constructor(message: string = BLUDV_AD_GATE_REASON) {
    super(message);
    this.name = 'BludvAdGateError';
  }
}

/** O erro lançado veio do portão (e não de um site fora do ar)? */
export function isBludvAdGate(err: unknown): boolean {
  return err instanceof BludvAdGateError || (err as any)?.code === BLUDV_AD_GATE_CODE;
}

/** O HTML do post publica o botão do portão? (medição; não é a decisão) */
export function hasAdGate(html: string): boolean {
  return BLUDV_AD_GATE_RE.test(String(html || ''));
}

/**
 * Lança `BludvAdGateError` quando o post está bloqueado: nenhum botão
 * aproveitável sobrou E o HTML publica o botão do portão.
 *
 * A ordem importa. Um post que tiver os dois (protetor direto + portão) serve
 * as releases boas — errorizar nele faria o detector comer resultado que
 * funciona, o oposto do problema que ele existe para nomear.
 */
export function assertNoAdGate(html: string, usableLinks: number): void {
  if (usableLinks > 0) return;
  if (hasAdGate(html)) throw new BludvAdGateError();
}
