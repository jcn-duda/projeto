//! Agregado do magnetdb (`mag_meta:v1:counts`) na MESMA classe napi
//! `MagnetStateStore`.
//!
//! O agregado é derivado do acervo que a classe já abre, então ele mora no mesmo
//! handle: uma classe separada abriria OUTRO banco (e dois `:memory:` nos testes
//! não se veriam), o que quebraria a premissa de que a contagem e as linhas
//! contadas estão no mesmo `cache.db`.
//!
//! Irmão de `debrid_state.rs` por teto de linhas (400). O `register_class` do
//! napi-rs 2 ACUMULA propriedades por nome de classe (`props.extend`, em
//! `module_register.rs`), então um segundo `#[napi] impl` para a mesma struct
//! acrescenta estes três métodos em vez de substituir os do irmão.
//!
//! Nomes no JS saem em camelCase pela conversão default do napi-rs:
//! `counts`, `putCounts`, `forgetCounts`.

use std::collections::BTreeMap;

use adom_index::{MagMetaSums as CoreSums, MagMetaTotals as CoreTotals, MAG_META_VERSION};
use napi_derive::napi;

// A classe napi (não o store do core, que é o campo `inner` dela).
use super::MagnetStateStore;

fn erro(err: String) -> napi::Error {
    napi::Error::from_reason(err)
}

/// Uma entrada do agregado por adapter, já com a soma de TTL por lado. Achatado
/// de propósito: `#[napi(object)]` aninhado dobra a superfície da fronteira sem
/// ganho, e a forma persistida (com `ttlRemainingSums` aninhado) é montada no
/// núcleo, que é o dono do formato.
#[napi(object)]
pub struct MagMetaAdapter {
    pub adapter: String,
    pub alive: u32,
    pub bad: u32,
    pub lie: u32,
    /// Segundos restantes somados das linhas `alive` (estimativa incremental).
    pub ttl_alive: i64,
    pub ttl_bad: i64,
    pub ttl_lie: i64,
}

/// O agregado inteiro, na forma que o Node consome (`PersistentCountsPayload`).
#[napi(object)]
pub struct MagMetaCounts {
    pub version: u32,
    /// `updatedAt` gravado: base do envelhecimento da soma de TTL na leitura.
    pub updated_at: i64,
    pub adapters: Vec<MagMetaAdapter>,
}

#[napi]
impl MagnetStateStore {
    /// Agregado gravado; `null` = ausente, vencido ou ilegível — o chamador
    /// reconta o acervo (fail-closed), nunca inventa contagem.
    #[napi]
    pub fn counts(&self, now_ms: i64) -> napi::Result<Option<MagMetaCounts>> {
        let counts = self.inner.counts(now_ms).map_err(erro)?;
        Ok(counts.map(|counts| MagMetaCounts {
            version: MAG_META_VERSION,
            updated_at: counts.updated_at,
            adapters: counts
                .adapters
                .into_iter()
                .map(|(adapter, totals)| MagMetaAdapter {
                    adapter,
                    alive: totals.alive,
                    bad: totals.bad,
                    lie: totals.lie,
                    ttl_alive: totals.ttl_remaining_sums.alive,
                    ttl_bad: totals.ttl_remaining_sums.bad,
                    ttl_lie: totals.ttl_remaining_sums.lie,
                })
                .collect(),
        }))
    }

    /// Grava o agregado com `updatedAt = nowMs` (o escritor não aceita carimbo
    /// nem versão do chamador). `ttlSeconds <= 0` = sem expiração.
    #[napi]
    pub fn put_counts(
        &self,
        adapters: Vec<MagMetaAdapter>,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> napi::Result<()> {
        let mut totals = BTreeMap::new();
        for row in adapters {
            totals.insert(
                row.adapter,
                CoreTotals {
                    alive: row.alive,
                    bad: row.bad,
                    lie: row.lie,
                    ttl_remaining_sums: CoreSums {
                        alive: row.ttl_alive,
                        bad: row.ttl_bad,
                        lie: row.ttl_lie,
                    },
                },
            );
        }
        self.inner
            .put_counts(&totals, ttl_seconds, now_ms)
            .map_err(erro)
    }

    /// Apaga só o agregado. `true` = havia o que apagar (idempotente).
    #[napi]
    pub fn forget_counts(&self) -> napi::Result<bool> {
        self.inner.forget_counts().map_err(erro)
    }
}
