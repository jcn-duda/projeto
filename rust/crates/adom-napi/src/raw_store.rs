//! Handle do `raw:v1` para o Node (F3, dono único no Rust).
//!
//! O store mora no `adom-index` (`RawCacheStore`, MESMO `cache.db` do Node);
//! aqui é só a casca napi. O Node não carrega nem regrava linhas `raw` no
//! L1/L2 (`RUST_OWNED`): a leitura do diagnóstico (`trace-recompute`) e o
//! clear-cache passam por esta ponte — o mesmo desenho do `IdxStore`.

use std::path::Path;

use adom_index::{is_raw_key, RawCacheStore};
use napi::Error;
use napi_derive::napi;

fn erro(err: String) -> Error {
    Error::from_reason(err)
}

#[napi]
pub struct RawStore {
    inner: RawCacheStore,
}

#[napi]
impl RawStore {
    /// Abre (ou cria) o `cache.db` em `dbPath`; `:memory:` sobe só em memória
    /// (`CACHE_PERSIST=false`).
    #[napi(constructor)]
    pub fn new(db_path: String) -> napi::Result<Self> {
        let inner = if db_path == ":memory:" {
            RawCacheStore::open_memory()
        } else {
            RawCacheStore::open(Path::new(&db_path))
        };
        Ok(Self {
            inner: inner.map_err(erro)?,
        })
    }

    /// Leitura quiet de uma linha viva do namespace (`null` se ausente ou
    /// expirada). JSON em texto: o envelope `{items}` cru, como o escritor
    /// gravou. Chave de fora do namespace é erro de contrato, não miss.
    #[napi]
    pub fn peek_json(&self, key: String, now_ms: i64) -> napi::Result<Option<String>> {
        if !is_raw_key(&key) {
            return Err(erro(format!(
                "chave fora do namespace raw: {key} (esperado prefixo raw:v1:)"
            )));
        }
        let value = self.inner.peek(&key, now_ms).map_err(erro)?;
        Ok(value.map(|v| v.to_string()))
    }

    /// Grava o envelope cru (testes e diagnóstico; o caminho vivo de escrita
    /// é o coletor BLUDV dentro do gateway).
    #[napi]
    pub fn set_json(
        &self,
        key: String,
        value_json: String,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> napi::Result<()> {
        let value: serde_json::Value = serde_json::from_str(&value_json)
            .map_err(|err| erro(format!("JSON inválido: {err}")))?;
        self.inner
            .set_raw(&key, &value, ttl_seconds.max(0) as u64, now_ms)
            .map_err(erro)?;
        Ok(())
    }

    /// Apaga o namespace `raw` inteiro; devolve quantas linhas saíram.
    #[napi]
    pub fn clear(&self) -> napi::Result<i64> {
        self.inner.clear_all().map(|n| n as i64).map_err(erro)
    }

    /// Linhas do namespace (diagnóstico).
    #[napi]
    pub fn len(&self) -> napi::Result<i64> {
        self.inner.len().map(|n| n as i64).map_err(erro)
    }

    /// Par do `len`; o namespace vazio é o caso normal antes da 1ª coleta.
    #[napi]
    pub fn is_empty(&self) -> napi::Result<bool> {
        self.inner.is_empty().map_err(erro)
    }
}
