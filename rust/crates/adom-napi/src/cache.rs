//! Exposição NAPI da política de cotas do cache (`adom_core::cache_quotas` +
//! `adom_core::cache_keys`).
//!
//! A DECISÃO continua no TypeScript (`src/utils/cache.ts` lê as tabelas TS);
//! aqui o Node só CONSEGUE ler o contrato numérico pelo mesmo binário que o
//! Docker compila — que é o que permite ao shadow/golden comparar a tabela
//! viva do Rust com o `dist` sem duplicar os números em JS.

use adom_core as core;
use napi_derive::napi;

/// Cota de um namespace do cache (`quotaFor` do fonte TS).
///
/// Semântica do `??`: nome desconhecido cai no balde `__default`; cota
/// declarada `0` vale `0` (não vira fallback em silêncio).
#[napi(catch_unwind)]
pub fn cache_quota_for(namespace: String) -> u32 {
    core::quota_for(&namespace) as u32
}

/// Namespace de uma chave (`namespaceFor` do fonte TS): tudo antes do primeiro
/// `:`, ou `__default` quando a chave não tem `:`.
#[napi(catch_unwind)]
pub fn cache_namespace_for(key: String) -> String {
    core::namespace_for(&key).to_string()
}

/// Dump do contrato INTEIRO das cotas em JSON, para o shadow/golden comparar
/// byte a byte com o TS sem uma chamada por namespace.
///
/// Formato fixo e ordenado de propósito: `quotas` na ordem de inserção da
/// tabela (a ordem é parte do contrato), `namespaceVersions` na ordem do
/// `NAMESPACE_VERSIONS`, `universe` em ordem lexicográfica, mais a conta do
/// teto (`universeTotal`, `headroom`, `validate`).
#[napi(catch_unwind)]
pub fn cache_quotas_dump() -> String {
    let versions: Vec<serde_json::Value> = core::NAMESPACE_VERSIONS
        .iter()
        .map(|(ns, v)| serde_json::json!([ns, v]))
        .collect();
    let universe: Vec<serde_json::Value> =
        core::universe().into_iter().map(|ns| ns.into()).collect();
    let sem_cota: Vec<serde_json::Value> = core::namespaces_without_explicit_quota()
        .into_iter()
        .map(|ns| ns.into())
        .collect();
    let dump = serde_json::json!({
        // Pares [nome, cota]: JSON object perde ordem em consumidores
        // independentes; o par é a forma determinística do golden.
        "quotas": core::QUOTAS
            .iter()
            .map(|(ns, cota)| serde_json::json!([ns, *cota as u32]))
            .collect::<Vec<_>>(),
        "maxEntries": core::MAX_ENTRIES as u32,
        "namespaceVersions": versions,
        "legacyPrefixes": core::LEGACY_PREFIXES,
        "universe": universe,
        "universeTotal": core::universe_total() as u32,
        "headroom": core::headroom(),
        "namespacesWithoutExplicitQuota": sem_cota,
        "validate": core::validate_quotas(),
    });
    dump.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_for_com_fallback() {
        assert_eq!(cache_quota_for("streams".into()), 2_000);
        assert_eq!(cache_quota_for("mag_meta".into()), 1);
        assert_eq!(cache_quota_for("inexistente".into()), 500);
    }

    #[test]
    fn namespace_for_corta_no_primeiro_dois_pontos() {
        assert_eq!(cache_namespace_for("streams:v21:x".into()), "streams");
        assert_eq!(cache_namespace_for("sem-dois-pontos".into()), "__default");
    }

    #[test]
    fn dump_e_json_com_a_conta_que_fecha() {
        let dump = cache_quotas_dump();
        let v: serde_json::Value = serde_json::from_str(&dump).expect("dump é JSON válido");
        assert_eq!(v["maxEntries"], 93_000);
        assert_eq!(v["universeTotal"], 92_221);
        assert_eq!(v["headroom"], 779);
        assert_eq!(v["validate"], true);
        let quotas = v["quotas"].as_array().expect("quotas é lista");
        assert_eq!(quotas.len(), 27);
        assert_eq!(quotas[0], serde_json::json!(["streams", 2_000]));
        // Universo ordenado e sem fallback.
        assert!(v["namespacesWithoutExplicitQuota"]
            .as_array()
            .expect("lista")
            .is_empty());
    }
}
