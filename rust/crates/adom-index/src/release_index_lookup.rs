//! Consulta e poda do `idx:v14`: agregação episódio → temporada → raiz
//! (`lookup`), marcação de parcial e limpeza do namespace.
//!
//! Submódulo de `release_index`: enxerga a `conn` e os helpers privados.

use std::collections::HashMap;

use adom_core::WorkTarget;
use rusqlite::params;

use super::{idx_prefix, IndexedRelease, ReleaseIndexStore};

impl ReleaseIndexStore {
    /// `releaseIndex.lookup` — episódio → temporada → raiz, dedupe por hash com
    /// o `seenAt` mais recente.
    pub fn lookup(&self, imdb_id: &str, location: WorkTarget, now_ms: i64) -> Vec<IndexedRelease> {
        if !imdb_id.starts_with("tt") {
            return Vec::new();
        }
        let mut keys = Vec::new();
        if let (Some(season), Some(episode)) = (location.season, location.episode) {
            keys.push(Self::obra_key(
                imdb_id,
                WorkTarget {
                    season: Some(season),
                    episode: Some(episode),
                },
            ));
        }
        if let Some(season) = location.season {
            keys.push(Self::obra_key(
                imdb_id,
                WorkTarget {
                    season: Some(season),
                    episode: None,
                },
            ));
        }
        keys.push(Self::obra_key(
            imdb_id,
            WorkTarget {
                season: None,
                episode: None,
            },
        ));
        let mut merged: HashMap<String, IndexedRelease> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        for key in keys {
            let Some(entry) = self.read_entry(&key, now_ms) else {
                continue;
            };
            for release in entry.releases {
                match merged.get(&release.hash) {
                    Some(prior) if prior.seen_at >= release.seen_at => {}
                    Some(_) => {
                        merged.insert(release.hash.clone(), release);
                    }
                    None => {
                        order.push(release.hash.clone());
                        merged.insert(release.hash.clone(), release);
                    }
                }
            }
        }
        order
            .into_iter()
            .filter_map(|hash| merged.remove(&hash))
            .collect()
    }

    /// `releaseIndex.isPartial` — qualquer das três chaves marcada bloqueia.
    /// Existência exata de uma chave viva (diagnóstico e testes de roteamento).
    pub fn has_key(&self, key: &str, now_ms: i64) -> bool {
        let conn = self.lock();
        conn.query_row(
            "SELECT 1 FROM cache WHERE key = ?1 AND expires_at >= ?2",
            params![key, now_ms],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// Apaga todo o namespace `idx` (clear-cache do painel e `cache.clear()` dos testes).
    pub fn clear_all(&self) -> Result<usize, String> {
        let base = idx_prefix();
        let conn = self.lock();
        conn.execute(
            "DELETE FROM cache WHERE substr(key, 1, length(?1)) = ?1",
            params![base],
        )
        .map_err(|err| err.to_string())
    }

    /// Linhas vivas do namespace `idx` (diagnóstico do painel: `status().entries`).
    pub fn count_live(&self, now_ms: i64) -> Result<usize, String> {
        let base = idx_prefix();
        let conn = self.lock();
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cache WHERE substr(key, 1, length(?1)) = ?1 AND expires_at >= ?2",
                params![base, now_ms],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        Ok(total.max(0) as usize)
    }

    pub fn is_partial(&self, imdb_id: &str, location: WorkTarget, now_ms: i64) -> bool {
        if !imdb_id.starts_with("tt") {
            return false;
        }
        let mut keys = Vec::new();
        if let (Some(season), Some(episode)) = (location.season, location.episode) {
            keys.push(Self::obra_key(
                imdb_id,
                WorkTarget {
                    season: Some(season),
                    episode: Some(episode),
                },
            ));
        }
        if let Some(season) = location.season {
            keys.push(Self::obra_key(
                imdb_id,
                WorkTarget {
                    season: Some(season),
                    episode: None,
                },
            ));
        }
        keys.push(Self::obra_key(
            imdb_id,
            WorkTarget {
                season: None,
                episode: None,
            },
        ));
        keys.iter().any(|key| {
            self.read_entry(key, now_ms)
                .is_some_and(|entry| entry.partial)
        })
    }
}
