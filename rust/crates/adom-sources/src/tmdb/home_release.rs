//! Data do 1º lançamento DOMÉSTICO — porte de `src/utils/tmdb-home-release.ts`.
//!
//! Antes dessa data, release de fonte doméstica (WEB-DL, WEBRip, BluRay, HDTV,
//! DVD) não pode ser o filme: é outra obra com o mesmo nome (The Odyssey do
//! Nolan × o "The Odyssey (2026)" da Tubi). O CORTE em si é
//! `adom_core::pre_home_release_contradicts` — aqui só se resolve a DATA.
//!
//! Fail-open: sem chave, sem filme no TMDB, sem data doméstica ou falha de rede
//! devolve `None` e nada é cortado. Só filme (quem chama decide).
//!
//! Cache: resposta autoritativa (inclusive "não tem data/obra") vai para
//! `home_release_ttl_secs`; falha vai para `transient_miss_ttl_secs`. O
//! `peek_home_release_at` é a leitura SÍNCRONA usada pelo build — ele não
//! espera rede.

use serde_json::Value;

use crate::cache::{home_release_key, set_cached, CacheValue, HomeReleaseRead};
use crate::http::now_ms;
use crate::wire::{as_integer, parse_iso_date_ms};

// Tipos de lançamento do TMDB: 4 digital, 5 físico, 6 TV.
const HOME_TYPES: [i64; 3] = [4, 5, 6];

impl super::TmdbClient {
    /// 1ª data doméstica do filme (epoch ms) — `getHomeReleaseAt`.
    pub async fn get_home_release_at(&self, imdb: &str, deadline_at_ms: i64) -> Option<i64> {
        let imdb = imdb.trim();
        if !self.config.pre_home_release_cut || !self.config.has_api_key() || imdb.is_empty() {
            return None;
        }
        let key = home_release_key(imdb);
        let now = now_ms();
        if let Some(CacheValue::HomeRelease(cached)) = self.store.get(&key, now) {
            return cached.at;
        }

        let read = self.read_home_release(imdb, deadline_at_ms).await;
        let ttl = if read.ok {
            self.config.home_release_ttl_secs
        } else {
            self.config.transient_miss_ttl_secs
        };
        set_cached(
            &*self.store,
            &key,
            CacheValue::HomeRelease(read.clone()),
            ttl,
            now,
        );
        read.at
    }

    /// Leitura síncrona do que a busca já consultou (`peekHomeReleaseAt`).
    pub fn peek_home_release_at(&self, imdb: &str) -> Option<i64> {
        let imdb = imdb.trim();
        if !self.config.pre_home_release_cut || imdb.is_empty() {
            return None;
        }
        match self.store.get(&home_release_key(imdb), now_ms()) {
            Some(CacheValue::HomeRelease(read)) => read.at,
            _ => None,
        }
    }

    async fn read_home_release(&self, imdb: &str, deadline_at_ms: i64) -> HomeReleaseRead {
        // O TS não manda `language` aqui; a obra é a mesma.
        let Some(find_url) = self.find_url(imdb, None) else {
            return HomeReleaseRead::default();
        };
        let found = self
            .http
            .get_json(
                find_url,
                deadline_at_ms,
                self.config.request_timeout_ms,
                "tmdb data doméstica find",
            )
            .await;
        if !found.ok() {
            return HomeReleaseRead::default();
        }
        let Some(data) = found.data else {
            return HomeReleaseRead { at: None, ok: true };
        };
        let movie_id = data
            .get("movie_results")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .and_then(|movie| movie.get("id"))
            .and_then(as_integer)
            .filter(|id| *id > 0);
        let Some(movie_id) = movie_id else {
            // Sem filme: ausência autoritativa (TTL longo).
            return HomeReleaseRead { at: None, ok: true };
        };

        let Some(dates_url) =
            self.api_url(&["movie", &movie_id.to_string(), "release_dates"], None)
        else {
            return HomeReleaseRead::default();
        };
        let dates = self
            .http
            .get_json(
                dates_url,
                deadline_at_ms,
                self.config.request_timeout_ms,
                "tmdb data doméstica release_dates",
            )
            .await;
        if !dates.ok() {
            return HomeReleaseRead::default();
        }
        let at = dates.data.as_ref().and_then(earliest_home_release);
        HomeReleaseRead { at, ok: true }
    }
}

/// Menor data doméstica (epoch ms) entre todos os países, ou `None`.
fn earliest_home_release(data: &Value) -> Option<i64> {
    let mut min: Option<i64> = None;
    let countries = data.get("results").and_then(Value::as_array)?;
    for country in countries {
        let Some(entries) = country.get("release_dates").and_then(Value::as_array) else {
            continue;
        };
        for entry in entries {
            let Some(kind) = entry.get("type").and_then(as_integer) else {
                continue;
            };
            if !HOME_TYPES.contains(&kind) {
                continue;
            }
            let Some(date) = entry.get("release_date").and_then(Value::as_str) else {
                continue;
            };
            let Some(at) = parse_iso_date_ms(date) else {
                continue;
            };
            min = Some(min.map_or(at, |current| current.min(at)));
        }
    }
    min
}
