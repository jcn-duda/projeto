//! Handle do KV nativo (`NativeKv` do `adom-index`) para o Node.
//!
//! O store mora no `adom-index` (MESMO `data/cache.db` do Node, tabela
//! `cache`); aqui é só a casca napi — o mesmo desenho do `RawStore`. O Node
//! não carrega nem regrava no L1/L2 os namespaces que o Rust passou a possuir
//! (fila/estado do Chupim, posse/proteção do AllDebrid): lê por esta ponte.

use std::path::Path;

use adom_index::NativeKv as KvStore;
use napi::Error;
use napi_derive::napi;

fn erro(err: String) -> Error {
    Error::from_reason(err)
}

#[napi]
pub struct NativeKv {
    inner: KvStore,
}

#[napi]
impl NativeKv {
    /// Abre (ou cria) o `cache.db` em `dbPath`; `:memory:` sobe só em memória.
    #[napi(constructor)]
    pub fn new(db_path: String) -> napi::Result<Self> {
        let inner = if db_path == ":memory:" {
            KvStore::open_memory()
        } else {
            KvStore::open(Path::new(&db_path))
        };
        Ok(Self {
            inner: inner.map_err(erro)?,
        })
    }

    /// JSON cru da chave viva (`null` = ausente ou expirada; expirada é
    /// apagada na leitura, como o `cache.get` do Node).
    #[napi]
    pub fn get_json(&self, key: String, now_ms: i64) -> napi::Result<Option<String>> {
        let value = self.inner.get_json(&key, now_ms).map_err(erro)?;
        Ok(value.map(|v| v.to_string()))
    }

    /// Chaves vivas com o prefixo; as expiradas que a varredura encontra saem
    /// do banco na mesma passada (poda do namespace).
    #[napi]
    pub fn keys(&self, prefix: String, now_ms: i64) -> napi::Result<Vec<String>> {
        self.inner.keys_matching(&prefix, now_ms).map_err(erro)
    }

    /// Grava o valor JSON; `ttlSeconds <= 0` é permanente. O caminho vivo de
    /// escrita é o gateway/worker — esta porta existe para os testes e para a
    /// migração das fatias seguintes.
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
            .put_json(&key, &value, ttl_seconds, now_ms)
            .map_err(erro)
    }

    /// Remove a chave (`cache.forget` do Node). `false` = não havia nada.
    #[napi]
    pub fn forget(&self, key: String) -> napi::Result<bool> {
        self.inner.forget(&key).map_err(erro)
    }

    /// TTL restante em segundos (régua do `cache.peekRemaining`); `null` para
    /// ausente, permanente ou vencida.
    #[napi]
    pub fn remaining_seconds(&self, key: String, now_ms: i64) -> napi::Result<Option<i64>> {
        self.inner.remaining_seconds(&key, now_ms).map_err(erro)
    }

    /// Apaga o namespace inteiro (`clearNamespace` de um dono Rust) e devolve
    /// quantas linhas saíram.
    #[napi]
    pub fn forget_prefix(&self, prefix: String) -> napi::Result<u32> {
        self.inner.forget_prefix(&prefix).map_err(erro)
    }
}
