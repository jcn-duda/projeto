//! Limpeza segura da AllDebrid — porte de `src/debrid/protected.ts` e da
//! decisão de `src/debrid/alldebrid-check.ts`, atrás de `DEBRID_AL_CLEANUP`
//! (default do CÓDIGO **OFF**; o default do CORTE desde o F4.6 é **ON**, junto
//! com `DEBRID_AL_HOLDS=on`).
//!
//! A checagem da AllDebrid é um `/magnet/upload` real: sem limpeza cada busca
//! deixa dezenas de magnets na conta até estourar o teto e derrubar o ⚡. O
//! perigo anda junto: o autofetch sobe DE PROPÓSITO um torrent que ainda não
//! está pronto, então o `dropUncached` apagaria o download no meio.
//!
//! Duas camadas de proteção, como no Node:
//!
//! - **volátil** — [`Holds`] em memória com TTL (hold do autofetch em voo) e o
//!   fato `held` entregue pelo chamador;
//! - **durável** — `adprot:v1:alldebrid:<conta>:<hash>` no `cache.db` (retenção
//!   BR do autofetch). Lido em modo read-only por [`DurablePeek`]; o `adsub:v1`
//!   do mesmo banco marca o que o addon subiu (e pode sair) e o `adrm:v1` marca
//!   o que a limpeza apagou DE PROPÓSITO — filtro de UPLOAD, nunca veto de
//!   delete: ele só tira o hash do `/magnet/upload` da checagem.
//!
//! `knownBefore` é o snapshot da conta ANTES do upload: o que já era do usuário
//! não sai. O Rust carrega o próprio snapshot por `/magnet/status` (TTL
//! `ALLDEBRID_PREEXISTING_TTL_MS`) e subtrai a posse (`adsub` durável +
//! `submitted` desta instância). Sem snapshot, ninguém sai (fail-safe).
//!
//! **Contrato que o Rust NÃO tem:** o hold volátil do autofetch mora no processo
//! do Node. Por isso a limpeza só nasce com `holds_complete` (o chamador prova
//! que `held` cobre todos os hashes do lote). Sem esse fato — e hoje o caminho
//! nativo não o recebe — a nativa fica READ-ONLY mesmo com a flag ON: o plano é
//! devolvido em `CacheReport.cleanup` para diagnóstico, mas nasce suprimido e
//! não é executado.
//!
//! Fora desta fatia (seguem Node): varredura de mortos/não-dublados, evicção
//! por busca, reconcile, revalidate suprimida, `davail` e o `fsz`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use adom_core::{may_delete, DeleteFacts};
use rusqlite::params;
use sha2::{Digest, Sha256};

use crate::alldebrid::AllDebrid;
use crate::error::now_ms;

/// Liga a limpeza nativa. Default do código OFF (o corte sobe ON):
/// `drop_ready`/`drop_uncached` são ignorados e nada é apagado.
pub const CLEANUP_ENV: &str = "DEBRID_AL_CLEANUP";
/// Kill-switch de uma linha: qualquer valor de liga (`on/1/true/yes`) suprime
/// o plano e a fila mesmo com `DEBRID_AL_CLEANUP=on`.
pub const KILL_ENV: &str = "DEBRID_AL_CLEANUP_KILL";
/// TTL do snapshot `knownBefore`, o mesmo do Node (`ALLDEBRID_PREEXISTING_TTL_MS`).
pub const PREEXISTING_TTL_ENV: &str = "ALLDEBRID_PREEXISTING_TTL_MS";
/// Caminho do `cache.db` do Node (proteção durável `adprot`/`adsub`).
pub const CACHE_DB_ENV: &str = "CACHE_DB_PATH";

const DEFAULT_PREEXISTING_TTL_MS: u64 = 300_000;
const DEFAULT_CACHE_DB: &str = "data/cache.db";

// ── Flag / kill-switch ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CleanupMode {
    /// Default: read-only. Mesmo com os `drop_*` ligados, ninguém sai.
    #[default]
    Off,
    /// Habilita o plano; a execução ainda exige `holds_complete` + inventário.
    On,
}

