//! Testes da RODADA de descoberta por sitemap (`SitemapDiscovery`).
//!
//! O que estes testes protegem é a regra dura do módulo: `urls: []` com
//! `complete: true` NUNCA sai por engano — corpo ilegível, arquivo sem entrada,
//! arquivo sem obra e arquivo com o kind trocado são FALHA. Lista vazia só é
//! legal DEPOIS do corte incremental, quando cada arquivo já provou ter obra.
//!
//! A rede é dublê (`FakeFetch`): o que se mede aqui é o plano, a completude por
//! kind, o custo cobrado e o failover de host — não o fetch.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::discovery::fetch::SitemapFuture;
use crate::discovery::{DiscoveryOptions, SitemapDiscovery, SitemapFetch};
use crate::sitemap::CrawlPageKind;

const BLUDV: &str = "bludv-cardigann";
const BLUDV_HOST: &str = "bludvfilmes.xyz";
const VACA: &str = "vacatorrent";
const VACA_HOST: &str = "vaqueirofilmes1.com";
const NERD: &str = "nerdfilmes";
const NERD_HOST: &str = "xnerdfilmes.net";
const REDE: &str = "redetorrent-cardigann";
const REDE_HOST: &str = "redetorrent.xyz";

/// Fetcher de dublê: `url → corpo`; URL ausente é 404.
struct FakeFetch {
    bodies: HashMap<String, String>,
    hits: Mutex<Vec<String>>,
}

impl FakeFetch {
    fn new(bodies: &[(String, String)]) -> Arc<Self> {
        Arc::new(Self {
            bodies: bodies.iter().cloned().collect(),
            hits: Mutex::new(Vec::new()),
        })
    }

    fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }
}

impl SitemapFetch for FakeFetch {
    fn fetch<'a>(&'a self, _site: &'a str, url: &'a str) -> SitemapFuture<'a> {
        Box::pin(async move {
            self.hits.lock().unwrap().push(url.to_string());
            self.bodies
                .get(url)
                .cloned()
                .ok_or_else(|| "HTTP 404".to_string())
        })
    }
}

fn site(bodies: &[(String, String)]) -> (Arc<FakeFetch>, SitemapDiscovery) {
    let fake = FakeFetch::new(bodies);
    let disc = SitemapDiscovery::new(fake.clone(), Duration::from_secs(5));
    (fake, disc)
}

fn pair(host: &str, path: &str, body: &str) -> (String, String) {
    (format!("https://{host}{path}"), body.to_string())
}

fn opts(emit_series: bool) -> DiscoveryOptions {
    DiscoveryOptions {
        emit_series,
        ..Default::default()
    }
}

