/**
 * JSON para a fronteira napi (`nativeCore`).
 *
 * `JSON.stringify` emite `\ud800` quando o texto tem uma unidade surrogate
 * órfã, e o `serde_json` do lado Rust **recusa** o escape no parse (`unexpected
 * end of hex escape`) — a chamada lançaria no caminho da resposta. O
 * `toWellFormed()` troca o órfão por U+FFFD, que é a perda JÁ documentada da
 * travessia `String` do napi-rs; o importante é não derrubar a busca nem o
 * scan por causa de um título malformado.
 *
 * Node 20+ tem `toWellFormed`; o fallback cobre runtime antigo/test stub.
 */
function coreJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'string') return item;
    const text = item as string & { toWellFormed?: () => string };
    return typeof text.toWellFormed === 'function'
      ? text.toWellFormed()
      : text.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  });
}

export { coreJson };