impl CleanupMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "on" | "1" | "true" | "yes" | "rust" => Self::On,
            _ => Self::Off,
        }
    }

    pub fn from_env() -> Self {
        std::env::var(CLEANUP_ENV)
            .ok()
            .as_deref()
            .map(Self::parse)
            .unwrap_or_default()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::On => "on",
        }
    }

    pub fn is_on(self) -> bool {
        matches!(self, Self::On)
    }
}

pub fn kill_switch_on() -> bool {
    std::env::var(KILL_ENV)
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "on" | "1" | "true" | "yes"
            )
        })
        .unwrap_or(false)
}

pub fn env_truthy(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(raw) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "on" | "1" | "true" | "yes"
        ),
        Err(_) => default,
    }
}

// ── Escopo da conta ─────────────────────────────────────────────────────────

/// Mesma chave que `accountScope` do Node (`sha256(apiKey)` em hex), para bater
/// com `adprot`/`adsub` e com o inventário do Node. Chave vazia = `none`.
pub fn account_scope(api_key: &str) -> String {
    if api_key.is_empty() {
        return "none".into();
    }
    let digest = Sha256::digest(api_key.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

// ── Hold volátil (autofetch em voo) ─────────────────────────────────────────

/// Map `conta:hash → expira_ms`. Chamar de novo renova o prazo, como o
/// `hold` do Node. Expirado ou processo reiniciado, o hash volta a ser
/// candidato à limpeza normal.
#[derive(Default)]
pub struct Holds {
    inner: Mutex<HashMap<String, i64>>,
}

impl Holds {
    pub fn new() -> Self {
        Self::default()
    }

    fn key(account: &str, hash: &str) -> String {
        format!("{account}:{}", hash.trim().to_lowercase())
    }

    pub fn hold(&self, account: &str, hash: &str, ttl: Duration) {
        let hash = hash.trim().to_lowercase();
        if hash.is_empty() {
            return;
        }
        let ttl_ms = (ttl.as_millis() as i64).max(1);
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        guard.insert(Self::key(account, &hash), now_ms() as i64 + ttl_ms);
    }

    pub fn release(&self, account: &str, hash: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        guard.remove(&Self::key(account, hash));
    }

    pub fn is_held(&self, account: &str, hash: &str) -> bool {
        let key = Self::key(account, hash);
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        let Some(expires_at) = guard.get(&key).copied() else {
            return false;
        };
        if expires_at <= now_ms() as i64 {
            guard.remove(&key);
            return false;
        }
        true
    }

    pub fn sweep(&self) {
        let now = now_ms() as i64;
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        guard.retain(|_, expires_at| *expires_at > now);
    }

    pub fn len(&self) -> usize {
        self.sweep();
        self.inner
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        self.inner
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clear();
    }
}

static HOLDS: OnceLock<Holds> = OnceLock::new();

pub fn holds() -> &'static Holds {
    HOLDS.get_or_init(Holds::new)
}

/// Protege o hash por `ttl`. O autofetch nativo (fatia futura) chama isto antes
/// da checagem, como o Node faz em `protected.hold`.
pub fn hold(account: &str, hash: &str, ttl: Duration) {
    holds().hold(account, hash, ttl);
}

pub fn release(account: &str, hash: &str) {
    holds().release(account, hash);
}

pub fn is_held(account: &str, hash: &str) -> bool {
    holds().is_held(account, hash)
}

// ── Posse desta instância (`submitted`) ─────────────────────────────────────

/// Hashes que ESTA instância subiu com prova (não estavam no snapshot). O
/// inventário seguinte não pode tratá-los como acervo do usuário — é a mesma
/// regra do `rememberSubmitted` do Node. Só memória: o registro durável é
/// `adsub`, escrito pelo Node (lido em [`DurablePeek`]).
#[derive(Default)]
pub struct Submitted {
    inner: Mutex<HashMap<String, HashSet<String>>>,
}

impl Submitted {
    fn remember(&self, account: &str, hash: &str) -> bool {
        let hash = hash.trim().to_lowercase();
        if hash.is_empty() {
            return false;
        }
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        guard.entry(account.to_string()).or_default().insert(hash)
    }

    fn hashes(&self, account: &str) -> HashSet<String> {
        self.inner
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(account)
            .cloned()
            .unwrap_or_default()
    }

    fn clear(&self) {
        self.inner
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clear();
    }
}

static SUBMITTED: OnceLock<Submitted> = OnceLock::new();

fn submitted() -> &'static Submitted {
    SUBMITTED.get_or_init(Submitted::default)
}

