//! Cliente TMDB — porte de `src/utils/tmdb.ts`, `tmdb-br-aliases.ts`,
//! `tmdb-home-release.ts` e da leitura de coleção (`multiwork`).
//!
//! O `/find` é DUPLO: pt-BR (título localizado + original + idioma) e en-US
//! (título canônico INGLÊS) no MESMO prazo absoluto do caller. O en-US sai SÓ
//! de `title`/`name` — nunca `original_*`, que repetiria o idioma de origem
//! (Django Kill: "Se sei vivo spara", italiano).
//!
//! Cache longo (`cache_ttl_secs`, 7 dias) só quando as consultas auxiliares
//! responderam (`ok:true`); falha/timeout usa `retry_ttl_secs` (30s por
//! padrão), senão um blip congelaria o título — e a cobertura BR, que depende
//! dele, ficaria cega por uma semana.
//!
//! Os aliases BR (`alternative_titles` só `iso_3166_1 = BR`) passam pelo filtro
//! do `adom-core` (`filter_br_aliases`): "Operação: Lioness" entra; "Kill"
//! solto, que abriria release de outra obra, não.

mod collection;
mod find_item;
mod home_release;

use std::sync::Arc;

use reqwest::Url;
use serde_json::Value;

use crate::cache::{set_cached, titles_key, CacheValue, MetaStore};
use crate::config::TmdbConfig;
use crate::http::{now_ms, url_with_path, with_query, Http};
use crate::types::Titles;
use find_item::{parse_find_item, FindItem};

/// Cliente do TMDB.
pub struct TmdbClient {
    pub(crate) http: Http,
    pub(crate) config: TmdbConfig,
    pub(crate) store: Arc<dyn MetaStore>,
}

/// Resposta de um `/find`: `ok` = a API respondeu (mesmo sem resultado);
/// `transient` = falha que volta sozinha.
struct FindResult {
    ok: bool,
    transient: bool,
    item: Option<FindItem>,
}

struct AliasResult {
    titles: Vec<String>,
    ok: bool,
}

impl TmdbClient {
    /// Cria o cliente (com o `User-Agent` configurado) e o store injetado.
    pub fn new(
        config: TmdbConfig,
        user_agent: &str,
        store: Arc<dyn MetaStore>,
    ) -> Result<Self, String> {
        Ok(Self {
            http: Http::new(user_agent)?,
            config,
            store,
        })
    }

    pub(crate) fn from_parts(http: Http, config: TmdbConfig, store: Arc<dyn MetaStore>) -> Self {
        Self {
            http,
            config,
            store,
        }
    }

    pub fn config(&self) -> &TmdbConfig {
        &self.config
    }

