//! Testes dos adaptadores nativos (TMDB + ponte admin), SEM rede real.
//!
//! A tradução dos vereditos é provada a partir do `IdentifyResult` do
//! `adom-sources` e, para fechar o fio, um `TmdbSearchApi` falso alimenta o
//! `identify` NATIVO (a mesma chamada que o [`TmdbCatalog`] faz). A ponte admin
//! sobe um `axum` em porta efêmera e confere método, caminho, corpo e header.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use adom_sources::{
    identify as native_identify, ExternalImdbResult, IdentifyInput, IdentifyOutcome,
    IdentifyResult, SearchWorkType, Titles, TmdbSearchApi, TmdbSearchHit, TmdbSearchResult,
};
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::catalog::{PageVerdict, StreamInvalidator};
use super::native::{
    names_of, normalize_imdb, to_input, token_from_lookup, verdict_of, AdminStreamInvalidator,
};
use super::{IdentifyRequest, WorkKind};

// ─── Tradução de veredito ───────────────────────────────────────────────────

fn resultado(outcome: IdentifyOutcome, imdb: Option<&str>, reason: &'static str) -> IdentifyResult {
    IdentifyResult {
        outcome,
        imdb: imdb.map(str::to_string),
        reason,
        tmdb_id: Some(603),
    }
}

#[test]
fn identified_preserva_imdb_e_motivo() {
    let verdict = verdict_of(resultado(
        IdentifyOutcome::Identified,
        Some("tt0133093"),
        "casamento-titulo-original",
    ));
    assert_eq!(verdict.outcome, PageVerdict::Identified);
    assert_eq!(verdict.imdb.as_deref(), Some("tt0133093"));
    assert_eq!(verdict.reason, "casamento-titulo-original");
    assert!(!verdict.outcome.is_retryable());
}

#[test]
fn ambiguous_e_terminal_e_nao_carrega_imdb() {
    // Mesmo que o nativo devolvesse um id, homônimo NUNCA vira obra.
    let verdict = verdict_of(resultado(
        IdentifyOutcome::Ambiguous,
        Some("tt1"),
        "homonimo-ambiguo",
    ));
    assert_eq!(verdict.outcome, PageVerdict::Ambiguous);
    assert_eq!(verdict.imdb, None);
    assert_eq!(verdict.reason, "homonimo-ambiguo");
    assert!(!verdict.outcome.is_retryable());
}

#[test]
fn unavailable_e_o_unico_retentavel() {
    let verdict = verdict_of(resultado(
        IdentifyOutcome::Unavailable,
        None,
        "tmdb-indisponivel",
    ));
    assert_eq!(verdict.outcome, PageVerdict::Unavailable);
    assert!(verdict.outcome.is_retryable(), "TMDB fora é retentável");
    assert_eq!(verdict.imdb, None);
}

#[test]
fn unidentified_e_terminal() {
    let verdict = verdict_of(resultado(
        IdentifyOutcome::Unidentified,
        None,
        "nome-sem-casamento",
    ));
    assert_eq!(verdict.outcome, PageVerdict::Unidentified);
    assert!(!verdict.outcome.is_retryable());
}

/// O `identify` nativo roda com uma API falsa e o veredito chega traduzido —
/// prova que o adaptador não inventa estado nem perde o IMDb.
#[tokio::test]
async fn identify_nativo_chega_traduzido() {
    let api = FakeTmdb {
        hits: vec![TmdbSearchHit {
            tmdb_id: 603,
            title: "Matrix".to_string(),
            original_title: "The Matrix".to_string(),
            year: Some(1999),
        }],
        imdb: Some("tt0133093".to_string()),
    };
    let input = IdentifyInput {
        kind: SearchWorkType::Movie,
        title: "Matrix",
        year: Some(1999),
        original_title: None,
        season: None,
    };
    let verdict = verdict_of(native_identify(&api, &input).await);
    assert_eq!(verdict.outcome, PageVerdict::Identified);
    assert_eq!(verdict.imdb.as_deref(), Some("tt0133093"));
}

