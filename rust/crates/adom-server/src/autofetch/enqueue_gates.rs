//! Leitura dos gates vivos usados ao enfileirar (espelho de `autofetch-live` e
//! `autofetch-gates.ts`). O orçamento fica no prefixo já reservado ao worker.
//!
//! Duas leituras do KV moram aqui porque são FATO do enfileiramento, não
//! decisão: o gate do pool global (`autoFetchAnyDubbed`) e o anti-reenchimento
//! `adrm:v1` — este SÓ de leitura, a marca é do fluxo de evicção do Node.

use std::collections::HashSet;

use adom_autofetch::v3::sha256_hex;
use adom_debrid::alldebrid_cleanup::{adrm_key, reupload_block_enabled};
use adom_index::NativeKv;
use serde_json::{json, Value};

const LIVE_CONFIG_KEY: &str = "cfg:v1:autofetch";
const BUDGET_PREFIX: &str = "autofetch-worker:v1:budget:";
const HOUR_MS: i64 = 60 * 60 * 1000;
/// Nome do pool global dublado no Node (`src/config/debrid.ts:210`).
const ANY_ENV: &str = "DEBRID_AUTO_FETCH_ANY";
/// Alias histórico deste laço: só decide quando `ANY_ENV` está ausente.
const ANY_DUBBED_ENV: &str = "DEBRID_AUTO_FETCH_ANY_DUBBED";

#[derive(Clone, Copy, Debug)]
pub(in crate::autofetch) struct LivePolicy {
    pub(in crate::autofetch) max_attempts: i64,
    pub(in crate::autofetch) top_seeds_max: i64,
    pub(in crate::autofetch) top_seeds_enabled: bool,
    pub(in crate::autofetch) any_dubbed_enabled: bool,
    pub(in crate::autofetch) queue_enabled: bool,
    pub(in crate::autofetch) queue_depth: usize,
    pub(in crate::autofetch) hourly_limit: usize,
    pub(in crate::autofetch) pause_at: u64,
    /// `autoFetchRareMax` (`DEBRID_AUTO_FETCH_RARE_MAX`, default `4`) — teto do
    /// pool `seeds` no regime RARO. Régua de `src/config/debrid-autofetch-seeds.ts:27`
    /// (`Math.min(6, Math.max(1, Math.trunc(num(env, 4))))`) com o clamp do
    /// overlay ao vivo (`utils/autofetch-live.ts:113`).
    pub(in crate::autofetch) rare_max: i64,
    /// `autoFetchTtl` (`DEBRID_AUTO_FETCH_TTL`, default `6h`) — JANELA deslizante
    /// do registro por obra (`src/config/debrid.ts:208` + o `Math.max(0, n)` do
    /// overlay em `utils/autofetch-live.ts:130`). É o TTL do registro que a
    /// reserva grava no aceite (`commitObra` → `cache.set(key, …, autoFetchTtl)`,
    /// `src/providers/autofetch-obra.ts:352`).
    pub(in crate::autofetch) obra_ttl_seconds: i64,
    /// `autoFetchSeasonFill` (`DEBRID_AUTO_FETCH_SEASON_FILL`, default ligado) —
    /// entra na IDENTIDADE da obra: com ele ligado um pack de temporada conta a
    /// vaga da TEMPORADA, não a do episódio
    /// (`src/providers/autofetch-runner.ts:67`).
    pub(in crate::autofetch) season_fill: bool,
}

