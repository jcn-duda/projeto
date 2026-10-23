// Ids compartilhados das consultas vivas por indexer. O estado de falha por
// coleta (pendente/falho/vazio suspeito) que ficava aqui alimentava o fallback
// 📦 do build Node; o build e o fallback são do orquestrador Rust desde o
// F4.4, e o que sobrou é o vocabulário que o `jackett.search` e o filtro de
// `ji` ainda usam.

/** Id sintético do ramo agregado `/all`. */
export const ALL_QUERY_INDEXER = '*all*';

/** Id de indexer vindo da config do usuário (URL): só entra em query, limite
 * por id ou desempate depois desta validação — nunca interpolado. */
export const SAFE_INDEXER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
