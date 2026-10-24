//! Costura de rede da lane do Mico: o que a descoberta e a leitura de página
//! precisam, atrás de uma trait — o teste injeta um dublê sem tocar a rede.
//!
//! `MicoClient` (HTTP real) implementa esta trait em `client.rs`. Futures
//! boxed: `async fn` em trait ainda não é compatível com `dyn`, e o motor
//! guarda a API como `Arc<dyn MicoApi>`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use crate::mico::SeriesMeta;
use crate::mico_net::types::{CatalogPage, CatalogType, MicoError};

/// Futuro boxed de uma chamada ao Mico.
pub type MicoFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Base pública da Cinemeta (mesma URL de `src/utils/cinemeta.ts`).
pub const CINEMETA_BASE: &str = "https://v3-cinemeta.strem.io";

/// Rede do Mico + metadados de série da Cinemeta.
pub trait MicoApi: Send + Sync {
    /// Página do catálogo (`/catalog/{tipo}/{catalogo}/skip={skip}.json`).
    fn catalog_page<'a>(
        &'a self,
        kind: CatalogType,
        catalog_id: &'a str,
        skip: usize,
    ) -> MicoFuture<'a, Result<CatalogPage, MicoError>>;

    /// GET JSON de uma URL do Mico.
    ///
    /// Paridade com o `fetchMicoStreams` do TS: `Ok(None)` para `4xx` (exceto
    /// 429) — é da obra, não prova host caído, e o chamador trata como "sem
    /// stream"; `Err` para 429/5xx/rede (o motor faz backoff).
    fn get_json<'a>(&'a self, url: &'a str) -> MicoFuture<'a, Result<Option<String>, MicoError>>;

    /// Metadados de série da Cinemeta. `Ok(None)` = id desconhecido (o
    /// chamador trata como erro RETENTÁVEL: sem meta não dá para afirmar que a
    /// série não tem episódios).
    fn series_meta<'a>(
        &'a self,
        imdb: &'a str,
    ) -> MicoFuture<'a, Result<Option<SeriesMeta>, MicoError>>;
}

/// Extrai `episodes` (temporada → nº de episódios) e `episodeAired` (`"S:E"` →
/// data) do payload da Cinemeta. Espelha `episodesBySeason` + `episodeAiredDates`
/// de `src/utils/cinemeta.ts`: temporada 0 (especiais) fica fora e a data usa
/// `released` com fallback em `firstAired`.
pub fn parse_series_meta(json: &str) -> Option<SeriesMeta> {
    let value: Value = serde_json::from_str(json).ok()?;
    let meta = value.get("meta")?;
    let videos = meta.get("videos").and_then(|v| v.as_array());

    let mut episodes: HashMap<String, u32> = HashMap::new();
    let mut episode_aired: HashMap<String, String> = HashMap::new();
    if let Some(videos) = videos {
        for video in videos {
            let season = video.get("season").and_then(|s| s.as_u64()).unwrap_or(0) as u32;
            let episode = video
                .get("episode")
                .or_else(|| video.get("number"))
                .and_then(|e| e.as_u64())
                .unwrap_or(0) as u32;
            if season == 0 || episode == 0 {
                continue;
            }
            let count = episodes.entry(season.to_string()).or_insert(0);
            if episode > *count {
                *count = episode;
            }
            let date = video
                .get("released")
                .and_then(|d| d.as_str())
                .filter(|d| !d.is_empty())
                .or_else(|| {
                    video
                        .get("firstAired")
                        .and_then(|d| d.as_str())
                        .filter(|d| !d.is_empty())
                });
            if let Some(date) = date {
                episode_aired.insert(format!("{season}:{episode}"), date.to_string());
            }
        }
    }

    let name = meta
        .get("name")
        .or_else(|| meta.get("title"))
        .and_then(|n| n.as_str())
        .map(str::to_string);
    Some(SeriesMeta {
        episodes,
        episode_aired,
        name,
        year: meta.get("year").cloned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serie_meta_agrupa_temporadas_e_datas() {
        let json = r#"{"meta":{"name":"Série","year":"2020","videos":[
            {"season":1,"episode":1,"released":"2020-01-01T00:00:00.000Z"},
            {"season":1,"episode":2,"firstAired":"2020-01-08T00:00:00.000Z"},
            {"season":2,"number":1,"released":"2021-01-01"},
            {"season":0,"episode":1,"released":"2019-01-01"}
        ]}}"#;
        let meta = parse_series_meta(json).expect("meta válida");
        assert_eq!(meta.episodes.get("1"), Some(&2));
        assert_eq!(meta.episodes.get("2"), Some(&1));
        assert_eq!(meta.episodes.get("0"), None, "especiais ficam fora");
        assert_eq!(
            meta.episode_aired.get("2:1").map(String::as_str),
            Some("2021-01-01")
        );
        assert_eq!(meta.name.as_deref(), Some("Série"));
    }

    #[test]
    fn serie_meta_sem_videos_vira_mapas_vazios() {
        let meta = parse_series_meta(r#"{"meta":{"name":"X"}}"#).expect("meta válida");
        assert!(meta.episodes.is_empty());
        assert!(meta.episode_aired.is_empty());
    }

    #[test]
    fn payload_invalido_nao_explode() {
        assert!(parse_series_meta("nao-json").is_none());
        assert!(parse_series_meta(r#"{"meta":null}"#).is_some());
    }
}