/// Marca o hash como subido por nós. O chamador só deve chamar quando o
/// snapshot corrente prova que ele NÃO estava na conta (ver `check`).
pub fn remember_submitted(account: &str, hash: &str) {
    submitted().remember(account, hash);
}

pub fn submitted_hashes(account: &str) -> HashSet<String> {
    submitted().hashes(account)
}

/// Simula o restart nos testes.
pub fn reset_submitted() {
    submitted().clear();
}

// ── Proteção durável (`adprot`) e posse (`adsub`) no cache.db do Node ───────

pub fn adprot_key(account: &str, hash: &str) -> String {
    format!(
        "adprot:v1:alldebrid:{account}:{}",
        hash.trim().to_lowercase()
    )
}

pub fn adsub_key(account: &str, hash: &str) -> String {
    format!("adsub:v1:{account}:{}", hash.trim().to_lowercase())
}

fn adsub_prefix(account: &str) -> String {
    format!("adsub:v1:{account}:")
}

/// Anti-reenchimento da AllDebrid (Fase 8, item 8.14): hash que a limpeza
/// apagou DE PROPÓSITO não volta ao `/magnet/upload`. **Sem** segmento de
/// adapter de propósito (≠ `adprot:v1:alldebrid:...`): só a AllDebrid marca e
/// a leitura de outra conta simplesmente não encontra registro — é o mesmo
/// `key()` de `markReuploadBlocked` no Node.
pub fn adrm_key(account: &str, hash: &str) -> String {
    format!("adrm:v1:{account}:{}", hash.trim().to_lowercase())
}

fn adrm_prefix(account: &str) -> String {
    format!("adrm:v1:{account}:")
}

/// Leitor read-only do `cache.db` (o mesmo arquivo que o Node mantém em WAL).
/// Abre sob demanda, uma vez; erro de abertura/consulta devolve "não protegido"
/// (o fail-safe da limpeza é `holds_complete` + inventário, não este banco).
///
/// Clonável porque a checagem usa o MESMO leitor para dois papéis: o filtro de
/// upload (`adrm`, vale sempre) e a guarda durável da limpeza (`adprot`/`adsub`,
/// só com `DEBRID_AL_CLEANUP=on`). A conexão é compartilhada pelo `Arc`.
#[derive(Clone)]
pub struct DurablePeek {
    path: PathBuf,
    conn: Arc<Mutex<Option<rusqlite::Connection>>>,
}

