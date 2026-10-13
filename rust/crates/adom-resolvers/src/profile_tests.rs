use super::*;

fn profile() -> ResolverProfile {
    ResolverProfile::new("comandotorrents", "https://comandotorrents.com", vec![])
}

#[test]
fn profile_e_send_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ResolverProfile>();
}

#[test]
fn variantes_de_nome_resolvem_o_registry() {
    let apache = ResolverProfile::new("apachetorrent", "https://apachetorrent.com", vec![]);
    let hosts = &apache.network.candidate_hosts;
    assert_eq!(apache.network.site_id, "apachetorrent-cardigann");
    assert!(hosts.contains(&"apachetorrent.com".to_string()));
    let hdr = ResolverProfile::new("hdrtorrent", "https://hdrtorrents.net", vec![]);
    assert_eq!(hdr.network.site_id, "hdrtorrent-cardigann");
}

#[test]
fn protetores_base_e_extras() {
    let unknown = ResolverProfile::new("sitex", "https://sitex.com", vec![]);
    let base = &unknown.network.protector_suffixes;
    assert!(base.iter().any(|s| s == "videosad.net"));
    let p = ResolverProfile::new(
        "comandotorrents",
        "https://comandotorrents.com",
        vec!["meuprotetor.com".into()],
    );
    let url = "https://cdn.meuprotetor.com/go";
    assert!(p.allowlist.assert_allowed_url(url).is_ok());
}

#[test]
fn candidatos_ordem_e_dedup() {
    let p = profile();
    assert_eq!(p.selector.url(), "https://comandotorrents.com");
    let hosts = p.selector.hosts();
    assert_eq!(hosts.first(), Some(&"comandotorrents.com".to_string()));
    let do_operador = hosts.iter().filter(|h| *h == "comandotorrents.com").count();
    assert_eq!(do_operador, 1);
    assert!(hosts.contains(&"comandotorrents.tv".to_string()));
}

#[test]
fn sessao_apenas_para_apache() {
    assert!(profile().session.is_none());
    let apache = ResolverProfile::new("apachetorrent", "https://apachetorrent.com", vec![]);
    assert!(apache.session.is_some());
}

/// Chave normaliza case/espaços; URL de busca usa o domínio ativo.
#[test]
fn chave_e_url_de_busca() {
    assert_eq!(ResolverProfile::search_cache_key("  Aton  "), "search:aton");
    let url = profile().search_url("Aton 2024").unwrap();
    assert_eq!(url, "https://comandotorrents.com/?s=Aton+2024");
}

/// Sem candidato válido a busca falha antes de tocar na rede.
#[tokio::test]
async fn busca_sem_base_falha_antes_da_rede() {
    let p = ResolverProfile::new("sitex", "", vec![]);
    assert_eq!(p.selector.url(), "");
    assert!(p.search_url("x").unwrap_err().starts_with("invalid_url:"));
    assert!(p.search_html("aton").await.is_err());
}

/// `resolve` barra host fora da allowlist; magnet puro passa sem assert.
#[tokio::test]
async fn resolve_valida_a_entrada_antes_da_rede() {
    let p = profile();
    let err = p.resolve("https://evil.example.com/x").await.unwrap_err();
    assert!(err.contains("blocked_host"), "erro inesperado: {err}");
    let magnet = p.resolve("MAGNET:?xt=urn:btih:abc").await.unwrap();
    assert_eq!(magnet, "magnet:?xt=urn:btih:abc");
}
