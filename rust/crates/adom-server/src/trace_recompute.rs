//! Recompute NATIVO do trace (`GET /streams/trace`) — a dívida 4.2(b).
//!
//! Desde o corte F4.4a o L1 `streams` do Node nasce vazio e ninguém escreve nele,
//! então o `recomputeOffline` do `/stream-trace.json` (`src/utils/trace-recompute.ts`)
//! ficou INALCANÇÁVEL em produção: o caminho vivo é a ponte (`fetchNativeStreamTrace`),
//! e o NATIVO respondia `found:true` com `trace:null` sem explicar nada.
//!
//! Aqui o trace é recomputado quando a entrada TEM lista (`found`) mas NÃO tem
//! ledger gravado. O funil real do build (cortes por item) NÃO é persistido em
//! lugar nenhum — o que existe é a lista final e o `searchMeta`. Por isso o porte
//! é a versão autorizada pela tarefa: recomputar A PARTIR DA LISTA GRAVADA, com
//! os campos IDÊNTICOS aos que o TS produzia — o teste do Node é a régua
//! (`test/stream-trace-route.test.ts`, "ramo NATIVO sem trace recomputa").
//!
//! Semântica herdada do `trace-recompute.ts` (a régua):
//! 1. O estado registrado é ESTADO ATUAL (`now`), não causa do sumiço histórico.
//! 2. Matéria-prima é só o que está QUENTE (`idx:v14`, `raw:v1`, `mag:v1`,
//!    `autofetch:v3:dead`) via leituras quiet — nunca rede, nunca contador.
//! 3. O recompute NUNCA reescreve a entrada nem grava o trace no store: o
//!    `RecomputeOutcome` é a foto de hoje, não o ledger da build.
//! 4. `built:false` com `note` é resultado LEGÍTIMO (no-names/no-material).
//!
//! Divergências documentadas do porte (honestidade dura):
//! - `basis` nunca ganha `inventory`: o inventário do Node (`dinv`) tem flush
//!   DEFERIDO no L1, o gateway não tem como lê-lo com consistência — fora do
//!   porte (o build nativo usa a conta pelo caminho da posse, não por leitura).
//! - A instalação (lista de indexers + conta) vem da PRÓPRIA `streamsCacheKey`
//!   da entrada (`:account:<scope>` + shape JSON), o que é mais fiel que o TS
//!   morto, que lia `opts()` do processo mesmo no cruzamento de escopos.
//! - Rótulos passam pela MESMA porta (`sanitize_trace_label` do núcleo); a
//!   conversão final usa `from_utf16_lossy` — só diverge de um surrogate órfão
//!   exatamente na fronteira do teto de 60 unidades.
//!
//! Arquivos: a produção do outcome mora no [`core`](self::core), a moldura das
//! chaves `raw:v1` no [`raw_key`](self::raw_key) e o handler em
//! [`trace_recompute_handler.rs`](crate::store_admin::trace_handler).

use std::sync::{Arc, RwLock};

use serde_json::Value;

use adom_index::{MagnetStateStore, NativeKv, RawCacheStore, ReleaseIndexStore};

#[path = "trace_recompute_core.rs"]
pub(crate) mod core;
#[path = "trace_recompute_raw_key.rs"]
mod raw_key;

/// Serializa instalações de boot ENTRE os testes (`BOOT` é global do processo;
/// nenhum outro módulo de teste escreve, então o lock deste módulo basta).
#[cfg(test)]
pub(crate) static BOOT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Relógio FIXO dos testes unitários (seed e leitura coerentes).
#[cfg(test)]
pub(crate) const TEST_NOW: i64 = 1_700_000_000_000;

/// Boot de memória para os testes: stores vazios e listas mínimas.
#[cfg(test)]
pub(crate) fn boot_mem() -> TraceRecompute {
    from_stores(
        RawCacheStore::open_memory().unwrap(),
        ReleaseIndexStore::open_memory().unwrap(),
        MagnetStateStore::open_memory().unwrap(),
        NativeKv::open_memory().unwrap(),
        vec!["bludv-cardigann".into()],
        Vec::new(),
        vec!["bludv-cardigann".into()],
        "realdebrid".into(),
    )
}

