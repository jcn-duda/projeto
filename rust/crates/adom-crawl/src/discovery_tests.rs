//! Testes das regras PURAS e da TABELA de sites da descoberta (fase 6).
//!
//! Nada aqui toca rede nem banco: corte incremental por kind, avanço de cursor,
//! `maxLastmod` e o `Date.parse` do subconjunto ISO que os sitemaps publicam.
//! A rodada (índice → sitemaps de obra → relatório) tem arquivo próprio,
//! `discovery_service_tests.rs`; o tick do motor, `motor/discovery_tick_tests.rs`.

use super::*;

use crate::site_profiles;
use crate::sitemap::CrawlPageKind;
use crate::store::url_key::crawl_url_key;

fn url(u: &str, lastmod: &str, kind: CrawlPageKind) -> DiscoveredUrl {
    DiscoveredUrl {
        url: u.to_string(),
        lastmod: lastmod.to_string(),
        kind,
    }
}

fn report(urls: Vec<DiscoveredUrl>) -> DiscoveryReport {
    DiscoveryReport {
        urls,
        complete: true,
        complete_movie: true,
        complete_tv_show: true,
        failures: Vec::new(),
        request_cost: 1,
        state_writes: Vec::new(),
    }
}

// ─── Cursor por kind ────────────────────────────────────────────────────────

#[test]
fn cursor_por_kind_sem_heranca() {
    let cuts = discovery_cuts(Some(" 2026-10-01T00:00:00Z "), None);
    assert_eq!(cuts.phase, DiscoveryPhase::Incremental);
    assert_eq!(cuts.movie.as_deref(), Some("2026-10-01T00:00:00Z"));
    assert_eq!(cuts.tv_show, None, "kind sem cursor NÃO herda o do outro");

    let so_serie = discovery_cuts(None, Some("2026-01-01"));
    assert_eq!(
        so_serie.phase,
        DiscoveryPhase::Initial,
        "a fase da rodada é a do filme (domina o painel)"
    );
    assert_eq!(so_serie.movie, None);
    assert_eq!(so_serie.tv_show.as_deref(), Some("2026-01-01"));
}

#[test]
fn cursor_vazio_e_ausencia() {
    let cuts = discovery_cuts(Some("   "), Some(""));
    assert_eq!((cuts.movie, cuts.tv_show), (None, None));
    assert_eq!(cuts.phase, DiscoveryPhase::Initial);
    assert_eq!(DiscoveryPhase::Initial.as_str(), "initial");
    assert_eq!(DiscoveryPhase::Incremental.as_str(), "incremental");
}

#[test]
fn chaves_de_cursor_sao_estaveis() {
    assert_eq!(cursor_key(CrawlPageKind::Movie), "cursor:movie");
    assert_eq!(cursor_key(CrawlPageKind::TvShow), "cursor:tv_show");
    assert_eq!(CURSOR_MOVIE_KEY, "cursor:movie");
    assert_eq!(CURSOR_TV_KEY, "cursor:tv_show");
    assert_eq!(LEGACY_CURSOR_KEY, "cursor");
}

// ─── Date.parse do subconjunto ISO ──────────────────────────────────────────

#[test]
fn parse_iso_ms_cobre_o_iso_dos_sitemaps() {
    let dia = 1_790_812_800_000; // 2026-10-01T00:00:00Z
    assert_eq!(
        parse_iso_ms("2026-10-01"),
        Some(dia),
        "data pura é meia-noite UTC"
    );
    assert_eq!(parse_iso_ms("2026-10-01T00:00:00Z"), Some(dia));
    assert_eq!(
        parse_iso_ms("2026-10-01 00:00"),
        Some(dia),
        "espaço no lugar do T"
    );
    assert_eq!(parse_iso_ms("2026-10-01T00:00:00.500Z"), Some(dia + 500));
    assert_eq!(
        parse_iso_ms("2026-10-01T03:00:00+03:00"),
        Some(dia),
        "offset positivo é subtraído"
    );
    assert_eq!(
        parse_iso_ms("2026-10-01T12:30:00-01:30"),
        Some(dia + 14 * 3_600_000),
        "offset negativo é somado"
    );
    assert_eq!(parse_iso_ms("2026-10-02"), Some(dia + 86_400_000));
}

