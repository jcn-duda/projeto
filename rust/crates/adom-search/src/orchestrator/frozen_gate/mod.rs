//! Gate de paridade CONGELADA do `/stream` (Fase 1, `docs/stream-frozen-gate.md`).
//!
//! Lê `rust/golden/stream-frozen/<caso>/` e monta o orquestrador REAL com as
//! rotas internas substituídas pela captura: `FrozenRoutes` (meta/collect) e
//! `FrozenDebridFactory` (veredito de cache por hash). O índice e o banco são
//! NATIVOS desde o R4 (não há mais rota Node): o lote do `inputs/index.json` é
//! entregue VERBATIM à via rápida (`with_frozen_fast_path`), com as anotações
//! de prova que o build do Node aplicou. Nenhuma rede, nenhum SQLite, nenhum
//! relógio de parede.
//!
//! O alvo é `expected/node-response.json`, produzido pelo Node a partir das
//! MESMAS entradas. Diferença aqui é divergência de pipeline; ruído de coleta
//! ficou de fora por construção.

mod annotate;
mod annotate_sources;
mod audio;
mod capture;
mod case;
mod case_config;
mod case_views;
mod compare;
mod debrid;
mod helpers;
mod replay;
mod routes;

#[cfg(test)]
#[path = "../frozen_gate_tests.rs"]
mod tests;

use std::path::{Path, PathBuf};

use serde_json::Value;

use case::FrozenCase;
use compare::{compare, compare_streams};
use helpers::read_json;
use replay::replay;

// ── porta pública do gate ───────────────────────────────────────────────────
//
// O módulo é exposto (`orchestrator::frozen_gate`) porque o alvo de integração
// `tests/stream_frozen_parity.rs` — o comando do gate — chama de fora do crate;
// `cfg(test)`/feature flag não servem (o comando é sem features e o alvo de
// integração é outro crate). A montagem segue privada: só estas três funções
// são públicas.

/// Raiz da captura: `rust/golden/stream-frozen` (mesma âncora de
/// `tests/stream_e2e_parity.rs`).
pub fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden/stream-frozen")
}

