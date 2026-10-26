//! Estado de debrid que já foi MEDIDO e ficou no disco: `davail:v1` (⚡) e
//! `mag:v1` (alive/bad/lie).
//!
//! Os dois stores moram no `adom-index` (MESMO `data/cache.db` do Node e do
//! gateway); aqui é só a casca napi — o mesmo desenho do `RawStore`/`NativeKv`.
//! Nada de rede: o veredito é evidência gravada por quem já perguntou ao
//! serviço, e o TTL (positivo × negativo) é do store, não desta ponte.
//!
//! Os nomes que chegam ao JS são camelCase, por conversão default do napi-rs:
//! `dbPath`, `apiKey`, `ttlSeconds`, `nowMs`, `markAlive`, `markBad`,
//! `markLie`, `forgetBad`, `stateSnapshot`, `getMany`, `putMany`.

use std::path::Path;

use adom_index::{
    DavailStore, MagnetMark as CoreMark, MagnetState as CoreState, MagnetStateStore as CoreStore,
};
use napi::Error;
use napi_derive::napi;

fn erro(err: String) -> Error {
    Error::from_reason(err)
}

/// Veredito de ⚡ de um hash presente no lote (`get_many` só devolve os vivos).
#[napi(object)]
pub struct DavailFlag {
    pub hash: String,
    /// `true` = o debrid confirmou pronto; `false` = provou que está frio.
    pub cached: bool,
}

/// Foto de um hash no banco de magnets: `"alive"` | `"bad"` | `"lie"` | `null`
/// (`null` = nenhuma evidência viva nesta conta).
#[napi(object)]
pub struct MagnetMark {
    pub hash: String,
    pub state: Option<String>,
}

/// Rótulo do campo do `mag:v1` — o `field()` do core é privado de propósito.
fn state_label(state: CoreState) -> &'static str {
    match state {
        CoreState::Alive => "alive",
        CoreState::Bad => "bad",
        CoreState::Lie => "lie",
    }
}

/// ⚡ por hash, escopado por adapter + conta (o mesmo `davail:v1` do Node).
#[napi]
pub struct DavailState {
    inner: DavailStore,
}

#[napi]
impl DavailState {
    /// Abre (ou cria) o `cache.db` em `dbPath`; `:memory:` sobe só em memória.
    #[napi(constructor)]
    pub fn new(db_path: String) -> napi::Result<Self> {
        let inner = if db_path == ":memory:" {
            DavailStore::open_memory()
        } else {
            DavailStore::open(Path::new(&db_path))
        };
        Ok(Self {
            inner: inner.map_err(erro)?,
        })
    }

    /// Veredito de um hash; `null` = ausente ou expirado (expirado é apagado na
    /// leitura, então ausência manda perguntar ao debrid).
    #[napi]
    pub fn get(
        &self,
        adapter: String,
        api_key: String,
        hash: String,
        now_ms: i64,
    ) -> napi::Result<Option<bool>> {
        self.inner
            .get(&adapter, &api_key, &hash, now_ms)
            .map_err(erro)
    }

    /// Lote em uma passada; só os hashes vivos voltam (teto de 200 no store, o
    /// excedente fica sem veredito — erro para o lado seguro).
    #[napi]
    pub fn get_many(
        &self,
        adapter: String,
        api_key: String,
        hashes: Vec<String>,
        now_ms: i64,
    ) -> napi::Result<Vec<DavailFlag>> {
        let answers = self
            .inner
            .get_many(&adapter, &api_key, &hashes, now_ms)
            .map_err(erro)?;
        Ok(answers
            .into_iter()
            .map(|answer| DavailFlag {
                hash: answer.hash,
                cached: answer.cached,
            })
            .collect())
    }

