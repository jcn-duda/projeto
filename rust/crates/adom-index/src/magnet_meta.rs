//! Agregado durável do banco de magnets (`mag_meta:v1:counts`) — agora do Rust.
//!
//! O agregado é DERIVADO do acervo (`mag:v1`): cada adapter guarda quantos
//! `alive`/`bad`/`lie` tem e a soma dos segundos restantes de cada lado. Enquanto
//! o Node escrevia esta linha, o mesmo dado tinha dois donos — o acervo no Rust e
//! a contagem dele no Node — e uma escrita de opinião do Node podia sobreviver a
//! uma mutação do núcleo (o `cache.set` só despeja no SQLite no próximo
//! `setImmediate`). Aqui o escritor passa a ser o dono do acervo.
//!
//! Forma do valor (idêntica à que o Node gravava, para o `cache.db` herdado
//! continuar legível e para o painel não mudar de contrato):
//!
//! ```json
//! {
//!   "version": 1,
//!   "updatedAt": 1760000000000,
//!   "adapters": {
//!     "premiumize": {
//!       "alive": 2, "bad": 0, "lie": 1,
//!       "ttlRemainingSums": { "alive": 604800, "bad": 0, "lie": 1209600 }
//!     }
//!   }
//! }
//! ```
//!
//! O escritor NÃO aceita `version` nem `updatedAt` do chamador: a versão é a
//! constante deste módulo e o carimbo é o `now_ms` de quem grava (o mesmo
//! `Date.now()` do Node). O carimbo é o que envelhece a soma de TTL na leitura,
//! então ele não pode vir de fora.
//!
//! Regras que este arquivo garante:
//! - ausente, vencido ou ILEGÍVEL devolve `None` — nunca uma contagem inventada;
//!   quem lê reconta o acervo (o `adoptRebuild` do Node) e regrava;
//! - a leitura NÃO apaga a linha vencida: o rebuild regrava por cima e a
//!   varredura não existe para o agregado (é uma linha só, não um namespace);
//! - `version` desconhecida, `adapters` que não é objeto e JSON quebrado contam
//!   como ausente — payload de significado incerto não vira verdade;
//! - entrada torta (texto onde se espera número, contagem negativa) vira 0 em
//!   vez de derrubar o agregado inteiro: o total continua sendo o dos lados, e
//!   quem desconfia do total ainda tem a sentinela de divergência do Node.

use std::collections::BTreeMap;

use adom_core::mag_meta_counts_key;
use rusqlite::params;
use serde_json::{Map, Value};

use crate::magnet_state::{forget, is_expired, read_row, MagnetStateStore};

/// Versão do payload que este escritor grava — e a única que ele lê.
pub const MAG_META_VERSION: u32 = 1;

/// Soma dos segundos restantes por lado (`ttlRemainingSums` no JSON).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MagMetaSums {
    pub alive: i64,
    pub bad: i64,
    pub lie: i64,
}

/// Uma entrada do agregado: contagem e soma de TTL restante por lado.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MagMetaTotals {
    pub alive: u32,
    pub bad: u32,
    pub lie: u32,
    pub ttl_remaining_sums: MagMetaSums,
}

/// O agregado inteiro, já decodificado (sem o hash de quem foi contado).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MagMetaCounts {
    /// `updatedAt` gravado: base do envelhecimento da soma de TTL na leitura.
    pub updated_at: i64,
    pub adapters: BTreeMap<String, MagMetaTotals>,
}

impl MagnetStateStore {
    /// Agregado gravado; `None` = ausente, vencido ou ilegível. Não apaga: a
    /// linha vencida é sobrescrita pelo rebuild, não some no meio da leitura.
    pub fn counts(&self, now_ms: i64) -> Result<Option<MagMetaCounts>, String> {
        let conn = self.lock();
        let Some((raw, expires_at)) = read_row(&conn, &mag_meta_counts_key())? else {
            return Ok(None);
        };
        if is_expired(expires_at, now_ms) {
            return Ok(None);
        }
        Ok(parse_counts(&raw))
    }

