//! Regressões OFFLINE do fim da passada: a URL `/resolve` nasce para toda
//! disposição `resolve` do núcleo (cache, lote degradado e `resolveUncached`),
//! não só para o ⚡. Nada de rede: o `DebridCheck` é stub e o HMAC é verificado
//! com o mesmo `verify_resolve_play` da rota Node.
//!
//! Cobre os cinco serviços (a sigla do rótulo muda) porque a decisão é do lote
//! (`known:false`) e a materialização usa o `short` do adaptador.

use adom_core::{cache_check_honest, RankingStream, StreamDisplayConfig};

use crate::contract::StreamItem;
use crate::list_builder::{
    build_stream_list, BuildContext, BuildOptions, DebridAnswer, DebridCheck,
};
use crate::raw_item::RawItem;
use crate::resolve_url::{resolve_play_from, verify_resolve_play, ResolveSigner, ResolveVerify};

use super::finish_value;
use crate::orchestrator::config::{DebridContext, OrchestratorConfig};
use crate::orchestrator::meta::SearchMeta;

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET: &str = "segredo-de-teste";
const NOW: i64 = 1_700_000_000_000;
const SERVICES: [&str; 5] = [
    "alldebrid",
    "premiumize",
    "torbox",
    "realdebrid",
    "debridlink",
];

#[derive(Clone, Copy)]
enum Answer {
    Cached,
    Missing,
    Unknown,
    Unusable,
}

struct StubDebrid {
    answer: Answer,
}

impl DebridCheck for StubDebrid {
    fn check(&mut self, _stream: &RankingStream) -> DebridAnswer {
        match self.answer {
            Answer::Cached => DebridAnswer::Cached { url: None },
            Answer::Missing => DebridAnswer::Missing,
            Answer::Unknown => DebridAnswer::Unknown,
            Answer::Unusable => DebridAnswer::Unusable,
        }
    }
}

fn raw(multi_work_admitted: bool) -> RawItem {
    RawItem {
        title: Some("Filme Teste 2024 1080p".into()),
        info_hash: Some(HASH.into()),
        seeders: Some(20.0),
        indexer: Some("bludv".into()),
        multi_work_admitted,
        ..RawItem::default()
    }
}

fn build_ctx(service: &str, resolve_uncached: bool) -> BuildContext {
    BuildContext {
        names: vec!["Filme Teste".into()],
        year: "2024".into(),
        debrid_available: true,
        debrid_cache_check_honest: cache_check_honest(service),
        debrid_has_key: true,
        debrid_resolve_uncached: resolve_uncached,
        now_ms: NOW,
        ..BuildContext::default()
    }
}

/// Uma passada completa (finalize + finish) sem rede, devolvendo os itens.
fn run(
    service: &str,
    answer: Answer,
    resolve_uncached: bool,
    multi_work_admitted: bool,
) -> Vec<StreamItem> {
    run_checked(service, answer, resolve_uncached, multi_work_admitted, true)
}

/// `checked=false` = a checagem não perguntou ao debrid: `NoDebridCheck`
/// responde Unknown — nada pode virar `/resolve` (nem com o knob ligado).
fn run_checked(
    service: &str,
    answer: Answer,
    resolve_uncached: bool,
    multi_work_admitted: bool,
    checked: bool,
) -> Vec<StreamItem> {
    run_case(
        service,
        true,
        answer,
        resolve_uncached,
        multi_work_admitted,
        checked,
    )
}

/// Sem debrid ativo (`service`/chave vazios) o orquestrador usa
/// `NoDebridCheck`: `Unknown` é ausência de pergunta, nunca "frio conhecido".
fn run_inactive(
    answer: Answer,
    resolve_uncached: bool,
    multi_work_admitted: bool,
) -> Vec<StreamItem> {
    run_case(
        "",
        false,
        answer,
        resolve_uncached,
        multi_work_admitted,
        true,
    )
}