impl LivePolicy {
    pub(in crate::autofetch) fn load(
        kv: &NativeKv,
        adapter: &str,
        now_ms: i64,
    ) -> Result<Self, String> {
        let live = kv.get_json(LIVE_CONFIG_KEY, now_ms)?;
        let number = |key: &str, env: &str, fallback: i64| {
            live.as_ref()
                .and_then(|value| value.get(key))
                .and_then(Value::as_i64)
                .or_else(|| std::env::var(env).ok()?.trim().parse::<i64>().ok())
                .unwrap_or(fallback)
        };
        // Boletim do painel (`cfg:v1:autofetch`) vence o `.env` nos DOIS lados;
        // no `.env` a régua é a do Node (`env_js_true`), não `== "true"` seco:
        // `KEY=` (vazia) cai no default ligado, como o `|| 'true'` do TS.
        let boolean = |key: &str, env: &str, fallback: bool| {
            live.as_ref()
                .and_then(|value| value.get(key))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    std::env::var(env)
                        .ok()
                        .map_or(fallback, |raw| env_js_true(Some(raw.as_str())))
                })
        };
        let any_dubbed = live
            .as_ref()
            .and_then(|value| value.get("autoFetchAnyDubbed"))
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                any_dubbed_from(
                    std::env::var(ANY_ENV).ok().as_deref(),
                    std::env::var(ANY_DUBBED_ENV).ok().as_deref(),
                )
            });
        let max_attempts = number("autoFetchMax", "DEBRID_AUTO_FETCH_MAX", 3).clamp(1, 12);
        let top_seeds_max =
            number("autoFetchTopSeedsMax", "DEBRID_AUTO_FETCH_TOP_SEEDS_MAX", 2).clamp(1, 4);
        // Mesmo par default/clamp do TS para o regime raro e para a janela do
        // teto por obra: sem eles o `reserve` do crate usaria 4 e 6h fixos.
        let rare_max = number("autoFetchRareMax", "DEBRID_AUTO_FETCH_RARE_MAX", 4).clamp(1, 6);
        let obra_ttl_seconds = number("autoFetchTtl", "DEBRID_AUTO_FETCH_TTL", 21_600).max(0);
        let queue_depth = if boolean("autoFetchQueue", "DEBRID_AUTO_FETCH_QUEUE", true) {
            number("autoFetchQueueDepth", "DEBRID_AUTO_FETCH_QUEUE_DEPTH", 6).clamp(0, 12) as usize
        } else {
            0
        };
        // TorBox tem limite próprio no adaptador TS; os outros usam a régua
        // global, que também pode receber override do painel.
        let default_hourly = 50;
        let configured_hourly = number(
            "autoFetchEnqueueMaxHour",
            "DEBRID_AUTO_FETCH_ENQUEUE_MAX_HOUR",
            default_hourly,
        )
        .max(1) as usize;
        let hourly_limit = if adapter == "torbox" {
            50
        } else {
            configured_hourly
        };
        let pause_at =
            number("autoFetchPauseAt", "DEBRID_AUTO_FETCH_PAUSE_AT", 2_000).max(0) as u64;
        Ok(Self {
            max_attempts,
            top_seeds_max,
            top_seeds_enabled: boolean("autoFetchTopSeeds", "DEBRID_AUTO_FETCH_TOP_SEEDS", true),
            any_dubbed_enabled: any_dubbed,
            queue_enabled: queue_depth > 0,
            queue_depth,
            hourly_limit,
            pause_at,
            rare_max,
            obra_ttl_seconds,
            season_fill: boolean("autoFetchSeasonFill", "DEBRID_AUTO_FETCH_SEASON_FILL", true),
        })
    }
}

/// `String(process.env.X || 'true') === 'true'` do TS: ausente OU vazia cai no
/// default LIGADO e só o literal `true` liga. O TS não faz `trim` nem
/// `toLowerCase` — `" true "`, `TRUE`, `on`, `1` e `yes` DESLIGAM nos dois lados.
fn env_js_true(raw: Option<&str>) -> bool {
    match raw {
        None | Some("") => true,
        Some(text) => text == "true",
    }
}

/// Pool global (dublado fora do BR) com as DUAS chaves. PRECEDÊNCIA:
/// `DEBRID_AUTO_FETCH_ANY` (o nome do Node) vence sempre que EXISTE — inclusive
/// vazia, que o `|| 'true'` do TS resolve como ligado; o alias
/// `DEBRID_AUTO_FETCH_ANY_DUBBED` só decide quando `_ANY` está ausente, então um
/// `.env` antigo com `_ANY_DUBBED=false` continua desligando o pool.
fn any_dubbed_from(any: Option<&str>, alias: Option<&str>) -> bool {
    match any {
        Some(raw) => env_js_true(Some(raw)),
        None => env_js_true(alias),
    }
}

/// O anti-reenchimento está ligado? `enabled()` do Node
/// (`alldebrid-reupload.ts:52`): `DEBRID_REUPLOAD_BLOCK` **e**
/// `ALLDEBRID_REUPLOAD_BLOCK_TTL_MS > 0`. A régua mora no `adom-debrid` (a
/// mesma que a checagem nativa usa) para os dois lados de um `.env` só.
fn adrm_enabled() -> bool {
    reupload_block_enabled()
}

