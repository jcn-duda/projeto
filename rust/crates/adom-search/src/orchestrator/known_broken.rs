//! Evidência de histórico RUIM da conta no build nativo (F4.4a).
//!
//! O Node grava `mag:v1:{bad|lie}:<adapter>:<conta>:<hash>` no `cache.db` e o
//! `pruneKnownBroken` corta esses hashes ANTES da checagem do debrid. No corte
//! nativo a coleta e o índice também são nativos, então o item não passa mais
//! pela rota de evidência do Node — sem esta fonte, hash que o play provou
//! quebrado voltava à lista até o TTL.
//!
//! O trait mora AQUI (e não em `adom-store`) porque `adom-store` depende deste
//! crate: quem implementa é o gateway, que tem o `cache.db` (`adom-store::
//! MagnetDbStore`). A busca só consome o conjunto de hashes.
//!
//! A decisão continua sendo uma só: o build marca `_broken` e o `finalize`
//! filtra — exatamente o `broken:true` que a rota interna do Node devolve.

use std::collections::HashSet;

/// Hashes que o PLAY desta conta já provou quebrados (`bad`/`lie` vivos).
///
/// Devolve conjunto VAZIO quando não há evidência ou quando a leitura falha —
/// "sem banco" não pode derrubar a busca (regra de ouro: falso negativo é pior
/// que falso positivo, mas ausência de fonte não é evidência de nada).
pub trait KnownBroken: Send + Sync {
    /// `adapter` = `debridService` da config; `api_key` = credencial da conta.
    /// `now_ms` é o relógio da busca (testável sem espera real).
    fn broken_hashes(&self, adapter: &str, api_key: &str, now_ms: i64) -> HashSet<String>;
}