fn run_case(
    service: &str,
    active: bool,
    answer: Answer,
    resolve_uncached: bool,
    multi_work_admitted: bool,
    checked: bool,
) -> Vec<StreamItem> {
    let mut ctx = build_ctx(service, resolve_uncached);
    if !active {
        ctx.debrid_available = false;
        ctx.debrid_has_key = false;
        ctx.debrid_cache_check_honest = false;
    }
    ctx.debrid_check_disabled = !checked;
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid { answer };
    let built = build_stream_list(
        &[raw(multi_work_admitted)],
        &ctx,
        &opts,
        &mut debrid,
        &StreamDisplayConfig::default(),
    );
    let meta = SearchMeta::from_id("tt1234567");
    let signer = ResolveSigner {
        prefix: "/cfg".into(),
        secret: SECRET.into(),
        imdb_id: Some(meta.imdb_id.clone()),
        ..ResolveSigner::default()
    };
    let config = OrchestratorConfig {
        resolve_uncached,
        ..OrchestratorConfig::default()
    };
    let debrid_ctx = if active {
        DebridContext {
            service: service.into(),
            api_key: "chave-do-usuario".into(),
            ..DebridContext::default()
        }
    } else {
        DebridContext::default()
    };
    let value = finish_value(
        built,
        &meta,
        false,
        checked,
        &debrid_ctx,
        "streams:v21:teste",
        &signer,
        &config,
        false,
        NOW,
    );
    value.entry.streams
}

/// A URL relativa precisa verificar com o MESMO segredo e não pode carregar
/// host (o origin entra só na resposta).
fn assert_resolve_ok(item: &StreamItem, service: &str, cached: bool) {
    let url = item
        .url
        .as_deref()
        .unwrap_or_else(|| panic!("{service}: sem /resolve para disposição resolve"));
    assert!(!url.contains("http"), "{service}: host não entra na lista");
    assert!(
        url.starts_with(&format!("/cfg/resolve/{HASH}")),
        "{service}: path inesperado {url}"
    );
    assert!(
        item.info_hash.is_none(),
        "{service}: resolvido perde infoHash"
    );
    assert!(item.sources.is_none(), "{service}: resolvido perde sources");
    let (path, query) = url
        .split_once('?')
        .unwrap_or_else(|| panic!("{service}: URL sem query: {url}"));
    let play = resolve_play_from(path, Some(query))
        .unwrap_or_else(|| panic!("{service}: URL não parseia: {url}"));
    assert_eq!(play.info_hash, HASH, "{service}: hash minúsculo");
    assert_eq!(
        verify_resolve_play(&play, SECRET),
        ResolveVerify::Ok,
        "{service}: HMAC da URL não confere"
    );
    let name = item.name.as_deref().unwrap_or_default();
    if cached {
        assert!(name.contains('⚡'), "{service}: cacheado leva ⚡: {name}");
    } else {
        assert!(
            !name.contains('⚡') && name.contains("download"),
            "{service}: frio via resolve é `download`: {name}"
        );
    }
}

fn assert_p2p(item: &StreamItem, service: &str) {
    assert!(item.url.is_none(), "{service}: P2P não leva url");
    assert_eq!(
        item.info_hash.as_deref(),
        Some(HASH),
        "{service}: P2P mantém infoHash"
    );
}

#[test]
fn cacheado_vira_resolve_hmac_nos_cinco_servicos() {
    for service in SERVICES {
        let streams = run(service, Answer::Cached, false, false);
        assert_eq!(streams.len(), 1, "{service}: um stream");
        assert_resolve_ok(&streams[0], service, true);
    }
}

#[test]
fn lote_unknown_degrada_para_resolve_nos_cinco_servicos() {
    // RD sem store/ledger e Debrid-Link (`cacheCheck=false`) devolvem
    // `known:false`; o Node manda TODOS pelo `/resolve`, sem ⚡.
    for service in SERVICES {
        let streams = run(service, Answer::Unknown, false, false);
        assert_eq!(streams.len(), 1, "{service}: unknown não some");
        assert_resolve_ok(&streams[0], service, false);
    }
}

#[test]
fn resolve_uncached_manda_o_frio_para_o_resolve() {
    for service in SERVICES {
        let streams = run(service, Answer::Missing, true, false);
        assert_eq!(streams.len(), 1, "{service}: frio com knob continua");
        assert_resolve_ok(&streams[0], service, false);
    }
}