/// Instalação de teste (scope derivado da api key, como o runtime faz).
#[cfg(test)]
pub(crate) fn test_install(
    jackett_indexers: &[&str],
    adapter: &str,
    api_key: Option<&str>,
) -> Install {
    let scope = api_key
        .map(|key| adom_core::account_scope(&serde_json::json!(key)))
        .unwrap_or_else(|| "none".to_string());
    Install {
        adapter: adapter.to_string(),
        has_account: scope.len() == 64,
        scope,
        jackett_indexers: jackett_indexers
            .iter()
            .map(|item| item.to_string())
            .collect(),
    }
}

#[cfg(test)]
#[path = "trace_recompute_route_tests.rs"]
mod route_tests;
#[cfg(test)]
#[path = "trace_recompute_tests.rs"]
mod tests;

/// Instalação EXTRAÍDA da chave da entrada: quem fez a busca foi ESTA conta com
/// ESTA lista de indexers — a matéria (raw) e os estados (mag/dead) precisam
/// bater com o funil real.
pub(crate) struct Install {
    /// `debridService` do shape (lowercase, como o runtime grava).
    pub adapter: String,
    /// Escopo da conta (`accountScope`), extraído do sufixo da chave.
    pub scope: String,
    /// `scope` é um escopo REAL (64 hex): sem conta, os estados da conta nem
    /// são consultados (mesmo gate do `currentState` do TS).
    pub has_account: bool,
    /// Lista EFETIVA de indexers da instalação (`jackettIndexers` do shape;
    /// vazia → a lista do operador, como o `collectLocalMaterial` do TS).
    pub jackett_indexers: Vec<String>,
}

/// Material de boot do recompute: os stores do `cache.db` compartilhado e as
/// listas do operador. Construído UMA VEZ (a leitura do volume do Jackett é de
/// boot, igual à da busca).
pub(crate) struct TraceRecompute {
    raw: RawCacheStore,
    idx: ReleaseIndexStore,
    mag: MagnetStateStore,
    kv: NativeKv,
    /// `JACKETT_PT_BR_INDEXERS` (mesmo default do `config/jackett.ts`).
    pt_br_indexers: Vec<String>,
    /// `JACKETT_BARE_TITLE_INDEXERS`.
    bare_title_indexers: Vec<String>,
    /// `config.jackett.indexers` do operador (env ou volume do Jackett).
    default_indexers: Vec<String>,
    /// `DEBRID_SERVICE` do operador (instalação default, sem shape válido).
    default_adapter: String,
}

/// Registro global (o `config` cacheado do TS). `Some(None)` = decisão já
/// tomada (inclusive "não ligado") — o boot de env roda UMA vez por processo.
/// Os testes instalam/limpam por [`install_for_tests`].
static BOOT: RwLock<Option<Option<Arc<TraceRecompute>>>> = RwLock::new(None);

/// Boot do módulo para o handler. Em `cfg(test)` o boot de env NÃO roda: os
/// testes que não exercitam o recompute não abrem disco nem leem env (o
/// `router_with_ownership` é montado por dezenas de testes) — quem precisa,
/// instala stores de memória por [`install_for_tests`].
pub(crate) fn boot() -> Option<Arc<TraceRecompute>> {
    if let Some(boot) = BOOT.read().unwrap_or_else(|err| err.into_inner()).as_ref() {
        return boot.clone();
    }
    let mut write = BOOT.write().unwrap_or_else(|err| err.into_inner());
    if let Some(boot) = write.as_ref() {
        return boot.clone();
    }
    let built = if cfg!(test) {
        None
    } else {
        boot_from_env().map(Arc::new)
    };
    *write = Some(built.clone());
    built
}

/// Instalação de TESTE: sobrescreve o boot (stores de memória semeados pelo
/// teste). O chamador limpa com `install_for_tests(None)` no `finally`.
#[cfg(test)]
pub(crate) fn install_for_tests(boot: Option<TraceRecompute>) {
    *BOOT.write().unwrap_or_else(|err| err.into_inner()) = Some(boot.map(Arc::new));
}

/// Construtor usado pelo boot de env e pelos testes (stores SEMPRE fornecidos:
/// o módulo não abre disco por conta própria fora do boot de env).
#[allow(clippy::too_many_arguments)] // raw/idx/mag/kv + três listas + adapter
pub(crate) fn from_stores(
    raw: RawCacheStore,
    idx: ReleaseIndexStore,
    mag: MagnetStateStore,
    kv: NativeKv,
    pt_br_indexers: Vec<String>,
    bare_title_indexers: Vec<String>,
    default_indexers: Vec<String>,
    default_adapter: String,
) -> TraceRecompute {
    TraceRecompute {
        raw,
        idx,
        mag,
        kv,
        pt_br_indexers,
        bare_title_indexers,
        default_indexers,
        default_adapter,
    }
}

