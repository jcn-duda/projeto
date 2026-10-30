//! Efeitos do `/resolve` nativo, gravados DIRETO nos stores deste processo.
//!
//! Porte do que `src/debrid/rust-play-effects.ts`, `rust-resolve-apply.ts`,
//! `rust-resolve-magnet.ts`, `rust-resolve-cache.ts` e `rust-resolve-index.ts`
//! faziam quando o play ainda atravessava `/internal/resolve/effects`. Os
//! stores (`cache.db`, `streams.db`) moram aqui, então não há mais HTTP no
//! caminho: a regra (quem grava o quê, com qual TTL e sob qual gate) é a mesma.
//!
//! - Desfecho OK: arquivos (`fsz` + prova), davail negativo se o play provou
//!   frio e `alive` (magnet vivo, só com link). Roda em fundo: o 302 não espera.
//! - Desfecho de erro: arquivos, o efeito plano do núcleo (`resolve_effect`:
//!   mark/unprotect/invalidate/index/noteBlocked). A rota ESPERA esta escrita
//!   antes de responder, para a reabertura imediata não servir o hash recém
//!   falho.
//!
//! Falha de qualquer store só loga `[resolve]`; o status do play nunca muda.
//! A chave da conta vai só em memória: nenhum log a imprime.

use std::path::Path;
use std::sync::{Arc, Mutex};

use adom_debrid::alldebrid::PlayFile;
use adom_index::{DavailStore, MagnetStateStore, NativeKv};
use adom_store::{ReleaseIndexStore, StreamsStore};
use serde_json::Value;

use crate::dub_audit::{env_num, env_on, now_ms, DEFAULT_LIE_TTL};

#[path = "play_effects_native_plan.rs"]
mod plan;
#[path = "play_effects_native_writes.rs"]
mod writes;

use plan::EffectPlan;

/// Alvo do efeito: a conta (chave só em memória), o hash e a dica da obra.
/// Sem `Debug`: a chave não pode ir para log por engano.
#[derive(Clone)]
pub struct PlayJob {
    pub service: String,
    pub api_key: String,
    pub hash: String,
    pub imdb: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

/// Escritas do play. Trait para a rota de teste receber um gravador de faz de
/// conta, sem tocar SQLite. Os dois métodos são síncronos (SQLite): quem chama
/// põe em `spawn_blocking`.
pub trait PlayEffects: Send + Sync {
    /// Desfecho com link ou ainda baixando. Chamado em fundo (o 302 não espera).
    fn apply_ok(&self, job: PlayJob, alive: bool, unavailable: bool, files: Option<Vec<PlayFile>>);
    /// Desfecho de erro. `effect` é o JSON plano de `resolve_effect`.
    fn apply_error(&self, job: PlayJob, effect: Value, files: Option<Vec<PlayFile>>);
}

/// Régua do env, lida uma vez na subida. Mesmos nomes e defaults do TS
/// (`src/config/audit.ts`, `src/config/debrid.ts`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EffectConfig {
    pub magnet_db: bool,
    pub alive_ttl: i64,
    pub bad_ttl: i64,
    pub lie_enabled: bool,
    pub lie_ttl: i64,
    pub avail_neg_ttl: i64,
    pub rd_ledger: bool,
    pub rd_blocked_ttl: f64,
    /// 0 desliga a limpeza das listas por bloqueio legal.
    pub blocked_cooldown_ms: i64,
}

impl EffectConfig {
    pub fn from_env() -> Self {
        Self {
            magnet_db: env_on("MAGNET_DB", true),
            alive_ttl: env_num("MAGNET_ALIVE_TTL", 7 * 24 * 3600),
            bad_ttl: env_num("MAGNET_BAD_TTL", 24 * 3600),
            lie_enabled: env_on("MAGNET_LIE", true),
            lie_ttl: env_num("MAGNET_LIE_TTL", DEFAULT_LIE_TTL),
            avail_neg_ttl: env_num("DEBRID_AVAIL_NEG_TTL", 120),
            rd_ledger: env_on("DEBRID_RD_LEDGER", true),
            rd_blocked_ttl: env_num("DEBRID_RD_LEDGER_BLOCKED_TTL", 2_592_000).max(0) as f64,
            blocked_cooldown_ms: env_num("RESOLVE_BLOCKED_INVALIDATE_COOLDOWN_MS", 30_000).max(0),
        }
    }
}

