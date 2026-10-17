/**
 * Parse de magnet e texto de título — decisão INTEIRA no núcleo Rust
 * (`rust/crates/adom-napi/src/text.rs`; lógica em `adom-core`, golden contra
 * o TS do `esm`). O corpo TS saiu do branch: aqui só se monta a entrada e se
 * traduz o `Option` do Rust de volta para `null`.
 *
 * Módulo-folha: chama `nativeCore` direto (como `normalizeTitle` já fazia) —
 * `requireCore`/`rust-core` importa `config`, e quem nos alimenta
 * (`search-names`, `format`) não pode fechar ciclo com ele.
 *
 * Regra de ouro: NUNCA há reserva TS. Por chamada avulsa o napi é ~2× o TS
 * (travessia de string) e lote parece a resposta — mas medido em
 * `tmp/g1-measure.mjs` (450 magnets reais do `magnets.db`) o laço por item
 * custa <0,3 ms e a variante em lote é MAIS LENTA (a montagem do array no
 * lado JS domina: extractInfoHashes 0,29 ms vs 0,26 ms por item;
 * magnetDisplayNames 0,52 ms vs 0,27 ms). Então: chamada direta, SEM lote.
 */
import { nativeCore } from './native-core.js';

/** Funções de magnet/texto no `.node` (camelCase do napi-rs). */
type TextCore = {
  extractInfoHash(input: string): string | null;
  magnetDisplayName(magnet: string | null, magnetUri: string | null, guid: string | null): string;
  decodeEntities(text: string): string;
  bytesToSize(bytes: number): string | null;
  stripDiacritics(text: string): string;
  collapseAcronyms(text: string): string;
  dedupeNames(names: Array<string | null>): string[];
  normalizeTitle(text: string): string;
};

const textCore = () => nativeCore<TextCore>();

function bytesToSize(bytes: unknown): string | null {
  const n = Number(bytes);
  // O `Number()` do JS na borda: "1 KB" vira NaN e o núcleo devolve None.
  if (!Number.isFinite(n)) return null;
  return textCore().bytesToSize(n) ?? null;
}

/**
 * btih hex (40) ou base32 (32), puro ou via `btih:` — a normalização e o
 * trim rodam no núcleo. Hash de indexer BR em base32 repassado cru mata o
 * play: o cliente não monta o magnet.
 */
function extractInfoHash(magnetOrHash: unknown): string | null {
  if (!magnetOrHash) return null;
  return textCore().extractInfoHash(String(magnetOrHash)) ?? null;
}

/** Nome da release no `dn=` do magnet; URL de protetor devolve vazio. */
function magnetDisplayName(item: { magnet?: string; MagnetUri?: string; Guid?: string } | null | undefined): string {
  return textCore().magnetDisplayName(item?.magnet ?? null, item?.MagnetUri ?? null, item?.Guid ?? null);
}

/**
 * Entidades HTML cruas de indexer que raspa WordPress (BLUDV/Comando):
 * "Episódio II &#8211; Ataque dos Clones" saía literal na lista sem isto.
 * A tabela de ordinais ("4&ordf;") é a que mais muda DECISÃO de pack.
 */
function decodeEntities(text = ''): string {
  return textCore().decodeEntities(String(text));
}

/** Sigla com ponto ("G.O.R.A.") vira UMA palavra; consulta dos globais. */
function collapseAcronyms(s = ''): string {
  return textCore().collapseAcronyms(String(s));
}

/**
 * Normaliza um título para comparação no núcleo (sigla, caixa, fold latino,
 * NFD, marcas e compat do Latin-1). Oráculo no `esm`; goldens
 * `title-normalization` e `unicode_parity` no Rust.
 */
function normalizeTitle(s = ''): string {
  return textCore().normalizeTitle(String(s));
}

/**
 * Tira só o diacrítico, preservando caixa e pontuação — diferente de
 * normalizeTitle, que destruiria uma QUERY. Medido ao vivo: o buscador
 * WordPress dos sites BR devolve 0 para QUALQUER query acentuada; os globais
 * lidam bem com acento e não passam por aqui.
 */
function stripDiacritics(s = ''): string {
  return textCore().stripDiacritics(String(s));
}

/**
 * Deduplica nomes de obra por forma NORMALIZADA em UMA chamada de núcleo
 * (o dedupe roda inteiro lá, incluindo o normalizeTitle de cada nome —
 * chamada por item aqui dobraria o custo). Nome que normaliza para vazio
 * não entra no dedupe: o gate decide "sem nome", não a deduplicação.
 */
function dedupeNames(names: Array<string | null | undefined>): string[] {
  return textCore().dedupeNames(names.map((name) => (typeof name === 'string' ? name : null)));
}

export { bytesToSize, extractInfoHash, decodeEntities, normalizeTitle, collapseAcronyms, stripDiacritics, dedupeNames, magnetDisplayName };
