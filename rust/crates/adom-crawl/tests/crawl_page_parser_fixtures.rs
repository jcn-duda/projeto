//! Regressão do ROTEAMENTO de `parse_crawl_page` por site, sobre as FIXTURES
//! REAIS do repositório (as mesmas do parity TS×Rust).
//!
//! Prova o contrato do ramo genérico — BLUDV, ComandoTorrents, NerdFilmes e
//! TorrentDosFilmes —, onde cada site resolve o `href` pela régua do PRÓPRIO
//! profile e o status segue o magnet COLHIDO (zero magnet nunca é `done`: é
//! a semântica do motor TS, que só fecha `done` com releases):
//!
//! - NerdFilmes: magnet estrito | protetor externo | gate same-origin
//!   `/link.php`. Era o caso quebrado: a porta-vaca devolvia `no-torrent` para
//!   post com botão `/link.php` e criava release espúrio no magnet mutilado.
//! - BLUDV: magnet estrito | protetor absoluto.
//! - TorrentDosFilmes: prefixo `magnet:?` (case-sensitive) | protetor absoluto.
//!
//! Alvo de integração: liga o lib SEM os módulos `#[cfg(test)]`, então é
//! independente do split de testes de unidade.

use adom_crawl::shared::magnet_hash;
use adom_crawl::{parse_crawl_page, CrawlPageParsed};
use std::collections::BTreeSet;

const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../test/fixtures");

fn fx(rel: &str) -> String {
    std::fs::read_to_string(format!("{FIX}/{rel}")).unwrap_or_else(|e| panic!("fixture {rel}: {e}"))
}

/// Conjunto de `btih` de TODAS as releases (planas, agrupadas e não-locadas).
fn hashes_of(p: &CrawlPageParsed) -> BTreeSet<String> {
    p.releases
        .iter()
        .chain(p.groups.iter().flat_map(|g| g.releases.iter()))
        .chain(p.unlocated.iter())
        .filter_map(|r| magnet_hash(&r.magnet))
        .collect()
}

#[test]
fn nerdfilmes_botao_link_php_sem_magnet_e_no_torrent() {
    // post-movie: UM botão `/link.php` (protetor de MESMO ORIGIN). O parser do
    // nerd o aceita, mas o sidecar não segue o protetor — e o TS do motor só
    // fecha `done` com releases. Zero magnet colhido é `no-torrent`; um `done`
    // vazio aqui gravava o acervo fantasma do nerd (done com releases=0).
    let res = parse_crawl_page(
        "nerdfilmes",
        "movie",
        "https://nerdfilmes.com/x/",
        &fx("crawl/nerdfilmes/post-movie.html"),
    );
    assert_eq!(res.status, "no-torrent");
    assert_eq!(res.title.as_deref(), Some("Bancários"));
    assert_eq!(res.year, Some(2020));
    assert!(res.releases.is_empty(), "botão de protetor não é release");
    assert!(hashes_of(&res).is_empty());
}

#[test]
fn nerdfilmes_serie_somente_protetor_e_no_torrent() {
    let res = parse_crawl_page(
        "nerdfilmes",
        "tv_show",
        "https://nerdfilmes.com/y/",
        &fx("crawl/nerdfilmes/post-series.html"),
    );
    assert_eq!(res.status, "no-torrent");
    assert_eq!(res.title.as_deref(), Some("Lanternas"));
    assert_eq!(res.year, Some(2026));
    assert_eq!(res.work_type.as_deref(), Some("series"));
    assert!(hashes_of(&res).is_empty());
}

#[test]
fn nerdfilmes_magnet_mutilado_nao_vira_release() {
    // post-no-buttons: o href é um magnet MUTILADO (`xt=urnbtih79cb…`, sem
    // `:`/`=`). O nerd valida o magnet estrito → 0 links → `no-torrent`. (A
    // porta-vaca aceitava o prefixo `magnet:` e criava release espúrio.)
    let res = parse_crawl_page(
        "nerdfilmes",
        "movie",
        "https://nerdfilmes.com/z/",
        &fx("crawl/nerdfilmes/post-no-buttons.html"),
    );
    assert_eq!(res.status, "no-torrent");
    assert_eq!(
        res.title.as_deref(),
        Some("O Assassinato de Rachel Nickell")
    );
    assert_eq!(res.year, Some(2026));
    assert!(res.releases.is_empty());
    assert!(hashes_of(&res).is_empty());
}

