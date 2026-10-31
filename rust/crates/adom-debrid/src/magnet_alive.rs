//! Marca `alive` do magnetdb a partir da checagem nativa (gap D4).
//!
//! O play prova o hash vivo e grava `mag:v1:alive:<serviço>:<escopo>:<hash>`
//! (`play_effects_native_writes.rs::mark_alive`), mas a checagem TAMBÉM mede
//! vida: Premiumize/TorBox/AllDebrid nomeiam na hora os hashes que estão no
//! cache do serviço. Ninguém registrava essa evidência — o ⚡ do magnetdb só
//! nascia quando a busca virava play, e o recheck ficava sem escritor. Aqui a
//! marca nasce em fundo (a resposta da checagem nunca espera o disco), pelo
//! MESMO escritor do play (`adom_index::MagnetStateStore::mark_alive`), que
//! já recusa hash com `bad` vivo e ignora hash fora da forma canônica: a
//! guarda mora onde a chave nasce, não aqui.
//!
//! Real-Debrid fica FORA: o veredito da checagem dele vem do ledger `rdc:v2`
//! (verdict.rs) — evidência que o play já registrou —, não de uma medição no
//! serviço. Renovar `alive` a partir de hit de ledger era evidência de segunda
//! mão que se auto-sustenta sem play novo: "alive só com evidência medida".
//! `bad`/`lie` seguem exclusivos do play (NoVideoError/DubLieError).
//!
//! Réguas, as MESMAS do play (`play_effects_native.rs::EffectConfig`) e do
//! rd_warmer (`rd_warmer_magnet.rs`):
//! - `MAGNET_DB` — kill-switch (default ligado; só o literal `true` liga);
//! - `MAGNET_ALIVE_TTL` — segundos (default 7 dias; `<= 0` desliga a janela).
//!
//! Fail-open de ponta a ponta: falha de banco só loga, e a busca nunca espera.

use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

use adom_index::MagnetStateStore;

/// `MAGNET_ALIVE_TTL` default: 7 dias, o mesmo do play (`7 * 24 * 3600`).
const DEFAULT_ALIVE_TTL_S: i64 = 604_800;

/// Lote de vivos de UMA checagem. `api_key` entra só para virar o escopo
/// (`account_scope`) dentro da chave; nunca é gravado nem logado em claro.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct AliveBatch {
    service: String,
    api_key: String,
    hashes: Vec<String>,
}

/// Hash da forma do magnetdb = 40 hex MINÚSCULOS (a `mark_alive` recusa o
/// resto). Normaliza como o `marks_feed` faz: trim + minúsculas + dedupe —
/// um hash ruim não derruba o lote.
fn normalize_hashes(hashes: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    hashes
        .iter()
        .map(|raw| raw.trim().to_lowercase())
        .filter(|hash| !hash.is_empty())
        .filter(|hash| seen.insert(hash.clone()))
        .collect()
}

/// `MAGNET_DB` com a régua do play (`env_on`): valor não vazio liga só com o
/// literal `true`; ausente/vazio = default ligado.
fn magnet_db_enabled() -> bool {
    match std::env::var("MAGNET_DB") {
        Ok(value) if !value.is_empty() => value == "true",
        _ => true,
    }
}

/// `MAGNET_ALIVE_TTL` em segundos (parse com trim, como o `env_num` do play).
/// `<= 0` desliga a marca (a própria `mark_alive` também protege).
fn alive_ttl_seconds() -> i64 {
    std::env::var("MAGNET_ALIVE_TTL")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_ALIVE_TTL_S)
}

/// Marca habilitada = kill-switch ligado E janela positiva.
fn enabled() -> bool {
    magnet_db_enabled() && alive_ttl_seconds() > 0
}

/// Store do magnetdb, UMA conexão por processo — mesmo desenho do KV nativo
/// de `native_kv`: só a abertura bem-sucedida fica guardada e uma falha
/// transitória (lock no boot) retenta na próxima checagem. Nos testes o
/// caminho é um arquivo PRÓPRIO da marca (ver `cache_db_path`): nenhum teste
/// toca no `data/cache.db` do checkout.
static STORE: OnceLock<MagnetStateStore> = OnceLock::new();

