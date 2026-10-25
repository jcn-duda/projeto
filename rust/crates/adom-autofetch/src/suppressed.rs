//! Obras que desistiram (`autofetch:v1:suppressed:<digest>`).
//!
//! Semântica: a obra+episódio foi abandonada de propósito (sem candidato viável,
//! lista sem dublado, desistência do operador). Enquanto a chave vive, o
//! `enqueue` responde `Suppressed` — o portão roda ANTES da fila, para não gastar
//! a vaga de uma busca com quem já não tem de onde baixar.
//!
//! Isto NÃO é o `sup:` do Node: lá o registro é por hash represado (fila de
//! remoção), aqui é por obra+episódio. Os dois convivem até a T3-L6.

use adom_store::kv::NativeKv;

use crate::state::{
    identity, suppressed_key, suppressed_prefix, Episode, SuppressedRecord, SUPPRESSED_TTL_SECONDS,
};

/// Marca a obra+episódio como desistida. Regravar só renova o TTL.
pub fn suppress(
    kv: &NativeKv,
    imdb_id: &str,
    ep: Option<Episode>,
    reason: &str,
    now_ms: i64,
) -> Result<(), String> {
    if imdb_id.is_empty() {
        return Err("suppress sem obra".into());
    }
    let record = SuppressedRecord::new(imdb_id, ep, reason, now_ms);
    let value = serde_json::to_value(&record).map_err(|err| err.to_string())?;
    kv.put_json(
        &suppressed_key(imdb_id, ep),
        &value,
        SUPPRESSED_TTL_SECONDS,
        now_ms,
    )
}

/// Remove a marca. `false` = não havia nada (idempotente).
pub fn unsuppress(kv: &NativeKv, imdb_id: &str, ep: Option<Episode>) -> Result<bool, String> {
    if imdb_id.is_empty() {
        return Ok(false);
    }
    kv.forget(&suppressed_key(imdb_id, ep))
}

/// A obra+episódio está suprimida agora?
pub fn is_suppressed(
    kv: &NativeKv,
    imdb_id: &str,
    ep: Option<Episode>,
    now_ms: i64,
) -> Result<bool, String> {
    if imdb_id.is_empty() {
        return Ok(false);
    }
    Ok(kv.get_json(&suppressed_key(imdb_id, ep), now_ms)?.is_some())
}

/// Identidades suprimidas vivas (`tt7` / `tt7:1:2`), prontas para o painel.
/// A varredura também poda o que venceu, como o `keys()` do Node.
pub fn identities(kv: &NativeKv, now_ms: i64) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for key in kv.keys_matching(&suppressed_prefix(), now_ms)? {
        let Some(value) = kv.get_json(&key, now_ms)? else {
            continue;
        };
        let record: SuppressedRecord =
            serde_json::from_value(value).map_err(|err| format!("suprimida ilegível: {err}"))?;
        out.push(identity(
            &record.imdb_id,
            ep_of(record.season, record.episode),
        ));
    }
    Ok(out)
}

fn ep_of(season: Option<i64>, episode: Option<i64>) -> Option<Episode> {
    match (season, episode) {
        (Some(season), Some(episode)) => Some((season, episode)),
        _ => None,
    }
}