impl fmt::Debug for DurablePeek {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DurablePeek")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl DurablePeek {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            conn: Arc::new(Mutex::new(None)),
        }
    }

    /// `CACHE_DB_PATH` ou `data/cache.db` (o mesmo default do processo Node).
    pub fn from_env() -> Self {
        let path = std::env::var(CACHE_DB_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_CACHE_DB.to_string());
        Self::new(path)
    }

    fn with_conn<T>(&self, body: impl FnOnce(&rusqlite::Connection) -> Option<T>) -> Option<T> {
        let mut guard = self.conn.lock().unwrap_or_else(|err| err.into_inner());
        if guard.is_none() {
            if !self.path.exists() {
                return None;
            }
            // Leitura curta: a classificação roda no lote da checagem (worker
            // tokio). O `busy_timeout` de 5 s do `open_readonly` prenderia o
            // worker num checkpoint do Node — 200 ms e desiste (fail-open só
            // aqui; o fail-safe da limpeza é inventário+holds).
            let opened = rusqlite::Connection::open_with_flags(
                &self.path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .ok()
            .and_then(|conn| {
                conn.busy_timeout(Duration::from_millis(200)).ok()?;
                Some(conn)
            });
            *guard = opened;
        }
        body(guard.as_ref()?)
    }

    /// Registro existe e ainda não expirou (`cache.peek` do Node).
    pub fn alive(&self, key: &str, now: i64) -> bool {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT expires_at FROM cache WHERE key = ?1")
                .ok()?;
            let expires_at: Option<i64> = stmt
                .query_row(params![key], |row| row.get::<_, i64>(0))
                .ok();
            Some(expires_at.is_some_and(|expires| expires > now))
        })
        .unwrap_or(false)
    }

    /// Acervo BR retido (`adprot:v1:alldebrid:...`).
    pub fn is_protected(&self, account: &str, hash: &str, now: i64) -> bool {
        self.alive(&adprot_key(account, hash), now)
    }

    /// O addon subiu este hash (`adsub:v1`): ele pode sair sem virar "acervo".
    pub fn is_owned(&self, account: &str, hash: &str, now: i64) -> bool {
        self.alive(&adsub_key(account, hash), now)
    }

    /// Todos os `adsub` vivos da conta numa consulta (usado pelo inventário).
    pub fn owned_hashes(&self, account: &str, now: i64) -> HashSet<String> {
        self.prefixed_hashes(&adsub_prefix(account), now)
    }

    /// Hashes desta conta que a limpeza apagou de propósito (`adrm:v1`) e que a
    /// checagem NÃO pode re-subir.
    ///
    /// É filtro de UPLOAD, não de play: o hash sai da chamada do
    /// `/magnet/upload` (que é a própria consulta de cache) para a conta não
    /// reencher com o que acabou de sair. Fonte read-only — abrir/consultar este
    /// banco não grava, não expira e não toca na conta. Banco ausente/ilegível
    /// devolve vazio: sem prova do bloqueio, o hash volta a ser consultado (o
    /// fail-safe aqui é o lado do reenchimento, nunca o de esconder ⚡ real).
    pub fn blocked_hashes(&self, account: &str, now: i64) -> HashSet<String> {
        self.prefixed_hashes(&adrm_prefix(account), now)
    }

    /// Hashes vivos com `prefix` (`<namespace>:v1:<conta>:`), numa consulta — o
    /// MESMO SQL do `owned_hashes`, de propósito: um só lugar para a régua de
    /// TTL do `cache.db` do Node.
    fn prefixed_hashes(&self, prefix: &str, now: i64) -> HashSet<String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT key FROM cache
                     WHERE substr(key, 1, length(?1)) = ?1 AND expires_at > ?2",
                )
                .ok()?;
            let rows = stmt
                .query_map(params![prefix, now], |row| row.get::<_, String>(0))
                .ok()?;
            Some(
                rows.filter_map(Result::ok)
                    .filter_map(|key| key.strip_prefix(prefix).map(str::to_lowercase))
                    .filter(|hash| !hash.is_empty())
                    .collect(),
            )
        })
        .unwrap_or_default()
    }
}

// ── Inventário (`knownBefore`) ──────────────────────────────────────────────

#[derive(Default)]
struct InventoryEntry {
    hashes: Option<Arc<HashSet<String>>>,
    loaded_at_ms: i64,
    loading: bool,
    loading_since_ms: i64,
}

/// Lease do refresh: um task abortado (runtime caindo/falha) não pode deixar a
/// conta travada em `loading` para sempre — passado o lease, a próxima busca
/// tenta de novo. É bem maior que um `/magnet/status` normal.
const LOADING_LEASE_MS: i64 = 60_000;

/// Snapshot por conta com TTL. Vencido = `None` (fail-safe fechado) e refresh
/// em fundo; a busca NUNCA espera o `/magnet/status`. É o mesmo contrato do
/// `knownBefore` do Node, com a diferença de que aqui o refresh não bloqueia.
pub struct Inventory {
    ttl: Duration,
    entries: Mutex<HashMap<String, InventoryEntry>>,
}