#[cfg(not(test))]
fn cache_db_path() -> String {
    std::env::var(crate::alldebrid_cleanup::CACHE_DB_ENV)
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| "data/cache.db".to_string())
}

/// Nos testes o magnetdb NÃO compartilha o arquivo do KV nativo
/// (`adom-marks-test-{pid}.db`): os spawns `fsz`/`tsz`/`adsub` dos outros
/// testes do veredito gravam lá em paralelo, e duas conexões no mesmo arquivo
/// concorrem no WAL — o upgrade da transação de escrita dá "database is
/// locked" e o teste vira flaky. Em produção os dois voltam a ser o
/// `cache.db`, o padrão do gateway (várias stores no mesmo arquivo).
#[cfg(test)]
pub(crate) fn cache_db_path() -> String {
    std::env::temp_dir()
        .join(format!("adom-magnet-alive-test-{}.db", std::process::id()))
        .to_string_lossy()
        .into_owned()
}

fn production_store() -> Option<&'static MagnetStateStore> {
    if let Some(store) = STORE.get() {
        return Some(store);
    }
    match MagnetStateStore::open(Path::new(&cache_db_path())) {
        Ok(store) => {
            // Corrida entre dois lotes: o perdedor descarta a própria conexão.
            let _ = STORE.set(store);
            STORE.get()
        }
        Err(err) => {
            eprintln!("[debrid] magnetdb indisponível p/ alive: {err}");
            None
        }
    }
}

/// Grava `alive` para os hashes válidos e únicos do lote. Devolve quantas
/// chaves NASCERAM (régua do `mark_alive`: renovação não conta e hash com
/// `bad` vivo é recusado — o play provou que está quebrado). Janela `<= 0`,
/// serviço ou conta vazios não gravam nada.
fn mark_alive_batch(
    store: &MagnetStateStore,
    service: &str,
    api_key: &str,
    hashes: &[String],
    ttl_seconds: i64,
    now_ms: i64,
) -> usize {
    let service = service.trim();
    let api_key = api_key.trim();
    if ttl_seconds <= 0 || service.is_empty() || api_key.is_empty() {
        return 0;
    }
    let batch = normalize_hashes(hashes);
    if batch.is_empty() {
        return 0;
    }
    store
        .mark_alive(service, api_key, &batch, ttl_seconds, now_ms)
        .unwrap_or_else(|err| {
            eprintln!("[debrid] alive não gravado ({} hash): {err}", batch.len());
            0
        })
}

/// Grava a marca agora (thread atual). Chamado só do `spawn`.
fn grava(batch: &AliveBatch) {
    let Some(store) = production_store() else {
        return;
    };
    let born = mark_alive_batch(
        store,
        &batch.service,
        &batch.api_key,
        &batch.hashes,
        alive_ttl_seconds(),
        crate::error::now_ms() as i64,
    );
    if born > 0 {
        eprintln!(
            "[debrid] alive no magnetdb: {born} hash(es) de {}",
            batch.service
        );
    }
}

/// Dispara a gravação do lote em fundo. Sem gate, sem conta ou sem hash não
/// faz nada. Com runtime, roda em `spawn_blocking` (o SQLite é síncrono);
/// sem runtime, grava no thread atual — o mesmo desenho do `marks_feed::spawn`.
pub fn spawn(service: &str, api_key: &str, hashes: &[String]) {
    if !enabled() {
        return;
    }
    let batch = AliveBatch {
        service: service.trim().to_string(),
        api_key: api_key.trim().to_string(),
        hashes: normalize_hashes(hashes),
    };
    if batch.service.is_empty() || batch.api_key.is_empty() || batch.hashes.is_empty() {
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
#[path = "magnet_alive_tests.rs"]
mod magnet_alive_tests;