/// KV do `cache.db`: o de produção é único no processo (ver `adom-debrid`);
/// nos testes é uma conexão própria sobre o arquivo temporário.
enum Kv {
    /// Só os testes abrem KV próprio; o processo de produção usa o `Shared`.
    #[cfg_attr(not(test), allow(dead_code))]
    Own(NativeKv),
    Shared(&'static NativeKv),
}

impl Kv {
    fn get(&self) -> &NativeKv {
        match self {
            Kv::Own(kv) => kv,
            Kv::Shared(kv) => kv,
        }
    }
}

/// Gravador de produção. Um store por tipo; o que não abriu vira `None` e a
/// escrita correspondente é pulada com log.
pub struct NativePlayEffects {
    cfg: EffectConfig,
    kv: Option<Kv>,
    davail: Option<DavailStore>,
    mag: Option<MagnetStateStore>,
    index: Option<ReleaseIndexStore>,
    streams: Option<Arc<StreamsStore>>,
    /// Instante (ms) do último pedido de limpeza por bloqueio. Vive no processo:
    /// é o cooldown que impede uma rajada de plays 451 de esfriar todas as listas.
    last_blocked_clear_ms: Mutex<i64>,
}

impl NativePlayEffects {
    /// Produção: o `cache.db` padrão e o KV único do processo. O `streams` é o
    /// handle do próprio gateway (mesma instância do SWR, sem segunda conexão).
    pub fn from_env(streams: Option<Arc<StreamsStore>>) -> Arc<dyn PlayEffects> {
        let path = adom_store::default_cache_db_path();
        let kv = adom_debrid::native_kv::production_kv().map(Kv::Shared);
        Arc::new(Self::build(EffectConfig::from_env(), &path, kv, streams))
    }

    /// Testes: KV próprio e stores sobre o arquivo dado.
    #[cfg(test)]
    pub fn open_at(cfg: EffectConfig, path: &Path, streams: Option<Arc<StreamsStore>>) -> Self {
        let kv = NativeKv::open(path).ok().map(Kv::Own);
        Self::build(cfg, path, kv, streams)
    }

    fn build(
        cfg: EffectConfig,
        path: &Path,
        kv: Option<Kv>,
        streams: Option<Arc<StreamsStore>>,
    ) -> Self {
        Self {
            cfg,
            kv,
            davail: abre("davail", DavailStore::open(path)),
            mag: abre("mag:v1", MagnetStateStore::open(path)),
            index: abre("idx:v14", ReleaseIndexStore::open(path)),
            streams,
            last_blocked_clear_ms: Mutex::new(0),
        }
    }

    fn kv(&self) -> Option<&NativeKv> {
        self.kv.as_ref().map(Kv::get)
    }
}

fn abre<T>(nome: &str, aberto: Result<T, String>) -> Option<T> {
    match aberto {
        Ok(store) => Some(store),
        Err(err) => {
            eprintln!("[resolve] {nome} indisponível ({err}); o efeito dele não é gravado");
            None
        }
    }
}

/// Falha de escrita só vira log: o status do play já foi decidido.
fn grava<T>(what: &str, result: Result<T, String>) {
    if let Err(err) = result {
        eprintln!("[resolve] {what} não gravado: {err}");
    }
}

impl PlayEffects for NativePlayEffects {
    fn apply_ok(&self, job: PlayJob, alive: bool, unavailable: bool, files: Option<Vec<PlayFile>>) {
        let now = now_ms();
        self.apply_files(&job, files.as_deref(), now);
        if unavailable {
            self.note_unavailable(&job, now);
        }
        if alive {
            self.mark_alive(&job, now);
        }
    }

    fn apply_error(&self, job: PlayJob, effect: Value, files: Option<Vec<PlayFile>>) {
        let now = now_ms();
        self.apply_files(&job, files.as_deref(), now);
        let plan = EffectPlan::from_value(&effect);
        self.apply_plan(&job, &plan, now);
    }
}

#[cfg(test)]
pub struct NoPlayEffects;

#[cfg(test)]
impl PlayEffects for NoPlayEffects {
    fn apply_ok(&self, _: PlayJob, _: bool, _: bool, _: Option<Vec<PlayFile>>) {}
    fn apply_error(&self, _: PlayJob, _: Value, _: Option<Vec<PlayFile>>) {}
}

#[cfg(test)]
#[path = "play_effects_native_tests.rs"]
mod tests;
