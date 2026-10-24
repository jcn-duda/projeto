//! Testes da descoberta nativa do Mico: passo fixo, reconsulta de vazio, fim
//! por vazias seguidas, teto, corte por obras conhecidas e marcador de
//! varredura completa. Sem rede e sem SQLite.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use crate::mico::{bucket_lastmod, synthetic_url, MicoKind};
use crate::mico_net::api::{MicoApi, MicoFuture};
use crate::mico_net::types::{CatalogPage, CatalogType, MicoError};
use crate::store::url_key::crawl_url_key;

use super::{discover_kind, is_full_sweep, walk_catalog, MicoCrawlConfig};

/// Catálogo falso: `pages` por skip, `always` devolve uma obra nova por skip e
/// `flaky` devolve vazio na PRIMEIRA visita daquele skip.
#[derive(Default)]
struct FakeApi {
    pages: Mutex<HashMap<usize, Vec<String>>>,
    flaky: Mutex<HashSet<usize>>,
    calls: Mutex<Vec<usize>>,
    always: bool,
}

impl FakeApi {
    fn new(pages: &[(usize, &[&str])]) -> Self {
        let mut map = HashMap::new();
        for (skip, ids) in pages {
            map.insert(*skip, ids.iter().map(|s| s.to_string()).collect());
        }
        Self {
            pages: Mutex::new(map),
            ..Default::default()
        }
    }

    fn always(mut self) -> Self {
        self.always = true;
        self
    }

    fn flaky(self, skip: usize) -> Self {
        self.flaky.lock().unwrap().insert(skip);
        self
    }

    fn calls(&self) -> Vec<usize> {
        self.calls.lock().unwrap().clone()
    }
}

impl MicoApi for FakeApi {
    fn catalog_page<'a>(
        &'a self,
        _kind: CatalogType,
        _catalog_id: &'a str,
        skip: usize,
    ) -> MicoFuture<'a, Result<CatalogPage, MicoError>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(skip);
            if self.flaky.lock().unwrap().remove(&skip) {
                return Ok(CatalogPage {
                    count: 0,
                    ids: Vec::new(),
                });
            }
            let ids = if self.always {
                vec![format!("tt{}", 1_000_000 + skip)]
            } else {
                self.pages
                    .lock()
                    .unwrap()
                    .get(&skip)
                    .cloned()
                    .unwrap_or_default()
            };
            Ok(CatalogPage {
                count: ids.len(),
                ids,
            })
        })
    }

    fn get_json<'a>(&'a self, _url: &'a str) -> MicoFuture<'a, Result<Option<String>, MicoError>> {
        Box::pin(async { unimplemented!("descoberta não lê stream") })
    }

    fn series_meta<'a>(
        &'a self,
        _imdb: &'a str,
    ) -> MicoFuture<'a, Result<Option<crate::mico::SeriesMeta>, MicoError>> {
        Box::pin(async { unimplemented!("descoberta não lê Cinemeta") })
    }
}

fn cfg() -> MicoCrawlConfig {
    MicoCrawlConfig {
        base_url: "https://mico.teste".to_string(),
        ..Default::default()
    }
}

fn sem_abortar() -> impl Fn() -> bool + Sync {
    || false
}

#[tokio::test]
async fn passo_fixo_25_ate_1000_e_50_depois() {
    let api = FakeApi::default().always();
    let cfg = MicoCrawlConfig {
        max_pages: 42,
        empty_retries: 0,
        end_after_empties: 99,
        known_pages_to_stop: 99,
        ..cfg()
    };
    let walk = walk_catalog(&api, &cfg, MicoKind::Movie, None, &sem_abortar()).await;
    let calls = api.calls();
    assert_eq!(walk.pages, 42);
    assert_eq!(&calls[..3], &[0, 25, 50], "passo fixo de 25 até 1000");
    assert_eq!(calls[40], 1_000, "a 41ª página começa em 1000");
    assert_eq!(calls[41], 1_050, "depois de 1000 o passo é 50");
}

#[tokio::test]
async fn pagina_vazia_intermitente_e_reconsultada_no_mesmo_skip() {
    let api = FakeApi::default().always().flaky(25);
    let cfg = MicoCrawlConfig {
        max_pages: 4,
        empty_retries: 2,
        end_after_empties: 99,
        known_pages_to_stop: 99,
        ..cfg()
    };
    let walk = walk_catalog(&api, &cfg, MicoKind::Movie, None, &sem_abortar()).await;
    assert_eq!(
        api.calls(),
        vec![0, 25, 25, 50],
        "vazio intermitente reconsulta o MESMO skip"
    );
    assert_eq!(walk.pages, 4, "a reconsulta conta no teto");
    assert_eq!(walk.ids.len(), 3);
    assert!(!walk.saw_end);
}

#[tokio::test]
async fn fim_so_depois_de_vazias_seguidas() {
    let api = FakeApi::new(&[(0, &["tt1000001"]), (25, &["tt1000002"])]);
    let cfg = MicoCrawlConfig {
        max_pages: 50,
        empty_retries: 0,
        end_after_empties: 2,
        known_pages_to_stop: 99,
        ..cfg()
    };
    let walk = walk_catalog(&api, &cfg, MicoKind::Movie, None, &sem_abortar()).await;
    assert_eq!(api.calls(), vec![0, 25, 50, 75]);
    assert!(walk.saw_end);
    assert_eq!(walk.ids, vec!["tt1000001", "tt1000002"]);
}