impl Inventory {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn from_env() -> Self {
        let ms = std::env::var(PREEXISTING_TTL_ENV)
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_PREEXISTING_TTL_MS);
        Self::new(Duration::from_millis(ms))
    }

    fn peek(&self, account: &str) -> Option<Arc<HashSet<String>>> {
        if self.ttl.is_zero() {
            return None;
        }
        let guard = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.get(account)?;
        let hashes = entry.hashes.clone()?;
        let fresh =
            (now_ms() as i64).saturating_sub(entry.loaded_at_ms) < self.ttl.as_millis() as i64;
        fresh.then_some(hashes)
    }

    fn begin(&self, account: &str) -> bool {
        let now = now_ms() as i64;
        let mut guard = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.entry(account.to_string()).or_default();
        if entry.loading && now.saturating_sub(entry.loading_since_ms) < LOADING_LEASE_MS {
            return false;
        }
        entry.loading = true;
        entry.loading_since_ms = now;
        true
    }

    fn finish(&self, account: &str, hashes: Option<HashSet<String>>) {
        let mut guard = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.entry(account.to_string()).or_default();
        entry.loading = false;
        match hashes {
            Some(hashes) => {
                entry.hashes = Some(Arc::new(hashes));
                entry.loaded_at_ms = now_ms() as i64;
            }
            None => {
                // Falha limpa a referência: a próxima tentativa recarrega.
                entry.hashes = None;
                entry.loaded_at_ms = 0;
            }
        }
    }

    async fn load_inner(
        &self,
        ad: &AllDebrid,
        api_key: &str,
        account: &str,
        durable: Option<&DurablePeek>,
    ) -> Option<HashSet<String>> {
        let hashes = ad.magnet_hashes(api_key).await.ok()?;
        Some(build_snapshot(account, hashes, durable))
    }

    /// Aguarda o snapshot (usado por testes e por caminhos de fundo). Em
    /// produção o `check` só faz `peek` + refresh em fundo.
    pub async fn load_now(
        &self,
        ad: &AllDebrid,
        api_key: &str,
        account: &str,
        durable: Option<&DurablePeek>,
    ) -> Option<Arc<HashSet<String>>> {
        if !self.begin(account) {
            return None;
        }
        let hashes = self.load_inner(ad, api_key, account, durable).await;
        self.finish(account, hashes);
        self.peek(account)
    }
}

/// Snapshot = conta menos a posse provada (`adsub` durável e `submitted` desta
/// instância). O que sobra é acervo do usuário e não sai.
fn build_snapshot(
    account: &str,
    hashes: Vec<String>,
    durable: Option<&DurablePeek>,
) -> HashSet<String> {
    let now = now_ms() as i64;
    let owned = durable
        .map(|peek| peek.owned_hashes(account, now))
        .unwrap_or_default();
    let mut snapshot: HashSet<String> = hashes
        .into_iter()
        .map(|hash| hash.trim().to_lowercase())
        .filter(|hash| !hash.is_empty())
        .collect();
    for hash in submitted().hashes(account) {
        snapshot.remove(&hash);
    }
    for hash in owned {
        snapshot.remove(&hash);
    }
    snapshot
}

static INVENTORY: OnceLock<Inventory> = OnceLock::new();

pub fn inventory() -> &'static Inventory {
    INVENTORY.get_or_init(Inventory::from_env)
}

/// Snapshot vigente (peek). `None` = sem referência autorizada nesta rodada.
pub fn known_before(account: &str) -> Option<Arc<HashSet<String>>> {
    inventory().peek(account)
}

/// Dispara o refresh em fundo se o snapshot venceu. Nunca bloqueia a busca e
/// nunca decide nada sozinho: esta rodada segue fail-closed.
pub fn refresh_known_before(
    ad: &AllDebrid,
    api_key: &str,
    account: &str,
    durable: Option<Arc<DurablePeek>>,
) -> bool {
    let inv = inventory();
    if inv.peek(account).is_some() || !inv.begin(account) {
        return false;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        inv.finish(account, None);
        return false;
    };
    let ad = ad.clone();
    let key = api_key.to_string();
    let account = account.to_string();
    handle.spawn(async move {
        let inv = inventory();
        let hashes = inv
            .load_inner(&ad, &key, &account, durable.as_deref())
            .await;
        inv.finish(&account, hashes);
    });
    true
}

// ── Guarda da limpeza ───────────────────────────────────────────────────────

/// Fatos que decidem se um hash do lote pode sair. O `held` é a lista do
/// chamador; o registro volátil e o `adprot` entram por cima.
pub struct CleanupGate {
    pub drop_ready: bool,
    pub drop_uncached: bool,
    pub holds_complete: bool,
    held: HashSet<String>,
    durable: Option<Arc<DurablePeek>>,
    account: String,
}