/// Hashes do lote com `adrm:v1` VIVO nesta conta — o `reuploadBlocked` do Node
/// (`alldebrid-reupload.ts:61`): hash que a evicção apagou DE PROPÓSITO e que
/// não pode voltar ao `/magnet/upload`. Sai dos candidatos ANTES dos pools ou o
/// Chupim para nele a cada busca (Lanterns S01E08, 2026-10-24).
///
/// Rótulo do skip: `adrm` (o `CascadeDrop::Adrm` da cascata), par do contador
/// `autofetch.reupload-blocked-skipped` do Node — que também não tem `noteSkip`
/// nesse caminho (`autofetch-candidates.ts:112`).
///
/// O `kv` do worker É o `cache.db` (`boot.rs`), o mesmo arquivo onde o Node
/// grava: `account` é o sufixo do escopo do cofre (`adapter:account`), a mesma
/// conta que `suppressed_step` usa para ler `adrm:v1` — não há KV paralelo.
///
/// Porta SÓ DE LEITURA: quem MARCA é a evicção (`markReuploadBlocked`); este
/// worker nunca grava, renova nem apaga a marca. Kill-switch/TTL desligados
/// devolvem vazio sem tocar no KV.
///
/// Erro de leitura NÃO vira "não bloqueado": o lote inteiro sai com `Err` (como
/// as outras leituras do `run`), senão um banco ilegível autorizaria justamente
/// o re-upload que a marca existe para barrar.
pub(in crate::autofetch) fn adrm_blocked(
    kv: &NativeKv,
    account: &str,
    hashes: &[String],
    now_ms: i64,
) -> Result<HashSet<String>, String> {
    adrm_blocked_when(kv, account, hashes, now_ms, adrm_enabled())
}

/// Miolo com a flag explícita — testes sem env global.
fn adrm_blocked_when(
    kv: &NativeKv,
    account: &str,
    hashes: &[String],
    now_ms: i64,
    enabled: bool,
) -> Result<HashSet<String>, String> {
    if !enabled || account.trim().is_empty() {
        return Ok(HashSet::new());
    }
    let mut blocked = HashSet::new();
    for hash in hashes {
        // O `get_json` só apaga o que JÁ venceu (faxina do KV, não marcação).
        if !hash.trim().is_empty() && kv.get_json(&adrm_key(account, hash), now_ms)?.is_some() {
            blocked.insert(hash.to_ascii_lowercase());
        }
    }
    Ok(blocked)
}

pub(in crate::autofetch) fn account_is_blocked(used: Option<u64>, pause_at: u64) -> bool {
    pause_at > 0 && used.is_some_and(|count| count >= pause_at)
}

fn budget_key(adapter: &str, account: &str) -> String {
    // O escopo já é digestado; hash novamente evita que delimitadores ou
    // conteúdo externo alterem o prefixo administrativo.
    format!(
        "{BUDGET_PREFIX}{}",
        sha256_hex(&format!("{adapter}:{account}"))
    )
}

fn read_timestamps(kv: &NativeKv, key: &str, now_ms: i64) -> Result<Vec<i64>, String> {
    let Some(value) = kv.get_json(key, now_ms)? else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_array() else {
        return Ok(Vec::new());
    };
    Ok(values
        .iter()
        .filter_map(Value::as_i64)
        .filter(|at| *at > now_ms.saturating_sub(HOUR_MS))
        .collect())
}

pub(in crate::autofetch) fn budget_count(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    now_ms: i64,
) -> Result<usize, String> {
    read_timestamps(kv, &budget_key(adapter, account), now_ms).map(|items| items.len())
}

/// Reserva uma chamada antes do HTTP, como `checkAndRecordBudget` no TS. A
/// falha/recusa do serviço consome cota; orçamento esgotado não consome nada.
pub(in crate::autofetch) fn reserve_budget(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    limit: usize,
    now_ms: i64,
) -> Result<bool, String> {
    let key = budget_key(adapter, account);
    let mut timestamps = read_timestamps(kv, &key, now_ms)?;
    if timestamps.len() >= limit {
        return Ok(false);
    }
    timestamps.push(now_ms);
    kv.put_json(&key, &json!(timestamps), 3_600, now_ms)?;
    Ok(true)
}

#[cfg(test)]
#[path = "enqueue_gates_tests.rs"]
mod tests;