#[test]
fn parse_iso_ms_recusa_o_que_nao_e_data() {
    for ruido in [
        "",
        "abc",
        "2026",
        "01/10/2026",
        "2026-13-01",
        "2026-10-32",
        "2026-10-01T25:00Z",
        "2026-10-01T00:00:00Zjunk",
    ] {
        assert_eq!(parse_iso_ms(ruido), None, "{ruido:?} não é data");
    }
}

// ─── Corte incremental ──────────────────────────────────────────────────────

#[test]
fn corte_incremental_mantem_ilegivel_e_descarta_o_ja_lido() {
    let since = Some("2026-10-01T00:00:00Z");
    assert!(
        should_keep("2026-10-02T00:00:00Z", since),
        "mais novo entra"
    );
    assert!(
        !should_keep("2026-10-01T00:00:00Z", since),
        "igual ao cursor já foi lido"
    );
    assert!(!should_keep("2026-09-30T23:59:59Z", since));
    assert!(
        should_keep("sem-data", since),
        "ilegível ENTRA: obra não se perde por ruído de data"
    );
    assert!(should_keep("", since));
    assert!(
        should_keep("2026-10-02", None),
        "sem cursor é carga inicial"
    );
    assert!(
        should_keep("2026-10-02", Some("lixo")),
        "cursor ilegível não corta nada"
    );
}

// ─── maxLastmod / avanço de cursor ──────────────────────────────────────────

#[test]
fn max_lastmod_compara_por_instante_e_por_kind() {
    let urls = vec![
        url("/a/", "2026-10-03T00:00:00Z", CrawlPageKind::Movie),
        // 2026-10-03T04:00Z: MAIOR por instante, MENOR por texto.
        url("/b/", "2026-10-02T23:00:00-05:00", CrawlPageKind::Movie),
        url("/c/", "2026-10-05T00:00:00Z", CrawlPageKind::TvShow),
        url("/lixo/", "sem-data", CrawlPageKind::Movie),
    ];
    assert_eq!(
        max_lastmod(&urls, CrawlPageKind::Movie),
        "2026-10-02T23:00:00-05:00",
        "compara por instante, não por texto"
    );
    assert_eq!(
        max_lastmod(&urls, CrawlPageKind::TvShow),
        "2026-10-05T00:00:00Z",
        "o max é por kind"
    );
}

#[test]
fn max_lastmod_nao_inventa_data() {
    let ilegiveis = vec![
        url("/a/", "sem-data", CrawlPageKind::Movie),
        url("/b/", "", CrawlPageKind::Movie),
    ];
    assert_eq!(
        max_lastmod(&ilegiveis, CrawlPageKind::Movie),
        "sem-data",
        "mantém o primeiro ilegível em vez de inventar data"
    );
    assert_eq!(max_lastmod(&[], CrawlPageKind::Movie), "");
    let misto = vec![
        url("/a/", "sem-data", CrawlPageKind::Movie),
        url("/b/", "2026-10-01", CrawlPageKind::Movie),
    ];
    assert_eq!(
        max_lastmod(&misto, CrawlPageKind::Movie),
        "2026-10-01",
        "ilegível não derruba um max legível"
    );
}

#[test]
fn cursor_so_anda_com_o_kind_completo() {
    let r = report(vec![
        url("/a/", "2026-10-01T00:00:00Z", CrawlPageKind::Movie),
        url("/b/", "2026-10-02T00:00:00Z", CrawlPageKind::Movie),
    ]);
    assert_eq!(
        next_cursor(&r, CrawlPageKind::Movie).as_deref(),
        Some("2026-10-02T00:00:00Z")
    );

    let mut parcial = r.clone();
    parcial.complete_movie = false;
    parcial.failures = vec!["post-sitemap2.xml: HTTP 404".to_string()];
    assert_eq!(
        next_cursor(&parcial, CrawlPageKind::Movie),
        None,
        "parcial trava o cursor: o que ficou no arquivo perdido seria pulado"
    );

    let mut so_filme = r.clone();
    so_filme.complete_tv_show = false;
    assert!(
        next_cursor(&so_filme, CrawlPageKind::Movie).is_some(),
        "o cursor do filme anda mesmo com a série parcial"
    );
    assert_eq!(next_cursor(&so_filme, CrawlPageKind::TvShow), None);

    assert_eq!(
        next_cursor(&DiscoveryReport::empty_complete(), CrawlPageKind::Movie),
        None,
        "completo sem URL do kind não escreve cursor"
    );
}

// ─── Relatório → fila ───────────────────────────────────────────────────────