    /// Um veredito. Sem adapter ou sem chave não há conta: não grava nada.
    #[napi]
    pub fn put(
        &self,
        adapter: String,
        api_key: String,
        hash: String,
        cached: bool,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> napi::Result<()> {
        self.inner
            .put(&adapter, &api_key, &hash, cached, ttl_seconds, now_ms)
            .map_err(erro)
    }

    /// Lote em UMA transação. O store aceita TTL por entrada (positivo e
    /// negativo não compartilham janela); esta porta aplica `ttl_seconds` a
    /// todas — quem precisa de janelas diferentes chama `put`.
    #[napi]
    pub fn put_many(
        &self,
        adapter: String,
        api_key: String,
        flags: Vec<DavailFlag>,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> napi::Result<()> {
        let entries: Vec<(String, bool, i64)> = flags
            .into_iter()
            .map(|flag| (flag.hash, flag.cached, ttl_seconds))
            .collect();
        self.inner
            .put_many(&adapter, &api_key, &entries, now_ms)
            .map_err(erro)
    }
}

/// Banco de magnets por conta (`mag:v1`): `alive`/`bad`/`lie` com TTL.
#[napi]
pub struct MagnetStateStore {
    // Nome igual ao da classe napi: o alias `CoreStore` evita o conflito.
    inner: CoreStore,
}

#[napi]
impl MagnetStateStore {
    /// Abre (ou cria) o `cache.db` em `dbPath`; `:memory:` sobe só em memória.
    #[napi(constructor)]
    pub fn new(db_path: String) -> napi::Result<Self> {
        let inner = if db_path == ":memory:" {
            CoreStore::open_memory()
        } else {
            CoreStore::open(Path::new(&db_path))
        };
        Ok(Self {
            inner: inner.map_err(erro)?,
        })
    }

    /// Grava `alive` em lote e devolve quantas chaves NASCERAM (renovação de
    /// chave viva não conta). Hash com `bad` vivo é recusado: o play já provou
    /// que está quebrado. `usize` não atravessa a fronteira napi — sai `u32`.
    #[napi]
    pub fn mark_alive(
        &self,
        adapter: String,
        api_key: String,
        hashes: Vec<String>,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> napi::Result<u32> {
        let born = self
            .inner
            .mark_alive(&adapter, &api_key, &hashes, ttl_seconds, now_ms)
            .map_err(erro)?;
        Ok(born as u32)
    }

    /// Grava `bad` e apaga o `alive` do mesmo hash na MESMA transação. `true` =
    /// a chave `bad` nasceu agora.
    #[napi]
    pub fn mark_bad(
        &self,
        adapter: String,
        api_key: String,
        hash: String,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> napi::Result<bool> {
        self.inner
            .mark_bad(&adapter, &api_key, &hash, ttl_seconds, now_ms)
            .map_err(erro)
    }

    /// Grava `lie` (há vídeo, a promessa de áudio PT não se cumpriu); NÃO apaga
    /// o `alive`. `true` = a chave nasceu agora.
    #[napi]
    pub fn mark_lie(
        &self,
        adapter: String,
        api_key: String,
        hash: String,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> napi::Result<bool> {
        self.inner
            .mark_lie(&adapter, &api_key, &hash, ttl_seconds, now_ms)
            .map_err(erro)
    }

    /// Apaga SÓ o `bad` (reparo); `alive`/`lie` do mesmo hash ficam. `true` =
    /// havia o que apagar.
    #[napi]
    pub fn forget_bad(&self, adapter: String, api_key: String, hash: String) -> napi::Result<bool> {
        self.inner
            .forget_bad(&adapter, &api_key, &hash)
            .map_err(erro)
    }

    /// Estado de um hash, precedência `bad > lie > alive`; `null` = sem
    /// evidência viva.
    #[napi]
    pub fn state(
        &self,
        adapter: String,
        api_key: String,
        hash: String,
        now_ms: i64,
    ) -> napi::Result<Option<String>> {
        let state = self
            .inner
            .state(&adapter, &api_key, &hash, now_ms)
            .map_err(erro)?;
        Ok(state.map(|state| state_label(state).to_string()))
    }

    /// Lote: uma entrada por hash pedido, na ordem pedida (`state: null` quando
    /// não há evidência viva).
    #[napi]
    pub fn state_snapshot(
        &self,
        adapter: String,
        api_key: String,
        hashes: Vec<String>,
        now_ms: i64,
    ) -> napi::Result<Vec<MagnetMark>> {
        let marks = self
            .inner
            .state_snapshot(&adapter, &api_key, &hashes, now_ms)
            .map_err(erro)?;
        Ok(marks.into_iter().map(mark_of).collect())
    }
}

/// `CoreMark` → objeto da fronteira; o enum do core vira rótulo em texto.
fn mark_of(mark: CoreMark) -> MagnetMark {
    MagnetMark {
        hash: mark.hash,
        state: mark.state.map(|state| state_label(state).to_string()),
    }
}
