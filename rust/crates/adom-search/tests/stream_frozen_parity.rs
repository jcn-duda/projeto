//! Gate de paridade CONGELADA do `/stream` — alvo de integração.
//!
//! Comando exigido (`docs/stream-frozen-gate.md`):
//!
//! ```text
//! cargo test -p adom-search --test stream_frozen_parity
//! ```
//!
//! A montagem (rotas congeladas + debrid congelado + orquestrador real) mora em
//! `adom_search::orchestrator::frozen_gate`, exposto com `#[doc(hidden)]` para
//! este alvo — sem feature flag, porque o comando do gate não passa
//! `--features`.
//!
//! Contrato deste teste, ao contrário do `#[tokio::test]` inline que ele
//! substitui:
//!
//! 1. acha `CARGO_MANIFEST_DIR/../../golden/stream-frozen`;
//! 2. lista os casos com `request.json` e FALHA se a captura não existir ou
//!    estiver vazia (o inline dava `return` cedo e o gate passava em branco);
//! 3. roda TODOS os casos e falha com o diff legível (total got/want,
//!    primeiro stream divergente, `cacheMaxAge`), nunca só o primeiro erro.

use adom_search::orchestrator::frozen_gate;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn frozen_case_matches_node() {
    let root = frozen_gate::corpus_root();
    let cases = match frozen_gate::case_dirs() {
        Ok(cases) => cases,
        // Captura ausente/vazia é falha do gate, não "nada a comparar".
        Err(err) => panic!("[frozen] {err}"),
    };
    assert!(
        !cases.is_empty(),
        "[frozen] captura congelada vazia em {}",
        root.display()
    );
    let names: Vec<String> = cases
        .iter()
        .filter_map(|dir| dir.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .collect();
    println!(
        "[frozen] {} caso(s) em {}: {}",
        names.len(),
        root.display(),
        names.join(", ")
    );

    if let Err(diff) = frozen_gate::run_all().await {
        panic!("[frozen] {diff}");
    }
}