#[test]
fn to_rows_monta_linha_pending_com_chave_da_url() {
    let r = report(vec![url(
        "https://bludvfilmes.xyz/matrix-1999/",
        "2026-10-01T00:00:00Z",
        CrawlPageKind::Movie,
    )]);
    let rows = r.to_rows("bludv-cardigann", 1_700_000_000_000);
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.site, "bludv-cardigann");
    assert_eq!(row.kind, "movie");
    assert_eq!(row.status, "pending");
    assert_eq!(row.lastmod, "2026-10-01T00:00:00Z");
    assert_eq!(row.added_at, 1_700_000_000_000);
    assert_eq!(
        row.url_key,
        crawl_url_key("https://bludvfilmes.xyz/matrix-1999/")
    );
}

// ─── Tabela de sites ────────────────────────────────────────────────────────

#[test]
fn tabela_fecha_os_seis_sites_de_sitemap() {
    assert_eq!(
        sitemap_sites(),
        vec![
            "vacatorrent",
            "redetorrent-cardigann",
            "bludv-cardigann",
            "nerdfilmes",
            "comandotorrents",
            "torrentdosfilmesv2",
        ]
    );
    for site in sitemap_sites() {
        let cfg = discovery_config(site).expect("site da lista tem config");
        assert_eq!(cfg.site_id, site);
        assert!(
            site_profiles::site_network_config(site).is_some(),
            "{site}: sem perfil de rede a rodada nem começa"
        );
        assert!(
            site_profiles::all_site_ids().contains(&site),
            "{site}: id fora do registry"
        );
        assert!(
            !site_profiles::is_own_pace(site),
            "{site}: ritmo próprio tem lane dedicada, não sitemap"
        );
    }
}

#[test]
fn sites_fora_do_sitemap_nao_descobrem() {
    for site in [
        "hdrtorrent-cardigann",
        "apachetorrent-cardigann",
        "torrentgalaxy-cardigann",
        "mico",
        "bludv",
        "redetorrent",
        "torrentdosfilmes",
    ] {
        assert!(
            discovery_config(site).is_none(),
            "{site}: listagem paginada, lane própria ou id que não é o da fila"
        );
    }
}

#[test]
fn modelo_de_completude_por_site() {
    assert_eq!(
        discovery_config("vacatorrent").unwrap().kind_model,
        KindModel::PerKind
    );
    assert_eq!(
        discovery_config("redetorrent-cardigann")
            .unwrap()
            .kind_model,
        KindModel::PerKind
    );
    assert_eq!(
        discovery_config("bludv-cardigann").unwrap().kind_model,
        KindModel::Mixed {
            tv_hidden_off: true
        },
        "BLUDV declara a série completa com o gate fechado"
    );
    for site in ["nerdfilmes", "comandotorrents", "torrentdosfilmesv2"] {
        assert_eq!(
            discovery_config(site).unwrap().kind_model,
            KindModel::Mixed {
                tv_hidden_off: false
            },
            "{site}"
        );
    }
    assert_eq!(
        discovery_config("bludv-cardigann").unwrap().shape,
        EntryShape::Xml
    );
    assert_eq!(
        discovery_config("vacatorrent").unwrap().shape,
        EntryShape::XmlOrViewer
    );
    assert_eq!(
        discovery_config("torrentdosfilmesv2")
            .unwrap()
            .sitemap
            .site_id,
        "torrentdosfilmesv2",
        "o id do parser não é o id da fila"
    );
}

#[test]
fn arquivo_de_serie_e_reconhecido_pelo_loc() {
    let vaca = discovery_config("vacatorrent").unwrap();
    assert!(vaca.is_series_loc("https://vaqueirofilmes1.com/tv_show-sitemap1.xml"));
    assert!(
        vaca.is_series_loc("https://VaqueiroFilmes1.com/TV_SHOW-SITEMAP1.XML"),
        "o loc vem com a caixa do site"
    );
    assert!(!vaca.is_series_loc("https://vaqueirofilmes1.com/movie-sitemap1.xml"));
    let rede = discovery_config("redetorrent-cardigann").unwrap();
    assert!(rede.is_series_loc("https://redetorrent.xyz/tvshows-sitemap1.xml"));
    assert!(!rede.is_series_loc("https://redetorrent.xyz/movies-sitemap1.xml"));
    let bludv = discovery_config("bludv-cardigann").unwrap();
    assert!(
        !bludv.is_series_loc("https://bludvfilmes.xyz/post-sitemap1.xml"),
        "no post-sitemap misto não existe arquivo de série"
    );
}