// ─── Nomes do filtro ────────────────────────────────────────────────────────

fn titles(pt: Option<&str>, original: Option<&str>, en: Option<&str>) -> Titles {
    Titles {
        pt: pt.map(str::to_string),
        original: original.map(str::to_string),
        en: en.map(str::to_string),
        aliases_br: Vec::new(),
        year: None,
        original_language: None,
        tmdb_id: Some(603),
        is_series: false,
        fetched_at_ms: None,
    }
}

#[test]
fn names_segue_a_ordem_do_resolve_search_names_sem_meta() {
    let mut titles = titles(Some("Matrix"), Some("The Matrix"), Some("The Matrix"));
    titles.aliases_br = vec!["Matrix Reloaded".to_string(), "matrix".to_string()];
    titles.year = Some("1999".to_string());
    let names = names_of(&titles).expect("tem nomes");
    // en → pt → original (duplicado pelo normalizado) → aliases (o "matrix"
    // solto também é duplicado; só o alias distinto sobrevive).
    assert_eq!(names.names, vec!["The Matrix", "Matrix", "Matrix Reloaded"]);
    assert_eq!(names.year, Some(1999));
}

#[test]
fn names_sem_titulo_nenhum_e_none() {
    assert!(names_of(&titles(None, None, None)).is_none());
    assert!(names_of(&titles(Some(""), None, None)).is_none());
    // Ano inválido não vira contexto: `None` deixa o ano da página valer.
    let mut sem_ano = titles(Some("Matrix"), None, None);
    sem_ano.year = Some("0000".to_string());
    assert_eq!(names_of(&sem_ano).expect("nome").year, None);
}

#[test]
fn to_input_traduz_tipo_e_campos() {
    let request = IdentifyRequest {
        kind: WorkKind::Series,
        title: "Lanternas".to_string(),
        year: Some(2026),
        original_title: Some("Lanterns".to_string()),
        season: Some(2),
    };
    let input = to_input(&request);
    assert_eq!(input.kind, SearchWorkType::Series);
    assert_eq!(input.title, "Lanternas");
    assert_eq!(input.year, Some(2026));
    assert_eq!(input.original_title, Some("Lanterns"));
    assert_eq!(input.season, Some(2));
}

// ─── Ponte admin ────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Ponte {
    /// `true` = a rota recusa, como um gateway sem token/permissão.
    recusa: bool,
    chamadas: Arc<Mutex<Vec<Chamada>>>,
}

#[derive(Debug, Clone)]
struct Chamada {
    method: String,
    path: String,
    token: String,
    body: Value,
}

impl Ponte {
    fn chamadas(&self) -> Vec<Chamada> {
        self.chamadas
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }
}

