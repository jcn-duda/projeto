//! Flush dos contadores `meta.*` no KV nativo (Fatia 0 do corte do fallback
//! de metadados).
//!
//! Os contadores vivem em RAM (`meta_metrics.rs`, `OnceLock`): cada recriação
//! de container zerava a janela de medição `meta.fallback.*`, e a decisão de
//! cortar o fallback do Node exigia horas de uso sem deploy para acumulá-la.
//! O snapshot vai para o `cache.db` compartilhado a cada minuto
//! (`metam:v1:counts`, permanente, agregado O(1) como o `mag_meta`) e volta no
//! boot deste módulo, chamado no `run_gateway`.
//!
//! Fail-open: falha de leitura ou gravação só loga — a medição nunca derruba
//! o gateway, e o pior caso é a janela recomeçar de zero (o comportamento de
//! antes da fatia). O `cache.clear()` do Node trunca a tabela inteira e leva a
//! linha junto (mesma exposição dos irmãos de posse do AllDebrid): benigno, o
//! boot seguinte reconta de zero.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{Map, Value};

use adom_debrid::native_kv::production_kv;
use adom_index::NativeKv;

/// Chave única do agregado no KV nativo (`ttl <= 0` grava permanente). Com
/// segmento após a versão, o prefixo literal `metam:v1:` do Node
/// (`RUST_OWNED_PREFIXES`) cobre a guarda do L1 — sem segmento, `startsWith`
/// não casaria.
pub const KEY: &str = "metam:v1:counts";
/// Cadência do flush: 1 upsert por minuto contra uma janela de dias.
const FLUSH_INTERVAL: Duration = Duration::from_secs(60);

/// Grava o snapshot no KV. `now_ms` entra por parâmetro (mesma régua dos
/// stores: o relógio nunca mora dentro do store).
pub fn flush_now(
    kv: &NativeKv,
    snapshot: BTreeMap<String, u64>,
    now_ms: i64,
) -> Result<(), String> {
    let mut counts = Map::new();
    for (key, by) in snapshot {
        counts.insert(key, Value::from(by));
    }
    kv.put_json(KEY, &Value::Object(counts), 0, now_ms)
}

/// Lê o agregado persistido. Linha ausente (primeiro boot) é mapa vazio;
/// valor que não é objeto, ou com contador não-numérico, é erro — a linha
/// regravada no próximo flush conserta.
pub fn load_persisted(kv: &NativeKv, now_ms: i64) -> Result<BTreeMap<String, u64>, String> {
    let Some(value) = kv.get_json(KEY, now_ms)? else {
        return Ok(BTreeMap::new());
    };
    let Some(object) = value.as_object() else {
        return Err(format!("{KEY}: valor não é objeto"));
    };
    let mut counts = BTreeMap::new();
    for (key, count) in object {
        let Some(by) = count.as_u64() else {
            return Err(format!("{KEY}: contador de {key} não é numérico"));
        };
        counts.insert(key.clone(), by);
    }
    Ok(counts)
}

/// Boot: reidrata o flush do deploy anterior na global do `adom-search`.
fn restore_from_kv() {
    let Some(kv) = production_kv() else {
        eprintln!("[gateway] meta flush sem KV nativo; janela meta.* recomeça em zero");
        return;
    };
    match load_persisted(kv, adom_sources::now_ms()) {
        Ok(counts) if counts.is_empty() => {}
        Ok(counts) => {
            adom_search::orchestrator::meta_metrics_restore(counts);
            eprintln!("[gateway] meta.* restaurado do deploy anterior");
        }
        Err(err) => eprintln!("[gateway] meta flush não reidratou: {err}"),
    }
}

/// Restaura no boot e agenda o flush por minuto. Falha não derruba o gateway:
/// o loop é fire-and-forget como o do warmer e das varreduras.
pub fn spawn_from_env() {
    restore_from_kv();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(FLUSH_INTERVAL);
        loop {
            interval.tick().await;
            let Some(kv) = production_kv() else {
                continue;
            };
            let snapshot = adom_search::orchestrator::meta_metrics_snapshot();
            if let Err(err) = flush_now(kv, snapshot, adom_sources::now_ms()) {
                eprintln!("[gateway] meta flush não gravou: {err}");
            }
        }
    });
}

#[cfg(test)]
#[path = "meta_metrics_flush_tests.rs"]
mod tests;
