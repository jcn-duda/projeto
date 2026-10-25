//! Obra/episódio terminal (`autofetch:v1:terminal:<digest>`).
//!
//! Um torrent morto (ou a obra que já falhou demais) não pode ser reenfileirado
//! a cada busca: o TTL curto da chave (24 h) é o que segura o `enqueue` no
//! `Duplicate` até a próxima janela. O registro da obra guarda o motivo só como
//! ESPELHO de diagnóstico — quem barra é esta chave.
//!
//! O `terminal` do Node (`autofetch-terminal.ts`) é outra coisa: lá o nome é o
//! colapso de um hash morto no lote do recheck. O nome só coincide.

use adom_store::kv::NativeKv;

use crate::state::{
    obra_key, terminal_key, terminal_prefix, Episode, ObraRecord, TerminalRecord, OBRA_TTL_SECONDS,
    TERMINAL_TTL_SECONDS,
};

/// Marca a obra+episódio como terminal e espelha o motivo no registro da obra.
pub fn terminate(
    kv: &NativeKv,
    imdb_id: &str,
    ep: Option<Episode>,
    reason: &str,
    now_ms: i64,
) -> Result<(), String> {
    if imdb_id.is_empty() {
        return Err("terminate sem obra".into());
    }
    let record = TerminalRecord::new(imdb_id, ep, reason, now_ms);
    let value = serde_json::to_value(&record).map_err(|err| err.to_string())?;
    kv.put_json(
        &terminal_key(imdb_id, ep),
        &value,
        TERMINAL_TTL_SECONDS,
        now_ms,
    )?;
    mirror_obra(kv, imdb_id, reason, now_ms)
}

/// Terminal vivo (dentro do TTL) da obra+episódio.
pub fn terminal_for(
    kv: &NativeKv,
    imdb_id: &str,
    ep: Option<Episode>,
    now_ms: i64,
) -> Result<Option<TerminalRecord>, String> {
    if imdb_id.is_empty() {
        return Ok(None);
    }
    let Some(value) = kv.get_json(&terminal_key(imdb_id, ep), now_ms)? else {
        return Ok(None);
    };
    serde_json::from_value(value)
        .map(Some)
        .map_err(|err| format!("terminal ilegível: {err}"))
}

/// Identidades terminadas vivas (`tt7` / `tt7:1:2`), para o status do painel.
pub fn identities(kv: &NativeKv, now_ms: i64) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for key in kv.keys_matching(&terminal_prefix(), now_ms)? {
        let Some(value) = kv.get_json(&key, now_ms)? else {
            continue;
        };
        let record: TerminalRecord =
            serde_json::from_value(value).map_err(|err| format!("terminal ilegível: {err}"))?;
        out.push(crate::state::identity(
            &record.imdb_id,
            match (record.season, record.episode) {
                (Some(season), Some(episode)) => Some((season, episode)),
                _ => None,
            },
        ));
    }
    Ok(out)
}

/// Espelha `terminal` no registro da obra, preservando os contadores.
fn mirror_obra(kv: &NativeKv, imdb_id: &str, reason: &str, now_ms: i64) -> Result<(), String> {
    let key = obra_key(imdb_id);
    let mut record = match kv.get_json(&key, now_ms)? {
        Some(value) => serde_json::from_value::<ObraRecord>(value)
            .map_err(|err| format!("obra ilegível: {err}"))?,
        None => ObraRecord::default(),
    };
    record.terminal = Some(reason.to_string());
    record.last_at = now_ms;
    let value = serde_json::to_value(&record).map_err(|err| err.to_string())?;
    kv.put_json(&key, &value, OBRA_TTL_SECONDS, now_ms)
}