async fn captura(
    State(ponte): State<Ponte>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> StatusCode {
    let token = headers
        .get("x-indexer-test-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    ponte
        .chamadas
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .push(Chamada {
            method: method.as_str().to_string(),
            path: uri.path().to_string(),
            token,
            body,
        });
    if ponte.recusa {
        StatusCode::INTERNAL_SERVER_ERROR
    } else {
        StatusCode::OK
    }
}

/// Sobe a ponte em `127.0.0.1:0` e devolve a base HTTP.
async fn ponte(recusa: bool) -> (String, Ponte) {
    let state = Ponte {
        recusa,
        chamadas: Arc::new(Mutex::new(Vec::new())),
    };
    let app = Router::new()
        .route("/streams/invalidate", post(captura))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind efêmero da ponte");
    let addr = listener.local_addr().expect("endereço da ponte");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

#[tokio::test]
async fn invalida_com_post_corpo_e_header() {
    let (base, servidor) = ponte(false).await;
    let invalidador = AdminStreamInvalidator::new(&base, "token-da-ponte", 500);

    assert!(invalidador.invalidate("TT0133093").await);
    let chamadas = servidor.chamadas();
    assert_eq!(chamadas.len(), 1);
    assert_eq!(chamadas[0].method, "POST");
    assert_eq!(chamadas[0].path, "/streams/invalidate");
    assert_eq!(chamadas[0].token, "token-da-ponte");
    // O IMDb vai canônico (minúsculo): a chave do streams.db é por obra.
    assert_eq!(chamadas[0].body, json!({ "imdbId": "tt0133093" }));
}

#[tokio::test]
async fn ponte_recusando_falha_silenciosa() {
    let (base, servidor) = ponte(true).await;
    let invalidador = AdminStreamInvalidator::new(&base, "token", 500);
    assert!(!invalidador.invalidate("tt0133093").await);
    assert_eq!(servidor.chamadas().len(), 1, "tentou uma vez, não repetiu");
}

#[tokio::test]
async fn ponte_fora_nao_derruba_a_pagina() {
    // Porta efêmera aberta e FECHADA em seguida: conexão recusada local.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    drop(listener);
    let invalidador = AdminStreamInvalidator::new(&format!("http://{addr}"), "token", 300);
    assert!(!invalidador.invalidate("tt0133093").await);
}

#[tokio::test]
async fn sem_token_e_sem_imdb_nao_chama_a_ponte() {
    let (base, servidor) = ponte(false).await;
    let sem_token = AdminStreamInvalidator::new(&base, "", 500);
    assert!(!sem_token.invalidate("tt0133093").await);
    let com_token = AdminStreamInvalidator::new(&base, "token", 500);
    assert!(!com_token.invalidate("lixo-da-pagina").await);
    assert!(servidor.chamadas().is_empty(), "nada foi enviado à ponte");
}

#[test]
fn imdb_canonico_aceita_tt_e_recusa_o_resto() {
    assert_eq!(normalize_imdb(" TT0133093 ").as_deref(), Some("tt0133093"));
    assert_eq!(normalize_imdb("tt1"), Some("tt1".to_string()));
    assert_eq!(normalize_imdb("tt"), None);
    assert_eq!(normalize_imdb("nm1234567"), None);
}

#[test]
fn token_precedencia_igual_ao_store_admin() {
    fn token_com(pares: &[(&str, &str)]) -> String {
        let mapa: HashMap<String, String> = pares
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        token_from_lookup(|key| mapa.get(key).cloned())
    }
    assert_eq!(
        token_com(&[
            ("STREAM_STORE_ADMIN_TOKEN", "proprio"),
            ("DEBRID_INTERNAL_TOKEN", "debrid"),
        ]),
        "proprio"
    );
    assert_eq!(
        token_com(&[
            ("STREAM_STORE_ADMIN_TOKEN", "  "),
            ("DEBRID_INTERNAL_TOKEN", "debrid"),
            ("JACKETT_TEST_TOKEN", "jackett"),
        ]),
        "debrid",
        "vazio não vence"
    );
    assert_eq!(token_com(&[("JACKETT_TEST_TOKEN", "jackett")]), "jackett");
    assert!(token_com(&[]).is_empty());
}

// ─── API TMDB falsa (sem rede) ──────────────────────────────────────────────

struct FakeTmdb {
    hits: Vec<TmdbSearchHit>,
    imdb: Option<String>,
}

impl TmdbSearchApi for FakeTmdb {
    fn search<'a>(
        &'a self,
        _kind: SearchWorkType,
        _title: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = TmdbSearchResult> + Send + 'a>> {
        Box::pin(async move {
            TmdbSearchResult {
                ok: true,
                hits: self.hits.clone(),
            }
        })
    }

    fn external_imdb<'a>(
        &'a self,
        _tmdb_id: u64,
        _kind: SearchWorkType,
    ) -> Pin<Box<dyn std::future::Future<Output = ExternalImdbResult> + Send + 'a>> {
        Box::pin(async move {
            ExternalImdbResult {
                ok: true,
                imdb: self.imdb.clone(),
            }
        })
    }
}