/// Casos do gate: diretórios com `request.json`, em ordem estável.
///
/// Não existe caminho "sem captura": raiz ausente ou vazia é ERRO. O teste
/// inline antigo retornava cedo quando o diretório faltava, o que deixava o
/// gate verde sem ter comparado nada — justamente o que o alvo novo não pode
/// fazer.
pub fn case_dirs() -> Result<Vec<PathBuf>, String> {
    let root = corpus_root();
    if !root.is_dir() {
        return Err(format!(
            "captura congelada ausente: {} não existe (o gate exige <caso>/request.json)",
            root.display()
        ));
    }
    let mut cases: Vec<PathBuf> = std::fs::read_dir(&root)
        .map_err(|err| format!("ler {}: {err}", root.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("request.json").is_file())
        .collect();
    cases.sort();
    if cases.is_empty() {
        return Err(format!(
            "captura congelada vazia: nenhum <caso>/request.json em {}",
            root.display()
        ));
    }
    Ok(cases)
}

/// Roda TODOS os casos e devolve, de uma vez, o diff legível de cada falha.
pub async fn run_all() -> Result<(), String> {
    let cases = case_dirs()?;
    let mut failures = Vec::new();
    for dir in cases {
        if let Err(err) = run_case(&dir).await {
            failures.push(format!("{}: {err}", dir.display()));
        }
    }
    if failures.is_empty() {
        return Ok(());
    }
    Err(format!(
        "paridade congelada falhou em {} caso(s):\n\n{}",
        failures.len(),
        failures.join("\n\n")
    ))
}

/// Origem sintética do corpus do gate (os dois lados são mascarados).
const FROZEN_ORIGIN: &str = "http://127.0.0.1:7200";
/// Relógio fixo do replay do corpus: a captura inteira foi feita neste instante.
const FROZEN_NOW_MS: i64 = 1_760_000_000_000;

async fn run_case(dir: &Path) -> Result<(), String> {
    let frozen = FrozenCase::load(dir)?;
    let encoded = if frozen.request.encoded_len == 0 {
        None
    } else {
        Some("e30".to_string())
    };
    let got = replay(frozen, FROZEN_ORIGIN, encoded.clone(), Some(FROZEN_NOW_MS)).await?;
    let expected: Value = read_json(&dir.join("expected/node-response.json"))?;
    compare(
        &got,
        &expected,
        FROZEN_ORIGIN,
        encoded.as_deref().unwrap_or(""),
    )?;
    // Evidência do que foi comparado: sucesso silencioso esconderia um gate que
    // não olhou nada (o defeito do teste inline que este alvo substituiu).
    println!(
        "[frozen] {}: {} stream(s), cacheMaxAge={} — igual ao Node",
        dir.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        got.get("streams")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        got.get("cacheMaxAge").cloned().unwrap_or(Value::Null),
    );
    Ok(())
}

/// Replay da MESMA montagem do gate, mas contra o corpo que o Node devolveu ao
/// vivo e só pela lista de `streams`.
///
/// Usado pela sombra (`adom-server::shadow`): o Node grava
/// `<base>/<id>/{request,inputs,expected,manifest}` para ESTA requisição e o
/// `expected` aqui é o **corpo normal** que ele respondeu (não o
/// `expected/node-response.json`, que é o envelope mascarado do corpus).
///
/// - relógio de PAREDE (`now_ms: None`): o corpo do Node acabou de ser gerado
///   para a mesma requisição; congelar o relógio mudaria a janela de
///   estreia/pré-air de conteúdo recém-lançado e criaria divergência falsa.
/// - `origin`/`encoded` mascarados nos DOIS lados (host e segmento de config
///   não entram no diff) e também usados na montagem das URLs.
/// - só `streams` é comparado: `cacheMaxAge`/`stale*` do caminho normal podem
///   diferir do replay congelado (o store da sombra é outro e o debrid é
///   congelado) e não dizem nada sobre o pipeline. No gate (`run_case`) o
///   envelope inteiro continua sendo comparado.
///
/// `Err` traz o diff legível; uma linha iniciada por `#` por item divergente é
/// o formato que a sombra conta em `stream.shadow.divergence.items`.
pub async fn run_case_with_expected(
    dir: &Path,
    expected: &Value,
    origin: &str,
    encoded: &str,
) -> Result<(), String> {
    let got = replay_case_value(dir, origin, encoded).await?;
    match compare_streams(&got, expected, origin, encoded) {
        Ok(()) => Ok(()),
        Err(first) => {
            // `instant.json` é a última escrita do record; em caso de ordem
            // divergente, tenta a leitura sem ele (1ª resposta). Só aceita se
            // o corpo INTEIRO bater — não muda o resultado de quem já falha
            // por conteúdo.
            let frozen = FrozenCase::load(dir)?;
            let mut frozen = frozen;
            frozen.instant.clear();
            let encoded = match encoded.trim() {
                "" => None,
                segment => Some(segment.to_string()),
            };
            let without = replay(frozen, origin, encoded.clone(), None).await?;
            if compare_streams(&without, expected, origin, encoded.as_deref().unwrap_or("")).is_ok()
            {
                Ok(())
            } else {
                Err(first)
            }
        }
    }
}

/// Diagnóstico (host): devolve o corpo do replay da MESMA montagem da sombra.
/// Usado pelo harness `examples/shadow_replay` para classificar divergências.
pub async fn replay_case_value(dir: &Path, origin: &str, encoded: &str) -> Result<Value, String> {
    let frozen = FrozenCase::load(dir)?;
    let encoded = match encoded.trim() {
        "" => None,
        segment => Some(segment.to_string()),
    };
    replay(frozen, origin, encoded, None).await
}
