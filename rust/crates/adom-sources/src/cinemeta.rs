//! Cliente Cinemeta — porte de `src/utils/cinemeta.ts`.
//!
//! Fonte PREFERIDA do nome/ano da obra no addon. O que o TS fazia e continua
//! valendo aqui:
//!
//! - cache POSITIVO de 7 dias por `meta:{tipo}:{imdb}`;
//! - cache NEGATIVO separado: 404/corpo sem `meta` é miss autoritativo
//!   (`miss_ttl_secs`); rede/timeout/429/5xx é transitório
//!   (`transient_miss_ttl_secs`), para um blip não congelar o id;
//! - série: episódios por temporada (sem especiais, temporada 0) e a data REAL
//!   por episódio (`released` com fallback em `firstAired`);
//! - `released`/`firstAired` da obra entram quando o payload publica (o teto de
//!   lançamento recente do índice precisa deles).
//!
//! Falha nunca derruba: devolve `None` e loga com prefixo `[sources]`.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::Value;

use crate::cache::{cinemeta_key, set_cached, CacheValue, MetaStore};
use crate::config::CinemetaConfig;
use crate::http::{now_ms, url_with_path, Http};
use crate::types::{CinemetaMeta, EpisodeAired, MediaType};
use crate::wire::{as_integer, nonempty_str, scalar_text};

/// Cliente do Cinemeta.
pub struct CinemetaClient {
    http: Http,
    config: CinemetaConfig,
    store: Arc<dyn MetaStore>,
}

impl CinemetaClient {
    /// Cria o cliente (com o `User-Agent` configurado) e o store injetado.
    pub fn new(
        config: CinemetaConfig,
        user_agent: &str,
        store: Arc<dyn MetaStore>,
    ) -> Result<Self, String> {
        Ok(Self {
            http: Http::new(user_agent)?,
            config,
            store,
        })
    }

    pub(crate) fn from_parts(
        http: Http,
        config: CinemetaConfig,
        store: Arc<dyn MetaStore>,
    ) -> Self {
        Self {
            http,
            config,
            store,
        }
    }

    pub fn config(&self) -> &CinemetaConfig {
        &self.config
    }

    /// `getMeta(type, imdbId)`: meta tipada, `None` em miss/falha (honesto).
    pub async fn get_meta(
        &self,
        media_type: MediaType,
        imdb: &str,
        deadline_at_ms: i64,
    ) -> Option<CinemetaMeta> {
        let imdb = imdb.trim();
        if imdb.is_empty() {
            return None;
        }
        let key = cinemeta_key(media_type, imdb);
        let now = now_ms();
        if let Some(CacheValue::Cinemeta(cached)) = self.store.get(&key, now) {
            return cached;
        }

        let url = url_with_path(
            &self.config.base_url,
            &["meta", media_type.as_str(), &format!("{imdb}.json")],
        )?;
        let fetch = self
            .http
            .get_json(
                url,
                deadline_at_ms,
                self.config.request_timeout_ms,
                "cinemeta meta",
            )
            .await;

        if !fetch.ok() {
            // Transitório volta em segundos; o autoritativo (404) é decisão
            // estável da API. Os dois são miss NEGATIVO, TTLs diferentes.
            let ttl = if fetch.transient {
                self.config.transient_miss_ttl_secs
            } else {
                self.config.miss_ttl_secs
            };
            set_cached(&*self.store, &key, CacheValue::Cinemeta(None), ttl, now);
            return None;
        }

        let data = fetch.data?;
        let Some(meta) = data.get("meta").filter(|value| value.is_object()) else {
            // 2xx sem `meta`: "não conhece" autoritativo (miss TTL cheio).
            set_cached(
                &*self.store,
                &key,
                CacheValue::Cinemeta(None),
                self.config.miss_ttl_secs,
                now,
            );
            return None;
        };

        let parsed = parse_meta(meta, media_type);
        set_cached(
            &*self.store,
            &key,
            CacheValue::Cinemeta(Some(parsed.clone())),
            self.config.cache_ttl_secs,
            now,
        );
        Some(parsed)
    }
}

/// Payload `meta` → tipo público. O `type` do payload vence o pedido quando
/// reconhecível, como o `data.meta.type || kind` do TS.
fn parse_meta(meta: &Value, requested: MediaType) -> CinemetaMeta {
    let name = meta
        .get("name")
        .and_then(nonempty_str)
        .or_else(|| meta.get("title").and_then(nonempty_str))
        .map(str::to_string);
    let year = meta.get("year").and_then(scalar_text).or_else(|| {
        let release_info = meta.get("releaseInfo").and_then(Value::as_str)?;
        let cut: String = release_info.chars().take(4).collect();
        (!cut.is_empty()).then_some(cut)
    });
    let media_type = meta
        .get("type")
        .and_then(Value::as_str)
        .and_then(MediaType::parse)
        .unwrap_or(requested);

    let (episodes_by_season, episode_aired) = if media_type.is_series() {
        read_videos(meta.get("videos"))
    } else {
        (BTreeMap::new(), Vec::new())
    };

    CinemetaMeta {
        name,
        year,
        media_type,
        episodes_by_season,
        released: meta
            .get("released")
            .and_then(nonempty_str)
            .map(str::to_string),
        first_aired: meta
            .get("firstAired")
            .and_then(nonempty_str)
            .map(str::to_string),
        episode_aired,
    }
}

/// `episodesBySeason` + `episodeAiredDates`, ignorando temporada 0 e entradas
/// sem temporada/episódio inteiros.
fn read_videos(videos: Option<&Value>) -> (BTreeMap<i64, i64>, Vec<EpisodeAired>) {
    let mut counts: BTreeMap<i64, i64> = BTreeMap::new();
    let mut aired: BTreeMap<(i64, i64), String> = BTreeMap::new();
    let Some(list) = videos.and_then(Value::as_array) else {
        return (counts, Vec::new());
    };
    for video in list {
        let season = video.get("season").and_then(as_integer);
        let Some(season) = season.filter(|season| *season > 0) else {
            continue;
        };
        *counts.entry(season).or_insert(0) += 1;

        // `v.episode ?? v.number`: `??` só cai para `number` quando `episode`
        // é null/undefined — um `episode` inválido NÃO promove o `number`.
        let raw_episode = video.get("episode");
        let episode = match raw_episode {
            Some(value) if !value.is_null() => as_integer(value),
            _ => video.get("number").and_then(as_integer),
        };
        let Some(episode) = episode else {
            continue;
        };
        let released = video.get("released").and_then(nonempty_str);
        let first_aired = video.get("firstAired").and_then(nonempty_str);
        if let Some(date) = released.or(first_aired) {
            aired.insert((season, episode), date.to_string());
        }
    }
    let episode_aired = aired
        .into_iter()
        .map(|((season, episode), date)| EpisodeAired {
            season,
            episode,
            date,
        })
        .collect();
    (counts, episode_aired)
}