    /// Grava o agregado em `mag_meta:v1:counts` com `updatedAt = now_ms`.
    /// `ttl_seconds <= 0` = sem expiração (a régua do KV, [`crate::NativeKv`]) —
    /// ao contrário das marcas do `mag`, aqui a linha não é uma janela de
    /// evidência: apagá-la só custa um rebuild.
    pub fn put_counts(
        &self,
        adapters: &BTreeMap<String, MagMetaTotals>,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<(), String> {
        let payload = counts_value(now_ms, adapters).to_string();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![
                mag_meta_counts_key(),
                payload,
                counts_expires_at(ttl_seconds, now_ms)
            ],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Apaga só o agregado. `true` = havia o que apagar (idempotente).
    pub fn forget_counts(&self) -> Result<bool, String> {
        let conn = self.lock();
        Ok(forget(&conn, &mag_meta_counts_key())? > 0)
    }
}

/// `ttl <= 0` = `expires_at` 0 (permanente), como no `NativeKv::put_json`.
fn counts_expires_at(ttl_seconds: i64, now_ms: i64) -> i64 {
    if ttl_seconds <= 0 {
        return 0;
    }
    now_ms.saturating_add(ttl_seconds.saturating_mul(1_000))
}

/// Payload na forma do contrato. A ordem das chaves sai alfabética (BTreeMap),
/// mas JSON objeto não tem ordem: o que vale é o conjunto de campos.
fn counts_value(updated_at: i64, adapters: &BTreeMap<String, MagMetaTotals>) -> Value {
    let mut map = Map::new();
    for (id, totals) in adapters {
        map.insert(
            id.clone(),
            serde_json::json!({
                "alive": totals.alive,
                "bad": totals.bad,
                "lie": totals.lie,
                "ttlRemainingSums": {
                    "alive": totals.ttl_remaining_sums.alive,
                    "bad": totals.ttl_remaining_sums.bad,
                    "lie": totals.ttl_remaining_sums.lie,
                },
            }),
        );
    }
    serde_json::json!({
        "version": MAG_META_VERSION,
        "updatedAt": updated_at,
        "adapters": Value::Object(map),
    })
}

/// Decodificação tolerante: `None` só quando o payload inteiro é de outra
/// versão ou não é um objeto com `adapters` objeto.
fn parse_counts(raw: &str) -> Option<MagMetaCounts> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    if count_of(object.get("version")) != MAG_META_VERSION {
        return None;
    }
    let adapters = object.get("adapters")?.as_object()?;
    let mut out = BTreeMap::new();
    for (id, totals) in adapters {
        // Entrada que nem objeto é não tem o que descontar: fica fora.
        let Some(totals) = totals.as_object() else {
            continue;
        };
        out.insert(
            id.clone(),
            MagMetaTotals {
                alive: count_of(totals.get("alive")),
                bad: count_of(totals.get("bad")),
                lie: count_of(totals.get("lie")),
                ttl_remaining_sums: sums_of(totals.get("ttlRemainingSums")),
            },
        );
    }
    Some(MagMetaCounts {
        updated_at: signed_of(object.get("updatedAt")),
        adapters: out,
    })
}

/// Número do JSON → contagem sem sinal. Texto, booleano e ausente valem 0: o
/// agregado não inventa contagem a partir de lixo.
fn count_of(value: Option<&Value>) -> u32 {
    signed_of(value).clamp(0, i64::from(u32::MAX)) as u32
}

/// Número do JSON → inteiro com sinal, sem estourar em `null`/texto.
fn signed_of(value: Option<&Value>) -> i64 {
    let Some(value) = value else {
        return 0;
    };
    if let Some(n) = value.as_i64() {
        return n;
    }
    value.as_f64().map(|f| f.trunc() as i64).unwrap_or(0)
}

/// `ttlRemainingSums` ausente ou torto = zeros (nunca TTL negativo).
fn sums_of(value: Option<&Value>) -> MagMetaSums {
    let Some(sums) = value.and_then(Value::as_object) else {
        return MagMetaSums::default();
    };
    MagMetaSums {
        alive: non_negative(sums.get("alive")),
        bad: non_negative(sums.get("bad")),
        lie: non_negative(sums.get("lie")),
    }
}

fn non_negative(value: Option<&Value>) -> i64 {
    signed_of(value).max(0)
}

#[cfg(test)]
#[path = "magnet_meta_tests.rs"]
mod magnet_meta_tests;
