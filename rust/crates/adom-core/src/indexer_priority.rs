//! Porte de `priorityMap` e `compareIndexerPriority`
//! (`src/utils/indexer-priority.ts`).
//!
//! `priorityMap(ids)` monta o ranking das fontes na ORDEM escolhida pelo
//! usuário: a chave é `String(id || '').trim().toLowerCase()` e o valor é a
//! posição ORIGINAL do id no array. Chave vazia (`''`, `null`, só espaços) não
//! é fonte e é ignorada — mas a posição continua sendo a do array, o índice
//! NÃO é recomprimido depois do descarte. Id repetido mantém a PRIMEIRA
//! posição.
//!
//! `compareIndexerPriority(a, b, ranks)` é o desempate: devolve a DIFERENÇA
//! assinada das posições (`rankFor(a) - rankFor(b)`), nunca um `-1/0/1` — quem
//! chama decide pelo sinal. Fonte fora do ranking vale `Number.MAX_SAFE_INTEGER`
//! (vai para o fim); ranking vazio devolve `0`, preservando o desempate
//! existente.
//!
//! O ranking é devolvido como `Vec<(String, usize)>` na ordem de inserção: é o
//! mesmo texto que `[...map.entries()]` do JS e evita a ordem não determinística
//! de um `HashMap` serializado. As listas reais de prioridade são curtas, então
//! a busca do `rank_for` é linear sobre o vetor.
//!
//! `stream._indexer` é o ÚNICO campo lido (`None` = ausente/`null`); não há
//! fallback para nome de tracker. O `trim` é o `js_trim` do crate (cobre o BOM,
//! U+FEFF, que o `str::trim` não remove) e a caixa baixa é o `to_lowercase` da
//! toolchain pinada em `rust-toolchain.toml` (1.92.0 = Unicode 17.0.0), a mesma
//! do oráculo Node (v22, unicode=17.0).
//!
//! Nota de sigma: `str::to_lowercase` (não `char::to_lowercase`) implementa a
//! regra contextual `Final_Sigma` igual ao `toLowerCase` do JS — `"ΟΔΟΣ"` vira
//! `"οδος"` (ς final) nos dois lados, medido em `unicode_parity`. Nenhuma
//! ressalva: ids reais de indexer são ASCII de qualquer forma.
//!
//! Limite do porte (fora da classe coberta pelo golden): `ids` é
//! `&[Option<&str>]` (o tipo do TS é `string[]`), então id numérico (`String(5)`
//! = `"5"`) está fora do contrato.

use std::collections::HashSet;

use crate::js_text::js_trim;

/// `Number.MAX_SAFE_INTEGER` — posição de quem não está no ranking. Cabe
/// exatamente num `i64` e a diferença de duas posições nunca estoura.
pub const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `String(x || '').trim().toLowerCase()`: a chave de comparação da fonte.
fn source_key(value: Option<&str>) -> String {
    js_trim(value.unwrap_or("")).to_lowercase()
}

/// `priorityMap(ids)`: pares `(chave, posição original)` na ordem da primeira
/// ocorrência de cada chave.
///
/// `None` representa `null`/`undefined` no elemento do array. Chave que
/// normaliza para vazio não entra no mapa nem marca "visto".
pub fn priority_map(ids: &[Option<&str>]) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (index, id) in ids.iter().enumerate() {
        let key = source_key(*id);
        if key.is_empty() || !seen.insert(key.clone()) {
            continue;
        }
        // A posição guardada é a original no array: um id vazio ignorado no
        // meio não desloca as chaves seguintes.
        out.push((key, index));
    }
    out
}

/// `rankFor(stream, ranks)`: posição da fonte, ou `MAX_SAFE_INTEGER` se a
/// fonte não estiver no ranking.
fn rank_for(indexer: Option<&str>, ranks: &[(String, usize)]) -> i64 {
    let source = source_key(indexer);
    ranks
        .iter()
        .find(|(key, _)| *key == source)
        .map_or(JS_MAX_SAFE_INTEGER, |(_, rank)| *rank as i64)
}

/// `compareIndexerPriority(a, b, ranks)`: `rankFor(a) - rankFor(b)`.
///
/// `ranks` vazio (o `Map` sem entradas do TS) devolve `0`: sem prioridade, o
/// desempate anterior continua valendo. `a`/`b` são o `_indexer` de cada stream
/// (`None` = ausente/`null`).
pub fn compare_indexer_priority(
    a: Option<&str>,
    b: Option<&str>,
    ranks: &[(String, usize)],
) -> i64 {
    if ranks.is_empty() {
        return 0;
    }
    rank_for(a, ranks) - rank_for(b, ranks)
}
