//! Cópia SELADA do cofre no KV nativo, para o Chupim sobreviver a restart.
//!
//! Sem ela, cada deploy (todo push no `rust`) esvaziava o cofre em RAM e os
//! lotes já aceitos ficavam pulando `no-credential` até o dono da conta buscar
//! de novo: o recheck não via o torrent morrer e a cascata não andava (medido
//! na VPS em 2026-11-08 — Star Trek ficou horas sem dublado pronto).
//!
//! # Regras
//!
//! - Só grava com `RESOLVE_SECRET`: a linha é o MESMO selo `enc.v1` do `dk` da
//!   URL (`adom_core::seal_dk`). Sem segredo não há selo, e chave aberta em
//!   disco não entra nunca.
//! - Chave: `autofetch:v3:vault:<adapter>:<sha256 da chave>` — o escopo já
//!   persistido na fila/marker; não revela nada além do que já está lá.
//! - TTL da linha = vencimento da entrada em RAM. Restart não estende prazo.
//! - Nonce determinístico, derivado do escopo e do vencimento: o escopo é o
//!   `sha256` da chave, então o mesmo nonce só se repete para o MESMO texto
//!   (e aí o GCM devolve o mesmo blob, sem vazar nada). Dispensa RNG.
//! - Regravação no máximo a cada [`REFRESH_MS`] por conta: cada busca passa
//!   pelo `ingest`, e regravar a cada uma seria escrita à toa no `cache.db`.

use adom_core::{account_scope, seal_dk, unseal_dk};
use adom_index::NativeKv;
use serde_json::{json, Value};

pub(super) const PREFIX: &str = "autofetch:v3:vault:";

/// Intervalo mínimo entre regravações da mesma conta.
pub(super) const REFRESH_MS: i64 = 10 * 60 * 1000;

pub(super) fn key_for(scope: &str) -> String {
    format!("{PREFIX}{scope}")
}

fn nonce_for(scope: &str, expires_at: i64) -> [u8; 12] {
    let digest = account_scope(&Value::from(format!("vault-nonce:{scope}:{expires_at}")));
    let mut nonce = [0u8; 12];
    for (slot, pair) in nonce.iter_mut().zip(digest.as_bytes().chunks(2)) {
        let hex = std::str::from_utf8(pair).unwrap_or("00");
        *slot = u8::from_str_radix(hex, 16).unwrap_or(0);
    }
    nonce
}

/// Grava a linha selada. Sem segredo (ou se o selo não aconteceu) não grava.
/// Erro do SQLite só vira log: perder a cópia não pode derrubar o `ingest`.
pub(super) fn persist(
    kv: &NativeKv,
    resolve_secret: &str,
    scope: &str,
    api_key: &str,
    expires_at: i64,
    now_ms: i64,
) -> bool {
    if resolve_secret.is_empty() || api_key.is_empty() || expires_at <= now_ms {
        return false;
    }
    let sealed = seal_dk(api_key, resolve_secret, &nonce_for(scope, expires_at));
    if sealed == api_key || !adom_core::is_sealed(&sealed) {
        return false;
    }
    let ttl_seconds = ((expires_at - now_ms) / 1000).max(1);
    let value = json!({ "k": sealed, "exp": expires_at });
    match kv.put_json(&key_for(scope), &value, ttl_seconds, now_ms) {
        Ok(()) => true,
        Err(err) => {
            eprintln!("[autofetch] cofre: falha ao gravar a cópia selada: {err}");
            false
        }
    }
}

pub(super) fn forget(kv: &NativeKv, scope: &str) {
    if let Err(err) = kv.forget(&key_for(scope)) {
        eprintln!("[autofetch] cofre: falha ao apagar a cópia selada: {err}");
    }
}

/// Uma conta lida do disco: chave aberta e vencimento original.
pub(super) struct Restored {
    pub(super) scope: String,
    pub(super) api_key: String,
    pub(super) expires_at: i64,
}

/// Lê as linhas vivas e abre cada selo. Linha que não abre (segredo trocado,
/// blob corrompido) ou cujo `sha256` não bate com o escopo é APAGADA: uma
/// chave que não confere com o escopo serviria a conta errada.
pub(super) fn load(kv: &NativeKv, resolve_secret: &str, now_ms: i64) -> Vec<Restored> {
    if resolve_secret.is_empty() {
        return Vec::new();
    }
    let keys = match kv.keys_matching(PREFIX, now_ms) {
        Ok(keys) => keys,
        Err(err) => {
            eprintln!("[autofetch] cofre: falha ao listar as cópias seladas: {err}");
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for key in keys {
        let scope = key[PREFIX.len()..].to_string();
        let row = kv.get_json(&key, now_ms).ok().flatten();
        let sealed = row.as_ref().and_then(|v| v.get("k")).and_then(Value::as_str);
        let expires_at = row
            .as_ref()
            .and_then(|v| v.get("exp"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let api_key = sealed
            .map(|blob| unseal_dk(blob, resolve_secret))
            .unwrap_or_default();
        let digest_ok = scope
            .split_once(':')
            .is_some_and(|(_, digest)| digest == account_scope(&Value::from(api_key.as_str())));
        if api_key.is_empty() || !digest_ok || expires_at <= now_ms {
            forget(kv, &scope);
            continue;
        }
        out.push(Restored {
            scope,
            api_key,
            expires_at,
        });
    }
    out
}
