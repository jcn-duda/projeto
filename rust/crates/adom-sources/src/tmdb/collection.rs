//! Coleção multiobra — porte da metade `getCollection`/`readCollection` de
//! `src/utils/tmdb.ts`.
//!
//! Três saltos sequenciais no MESMO `deadline_at`: find (pt-BR) → `/movie/{id}`
//! só se o find não trouxe `belongs_to_collection` → `/collection/{id}`. Cada
//! fetch consome só o que sobrou do prazo.
//!
//! "Coleção" de uma obra só não é multiobra: a raiz normalizada precisa existir
//! (`adom_core::collection_root`) e as partes precisam cobrir **2+ anos**
//! distintos. Ausência autoritativa (`ok:true`, `info:None`) pode ir para o TTL
//! longo; falha vai para o curto. Fail-open: sem coleção, o chamador segue sem
//! o degrau de franquia.

use std::collections::HashSet;

use serde_json::Value;

use crate::cache::{collection_key, set_cached, CacheValue, CollectionRead};
use crate::http::now_ms;
use crate::types::CollectionInfo;
use crate::wire::{as_integer, nonempty_str};

impl super::TmdbClient {
    /// Raiz da coleção multiobra do IMDb id, ou `None` (fail-open).
    pub async fn get_collection(&self, imdb: &str, deadline_at_ms: i64) -> Option<CollectionInfo> {
        let imdb = imdb.trim();
        if !self.config.has_api_key() || imdb.is_empty() {
            return None;
        }
        let key = collection_key(imdb);
        let now = now_ms();
        if let Some(CacheValue::Collection(cached)) = self.store.get(&key, now) {
            // `ok:false` também é cacheado (curto): a ausência dele é o `info`
            // vazio, não uma nova tentativa a cada busca.
            return cached.info;
        }

        let read = self.read_collection(imdb, deadline_at_ms).await;
        let ttl = if read.ok {
            self.config.cache_ttl_secs
        } else {
            self.config.retry_ttl_secs()
        };
        set_cached(
            &*self.store,
            &key,
            CacheValue::Collection(read.clone()),
            ttl,
            now,
        );
        read.info
    }

    async fn read_collection(&self, imdb: &str, deadline_at_ms: i64) -> CollectionRead {
        let Some(find_url) = self.find_url(imdb, Some("pt-BR")) else {
            return CollectionRead::default();
        };
        let found = self
            .http
            .get_json(
                find_url,
                deadline_at_ms,
                self.config.request_timeout_ms,
                "tmdb multiobra find",
            )
            .await;
        if !found.ok() {
            return CollectionRead::default();
        }
        let Some(data) = found.data else {
            return CollectionRead {
                info: None,
                ok: true,
            };
        };
        let Some(movie) = data
            .get("movie_results")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
        else {
            // Série não tem `belongs_to_collection` e a feature é de filme:
            // ausência AUTORITATIVA.
            return CollectionRead {
                info: None,
                ok: true,
            };
        };
        let Some(movie_id) = movie.get("id").and_then(as_integer).filter(|id| *id > 0) else {
            return CollectionRead {
                info: None,
                ok: true,
            };
        };

        let mut collection = movie.get("belongs_to_collection").cloned();
        if collection_id(collection.as_ref()).is_none() {
            // TMDB "detalhado" já manda a coleção no `/find`; senão, um salto.
            let Some(detail_url) = self.api_url(&["movie", &movie_id.to_string()], Some("pt-BR"))
            else {
                return CollectionRead::default();
            };
            let detail = self
                .http
                .get_json(
                    detail_url,
                    deadline_at_ms,
                    self.config.request_timeout_ms,
                    "tmdb multiobra movie",
                )
                .await;
            if !detail.ok() {
                return CollectionRead::default();
            }
            collection = detail
                .data
                .as_ref()
                .and_then(|data| data.get("belongs_to_collection").cloned());
        }
        let Some(collection) = collection else {
            return CollectionRead {
                info: None,
                ok: true,
            };
        };
        let Some(collection_id) = collection_id(Some(&collection)) else {
            return CollectionRead {
                info: None,
                ok: true,
            };
        };

        let Some(collection_url) =
            self.api_url(&["collection", &collection_id.to_string()], Some("pt-BR"))
        else {
            return CollectionRead::default();
        };
        let coll = self
            .http
            .get_json(
                collection_url,
                deadline_at_ms,
                self.config.request_timeout_ms,
                "tmdb multiobra collection",
            )
            .await;
        if !coll.ok() {
            return CollectionRead::default();
        }
        let empty = Value::Null;
        let coll_data = coll.data.as_ref().unwrap_or(&empty);
        let name = coll_data
            .get("name")
            .and_then(nonempty_str)
            .or_else(|| collection.get("name").and_then(nonempty_str))
            .unwrap_or("")
            .trim()
            .to_string();
        let years = collection_years(coll_data);
        let root = adom_core::collection_root(&name);
        // Raiz sem evidência ou menos de 2 anos não é multiobra: admitir seria
        // inventar franquia a partir de um título solto.
        if root.is_empty() || years.len() < 2 {
            return CollectionRead {
                info: None,
                ok: true,
            };
        }
        CollectionRead {
            info: Some(CollectionInfo { name, root, years }),
            ok: true,
        }
    }
}

fn collection_id(collection: Option<&Value>) -> Option<i64> {
    collection
        .and_then(|collection| collection.get("id"))
        .and_then(as_integer)
        .filter(|id| *id > 0)
}

/// `[...new Set(parts.map(p => Number(p.release_date.slice(0, 4))).filter(y => y > 1900))]`
fn collection_years(data: &Value) -> Vec<i64> {
    let mut seen = HashSet::new();
    let mut years = Vec::new();
    let Some(parts) = data.get("parts").and_then(Value::as_array) else {
        return years;
    };
    for part in parts {
        let Some(date) = part.get("release_date").and_then(Value::as_str) else {
            continue;
        };
        let cut: String = date.chars().take(4).collect();
        let Ok(year) = cut.parse::<i64>() else {
            continue;
        };
        if year > 1900 && seen.insert(year) {
            years.push(year);
        }
    }
    years
}