fn boot_from_env() -> Option<TraceRecompute> {
    // Mesmos knobs do Node (`config/search.ts`): ausente/vazio = "true"; só
    // "0"/"false" desligam.
    for knob in ["STREAM_TRACE", "STREAM_TRACE_RECOMPUTE"] {
        if !knob_enabled(knob) {
            eprintln!("[gateway] recompute do trace desligado ({knob}=off)");
            return None;
        }
    }
    // O MESMO cache.db da busca (`CACHE_DB_PATH`, default `data/cache.db`);
    // `CACHE_PERSIST=false` segue a régua do `raw_store_from_env`: nada toca
    // disco (uma segunda conexão em memória é vazia por natureza — o recompute
    // vira `no-material`, sem mentir).
    let persist = std::env::var("CACHE_PERSIST")
        .map(|raw| !raw.trim().eq_ignore_ascii_case("false"))
        .unwrap_or(true);
    let stores = if persist {
        let path = adom_index::default_cache_db_path();
        (
            RawCacheStore::open(&path),
            ReleaseIndexStore::open(&path),
            MagnetStateStore::open(&path),
            NativeKv::open(&path),
        )
    } else {
        (
            RawCacheStore::open_memory(),
            ReleaseIndexStore::open_memory(),
            MagnetStateStore::open_memory(),
            NativeKv::open_memory(),
        )
    };
    let (raw_r, idx_r, mag_r, kv_r) = stores;
    let (Ok(raw), Ok(idx), Ok(mag), Ok(kv)) = (raw_r, idx_r, mag_r, kv_r) else {
        eprintln!("[gateway] recompute do trace sem stores: store indisponível");
        return None;
    };
    Some(from_stores(
        raw,
        idx,
        mag,
        kv,
        indexer_list(
            std::env::var("JACKETT_PT_BR_INDEXERS").ok().as_deref(),
            "bludv-cardigann,comandotorrents,nerdfilmes,torrentdosfilmesv2,vacatorrent,redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann",
        ),
        indexer_list(
            std::env::var("JACKETT_BARE_TITLE_INDEXERS").ok().as_deref(),
            "redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann",
        ),
        super::stream_config::operator_jackett_indexers(),
        std::env::var("DEBRID_SERVICE")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase(),
    ))
}

/// `!['0','false'].includes(String(env || 'true').trim().toLowerCase())`.
fn knob_enabled(key: &str) -> bool {
    let raw = std::env::var(key)
        .ok()
        .filter(|raw| !raw.is_empty())
        .unwrap_or_else(|| "true".to_string());
    let raw = raw.trim().to_ascii_lowercase();
    raw != "0" && raw != "false"
}

/// Instalação a partir da chave REAL da entrada
/// (`streams:v21:<type>:<id>:<shapeJSON>:account:<scope>`). Chave sem sufixo
/// legível (não deveria existir no v21) ⇒ sem recompute, sem inventar conta.
fn install_from_key(key: &str, kind: &str, id: &str, boot: &TraceRecompute) -> Option<Install> {
    let (head, scope) = key.rsplit_once(":account:")?;
    let scope = scope.trim();
    let has_account = scope.len() == 64 && scope.bytes().all(|b| b.is_ascii_hexdigit());
    if !has_account && scope != "none" {
        return None;
    }
    let head = head.strip_prefix(adom_store::streams_prefix())?;
    let shape_raw = head.strip_prefix(&format!("{kind}:{id}:"))?;
    let shape: Value = serde_json::from_str(shape_raw).ok()?;
    // Lista EFETIVA da instalação (mesmo gate do TS: array presente e não-vazio
    // vence a lista do operador).
    let jackett_indexers = shape
        .get("jackettIndexers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|list| !list.is_empty())
        .unwrap_or_else(|| boot.default_indexers.clone());
    let adapter = shape
        .get("debridService")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|service| !service.is_empty())
        .map(|service| service.to_ascii_lowercase())
        // Sem `debridService` no shape (entrada gravada antes do campo existir,
        // p. ex.), o melhor palpite é o MESMO que o TS morto usava: o default
        // do operador (as chaves de estado levam o adapter; errar aqui custa só
        // `tocável` a mais, nunca um estado falso).
        .unwrap_or_else(|| boot.default_adapter.clone());
    Some(Install {
        adapter,
        scope: scope.to_string(),
        has_account,
        jackett_indexers,
    })
}

use super::stream_config::indexer_list;
