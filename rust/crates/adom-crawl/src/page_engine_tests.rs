use super::*;

fn resp(status: u16, body: &str) -> FetchResponse {
    FetchResponse {
        status,
        body: body.to_string(),
        url: "https://comandotorrents.to/x/".into(),
        headers: HashMap::new(),
    }
}

/// Página real do comando (2026-10-14): 200 com o script `/jsd/` de
/// telemetria montado em JS. Não é desafio; o desafio de verdade é.
#[test]
fn telemetria_jsd_nao_e_desafio() {
    let ok = "<script>var a=document.createElement('script');            a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script><h1>Filme</h1>";
    assert!(!response_is_challenge(&resp(200, ok)));
    let chl = "<title>Just a moment...</title><script src=\"https://challenges.cloudflare.com/x\"></script>";
    assert!(response_is_challenge(&resp(403, chl)));
}

fn row(site: &str) -> UrlRow {
    UrlRow {
        site: site.to_string(),
        url: format!("https://exemplo.tv/{site}/a"),
        url_key: "/a".to_string(),
        kind: "movie".to_string(),
        status: "pending".to_string(),
        lastmod: String::new(),
        imdb: Some("tt9999999".to_string()),
        tries: 0,
        next_at: 0,
        checked_at: 0,
        releases: 0,
        error: String::new(),
        progress: String::new(),
        added_at: 0,
    }
}

fn release() -> CrawlParsedRelease {
    CrawlParsedRelease {
        title: "Obra 2024 1080p".to_string(),
        is_br: true,
        magnet: String::new(),
        indexer: "nerdfilmes".to_string(),
        tracker: String::new(),
        seeders: 0,
        size: None,
    }
}

/// Página com uma release plana e um grupo S2:E5; só `status` muda por teste.
fn page(status: &str) -> CrawlPageParsed {
    CrawlPageParsed {
        status: status.to_string(),
        imdb: Some("tt1234567".to_string()),
        title: Some("A Obra".to_string()),
        year: Some(2024),
        work_type: Some("movie".to_string()),
        error: None,
        releases: vec![release()],
        groups: vec![CrawlParsedGroup {
            season: Some(2),
            episode: Some(5),
            releases: vec![release()],
        }],
        ..CrawlPageParsed::error("https://exemplo.tv/a", "campos não usados")
    }
}

fn response_of(status: u16, body: &str, headers: &[(&str, &str)]) -> FetchResponse {
    FetchResponse {
        status,
        body: body.to_string(),
        url: "https://exemplo.tv/a".to_string(),
        headers: headers
            .iter()
            .map(|(n, v)| (n.to_string(), v.to_string()))
            .collect(),
    }
}

#[test]
fn challenge_so_em_200_403_503() {
    // Régua do TS: a espera só é desafio com o host do desafio junto.
    let moment = response_of(
        403,
        "<title>Just a moment...</title><script src=\"https://challenges.cloudflare.com/x\"></script>",
        &[],
    );
    let so_espera = response_of(403, "<h1>Just a moment</h1>", &[]);
    let mitigada = response_of(200, "ok", &[("cf-mitigated", "challenge")]);
    let erro = response_of(500, "Just a moment", &[]);
    let limpa = response_of(200, "<h1>Filme</h1>", &[]);
    assert!(response_is_challenge(&moment), "403 com página de desafio");
    assert!(response_is_challenge(&mitigada), "cf-mitigated no 200");
    assert!(
        !response_is_challenge(&so_espera),
        "espera sem host do desafio"
    );
    // 500 não é faixa de desafio, e página limpa de 200 também não.
    assert!(!response_is_challenge(&erro));
    assert!(!response_is_challenge(&limpa));
}

#[test]
fn work_traduz_status_custos_tipos_e_grupos() {
    let w = to_work(&row("nerdfilmes"), page("done"), 0);
    assert!(CrawlPageEngine::default().is_ready(), "libera o tick");
    assert_eq!(w.status, CrawlResultStatus::Done);
    assert_eq!(w.request_cost, 1, "piso de uma requisição por página");
    assert_eq!(w.imdb.as_deref(), Some("tt1234567"));
    assert_eq!((w.title.as_deref(), w.year), (Some("A Obra"), Some(2024)));
    assert_eq!(w.kind, "movie");
    let r = &w.releases[0];
    assert!(r.magnet.is_none(), "magnet vazio não é magnet");
    assert!(r.seeders.is_none() && r.tracker.is_none() && r.is_br);
    assert_eq!(
        (w.groups[0].season, w.groups[0].episode),
        (Some(2), Some(5))
    );
    let caro = to_work(&row("nerdfilmes"), page("no-torrent"), 7);
    assert_eq!(caro.request_cost, 7, "custo por hop passa inteiro");
    assert_eq!(caro.status, CrawlResultStatus::NoTorrent);
    // Sem work_type na ficha, vale o kind da fila.
    let mut sem_tipo = page("done");
    sem_tipo.work_type = None;
    let mut serie = row("nerdfilmes");
    serie.kind = "tv_show".to_string();
    assert_eq!(to_work(&serie, sem_tipo, 1).kind, "series");
}

#[test]
fn erro_de_parse_e_rotulo_desconhecido_caem_em_error() {
    let mut p = page("layout inesperado");
    p.error = Some("layout: página sem <h1> de título".to_string());
    p.imdb = None;
    let w = to_work(&row("nerdfilmes"), p, 1);
    assert_eq!(w.status, CrawlResultStatus::Error);
    assert_eq!(w.error, "layout: página sem <h1> de título");
    // A fila sabia do IMDb e a página não provou o contrário: não se perde.
    assert_eq!(w.imdb.as_deref(), Some("tt9999999"));
}

#[tokio::test]
async fn fora_do_caminho_generico_falha_sem_rede() {
    let engine = CrawlPageEngine::default();
    // Site sem perfil de rede e site de ritmo próprio (Mico) caem antes da rede.
    for site in ["site-inexistente", "mico"] {
        let outcome = engine.execute(&row(site)).await;
        let PageOutcome::Failed(msg) = outcome else {
            panic!("esperava Failed para {site}, veio {outcome:?}");
        };
        assert!(msg.contains(site), "a mensagem precisa nomear o site");
    }
}
