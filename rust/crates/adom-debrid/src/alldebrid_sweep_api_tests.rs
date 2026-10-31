use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::super::AllDebrid;
use crate::http::HttpClient;

const KEY: &str = "sweep-test-key";

#[derive(Clone)]
struct Scene {
    hits: Arc<Mutex<Vec<(String, String, bool)>>>,
    rows: Value,
    detail: Value,
}

async fn respond(State(scene): State<Scene>, request: Request<Body>) -> Response {
    let query = request.uri().query().unwrap_or("").to_string();
    let path = request.uri().path().to_string();
    let auth = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        == Some("Bearer sweep-test-key");
    scene
        .hits
        .lock()
        .unwrap()
        .push((path.clone(), query.clone(), auth));
    let data = if query.contains("id=") {
        scene.detail.clone()
    } else {
        scene.rows.clone()
    };
    let _ = request.into_body();
    (
        StatusCode::OK,
        json!({"status":"success","data":data}).to_string(),
    )
        .into_response()
}

async fn adapter(scene: Scene) -> AllDebrid {
    let app = Router::new().fallback(any(respond)).with_state(scene);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let lock = crate::test_env::lock();
    let previous = std::env::var("ALLDEBRID_API_BASE").ok();
    unsafe {
        std::env::set_var("ALLDEBRID_API_BASE", format!("http://{address}"));
    }
    let api = AllDebrid::new(HttpClient::new().unwrap());
    unsafe {
        match previous {
            Some(value) => std::env::set_var("ALLDEBRID_API_BASE", value),
            None => std::env::remove_var("ALLDEBRID_API_BASE"),
        }
    }
    drop(lock);
    api
}

#[tokio::test]
async fn lista_normaliza_campos_data_e_auth() {
    let scene = Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[
            {"id":12,"hash":"ABCDEF","status":"Ready","ready":false,"filename":"filme.mkv","size":42,"uploadDate":1700000000},
            {"id":"13","hash":"fedcba","status":"Downloading","uploadDate":"12"}
        ]}),
        detail: json!({}),
    };
    let hits = scene.hits.clone();
    let api = adapter(scene).await;
    let rows = api.sweep_magnet_list(KEY).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, "12");
    assert_eq!(rows[0].hash, "abcdef");
    assert!(rows[0].ready);
    assert_eq!(rows[0].filename, "filme.mkv");
    assert_eq!(rows[0].upload_date_ms, 1_700_000_000_000.0);
    assert!(!rows[1].ready);
    assert_eq!(rows[1].upload_date_ms, 12_000.0);
    let hits = hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0, "/magnet/status");
    assert!(hits[0].1.contains("agent=stremio-adom"));
    assert!(hits[0].2);
}

#[tokio::test]
async fn listagem_parcialmente_malformada_e_falha_nunca_lista_parcial() {
    // UMA linha boa + UMA sem id e UMA com hash vazio: foto POSSIVELMENTE
    // truncada da conta. Aceitá-la fundamentaria ausência não provada — a
    // poda cortaria o `adprot` de magnet presente e a fila `sup:` seria
    // curada por engano. Linhas inválidas NÃO são mais ignoradas.
    let scene = Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[
            {"id":12,"hash":"ABCDEF","status":"Ready","uploadDate":1700000000},
            {"id":14,"hash":""},
            {"hash":"sem-id"}
        ]}),
        detail: json!({}),
    };
    let api = adapter(scene).await;
    assert!(api.sweep_magnet_list(KEY).await.is_err());
    assert!(
        api.magnet_index(KEY).await.is_err(),
        "a evicção por hash herda o mesmo contrato"
    );
}

#[tokio::test]
async fn arquivos_sao_por_id_so_se_ready_e_achata_arvore_sem_link() {
    let scene = Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[]}),
        detail: json!({"magnets":[{"status":"rEaDy","files":[
            {"n":"Pasta","e":[{"n":"filme.mkv","s":123,"l":"https://segredo.invalid"}]},
            {"n":"leia-me.txt","s":4}
        ]}]}),
    };
    let hits = scene.hits.clone();
    let api = adapter(scene).await;
    let files = api.sweep_magnet_files(KEY, "42 &x").await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "Pasta/filme.mkv");
    assert_eq!(files[0].size, 123.0);
    let hits = hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].1.contains("id=42+%26x") || hits[0].1.contains("id=42%20%26x"));
    assert!(hits[0].2);
}