impl CleanupGate {
    pub fn new(
        drop_ready: bool,
        drop_uncached: bool,
        holds_complete: bool,
        held: HashSet<String>,
        durable: Option<Arc<DurablePeek>>,
        account: &str,
    ) -> Self {
        Self {
            drop_ready,
            drop_uncached,
            holds_complete,
            held: held.into_iter().map(|hash| hash.to_lowercase()).collect(),
            durable,
            account: account.to_string(),
        }
    }

    /// O hash está a salvo? Hold do chamador OU hold volátil OU `adprot`.
    pub fn protects(&self, hash: &str, now: i64) -> bool {
        let hash = hash.to_lowercase();
        if self.held.contains(&hash) || holds().is_held(&self.account, &hash) {
            return true;
        }
        self.durable
            .as_ref()
            .is_some_and(|peek| peek.is_protected(&self.account, &hash, now))
    }
}

/// Destino de uma remoção: `id` é o que a API apaga; `hash`/`name` são o que o
/// Node precisa para gravar o `adrm` (`name` também alimenta a blindagem BR do
/// 8.4 e o diagnóstico do operador).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanTarget {
    pub id: String,
    pub hash: String,
    /// Nome da release no `/magnet/upload`; `None` quando a API não mandou.
    pub name: Option<String>,
}

/// Por que a limpeza não vai rodar nesta checagem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupSuppressed {
    /// Flag OFF (default): a nativa é read-only.
    FlagOff,
    /// `DEBRID_AL_CLEANUP_KILL` ligado.
    KillSwitch,
    /// O chamador não provou que `held` cobre todos os holds vivos.
    HoldsIncomplete,
    /// Nem `dropReady` nem `dropUncached` pedidos.
    NoDropFlags,
    /// Sem snapshot `knownBefore` nesta rodada (fail-safe fechado).
    InventoryMissing,
}

impl CleanupSuppressed {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FlagOff => "flag_off",
            Self::KillSwitch => "kill_switch",
            Self::HoldsIncomplete => "holds_incomplete",
            Self::NoDropFlags => "no_drop_flags",
            Self::InventoryMissing => "inventory_missing",
        }
    }
}

/// Plano da checagem. `suppressed` conta o motivo; as listas só nascem quando
/// a limpeza está autorizada E o inventário existe.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CleanupPlan {
    pub ready: Vec<CleanTarget>,
    pub uncached: Vec<CleanTarget>,
    /// Hashes poupados por já serem do usuário (no snapshot).
    pub known_before: usize,
    /// Hashes poupados por hold/`adprot` (autofetch em voo ou acervo retido).
    pub protected: usize,
    pub suppressed: Option<CleanupSuppressed>,
}

impl CleanupPlan {
    pub fn suppressed(reason: CleanupSuppressed) -> Self {
        Self {
            suppressed: Some(reason),
            ..Self::default()
        }
    }

    pub fn is_empty(&self) -> bool {
        self.ready.is_empty() && self.uncached.is_empty()
    }

    pub fn target_count(&self) -> usize {
        self.ready.len() + self.uncached.len()
    }

    pub fn ids(&self) -> Vec<String> {
        self.ready
            .iter()
            .chain(self.uncached.iter())
            .map(|target| target.id.clone())
            .collect()
    }

    /// Cruza o relatório REAL da fila com os alvos do plano: só o id que a API
    /// confirmou sair vira marca devolvida ao Node. Falha de delete fica de
    /// fora — o magnet continua na conta e o `adrm` o esconderia da checagem
    /// à toa. Dedupe por hash (o mesmo magnet pode ter sido alvo de dois lotes).
    pub fn removed_marks(
        &self,
        report: &crate::alldebrid_delete::DeleteReport,
    ) -> Vec<crate::marks_feed::RemovedMark> {
        let gone: HashSet<&str> = report.removed.iter().map(String::as_str).collect();
        let mut marks: Vec<crate::marks_feed::RemovedMark> = Vec::new();
        for target in self.ready.iter().chain(self.uncached.iter()) {
            if !gone.contains(target.id.as_str()) {
                continue;
            }
            if marks.iter().any(|mark| mark.hash == target.hash) {
                continue;
            }
            marks.push(crate::marks_feed::RemovedMark {
                hash: target.hash.clone(),
                name: target.name.clone(),
            });
        }
        marks
    }

