//! Porte puro de `limitByIndexer` (`src/utils/stream-quotas.ts`): cota por
//! indexador, aplicada numa passada só.
//!
//! Mapeamento do objeto `StreamCandidate` (só o campo que a função lê):
//! - `stream._indexer` vira `indexers[i]: Option<&str>` (`None` = `null`/
//!   `undefined`). A chave normalizada é `String(x || '').trim().toLowerCase()`,
//!   feita aqui com o `js_trim` do crate.
//! - O `Set<StreamCandidate>` de identidade (`exempt`) vira um `HashSet<usize>`
//!   com as posições da lista. Um mesmo objeto aparecendo duas vezes no array
//!   não tem equivalente aqui; o TS nunca o produz.
//! - `indexerLimits` vira `HashMap<String, f64>`. A busca é por chave exata, como
//!   `hasOwnProperty`: a chave da config tem que estar em minúsculas (a fonte já
//!   vem assim), senão nunca casa.
//!
//! `limitByQuality`, `limitByQualityAndIndexer` e `limitReservingBr` ficam de
//! fora: dependem de `streamQuality` (módulo `stream-quotas-candidate`, ainda não
//! portado) e, no caso dos dois últimos, de `dropTrace` e de `onSelected`.
//!
//! Retorno: os índices mantidos, na ordem original. O TS devolve o subconjunto
//! de objetos; o índice é a identidade equivalente.

use std::collections::{HashMap, HashSet};

use crate::js_text::js_trim;

/// `Math.max(0, Math.trunc(Number(x) || 0))`: NaN vira 0, negativo vira 0,
/// fração é truncada. `Infinity` passa (o TS trata como sem limite).
pub(crate) fn clamp_limit(value: f64) -> f64 {
    if value.is_nan() {
        0.0
    } else {
        value.trunc().max(0.0)
    }
}

/// `String(stream?._indexer || '').trim().toLowerCase()`.
fn source_key(indexer: Option<&str>) -> String {
    indexer
        .map(|s| js_trim(s).to_lowercase())
        .unwrap_or_default()
}

/// Devolve os índices de `indexers` que passam pela cota por indexador.
///
/// `max_per_indexer` é a cota global (`0` = sem limite). `exempt` são as vagas
/// reservadas BR: passam mesmo acima da cota, mas continuam contando. Stream
/// sem indexador nunca conta e nunca corta.
pub fn limit_by_indexer(
    indexers: &[Option<&str>],
    max_per_indexer: f64,
    exempt: &HashSet<usize>,
    indexer_limits: &HashMap<String, f64>,
) -> Vec<usize> {
    let global_limit = clamp_limit(max_per_indexer);
    let has_overrides = !indexer_limits.is_empty();
    if global_limit == 0.0 && !has_overrides {
        return (0..indexers.len()).collect();
    }
    let mut counts: HashMap<String, f64> = HashMap::new();
    let mut kept = Vec::with_capacity(indexers.len());
    for (i, indexer) in indexers.iter().enumerate() {
        let source = source_key(*indexer);
        if source.is_empty() {
            kept.push(i);
            continue;
        }
        let own_limit = match indexer_limits.get(&source) {
            Some(raw) => clamp_limit(*raw),
            None => global_limit,
        };
        let count = counts.get(&source).copied().unwrap_or(0.0);
        // A reservada estoura o teto mas continua contando: se não contasse,
        // uma reserva de 2 com cota 1 deixaria passar um terceiro da mesma fonte.
        if exempt.contains(&i) {
            counts.insert(source, count + 1.0);
            kept.push(i);
            continue;
        }
        if own_limit != 0.0 && count >= own_limit {
            continue;
        }
        counts.insert(source, count + 1.0);
        kept.push(i);
    }
    kept
}