    /// `getTitles(imdbId)`: pt-BR + en-US no mesmo prazo, aliases BR e ano.
    ///
    /// Sem chave/`imdb` devolve `None` sem rede. Miss autoritativo (a API não
    /// conhece o id) e miss transitório têm TTLs diferentes no cache negativo.
    pub async fn get_titles(
        &self,
        imdb: &str,
        prefer_series: bool,
        deadline_at_ms: i64,
    ) -> Option<Titles> {
        let imdb = imdb.trim();
        if !self.config.has_api_key() || imdb.is_empty() {
            return None;
        }
        let key = titles_key(imdb);
        let now = now_ms();
        if let Some(CacheValue::Titles(cached)) = self.store.get(&key, now) {
            // "Sem tradução" velho é reconsultado (inclusive entrada gravada
            // antes desta regra, com 7 dias): é o que destrava a query pt-BR.
            let stale = cached
                .as_ref()
                .is_some_and(|t| t.unlocalized_is_stale(self.config.unlocalized_ttl_secs, now));
            if !stale {
                return cached;
            }
        }

        // Os dois `/find` no MESMO prazo absoluto: o en-US não estende o
        // orçamento e, rodando em paralelo, não soma parede de tempo.
        let (pt, en) = tokio::join!(
            self.find(imdb, Some("pt-BR"), prefer_series, deadline_at_ms),
            self.find(imdb, Some("en-US"), prefer_series, deadline_at_ms),
        );

        // `pt` é a consulta que dá o id numérico (aliases) e o título localizado.
        // Se ELA falhar, o en-US que respondeu ainda vira um parcial honesto:
        // título canônico + ano, com `title_pt=None`. Isso NUNCA vai para o TTL
        // longo (a consulta principal falhou).
        let pt_ok = pt.ok;
        let pt_transient = pt.transient;
        let en_ok = en.ok;
        let pt_item = pt.item;
        let en_item = en.item;
        let (item, pt_ok) = match pt_item {
            Some(item) if pt_ok => (item, true),
            _ if pt_ok => {
                // 200 sem resultado: "não conhece" autoritativo.
                set_cached(
                    &*self.store,
                    &key,
                    CacheValue::Titles(None),
                    self.config.miss_ttl_secs,
                    now,
                );
                return None;
            }
            _ => match en_item.clone() {
                Some(item) => (item, false),
                None => {
                    let ttl = if pt_transient {
                        self.config.transient_miss_ttl_secs
                    } else {
                        self.config.miss_ttl_secs
                    };
                    set_cached(&*self.store, &key, CacheValue::Titles(None), ttl, now);
                    return None;
                }
            },
        };

        // `en.ok=false` (rede/timeout/status) é degradação; `en.ok=true` sem
        // `title`/`name` é ausência autoritativa — os dois deixam `en=None`,
        // mas só o primeiro encurta o TTL.
        let en_title = if en_ok {
            en_item.as_ref().and_then(|item| item.title.clone())
        } else {
            None
        };

        let aliases = if pt_ok {
            match item.tmdb_id {
                Some(id) => self.fetch_aliases(id, item.is_series, deadline_at_ms).await,
                // Sem id numérico não há o que perguntar: ausência, não falha.
                None => AliasResult {
                    titles: Vec::new(),
                    ok: true,
                },
            }
        } else {
            // Degradação do pt-BR: não gasta mais rede em aliases.
            AliasResult {
                titles: Vec::new(),
                ok: true,
            }
        };

        // Ordem do TS: [pt, original, en]. As travas (palavras significativas
        // contidas, teto de 2, sem repetição) moram no `adom-core`.
        let canonical = [
            if pt_ok { item.title.as_deref() } else { None },
            item.original.as_deref(),
            en_title.as_deref(),
        ];
        let candidates: Vec<Option<&str>> =
            aliases.titles.iter().map(|t| Some(t.as_str())).collect();
        let aliases_br = adom_core::filter_br_aliases(&candidates, &canonical);

        let titles = Titles {
            pt: if pt_ok { item.title } else { None },
            original: item.original,
            en: en_title,
            aliases_br,
            year: item.year,
            original_language: item.original_language,
            tmdb_id: item.tmdb_id,
            is_series: item.is_series,
            fetched_at_ms: Some(now),
        };

        let ttl = if pt_ok && en_ok && aliases.ok && titles.is_unlocalized() {
            self.config
                .unlocalized_ttl_secs
                .min(self.config.cache_ttl_secs)
        } else if pt_ok && en_ok && aliases.ok {
            self.config.cache_ttl_secs
        } else {
            self.config.retry_ttl_secs()
        };
        set_cached(
            &*self.store,
            &key,
            CacheValue::Titles(Some(titles.clone())),
            ttl,
            now,
        );
        Some(titles)
    }