    /// Executa o plano na fila com backoff (fire-and-forget no chamador).
    pub async fn run(
        &self,
        ad: &AllDebrid,
        api_key: &str,
    ) -> Option<crate::alldebrid_delete::DeleteReport> {
        self.run_with(
            ad,
            api_key,
            crate::alldebrid_delete::DeleteConfig::from_env(),
        )
        .await
    }

    /// Igual a [`Self::run`], com config explícita (testes sem env global).
    pub async fn run_with(
        &self,
        ad: &AllDebrid,
        api_key: &str,
        config: crate::alldebrid_delete::DeleteConfig,
    ) -> Option<crate::alldebrid_delete::DeleteReport> {
        if self.is_empty() {
            return None;
        }
        let report =
            crate::alldebrid_delete::delete_with_backoff(ad, api_key, &self.ids(), config).await;
        eprintln!(
            "[alldebrid] limpeza nativa: {} removido(s), {} falhou(ram){}",
            report.removed.len(),
            report.failed.len(),
            match report.stopped {
                Some(stop) => format!(" — parada: {}", stop.as_str()),
                None => String::new(),
            }
        );
        // O Node é o dono único do `cache.db`: devolve só o que a fila PROVOU
        // removido para ele gravar o `adrm` (anti-reenchimento). Fail-open e
        // fora do prazo — a resposta já saiu.
        let removed = self.removed_marks(&report);
        if !removed.is_empty() {
            crate::marks_feed::spawn(crate::marks_feed::MarkedBatch {
                api_key: api_key.to_string(),
                submitted: Vec::new(),
                removed,
            });
        }
        Some(report)
    }
}

/// Decide o destino de um hash do lote. Só `CleanTarget` autoriza o delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DropVerdict {
    Delete(CleanTarget),
    Protected,
    KnownBefore,
    NoInventory,
}

/// Mesma regra do núcleo (`may_delete`): inventário carregado, hash novo e
/// sem proteção. As razões separadas alimentam o diagnóstico.
pub fn classify_drop(
    gate: &CleanupGate,
    inventory: Option<&HashSet<String>>,
    hash: &str,
    id: &str,
    now: i64,
) -> DropVerdict {
    let protected = gate.protects(hash, now);
    let known = inventory.is_some_and(|snapshot| snapshot.contains(&hash.to_lowercase()));
    let allowed = may_delete(DeleteFacts {
        inventory_loaded: inventory.is_some(),
        known_before: known,
        protected,
    });
    if allowed {
        return DropVerdict::Delete(CleanTarget {
            id: id.to_string(),
            hash: hash.to_lowercase(),
            // O nome só existe na resposta do upload; quem tiver o dado
            // (o lote) preenche depois.
            name: None,
        });
    }
    if protected {
        DropVerdict::Protected
    } else if inventory.is_none() {
        DropVerdict::NoInventory
    } else {
        DropVerdict::KnownBefore
    }
}

// ── Métricas `debrid.al.cleanup.*` ──────────────────────────────────────────

pub const METRIC_PLANNED: &str = "debrid.al.cleanup.planned";
pub const METRIC_PROTECTED: &str = "debrid.al.cleanup.protected";
pub const METRIC_KNOWN_BEFORE: &str = "debrid.al.cleanup.known_before";
pub const METRIC_SUPPRESSED: &str = "debrid.al.cleanup.suppressed";
pub const METRIC_REMOVED: &str = "debrid.al.cleanup.removed";
pub const METRIC_FAILED: &str = "debrid.al.cleanup.failed";
pub const METRIC_STOPPED: &str = "debrid.al.cleanup.stopped";

fn counters() -> &'static Mutex<BTreeMap<String, u64>> {
    static COUNTERS: OnceLock<Mutex<BTreeMap<String, u64>>> = OnceLock::new();
    COUNTERS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

pub fn bump(key: &str, by: u64) {
    if by == 0 {
        return;
    }
    let mut guard = counters().lock().unwrap_or_else(|err| err.into_inner());
    *guard.entry(key.to_string()).or_insert(0) += by;
}

/// Snapshot para o `/metrics` do gateway e da API interna.
pub fn metrics_snapshot() -> BTreeMap<String, u64> {
    counters()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone()
}

#[cfg(test)]
#[path = "alldebrid_cleanup_tests.rs"]
mod cleanup_tests;
