//! Escritas do veredito do interrogatório de áudio (T3-L7a).
//!
//! `mag`/`idx`/`adprot`/`streams` são estado do NÚCLEO desde a T2-L5/L6/L7:
//! aqui se chama a API nativa direto, sem rota interna e sem o Node. Falha de
//! abertura de um dos stores degrada só a escrita correspondente (log
//! `[audit]`) — o interrogatório continua, porque o `resolve` em si não
//! depende deles.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use adom_core::{account_scope, WorkTarget};
use adom_index::{MagnetState, MagnetStateStore, NativeKv};
use adom_store::{ReleaseIndexStore, StreamsStore};
use serde_json::Value;

use super::dub_audit::{env_num, env_on, now_ms, AuditWrites, DEFAULT_LIE_TTL};

/// Escritas de produção sobre os stores do núcleo.
pub struct NativeWrites {
    mag: Option<MagnetStateStore>,
    index: Option<ReleaseIndexStore>,
    kv: Option<NativeKv>,
    streams: Option<Arc<StreamsStore>>,
    lie_enabled: bool,
    lie_ttl: i64,
}

impl NativeWrites {
    /// Store no arquivo dado, com as flags no default LIGADO (teste e boot).
    pub fn open(path: &Path, streams: Option<Arc<StreamsStore>>) -> Self {
        let mag = match MagnetStateStore::open(path) {
            Ok(store) => Some(store),
            Err(err) => {
                eprintln!("[audit] mag:v1 indisponível ({err}); lie não será gravado");
                None
            }
        };
        let kv = match NativeKv::open(path) {
            Ok(store) => Some(store),
            Err(err) => {
                eprintln!(
                    "[audit] KV do cache.db indisponível ({err}); adprot não será destravado"
                );
                None
            }
        };
        let index = match ReleaseIndexStore::open(path) {
            Ok(store) => Some(store),
            Err(err) => {
                eprintln!("[audit] idx:v14 indisponível ({err}); prova não será marcada");
                None
            }
        };
        Self {
            mag,
            index,
            kv,
            streams,
            lie_enabled: true,
            lie_ttl: DEFAULT_LIE_TTL,
        }
    }

    pub fn from_env(streams: Option<Arc<StreamsStore>>) -> Self {
        let path: PathBuf = adom_store::default_cache_db_path();
        let mut writes = Self::open(&path, streams);
        writes.lie_enabled = env_on("MAGNET_DB", true) && env_on("MAGNET_LIE", true);
        writes.lie_ttl = env_num("MAGNET_LIE_TTL", DEFAULT_LIE_TTL);
        writes
    }
}

impl AuditWrites for NativeWrites {
    fn is_lie(&self, adapter: &str, api_key: &str, hash: &str) -> bool {
        let Some(mag) = &self.mag else {
            return false;
        };
        matches!(
            mag.state(adapter, api_key, hash, now_ms()),
            Ok(Some(MagnetState::Lie))
        )
    }

    fn is_missing(
        &self,
        imdb_id: &str,
        season: Option<i64>,
        episode: Option<i64>,
        hash: &str,
        now_ms: i64,
    ) -> bool {
        let Some(index) = &self.index else {
            return false;
        };
        index.is_missing(imdb_id, WorkTarget { season, episode }, hash, now_ms)
    }

    fn mark_lie(&self, adapter: &str, api_key: &str, hash: &str, now_ms: i64) {
        if !self.lie_enabled || self.lie_ttl <= 0 {
            return;
        }
        if let Some(mag) = &self.mag {
            let _ = mag.mark_lie(adapter, api_key, hash, self.lie_ttl, now_ms);
        }
    }

    fn mark_lied(
        &self,
        imdb_id: &str,
        season: Option<i64>,
        episode: Option<i64>,
        hash: &str,
        now_ms: i64,
    ) {
        if let Some(index) = &self.index {
            let _ = index.mark_lied(imdb_id, WorkTarget { season, episode }, hash, now_ms);
        }
    }

    fn mark_missing(
        &self,
        imdb_id: &str,
        season: i64,
        episode: i64,
        hash: &str,
        whole_season: bool,
        now_ms: i64,
    ) {
        let Some(index) = &self.index else {
            return;
        };
        let target = WorkTarget {
            season: Some(season),
            episode: Some(episode),
        };
        let _ = index.mark_missing(imdb_id, target, hash, now_ms);
        if whole_season {
            let _ = index.mark_missing_season(imdb_id, season, hash, now_ms);
        }
    }

    fn unprotect(&self, adapter: &str, api_key: &str, hash: &str) {
        let Some(kv) = &self.kv else {
            return;
        };
        if hash.is_empty() {
            return;
        }
        let account = account_scope(&Value::String(api_key.to_string()));
        if account == "none" {
            return;
        }
        let key = format!(
            "adprot:v1:{adapter}:{account}:{}",
            hash.to_ascii_lowercase()
        );
        let _ = kv.forget(&key);
    }

    fn invalidate_obra(&self, imdb_id: &str) {
        if let Some(streams) = &self.streams {
            let _ = streams.invalidate_for_obra(imdb_id);
        }
    }
}

#[cfg(test)]
#[path = "dub_audit_writes_tests.rs"]
mod tests;
