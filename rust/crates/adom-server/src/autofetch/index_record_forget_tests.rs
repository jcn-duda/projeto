//! Esquecimento do registro do Chupim no índice (`Op::Forget`).
//!
//! O achado M2 era a AUSÊNCIA de chamador: `forget_autofetch_hash` existia desde
//! a leva do `adom-index` e ninguém chamava, então release morta continuava no
//! índice como `autofetch_seeded` por até 30 dias e ligava a via rápida da busca
//! (`orchestrator/native_index.rs:162-166`) para um hash que a conta não tem
//! mais. Aqui se prova a porta: enfileirar sem IMDb válido é no-op, e o efeito
//! apaga SÓ a linha do Chupim — observação pública do mesmo hash fica.

use std::sync::{Arc, Mutex};

use adom_core::WorkTarget;
use adom_index::{RecordOptions, ReleaseIndexStore};
use adom_sources::now_ms;
use serde_json::json;

use super::ops::Sink;
use super::{clear, forget, register, test_lock, Accepted, Op, Refuse, SOURCE};

/// Obra só destes testes.
const IMDB: &str = "tt9900077";
/// Hash que vira `source:'autofetch'` e deve ser esquecido.
const DO_CHUPIM: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
/// Mesmo hash, mas a linha foi PROMOVIDA por observação pública depois.
const PROMOVIDA: &str = "ccccccccccccccccccccccccccccccccccccccc3";

/// Obra na chave RAIZ (`idx:v14:tt…`): é onde o `record` sem temporada grava.
fn at_root() -> WorkTarget {
    WorkTarget {
        season: None,
        episode: None,
    }
}

fn accepted(info_hash: &str) -> Accepted {
    Accepted {
        imdb_id: IMDB.to_string(),
        info_hash: info_hash.to_string(),
        title: "Titulo de Teste DUBLADO".to_string(),
        size: Some(3_000_000_000),
        indexer: "torrentdosfilmes".to_string(),
        is_br: true,
        dubbed: true,
        lied: false,
        quality: Some("1080p".to_string()),
        seeders: Some(40),
        season: None,
        episode: None,
    }
}

/// Sink de teste que GUARDA a operação e a aplica no store, como o `write_loop`
/// (uma conexão, `Keep` → `record`, `Forget` → `forget_autofetch_hash`).
fn capturing(store: &Arc<ReleaseIndexStore>, seen: &Arc<Mutex<Vec<Op>>>, now: i64) -> Sink {
    let store = Arc::clone(store);
    let seen = Arc::clone(seen);
    Arc::new(move |op| {
        seen.lock().unwrap().push(op.clone());
        match op {
            Op::Keep(aceite) => super::record(&store, &aceite, now).map_err(|_| Refuse::Closed),
            Op::Forget { imdb_id, hash } => store
                .forget_autofetch_hash(&imdb_id, &hash, now)
                .map_err(|_| Refuse::Closed),
        }
    })
}