#[tokio::test]
async fn teto_de_paginas_trunca_sem_marcar_fim() {
    let api = FakeApi::default().always();
    let cfg = MicoCrawlConfig {
        max_pages: 3,
        empty_retries: 0,
        end_after_empties: 99,
        known_pages_to_stop: 99,
        ..cfg()
    };
    let walk = walk_catalog(&api, &cfg, MicoKind::Movie, None, &sem_abortar()).await;
    assert_eq!(walk.pages, 3);
    assert!(!walk.saw_end);
    assert!(!walk.is_complete(), "truncada não é descoberta completa");
}

#[tokio::test]
async fn incremental_para_em_paginas_conhecidas_e_sai_complete() {
    let api = FakeApi::new(&[(0, &["tt1000001"]), (25, &["tt1000002"])]);
    let now = 1_800_000_000_000i64;
    let mut known = HashSet::new();
    for tt in ["tt1000001", "tt1000002"] {
        let url = synthetic_url(MicoKind::Movie, tt, Some(&cfg().base_url));
        known.insert(crawl_url_key(&url));
    }
    let d = discover_kind(
        &api,
        &cfg(),
        MicoKind::Movie,
        now,
        Some(&(now - 1_000).to_string()),
        Some(&known),
        &sem_abortar(),
    )
    .await;
    assert!(!d.full_sweep, "marcador recente = rodada incremental");
    assert!(d.complete);
    assert_eq!(d.urls.len(), 2);
    assert!(!d.mark_full_sweep, "incremental NUNCA move o marcador");
}

#[tokio::test]
async fn varredura_completa_marca_so_quando_ve_o_fim() {
    let api = FakeApi::new(&[(0, &["tt1000001"])]);
    let cfg = MicoCrawlConfig {
        max_pages: 50,
        empty_retries: 0,
        end_after_empties: 1,
        known_pages_to_stop: 99,
        ..cfg()
    };
    let now = 1_800_000_000_000i64;
    let d = discover_kind(&api, &cfg, MicoKind::Movie, now, None, None, &sem_abortar()).await;
    assert!(d.full_sweep, "sem marcador = primeira varredura completa");
    assert!(d.complete && d.saw_end);
    assert!(
        d.mark_full_sweep,
        "completa + fim gravam o marcador do tipo"
    );
    assert_eq!(d.state_key, "full-sweep:movie");

    let truncado = FakeApi::default().always();
    let cfg_truncado = MicoCrawlConfig {
        max_pages: 2,
        empty_retries: 0,
        end_after_empties: 99,
        ..cfg
    };
    let t = discover_kind(
        &truncado,
        &cfg_truncado,
        MicoKind::Movie,
        now,
        None,
        None,
        &sem_abortar(),
    )
    .await;
    assert!(!t.complete);
    assert!(!t.mark_full_sweep, "truncada NÃO move o marcador");
}

#[tokio::test]
async fn lastmod_sintetico_usa_o_balde_do_tipo() {
    let api = FakeApi::new(&[(0, &["tt1000001", "tt1000002"])]);
    let now = 1_790_899_200_000i64; // base dos testes de `bucket_lastmod`
    let cfg = MicoCrawlConfig {
        max_pages: 1,
        empty_retries: 0,
        end_after_empties: 99,
        ..cfg()
    };
    let filme = discover_kind(&api, &cfg, MicoKind::Movie, now, None, None, &sem_abortar()).await;
    assert_eq!(filme.urls[0].lastmod, bucket_lastmod("tt1000001", now, 14));
    assert_eq!(filme.urls[0].kind, "movie");
    assert_eq!(filme.urls[0].url_key, "/crawl/movie/tt1000001");
    assert_eq!(
        filme.urls[0].url,
        "https://mico.teste/crawl/movie/tt1000001/"
    );

    let serie = discover_kind(
        &api,
        &cfg,
        MicoKind::Series,
        now,
        None,
        None,
        &sem_abortar(),
    )
    .await;
    assert_eq!(serie.urls[0].lastmod, bucket_lastmod("tt1000001", now, 30));
    assert_eq!(serie.urls[0].kind, "tv_show");
    assert_eq!(serie.urls[0].url_key, "/crawl/series/tt1000001");
}

#[test]
fn janela_da_varredura_completa_e_por_horas() {
    let now = 1_800_000_000_000i64;
    assert!(is_full_sweep(None, now, 24), "nunca varreu = completa");
    assert!(!is_full_sweep(Some(&(now - 1_000).to_string()), now, 24));
    assert!(is_full_sweep(
        Some(&(now - 25 * 3_600_000).to_string()),
        now,
        24
    ));
    assert!(
        is_full_sweep(Some("lixo"), now, 24),
        "marcador ilegível = completa"
    );
}

#[tokio::test]
async fn falha_na_primeira_pagina_marca_falha_total() {
    struct Falha;
    impl MicoApi for Falha {
        fn catalog_page<'a>(
            &'a self,
            _kind: CatalogType,
            _catalog_id: &'a str,
            _skip: usize,
        ) -> MicoFuture<'a, Result<CatalogPage, MicoError>> {
            Box::pin(async {
                Err(MicoError::HttpError {
                    status: 500,
                    body: String::new(),
                })
            })
        }
        fn get_json<'a>(
            &'a self,
            _url: &'a str,
        ) -> MicoFuture<'a, Result<Option<String>, MicoError>> {
            Box::pin(async { unimplemented!() })
        }
        fn series_meta<'a>(
            &'a self,
            _imdb: &'a str,
        ) -> MicoFuture<'a, Result<Option<crate::mico::SeriesMeta>, MicoError>> {
            Box::pin(async { unimplemented!() })
        }
    }
    let d = discover_kind(
        &Falha,
        &cfg(),
        MicoKind::Movie,
        1_800_000_000_000,
        None,
        None,
        &sem_abortar(),
    )
    .await;
    assert!(d.total_failure);
    assert!(!d.complete);
    assert_eq!(d.urls.len(), 0);
}