    /// Um `/find` por idioma. `ok:true` = 2xx com corpo objeto; `item=None`
    /// significa que a API não conhece o id.
    async fn find(
        &self,
        imdb: &str,
        language: Option<&str>,
        prefer_series: bool,
        deadline_at_ms: i64,
    ) -> FindResult {
        let Some(url) = self.find_url(imdb, language) else {
            return FindResult {
                ok: false,
                transient: false,
                item: None,
            };
        };
        let label = match language {
            Some("pt-BR") => "tmdb find pt-BR",
            Some("en-US") => "tmdb find en-US",
            _ => "tmdb find",
        };
        let fetch = self
            .http
            .get_json(url, deadline_at_ms, self.config.request_timeout_ms, label)
            .await;
        if !fetch.ok() {
            return FindResult {
                ok: false,
                transient: fetch.transient,
                item: None,
            };
        }
        let Some(data) = fetch.data else {
            return FindResult {
                ok: true,
                transient: false,
                item: None,
            };
        };
        let first = |field: &str| {
            data.get(field)
                .and_then(Value::as_array)
                .and_then(|list| list.first())
        };
        // O MESMO IMDb pode vir em `movie_results` E `tv_results`: o TMDB tem
        // cadastro de filme duplicado/lixo para séries (Lanterns, tt26545992:
        // um "filme" sem tradução nem data ao lado da série "Lanternas").
        // Preferir sempre o filme roubava o título pt-BR da série; o tipo
        // pedido decide, e o outro resultado só entra como fallback.
        let (movie, tv) = (first("movie_results"), first("tv_results"));
        let (value, is_series) = match (prefer_series, movie, tv) {
            (true, _, Some(tv)) => (Some(tv), true),
            (_, Some(movie), _) => (Some(movie), false),
            (_, None, tv) => (tv, true),
        };
        FindResult {
            ok: true,
            transient: false,
            item: value.map(|value| parse_find_item(value, is_series)),
        }
    }

    /// `/find` com `external_source=imdb_id` e, quando há, `language`.
    fn find_url(&self, imdb: &str, language: Option<&str>) -> Option<Url> {
        let url = url_with_path(&self.config.base_url, &["find", imdb])?;
        let mut pairs: Vec<(&str, &str)> = vec![
            ("api_key", self.config.api_key.as_str()),
            ("external_source", "imdb_id"),
        ];
        if let Some(language) = language {
            pairs.push(("language", language));
        }
        Some(with_query(url, &pairs))
    }

    /// URL com `api_key` e `language` opcional (rotas de detalhe/aliases).
    pub(crate) fn api_url(&self, segments: &[&str], language: Option<&str>) -> Option<Url> {
        let url = url_with_path(&self.config.base_url, segments)?;
        let mut pairs: Vec<(&str, &str)> = vec![("api_key", self.config.api_key.as_str())];
        if let Some(language) = language {
            pairs.push(("language", language));
        }
        Some(with_query(url, &pairs))
    }

    /// `alternative_titles` só do BRASIL. `ok:false` é falha (encurta o TTL da
    /// entrada de títulos); lista ausente é ausência autoritativa.
    async fn fetch_aliases(
        &self,
        tmdb_id: u64,
        is_series: bool,
        deadline_at_ms: i64,
    ) -> AliasResult {
        let id = tmdb_id.to_string();
        let endpoint = if is_series { "tv" } else { "movie" };
        let Some(url) = self.api_url(&[endpoint, id.as_str(), "alternative_titles"], None) else {
            return AliasResult {
                titles: Vec::new(),
                ok: false,
            };
        };
        let fetch = self
            .http
            .get_json(
                url,
                deadline_at_ms,
                self.config.request_timeout_ms,
                "tmdb alternative_titles",
            )
            .await;
        if !fetch.ok() {
            return AliasResult {
                titles: Vec::new(),
                ok: false,
            };
        }
        let Some(data) = fetch.data else {
            return AliasResult {
                titles: Vec::new(),
                ok: true,
            };
        };
        // O endpoint de filme devolve `titles`; o de série, `results`.
        let entries = data
            .get(if is_series { "results" } else { "titles" })
            .and_then(Value::as_array);
        let Some(entries) = entries else {
            return AliasResult {
                titles: Vec::new(),
                ok: true,
            };
        };
        let titles = entries
            .iter()
            .filter(|entry| {
                entry.get("iso_3166_1").and_then(Value::as_str) == Some("BR")
                    && entry.get("title").and_then(Value::as_str).is_some()
            })
            .filter_map(|entry| {
                entry
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        AliasResult { titles, ok: true }
    }
}