#[tokio::test]
async fn magnet_nao_pronto_nao_expoe_arquivos() {
    let api = adapter(Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({}),
        detail: json!({"magnets":{"status":"Downloading","files":[{"n":"x.mkv","s":9,"l":"x"}]}}),
    })
    .await;
    assert!(api.sweep_magnet_files(KEY, "7").await.unwrap().is_empty());
}

#[tokio::test]
async fn listagem_sem_magnets_e_falha_nunca_vazio_valido() {
    // Corpo 200/success SEM `magnets`: leitura que não aconteceu. Vazio
    // válido aqui podaria o `adprot` inteiro (poda) e curaria a fila `sup:`.
    let api = adapter(Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({}),
        detail: json!({}),
    })
    .await;
    let err = api
        .sweep_magnet_list(KEY)
        .await
        .expect_err("malformada é FALHA");
    assert!(err.to_string().contains("magnets"));
}

#[tokio::test]
async fn listagem_sem_linha_reconhecivel_e_falha() {
    // A lista veio, mas NENHUMA linha rendeu id/hash: não é "conta vazia",
    // é leitura que não produziu identidade.
    let api = adapter(Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[{"id":1},{"foo":"bar"}]}),
        detail: json!({}),
    })
    .await;
    assert!(api.sweep_magnet_list(KEY).await.is_err());
}

#[tokio::test]
async fn listagem_conta_vazia_provada_continua_valida() {
    // `magnets: []` é vazio PROVADO: é o único vazio válido.
    let api = adapter(Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[]}),
        detail: json!({}),
    })
    .await;
    assert!(api.sweep_magnet_list(KEY).await.unwrap().is_empty());
}

#[tokio::test]
async fn hashes_sem_magnets_e_falha_snapshot_vazio_nao_prova() {
    // `magnet_hashes` alimenta o snapshot `knownBefore`: vazio aqui diria
    // "tudo na conta é nosso" e tiraria o preexisting de TODA a conta.
    let api = adapter(Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({}),
        detail: json!({}),
    })
    .await;
    assert!(api.magnet_hashes(KEY).await.is_err());
}

#[tokio::test]
async fn hashes_sem_hash_reconhecivel_e_falha() {
    let api = adapter(Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[{"id":1,"status":"Ready"}]}),
        detail: json!({}),
    })
    .await;
    assert!(api.magnet_hashes(KEY).await.is_err());
}

#[tokio::test]
async fn hashes_parcialmente_malformados_sao_falha_snapshot_nao_mentira() {
    // `magnet_hashes` alimenta o snapshot `knownBefore`: lista com hash em
    // PARTE das linhas esconderia magnets reais do preexisting — e ausência
    // que não se provou destrava acervo do usuário.
    let api = adapter(Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[{"id":1,"hash":"aabb"},{"id":2,"status":"Ready"}]}),
        detail: json!({}),
    })
    .await;
    assert!(api.magnet_hashes(KEY).await.is_err());
}

#[tokio::test]
async fn hashes_de_conta_vazia_provada_continuam_validos() {
    let api = adapter(Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[]}),
        detail: json!({}),
    })
    .await;
    let hashes = api.magnet_hashes(KEY).await.unwrap();
    assert!(hashes.is_empty(), "vazio provado é prova");
}

#[tokio::test]
async fn lista_com_tamanho_devolve_size_e_mantem_a_regra_de_falha() {
    // O catálogo precisa de `size` (o TS `magnetList` o devolve). Mesma régua
    // da listagem comum: linha sem id/hash derruba a leitura inteira.
    let ok = Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[
            {"id":12,"hash":"ABCDEF","status":"Ready","filename":"filme.mkv","size":"42","uploadDate":1700000000},
            {"id":"13","hash":"fedcba","status":"Downloading","size":0}
        ]}),
        detail: json!({}),
    };
    let api = adapter(ok).await;
    let rows = api.sized_magnet_list(KEY).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].magnet.id, "12");
    assert_eq!(rows[0].magnet.hash, "abcdef");
    assert!(rows[0].magnet.ready, "status Ready conta como pronto");
    assert_eq!(rows[0].size, 42.0, "tamanho vindo como texto também conta");
    assert_eq!(rows[0].magnet.upload_date_ms, 1_700_000_000_000.0);
    assert_eq!(rows[1].size, 0.0);

    let malformada = Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[
            {"id":12,"hash":"ABCDEF","size":1},
            {"id":14,"hash":""}
        ]}),
        detail: json!({}),
    };
    let api = adapter(malformada).await;
    assert!(api.sized_magnet_list(KEY).await.is_err());
}
