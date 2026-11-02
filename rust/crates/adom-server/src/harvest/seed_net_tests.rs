//! Testes do ciclo da semente contra um servidor axum efêmero (sem rede real):
//! marca antes da rede, lista que falha, coorte, teto, índice e headers. A
//! chave de teste nunca pode aparecer em erro.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use adom_search::orchestrator::{IndexedReleaseWire, ReleaseIndexSource};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::regra::COHORT_KEY;
use super::tests::{ajustes, filme, serie, CHAVE, HOST, NOW};
use super::*;

// ── ciclo contra servidor local ─────────────────────────────────────────────

#[derive(Clone)]
enum Resposta {
    Lista(Value),
    Erro(u16),
}

#[derive(Clone)]
struct Api {
    hits: Arc<AtomicUsize>,
    movies: Arc<Mutex<Resposta>>,
    series: Arc<Mutex<Resposta>>,
    chaves: Arc<Mutex<Vec<String>>>,
    hosts: Arc<Mutex<Vec<String>>>,
}

impl Api {
    fn novo(movies: Resposta, series: Resposta) -> Self {
        Self {
            hits: Arc::new(AtomicUsize::new(0)),
            movies: Arc::new(Mutex::new(movies)),
            series: Arc::new(Mutex::new(series)),
            chaves: Arc::new(Mutex::new(Vec::new())),
            hosts: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

async fn lista(
    State(api): State<Api>,
    Path(caminho): Path<String>,
    headers: HeaderMap,
) -> Response {
    api.hits.fetch_add(1, Ordering::SeqCst);
    let valor = |h: &str| {
        headers
            .get(h)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    api.chaves.lock().unwrap().push(valor("x-rapidapi-key"));
    api.hosts.lock().unwrap().push(valor("x-rapidapi-host"));
    let alvo = match caminho.as_str() {
        "most-popular-movies" => api.movies.lock().unwrap().clone(),
        "most-popular-tv" => api.series.lock().unwrap().clone(),
        _ => Resposta::Erro(404),
    };
    match alvo {
        Resposta::Lista(corpo) => Json(corpo).into_response(),
        Resposta::Erro(code) => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            "x",
        )
            .into_response(),
    }
}

async fn subir(api: Api) -> String {
    let app = Router::new()
        .route("/api/imdb/{lista}", get(lista))
        .with_state(api);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

/// Índice fake: só a obra `tt0000030` está indexada.
struct Indexada;

impl ReleaseIndexSource for Indexada {
    fn lookup(
        &self,
        imdb: &str,
        _season: Option<i64>,
        _episode: Option<i64>,
        _now_ms: i64,
    ) -> Vec<IndexedReleaseWire> {
        if imdb == "tt0000030" {
            vec![IndexedReleaseWire {
                hash: "h".to_string(),
                ..Default::default()
            }]
        } else {
            Vec::new()
        }
    }

    fn is_partial(&self, _imdb: &str, _s: Option<i64>, _e: Option<i64>, _now: i64) -> bool {
        false
    }

    fn record(
        &self,
        _entry: &adom_search::internal_types::ReleaseEntry,
        _now_ms: i64,
        _bank: Option<adom_search::orchestrator::BankLookup<'_>>,
    ) -> Result<usize, String> {
        Ok(0)
    }
}

#[tokio::test]
async fn sem_chave_nao_faz_requisicao() {
    let api = Api::novo(Resposta::Lista(json!([])), Resposta::Lista(json!([])));
    let base = subir(api.clone()).await;
    let kv = NativeKv::open_memory().unwrap();
    let sem_chave = SeedSettings {
        api_key: String::new(),
        ..ajustes(&base)
    };
    assert!(ciclo(&sem_chave, &kv, None, NOW).await.unwrap().is_empty());
    let desligada = SeedSettings {
        enabled: false,
        ..ajustes(&base)
    };
    assert!(ciclo(&desligada, &kv, None, NOW).await.unwrap().is_empty());
    let sem_indice = SeedSettings {
        release_index: false,
        ..ajustes(&base)
    };
    assert!(ciclo(&sem_indice, &kv, None, NOW).await.unwrap().is_empty());
    assert_eq!(api.hits(), 0, "inerte: nenhuma lista consultada");
    assert!(kv.get_json(MARCA_KEY, NOW).unwrap().is_none(), "sem marca");
}

#[tokio::test]
async fn marca_grava_antes_da_rede_e_api_fora_nao_repete() {
    let api = Api::novo(Resposta::Erro(500), Resposta::Erro(500));
    let base = subir(api.clone()).await;
    let kv = NativeKv::open_memory().unwrap();
    let s = ajustes(&base);

    let primeiro = ciclo(&s, &kv, None, NOW).await.unwrap();
    assert!(primeiro.is_empty());
    assert_eq!(api.hits(), 2, "as duas listas foram tentadas");
    assert_eq!(
        kv.remaining_seconds(MARCA_KEY, NOW).unwrap(),
        Some(24 * 3600),
        "marca com TTL do intervalo"
    );
    // Lista falha não grava coorte: nada respondeu.
    assert!(kv.get_json(COHORT_KEY, NOW).unwrap().is_none());

    let segundo = ciclo(&s, &kv, None, NOW + 60_000).await.unwrap();
    assert!(segundo.is_empty());
    assert_eq!(api.hits(), 2, "segundo ciclo dentro do cooldown: zero rede");
}

#[tokio::test]
async fn lista_que_falha_preserva_o_balde_anterior_da_coorte() {
    let api = Api::novo(
        Resposta::Erro(502),
        Resposta::Lista(json!([serie("tt0000009", 5000, "2020-01-01")])),
    );
    let base = subir(api.clone()).await;
    let kv = NativeKv::open_memory().unwrap();
    let previa = json!({"at": 1, "movies": ["tt0000001"], "series": ["tt0000002"]});
    kv.put_json(COHORT_KEY, &previa, 259_200, NOW).unwrap();

    let picks = ciclo(&ajustes(&base), &kv, None, NOW).await.unwrap();
    assert_eq!(
        picks,
        vec![Pick {
            imdb_id: "tt0000009".to_string(),
            media: HarvestMediaType::Series
        }]
    );
    let coorte = kv.get_json(COHORT_KEY, NOW).unwrap().expect("coorte");
    assert_eq!(coorte["movies"], json!(["tt0000001"]), "filmes preservados");
    assert_eq!(coorte["series"], json!(["tt0000009"]), "séries renovadas");
    assert!(coorte["at"].as_i64().unwrap() > 0);
    assert_eq!(
        kv.remaining_seconds(COHORT_KEY, NOW).unwrap(),
        Some(3 * 24 * 3600),
        "coorte com TTL de 3 intervalos"
    );
}

#[tokio::test]
async fn cap_limita_a_fila_mas_nao_a_coorte() {
    let filmes: Vec<Value> = (0..5)
        .map(|n| filme(&format!("tt00001{n}0"), 5000, "2020-01-01"))
        .collect();
    let api = Api::novo(Resposta::Lista(json!(filmes)), Resposta::Lista(json!([])));
    let base = subir(api.clone()).await;
    let kv = NativeKv::open_memory().unwrap();
    let s = SeedSettings {
        max_per_cycle: 2,
        ..ajustes(&base)
    };
    let picks = ciclo(&s, &kv, None, NOW).await.unwrap();
    assert_eq!(picks.len(), 2);
    assert_eq!(picks[0].imdb_id, "tt0000100");
    let coorte = kv.get_json(COHORT_KEY, NOW).unwrap().expect("coorte");
    assert_eq!(coorte["movies"].as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn obra_ja_indexada_nao_entra_na_fila() {
    let filmes = json!([
        filme("tt0000030", 5000, "2020-01-01"),
        filme("tt0000031", 5000, "2020-01-01"),
    ]);
    let api = Api::novo(Resposta::Lista(filmes), Resposta::Lista(json!([])));
    let base = subir(api).await;
    let kv = NativeKv::open_memory().unwrap();
    let indice: Arc<dyn ReleaseIndexSource> = Arc::new(Indexada);
    let picks = ciclo(&ajustes(&base), &kv, Some(indice.as_ref()), NOW)
        .await
        .unwrap();
    assert_eq!(
        picks.iter().map(|p| p.imdb_id.as_str()).collect::<Vec<_>>(),
        vec!["tt0000031"]
    );
}

#[tokio::test]
async fn headers_levam_a_chave_e_o_host_so_para_a_api() {
    let api = Api::novo(Resposta::Lista(json!([])), Resposta::Lista(json!([])));
    let base = subir(api.clone()).await;
    let kv = NativeKv::open_memory().unwrap();
    ciclo(&ajustes(&base), &kv, None, NOW).await.unwrap();
    let chaves: Vec<String> = api.chaves.lock().unwrap().clone();
    let hosts: Vec<String> = api.hosts.lock().unwrap().clone();
    assert_eq!(chaves, vec![CHAVE.to_string(), CHAVE.to_string()]);
    assert_eq!(hosts, vec![HOST.to_string(), HOST.to_string()]);
}

#[tokio::test]
async fn erro_de_lista_nunca_carrega_a_chave_nem_a_url() {
    let api = Api::novo(Resposta::Erro(401), Resposta::Lista(json!([])));
    let base = subir(api).await;
    let cliente = reqwest::Client::new();
    let erro = buscar_lista(&cliente, &ajustes(&base), "most-popular-movies")
        .await
        .unwrap_err();
    assert_eq!(erro, "http_401");

    // Conexão recusada: o erro de rede do reqwest não pode vazar URL nem chave.
    let fora = buscar_lista(&cliente, &ajustes("http://127.0.0.1:1"), "most-popular-tv")
        .await
        .unwrap_err();
    assert!(fora.starts_with("rede: "), "{fora}");
    assert!(!fora.contains(CHAVE));
    assert!(!fora.contains("127.0.0.1"));
}