#[test]
fn nerdfilmes_pagina_real_2026_gate_morto_e_no_torrent() {
    // Página REAL da fila em produção (2026-10-14): a base é a URL ENFILEIRADA
    // (host morto que hoje só redireciona); a página viva (xfilmeshd.org) tem
    // H1, texto SEO, scripts de UI e UM botão relativo `/link.php?id=<blob>` —
    // sem NENHUM magnet no HTML estático. O blob do protetor responde 400
    // "Payload inválido." (terminal, mesmo gate do TS), então o veredito
    // honesto do sidecar é `no-torrent` — nunca `done` vazio, que era o que
    // enchia o banco de done com releases=0 (299 linhas, todas tries=1,
    // medidas no crawl.db em 2026-10-14).
    let res = parse_crawl_page(
        "nerdfilmes",
        "movie",
        "https://www.filmesviatorrenthd.net/anjo-negro-2025/",
        &fx("crawl/nerdfilmes/post-anjo-negro-2025.html"),
    );
    assert_eq!(res.status, "no-torrent");
    assert_eq!(res.title.as_deref(), Some("Anjo Negro"));
    assert_eq!(res.year, Some(2024));
    // O theme do nerd não publica ficha técnica (medido 2026-09-28): IMDb nulo
    // é a leitura correta, e a identificação fica por título+ano no TMDB.
    assert_eq!(res.imdb, None);
    assert!(res.releases.is_empty());
    assert!(hashes_of(&res).is_empty());
}

#[test]
fn bludv_magnet_direto_estrito() {
    let res = parse_crawl_page(
        "bludv",
        "movie",
        "https://bludvfilmes1.xyz/x/",
        &fx("crawl/bludv/post-movie.html"),
    );
    assert_eq!(res.status, "done");
    assert_eq!(res.title.as_deref(), Some("O Final da Turnê"));
    assert_eq!(res.year, Some(2016));
    assert_eq!(res.imdb.as_deref(), Some("tt3416744"));
    let hashes = hashes_of(&res);
    // Dois botões magnet no post (720p e 1080p), hashes distintos.
    assert_eq!(hashes.len(), 2);
    assert!(hashes.contains("fdeeac2ec61e28d90f24500c3543d9e6ad2db0ab"));
    assert!(hashes.contains("70fa4e6fe1be23b288e90bc78a9fb89a4f0a8f6c"));
}

#[test]
fn bludv_serie_magnet_direto() {
    let res = parse_crawl_page(
        "bludv",
        "tv_show",
        "https://bludvfilmes1.xyz/y/",
        &fx("crawl/bludv/post-series.html"),
    );
    assert_eq!(res.status, "done");
    assert_eq!(
        res.title.as_deref(),
        Some("O Exterminador do Futuro: Crônicas de Sarah Connor")
    );
    assert_eq!(res.year, Some(2009));
    assert_eq!(res.imdb.as_deref(), Some("tt0851851"));
    let hashes = hashes_of(&res);
    assert_eq!(hashes.len(), 1);
    assert!(hashes.contains("aa465bf193bb3d8065929cad328ae55f2d5a7248"));
}

#[test]
fn tdf_magnet_por_prefixo() {
    let res = parse_crawl_page(
        "torrentdosfilmes",
        "movie",
        "https://torrentdosfilmes.com/x/",
        &fx("crawl/torrentdosfilmes/post-movie.html"),
    );
    assert_eq!(res.status, "done");
    assert_eq!(
        res.title.as_deref(),
        Some("Como Viajar com o Mala do seu Pai")
    );
    assert_eq!(res.year, Some(2008));
    let hashes = hashes_of(&res);
    assert_eq!(hashes.len(), 2);
    assert!(hashes.contains("74c56042d7775f2900d0bc6fd7ee18bad05ebd42"));
    // btih em base32 é normalizado para minúsculo pelo `magnet_hash`.
    assert!(hashes.contains("gjk25rhw5hnuxly3gcpnenrkzyo5u6rw"));
}

#[test]
fn tdf_pack_de_serie_e_done() {
    let res = parse_crawl_page(
        "torrentdosfilmes",
        "tv_show",
        "https://torrentdosfilmes.com/y/",
        &fx("crawl/torrentdosfilmes/post-series.html"),
    );
    assert_eq!(res.status, "done");
    assert_eq!(res.title.as_deref(), Some("O Caçador"));
    assert_eq!(res.year, Some(2014));
    let hashes = hashes_of(&res);
    assert_eq!(hashes.len(), 1);
    assert!(hashes.contains("0a9d58f9b2ed97415b29030e38e82e060be7f0c0"));
}