#[test]
fn sem_resolve_uncached_o_frio_fica_p2p_nos_cinco_servicos() {
    for service in SERVICES {
        let streams = run(service, Answer::Missing, false, false);
        assert_eq!(streams.len(), 1, "{service}: frio conhecido continua");
        assert_p2p(&streams[0], service);
    }
}

#[test]
fn multiobra_admitida_fria_so_sai_com_resolve_uncached() {
    // Sem o knob o pack multiobra ADMITIDO não pode virar torrent inteiro:
    // a lista sai sem ele (núcleo decide, não o finish).
    let sem_knob = run("alldebrid", Answer::Missing, false, true);
    assert!(
        sem_knob
            .iter()
            .all(|item| item.url.is_none() && item.info_hash.is_none()),
        "multiobra fria sem knob não pode ser oferecida: {sem_knob:?}"
    );

    let com_knob = run("alldebrid", Answer::Missing, true, true);
    assert_eq!(com_knob.len(), 1, "com knob o pack sai pelo resolve");
    assert_resolve_ok(&com_knob[0], "alldebrid", false);
    let url = com_knob[0].url.as_deref().unwrap();
    let (path, query) = url.split_once('?').unwrap();
    let play = resolve_play_from(path, Some(query)).unwrap();
    assert!(
        play.hint.contains("\"p\":1"),
        "a dica `p` do pack precisa entrar no HMAC: {}",
        play.hint
    );
}

#[test]
fn multiobra_admitida_em_cache_resolve_mesmo_sem_knob() {
    // O ramo do cache vence o multiobra no núcleo: ⚡ toca agora.
    let streams = run("alldebrid", Answer::Cached, false, true);
    assert_eq!(streams.len(), 1);
    assert_resolve_ok(&streams[0], "alldebrid", true);
}

#[test]
fn checagem_pulada_nao_materializa_resolve_nem_com_knob() {
    // Sem perguntar ao debrid, `Unknown` não é degradação e o knob de
    // `resolveUncached` não tem veredito para aplicar.
    let streams = run_checked("alldebrid", Answer::Unknown, true, false, false);
    assert_eq!(streams.len(), 1);
    assert_p2p(&streams[0], "checagem pulada");
}

#[test]
fn sem_debrid_ativo_knob_fica_p2p() {
    // Sem serviço/chave o Node nem chama o `applyDebrid`; o `Unknown` do
    // `NoDebridCheck` não autoriza `/resolve`, mesmo com o knob ligado.
    let streams = run_inactive(Answer::Unknown, true, false);
    assert_eq!(streams.len(), 1, "o stream P2P não pode sumir");
    assert_p2p(&streams[0], "sem debrid");
}

#[test]
fn unusable_com_knob_fica_p2p() {
    // auth/quota: a conta não responde. O Node devolve a lista como P2P; o
    // `/resolve` do knob morreria no play.
    let streams = run("alldebrid", Answer::Unusable, true, false);
    assert_eq!(streams.len(), 1, "a lista P2P continua");
    assert_p2p(&streams[0], "unusable");
}

#[test]
fn unusable_com_knob_remove_multiobra() {
    // Mesmo com o knob ligado, pack multiobra admitido não vira torrent
    // inteiro: `Unusable` segue o `filter(!_multiWorkAdmitted)` do Node.
    let streams = run("alldebrid", Answer::Unusable, true, true);
    assert!(
        streams
            .iter()
            .all(|item| item.info_hash.is_none() && item.url.is_none()),
        "multiobra em conta unusable não pode ser oferecido: {streams:?}"
    );
    assert!(
        streams
            .iter()
            .all(|item| item.name.is_some() || item.external_url.is_some()),
        "quando sobra vazio, o aviso é o único item"
    );
}

#[test]
fn ativo_unknown_com_knob_degrada_para_resolve() {
    let streams = run("alldebrid", Answer::Unknown, true, false);
    assert_eq!(streams.len(), 1);
    assert_resolve_ok(&streams[0], "alldebrid", false);
}

#[test]
fn cacheado_normal_permanece_com_knob() {
    // O ramo do cache vence o knob: ⚡ toca agora e continua no `/resolve`.
    let streams = run("alldebrid", Answer::Cached, true, false);
    assert_eq!(streams.len(), 1);
    assert_resolve_ok(&streams[0], "alldebrid", true);
}
