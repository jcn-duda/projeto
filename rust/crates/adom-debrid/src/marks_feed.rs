//! Posse (`adsub:v1`) da checagem NATIVA da AllDebrid, gravada direto no KV
//! nativo (`adom_index::NativeKv`, a tabela `cache` do `data/cache.db`).
//!
//! A checagem da AllDebrid é um `/magnet/upload` real e, com
//! `DEBRID_AL_CLEANUP=on` + `holds_complete` + inventário, a limpeza apaga pela
//! fila com backoff (`alldebrid_delete`). Quem sabe o que SUBIU de verdade é
//! este lado; sem a posse gravada, o snapshot seguinte classifica o magnet que a
//! checagem subiu como "do usuário" (imune à limpeza).
//!
//! Por que direto e não por rota HTTP ao Node: a rota `/internal/debrid/marked`
//! deixou de existir, e o `cache.db` já é compartilhado pelo SQLite (WAL) com
//! o mesmo schema. Gravar aqui evita um salto de rede por lote e tira do Node a
//! única escrita de `adsub` que não era dele de fato.
//!
//! Só a posse é gravada. NÃO há canal de remoção: a limpeza nativa é só a
//! HIGIENE da checagem, e o anti-reenchimento (`adrm:v1`) é para decisão sobre
//! o conteúdo. Marcar a higiene como `adrm` bloqueava por 3 dias todo candidato
//! fora do cache e o Chupim parava de baixar (2026-10-24).
//!
//! Fail-open de ponta a ponta: a gravação roda em `spawn_blocking`, fora do
//! prazo da resposta do `/stream`; falha só loga, e a busca nunca espera o disco.
//!
//! Gate: `DEBRID_AL_CLEANUP=on` (sem a limpeza ligada nada é gravado) e
//! `ALLDEBRID_SUBMITTED_TTL_MS > 0` (TTL 0 desliga a posse na origem, a mesma
//! régua de `ownership_enabled` dos leitores).

use std::collections::HashSet;

use adom_index::kv::KvWrite;
use adom_index::NativeKv;
use serde_json::json;

use crate::alldebrid_cleanup::{account_scope, adsub_key, CleanupMode, SUBMITTED_TTL_ENV};
// KV de produção é compartilhado com `file_sizes` (um só arquivo, uma conexão).
use crate::native_kv::production_kv;
// Re-export só para os testes do spawn (`alldebrid_marks_tests.rs`).
#[cfg(test)]
pub(crate) use crate::native_kv::test_kv;

/// `ALLDEBRID_SUBMITTED_TTL_MS` default: 7 dias (o mesmo do Node).
const DEFAULT_SUBMITTED_TTL_MS: f64 = 604_800_000.0;

/// Lote de posse de UMA conta. `api_key` é a identidade da conta: entra só para
/// virar o escopo (`sha256`) da chave; nunca é gravado nem logado em claro.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarkedBatch {
    pub api_key: String,
    pub submitted: Vec<String>,
}

impl MarkedBatch {
    pub fn is_empty(&self) -> bool {
        self.submitted.is_empty()
    }
}

/// Hash válido = 40 caracteres hexadecimais (já em minúsculas).
fn is_info_hash(hash: &str) -> bool {
    hash.len() == 40 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Grava `adsub:v1:<conta>:<hash>` com valor `{"at": now_ms}` para cada hash
/// válido e único do lote, numa ÚNICA transação. Devolve quantos gravou.
///
/// Hash é normalizado (trim + minúsculas) antes da chave, porque os leitores
/// (`adsub_key`) já comparam em minúsculas. Inválido e duplicado são ignorados
/// sem erro: o lote vem de uma checagem e um hash ruim não pode derrubar o resto.
/// `ttl_seconds <= 0` não grava nada (posse desligada).
pub(crate) fn write_marks(
    kv: &NativeKv,
    batch: &MarkedBatch,
    ttl_seconds: i64,
    now_ms: i64,
) -> Result<usize, String> {
    if ttl_seconds <= 0 {
        return Ok(0);
    }
    let account = account_scope(&batch.api_key);
    let mut seen = HashSet::new();
    let keys: Vec<String> = batch
        .submitted
        .iter()
        .map(|raw| raw.trim().to_lowercase())
        .filter(|hash| is_info_hash(hash))
        .filter(|hash| seen.insert(hash.clone()))
        .map(|hash| adsub_key(&account, &hash))
        .collect();
    if keys.is_empty() {
        return Ok(0);
    }
    let value = json!({ "at": now_ms });
    let writes: Vec<KvWrite<'_>> = keys
        .iter()
        .map(|key| KvWrite {
            key,
            value: &value,
            ttl_seconds,
            now_ms,
            only_if_absent: false,
        })
        .collect();
    // Uma transação só: ou o lote inteiro entra ou nenhuma posse do lote entra.
    kv.put_many_json_and_forget(&writes, &[])?;
    Ok(writes.len())
}

/// Régua do TTL da posse, pura (sem env): mesma de `submitted_ttl_ms_from` do
/// Node. Ausente = 7 dias; vazio/`0`/negativo = desligado (0); lixo cai no
/// default. Devolve segundos (piso de ms/1000).
pub(crate) fn parse_ttl_seconds(raw: Option<&str>) -> i64 {
    let ms = match raw {
        None => DEFAULT_SUBMITTED_TTL_MS,
        // `Number('')` é 0 no Node: vazio desliga a posse.
        Some(text) if text.trim().is_empty() => 0.0,
        Some(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .unwrap_or(DEFAULT_SUBMITTED_TTL_MS),
    };
    (ms.max(0.0) / 1_000.0).floor() as i64
}

fn ttl_seconds_from_env() -> i64 {
    parse_ttl_seconds(std::env::var(SUBMITTED_TTL_ENV).ok().as_deref())
}

/// Grava a posse do lote agora (no thread atual). Chamado só de `spawn`.
fn grava(batch: &MarkedBatch) {
    let ttl = ttl_seconds_from_env();
    if ttl <= 0 {
        return;
    }
    let Some(kv) = production_kv() else {
        return;
    };
    let now = crate::error::now_ms() as i64;
    if let Err(err) = write_marks(kv, batch, ttl, now) {
        eprintln!(
            "[alldebrid] posse nativa não gravada ({} subiu): {err}",
            batch.submitted.len()
        );
    }
}

/// Dispara a gravação da posse em fundo. Sem a limpeza ligada não faz nada.
/// Com runtime, roda em `spawn_blocking` (o SQLite é síncrono); sem runtime,
/// grava direto no thread atual.
pub fn spawn(batch: MarkedBatch) {
    if batch.is_empty() || !CleanupMode::from_env().is_on() {
        return;
    }
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn_blocking(move || grava(&batch));
        }
        Err(_) => grava(&batch),
    }
}

#[cfg(test)]
#[path = "marks_feed_tests.rs"]
mod marks_feed_tests;
