//! Objetos que atravessam a fronteira napi do estado de debrid (`mag:v1`).
//!
//! Irmão de `debrid_state.rs` por teto de linhas: as classes ficam lá e os
//! objetos viajam daqui. Em `#[napi(object)]` o `Option::None` chega ao JS como
//! `undefined` (a chave some do objeto) — o wrapper TS normaliza para `null`.
//! `usize` não atravessa: os contadores saem em `u32`.

use adom_index::{
    DavailSweep as CoreDavailSweep, MagCount as CoreCount, MagEntry as CoreEntry,
    MagSweep as CoreMagSweep,
};
use napi_derive::napi;

/// Uma linha viva do `mag:v1`, já filtrada pela enumeração do núcleo.
#[napi(object)]
pub struct MagEntry {
    pub adapter: String,
    pub side: String,
    pub hash: String,
    /// Segundos até vencer; `None` = linha sem janela.
    pub ttl_remaining_seconds: Option<i64>,
}

/// Página da enumeração: `matched` é o total casado ANTES do `limit`.
#[napi(object)]
pub struct MagPage {
    pub items: Vec<MagEntry>,
    pub matched: u32,
    pub truncated: bool,
}

/// Contagem por adapter × lado (`ttl_remaining_sum` só tem valor no `summary`).
#[napi(object)]
pub struct MagCount {
    pub adapter: String,
    pub side: String,
    pub count: u32,
    pub ttl_remaining_sum: i64,
}

/// O que a varredura do `mag` removeu, com o decremento por adapter × lado.
#[napi(object)]
pub struct MagSweep {
    pub expired: u32,
    pub evicted: u32,
    pub counts: Vec<MagCount>,
}

/// O que a varredura do `davail` removeu (o namespace não tem lado).
#[napi(object)]
pub struct DavailSweep {
    pub expired: u32,
    pub evicted: u32,
}

impl From<CoreEntry> for MagEntry {
    fn from(entry: CoreEntry) -> Self {
        Self {
            adapter: entry.adapter,
            side: entry.side,
            hash: entry.hash,
            ttl_remaining_seconds: entry.ttl_remaining_seconds,
        }
    }
}

impl From<CoreCount> for MagCount {
    fn from(count: CoreCount) -> Self {
        Self {
            adapter: count.adapter,
            side: count.side,
            count: count.count,
            ttl_remaining_sum: count.ttl_remaining_sum,
        }
    }
}

impl From<CoreMagSweep> for MagSweep {
    fn from(sweep: CoreMagSweep) -> Self {
        Self {
            expired: sweep.expired,
            evicted: sweep.evicted,
            counts: sweep.counts.into_iter().map(MagCount::from).collect(),
        }
    }
}

impl From<CoreDavailSweep> for DavailSweep {
    fn from(sweep: CoreDavailSweep) -> Self {
        Self {
            expired: sweep.expired,
            evicted: sweep.evicted,
        }
    }
}
