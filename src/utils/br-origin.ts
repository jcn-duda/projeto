/**
 * br-origin.ts — detecção de ORIGEM BR pelo título, o predicado que protege
 * acervo na limpeza da conta (8.4 do PLANO_MELHORIAS). A decisão é INTEIRA no
 * núcleo Rust (`rust/crates/adom-napi/src/lib.rs` → `adom-core::br_origin`,
 * golden contra o TS do `esm`); o corpo TS saiu do branch.
 *
 * Errar aqui ABSOLVENDO é o lado certo do erro: falso positivo destrói acervo
 * BR que custou horas de download (a cicatriz das 812 magnets registrada em
 * alldebrid-cleanup.ts). Por isso `brOriginMark` NUNCA foi unificado com
 * `hasPtSigns`: a lista de sites do caminho de limpeza é MAIOR (acrescenta
 * The Pirate Filmes) e `hasPtSigns` alimenta a rede de segurança do ranking
 * (stream-ranking), onde crescer muda o que o autofetch prioriza.
 *
 * Módulo-folha via `nativeCore`: quem nos alimenta (`audio-quality`,
 * `audio-cleanup`) não pode fechar ciclo com `rust-core`.
 */
import { nativeCore } from './native-core.js';

/** Funções de origem no `.node` (camelCase do napi-rs). */
type OriginCore = {
  hasPtSigns(title: string): boolean;
  brOriginMark(title: string): boolean;
};

const originCore = () => nativeCore<OriginCore>();

/**
 * Sem marca de áudio, mas o título denuncia português (post BR sem marcação é o
 * padrão): acentos ã/õ/ç (inclusive em CAIXA ALTA), vocabulário de post BR,
 * 2+ preposições ou marca de site nacional.
 */
function hasPtSigns(title = ''): boolean {
  return originCore().hasPtSigns(String(title ?? ''));
}

/**
 * Origem BR pelo nome, para NÃO apagar: marca de site BR, a palavra "filme(s)"
 * ou qualquer sinal de `hasPtSigns`. Regra do operador: *se tem nome BR, só pode
 * ser BR* — e como a regra serve para NÃO apagar, errar protegendo é o lado
 * certo. Acentos além de ã/õ/ç ficam FORA de propósito (são compartilhados com
 * francês/italiano e `hasPtSigns` não pode crescer nesse eixo).
 */
function brOriginMark(title = ''): boolean {
  return originCore().brOriginMark(String(title || ''));
}

export { hasPtSigns, brOriginMark };