/// Duas linhas na obra, `PROMOVIDA` com o MESMO hash visto também pelo colhedor
/// (a observação pública promove a linha: `source` sai, `seenAt` avança). O
/// esquecimento do Chupim tira a primeira e PRESERVA a segunda — apagar prova
/// pública porque um hash do Chupim morreu seria vazar evidência.
#[tokio::test]
async fn forget_apaga_so_a_linha_do_chupim() {
    let _serial = test_lock().await;
    let now = now_ms();
    let store = Arc::new(ReleaseIndexStore::open_memory().unwrap());
    let ops = Arc::new(Mutex::new(Vec::new()));
    register(capturing(&store, &ops, now));

    let sink = super::sink().expect("sink registrado");
    sink(Op::Keep(accepted(DO_CHUPIM))).unwrap();
    sink(Op::Keep(accepted(PROMOVIDA))).unwrap();
    // Colhedor vê a segunda: linha deixa de ser `source:'autofetch'`.
    store
        .record(
            IMDB,
            WorkTarget {
                season: None,
                episode: None,
            },
            &[json!({
                "title": "Titulo de Teste DUBLADO",
                "infoHash": PROMOVIDA,
                "_seeders": 30,
            })],
            RecordOptions::default(),
            store.ttl(),
            store.max_releases(),
            now + 1,
            None,
        )
        .unwrap();

    forget(Some(IMDB), DO_CHUPIM);
    forget(Some(IMDB), PROMOVIDA);
    clear();

    // Só as operações DESTA obra: o sink é do processo e outros testes rodando em
    // paralelo podem enfileirar as suas neste mesmo registro.
    let nossas: Vec<(String, String)> = ops
        .lock()
        .unwrap()
        .iter()
        .filter_map(|op| match op {
            Op::Forget { imdb_id, hash } if imdb_id == IMDB => {
                Some((imdb_id.clone(), hash.clone()))
            }
            _ => None,
        })
        .collect();
    // O esquecimento leva a OBRA do hint: sem o IMDb o escritor não acha a chave
    // `idx:v14:<imdb>` para apagar.
    assert_eq!(
        nossas,
        vec![
            (IMDB.to_string(), DO_CHUPIM.to_string()),
            (IMDB.to_string(), PROMOVIDA.to_string()),
        ],
        "um esquecimento por hash, na ordem em que saíram"
    );

    let found = store.lookup(IMDB, at_root(), now + 2);
    assert_eq!(found.len(), 1, "só a linha pública ficou: {}", found.len());
    assert_eq!(found[0].hash, PROMOVIDA);
    assert_eq!(found[0].source, None, "observação pública preservada");
}

/// Fiel ao TS: `forgetAutofetchHash(undefined, h)` não apagava nada. Sem IMDb
/// `^tt\d+$` (ou sem hash) o esquecimento é NO-OP — nem entra na fila do
/// escritor, porque `forget_autofetch_hash` recusaria lá de qualquer forma
/// (`adom-index/src/release_index_prova_works.rs:84-93`).
#[tokio::test]
async fn forget_sem_imdb_valido_nao_enfileira() {
    let _serial = test_lock().await;
    let now = now_ms();
    let store = Arc::new(ReleaseIndexStore::open_memory().unwrap());
    let ops = Arc::new(Mutex::new(Vec::new()));
    register(capturing(&store, &ops, now));

    forget(None, DO_CHUPIM);
    forget(Some(""), DO_CHUPIM);
    forget(Some("tt"), DO_CHUPIM);
    forget(Some("tt12a3"), DO_CHUPIM);
    forget(Some("nm0000123"), DO_CHUPIM);
    forget(Some(IMDB), "");
    forget(Some(IMDB), "   ");
    clear();

    // Só o hash DESTE teste: outros testes enfileiram no mesmo sink do processo.
    let ruido: Vec<String> = ops
        .lock()
        .unwrap()
        .iter()
        .filter_map(|op| match op {
            Op::Forget { hash, .. } if hash == DO_CHUPIM => Some(hash.clone()),
            _ => None,
        })
        .collect();
    assert!(
        ruido.is_empty(),
        "no-op não enfileira operação nenhuma: {ruido:?}"
    );
}

/// `CACHE_PERSIST`: só `false` (trim + case-insensitive) desliga — a MESMA régua
/// do leitor (`adom-index/src/release_index.rs:29-33,198-204`). Escritor e
/// leitor não podem divergir: escritor em disco + leitor em memória gravaria num
/// arquivo que ninguém lê.
#[test]
fn cache_persist_false_leva_o_escritor_para_memoria() {
    for (raw, want) in [
        (None, true),
        (Some("true"), true),
        (Some("1"), true),
        (Some("0"), true),
        (Some("false"), false),
        (Some(" FALSE "), false),
        (Some("False"), false),
    ] {
        assert_eq!(
            super::ops::persist_enabled(raw),
            want,
            "CACHE_PERSIST={raw:?}"
        );
    }
}

/// Sanidade da fixture: o `source` gravado pelo aceite é o do Chupim (a régua
/// acima só vale se a linha a apagar for mesmo `autofetch`).
#[test]
fn aceite_grava_a_fonte_que_o_esquecimento_procura() {
    let now = now_ms();
    let store = ReleaseIndexStore::open_memory().unwrap();
    super::record(&store, &accepted(DO_CHUPIM), now).unwrap();
    let found = store.lookup(IMDB, at_root(), now);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].source.as_deref(), Some(SOURCE));
}