fn index_xml(locs: &[&str]) -> String {
    let mut out =
        String::from(r#"<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">"#);
    for loc in locs {
        out.push_str(&format!("<sitemap><loc>{loc}</loc></sitemap>"));
    }
    out.push_str("</sitemapindex>");
    out
}

/// Sitemap de obra a partir de `(caminho, lastmod)`.
fn work_xml(host: &str, entries: &[(&str, &str)]) -> String {
    let mut out = String::from(r#"<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">"#);
    for (path, lastmod) in entries {
        out.push_str(&format!(
            "<url><loc>https://{host}{path}</loc><lastmod>{lastmod}</lastmod></url>"
        ));
    }
    out.push_str("</urlset>");
    out
}

fn bludv_bodies(index: &str, works: &str) -> Vec<(String, String)> {
    vec![
        pair(BLUDV_HOST, "/sitemap_index.xml", index),
        pair(BLUDV_HOST, "/post-sitemap1.xml", works),
    ]
}

fn vaca_bodies(index: &str, works: &str) -> Vec<(String, String)> {
    vec![
        pair(VACA_HOST, "/sitemap_index.xml", index),
        pair(VACA_HOST, "/movie-sitemap1.xml", works),
    ]
}

// ─── Caminho feliz ──────────────────────────────────────────────────────────

#[tokio::test]
async fn bludv_misto_enfileira_filme_e_serie() {
    let index = index_xml(&["/post-sitemap1.xml"]);
    let works = work_xml(
        BLUDV_HOST,
        &[
            ("/matrix-1999/", "2026-10-01T00:00:00Z"),
            ("/the-last-of-us-1a-temporada/", "2026-10-02T00:00:00Z"),
        ],
    );
    let (fake, disc) = site(&bludv_bodies(&index, &works));

    let report = disc.discover(BLUDV, &opts(true)).await.expect("rodada");
    assert!(report.complete);
    assert!(report.complete_movie && report.complete_tv_show);
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    let kinds: Vec<_> = report.urls.iter().map(|u| u.kind).collect();
    assert_eq!(
        kinds,
        vec![CrawlPageKind::Movie, CrawlPageKind::TvShow],
        "o kind sai do slug de cada linha do post-sitemap"
    );
    assert_eq!(report.request_cost, 2, "índice + um post-sitemap");
    assert_eq!(fake.hits().len(), 2);
}

#[tokio::test]
async fn bludv_sem_series_declara_serie_completa() {
    let index = index_xml(&["/post-sitemap1.xml"]);
    let works = work_xml(
        BLUDV_HOST,
        &[
            ("/matrix-1999/", "2026-10-01"),
            ("/the-last-of-us-1a-temporada/", "2026-10-02"),
        ],
    );
    let (_, disc) = site(&bludv_bodies(&index, &works));

    let report = disc.discover(BLUDV, &opts(false)).await.expect("rodada");
    assert_eq!(report.urls.len(), 1, "só o filme entra com o gate fechado");
    assert_eq!(report.urls[0].kind, CrawlPageKind::Movie);
    assert!(
        report.complete_tv_show,
        "BLUDV com séries fora do gate declara a série completa"
    );
}

#[tokio::test]
async fn indice_tenta_os_caminhos_do_host_na_ordem() {
    let index = index_xml(&["/post-sitemap1.xml"]);
    let works = work_xml(BLUDV_HOST, &[("/matrix-1999/", "2026-10-01")]);
    let (fake, disc) = site(&bludv_bodies(&index, &works));

    disc.discover(BLUDV, &opts(true)).await.expect("rodada");
    let hits = fake.hits();
    assert_eq!(hits[0], format!("https://{BLUDV_HOST}/sitemap_index.xml"));
    assert_eq!(hits[1], format!("https://{BLUDV_HOST}/post-sitemap1.xml"));
}

// ─── Falha parcial ──────────────────────────────────────────────────────────

#[tokio::test]
async fn nerdfilmes_parcial_derruba_os_dois_kinds() {
    let index = index_xml(&["/post-sitemap1.xml", "/post-sitemap2.xml"]);
    let works = work_xml(NERD_HOST, &[("/filme-teste-2026/", "2026-10-01")]);
    let (fake, disc) = site(&[
        pair(NERD_HOST, "/sitemap.xml", &index),
        pair(NERD_HOST, "/post-sitemap1.xml", &works),
    ]);

    let report = disc
        .discover(NERD, &opts(false))
        .await
        .expect("parcial vive no relatório");
    assert!(!report.complete && !report.complete_movie);
    assert!(
        !report.complete_tv_show,
        "sem `tv_hidden_off` a falha do misto derruba a série mesmo com o gate fechado"
    );
    assert_eq!(report.urls.len(), 1, "o arquivo bom ainda entra na fila");
    assert_eq!(report.failures.len(), 1);
    assert!(report.failures[0].contains("post-sitemap2.xml"));
    assert_eq!(fake.hits().len(), 3, "índice + dois arquivos");
}

#[tokio::test]
async fn todas_as_fontes_falhando_e_erro() {
    let index = index_xml(&["/post-sitemap1.xml", "/post-sitemap2.xml"]);
    let (_, disc) = site(&[pair(BLUDV_HOST, "/sitemap_index.xml", &index)]);

    let err = disc
        .discover(BLUDV, &opts(true))
        .await
        .expect_err("nenhuma fonte utilizável");
    assert!(err.contains("todos os sitemaps de obra falharam"), "{err}");
}

#[tokio::test]
async fn site_fora_da_tabela_nao_descobre() {
    let (_, disc) = site(&[]);
    let err = disc
        .discover("hdrtorrent-cardigann", &opts(true))
        .await
        .expect_err("listagem paginada, não sitemap");
    assert!(err.contains("site sem descoberta de sitemap"), "{err}");
}

// ─── Formas silenciosas de o cursor andar sobre acervo não lido ─────────────

#[tokio::test]
async fn indice_ilegivel_e_erro() {
    let (fake, disc) = site(&[pair(
        BLUDV_HOST,
        "/sitemap_index.xml",
        "<html><body>sem sitemap</body></html>",
    )]);

    let err = disc
        .discover(BLUDV, &opts(true))
        .await
        .expect_err("índice sem locs");
    assert!(err.contains("índice de sitemaps ilegível"), "{err}");
    assert!(err.contains("formato de sitemap não reconhecido"), "{err}");
    assert!(!fake.hits().is_empty(), "tentar host não é resposta");
}

#[tokio::test]
async fn sitemap_de_obra_ilegivel_nao_vira_vazio_completo() {
    let index = index_xml(&["/post-sitemap1.xml"]);
    let (_, disc) = site(&[
        pair(BLUDV_HOST, "/sitemap_index.xml", &index),
        pair(
            BLUDV_HOST,
            "/post-sitemap1.xml",
            "<html><body>oi</body></html>",
        ),
    ]);

    let err = disc
        .discover(BLUDV, &opts(true))
        .await
        .expect_err("corpo sem forma de sitemap");
    assert!(err.contains("formato de sitemap não reconhecido"), "{err}");
}

#[tokio::test]
async fn sitemap_sem_url_de_obra_e_falha() {
    let index = index_xml(&["/post-sitemap1.xml"]);
    let works = work_xml(BLUDV_HOST, &[("/filmes/", "2026-10-01")]);
    let (_, disc) = site(&bludv_bodies(&index, &works));

    let err = disc
        .discover(BLUDV, &opts(true))
        .await
        .expect_err("taxonomia não é obra");
    assert!(err.contains("sem URL de obra"), "{err}");
}

#[tokio::test]
async fn corte_incremental_vazio_continua_completo() {
    let index = index_xml(&["/post-sitemap1.xml"]);
    let works = work_xml(BLUDV_HOST, &[("/matrix-1999/", "2026-09-01T00:00:00Z")]);
    let (_, disc) = site(&bludv_bodies(&index, &works));

    let o = DiscoveryOptions {
        since_movie: Some("2026-10-01T00:00:00Z".to_string()),
        emit_series: true,
        ..Default::default()
    };
    let report = disc
        .discover(BLUDV, &o)
        .await
        .expect("nada novo não é falha");
    assert!(report.urls.is_empty());
    assert!(
        report.complete,
        "o arquivo provou ter obra ANTES do corte — zero é 'nada novo'"
    );
    assert!(report.failures.is_empty());
}

// ─── Sitemap por KIND (PerKind) ─────────────────────────────────────────────

fn vaca_index(with_series: bool) -> String {
    if with_series {
        index_xml(&["/movie-sitemap1.xml", "/tv_show-sitemap1.xml"])
    } else {
        index_xml(&["/movie-sitemap1.xml"])
    }
}

#[tokio::test]
async fn per_kind_serie_caida_nao_trava_o_filme() {
    let index = vaca_index(true);
    let works = work_xml(VACA_HOST, &[("/movie/matrix-1999/", "2026-10-01")]);
    let (fake, disc) = site(&vaca_bodies(&index, &works));

    let report = disc.discover(VACA, &opts(true)).await.expect("parcial");
    assert!(!report.complete);
    assert!(report.complete_movie, "o arquivo de filme respondeu");
    assert!(!report.complete_tv_show, "o de série caiu");
    assert_eq!(report.urls.len(), 1);
    assert_eq!(report.urls[0].kind, CrawlPageKind::Movie);
    assert!(report.failures[0].contains("tv_show-sitemap1.xml"));
    assert_eq!(report.request_cost, 3, "índice + os dois arquivos");
    assert_eq!(fake.hits().len(), 3);
}

#[tokio::test]
async fn per_kind_sem_series_nao_pede_o_arquivo_de_serie() {
    let index = vaca_index(true);
    let works = work_xml(VACA_HOST, &[("/movie/matrix-1999/", "2026-10-01")]);
    let (fake, disc) = site(&vaca_bodies(&index, &works));

    let report = disc.discover(VACA, &opts(false)).await.expect("rodada");
    assert_eq!(report.urls.len(), 1);
    assert!(report.complete && report.complete_movie && report.complete_tv_show);
    assert_eq!(report.request_cost, 2, "o arquivo de série nem é pedido");
    assert!(!fake.hits().iter().any(|h| h.contains("tv_show-sitemap")));
}

#[tokio::test]
async fn per_kind_sem_fonte_de_filme_e_erro() {
    let index = index_xml(&["/tv_show-sitemap1.xml"]);
    let (_, disc) = site(&[pair(VACA_HOST, "/sitemap_index.xml", &index)]);

    let err = disc
        .discover(VACA, &opts(false))
        .await
        .expect_err("nenhuma fonte de filme nesta rodada");
    assert!(err.contains("índice não tem sitemap de obra"), "{err}");
}

#[tokio::test]
async fn per_kind_arquivo_com_kind_trocado_e_falha() {
    let index = index_xml(&["/movies-sitemap1.xml"]);
    let works = work_xml(REDE_HOST, &[("/series/serie-x/", "2026-10-01")]);
    let (_, disc) = site(&[
        pair(REDE_HOST, "/sitemap.xml", &index),
        pair(REDE_HOST, "/movies-sitemap1.xml", &works),
    ]);

    let err = disc
        .discover(REDE, &opts(true))
        .await
        .expect_err("arquivo de filme só com série não prova nada");
    assert!(err.contains("sem URL do kind do arquivo"), "{err}");
}

// ─── Prazo ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn rodada_estourada_vira_erro() {
    struct Trava;

    impl SitemapFetch for Trava {
        fn fetch<'a>(&'a self, _site: &'a str, _url: &'a str) -> SitemapFuture<'a> {
            Box::pin(async move {
                std::future::pending::<()>().await;
                Err("nunca".to_string())
            })
        }
    }

    let disc = SitemapDiscovery::new(Arc::new(Trava), Duration::from_millis(20));
    let err = disc
        .discover(BLUDV, &opts(true))
        .await
        .expect_err("prazo da rodada vencido");
    assert!(err.contains("estourou o prazo"), "{err}");
}
