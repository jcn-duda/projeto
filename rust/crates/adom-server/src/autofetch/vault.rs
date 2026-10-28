//! Cofre em MEMÓRIA da chave de debrid do worker (opção 2 do gate de
//! credencial, `docs/autofetch-worker-credential-gate.md`).
//!
//! O worker roda fora de qualquer requisição e não tem o `RuntimeContext` do
//! Node. A chave chega pelo `encoded` que JÁ viaja no `EffectsBatch`
//! (`tail_effects.rs`), é decodificada com o MESMO caminho do `/resolve`
//! (`resolve_native::debrid_config`) e guardada aqui por `adapter:conta`, onde
//! `conta` é o `accountScope` (`adom_core::account_scope`, `sha256` da chave).
//!
//! # O que este módulo NUNCA faz
//!
//! - não grava em KV, disco nem env: o `Vault` só tem `HashMap` em RAM;
//! - não loga a chave (nem em erro de decodificação, que devolve `None`);
//! - não expõe a chave em `Debug` (redigido) nem em `Serialize` (não implementa
//!   `Serialize`; o status do painel não tem campo de chave);
//! - não sobrevive a restart — igual ao `recheckLots` do Node.
//!
//! A `Entry` zera o próprio buffer no `Drop`: a chave não fica em memória livre
//! depois de expirada, esquecida ou evictada pelo LRU.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Mutex, OnceLock, PoisonError};

use adom_core::account_scope;
use serde_json::Value;

use super::{worker_enabled, Policy};
use crate::resolve_native::{debrid_config, defaults_from_env};

/// A chave em si. Sem `Debug` herdado e sem `Serialize`: qualquer formatação
/// imprime um marcador, nunca o conteúdo.
#[derive(Clone, PartialEq, Eq)]
struct Secret(String);

impl Secret {
    /// Leitora ÚNICA é a fábrica do adaptador por conta (leva do flip). Fora
    /// dela nada neste processo pode extrair a chave.
    #[allow(dead_code)]
    fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // SAFETY: só sobrescrevemos bytes com `0`, que é UTF-8 válido em
        // qualquer posição; o `String` continua consistente até o fim do drop.
        unsafe {
            for byte in self.0.as_bytes_mut() {
                *byte = 0;
            }
        }
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("<redacted>")
    }
}

struct Entry {
    #[allow(dead_code)]
    secret: Secret,
    expires_at: i64,
    /// Ordem de uso: maior = mais recente (o relógio do LRU, sem `Instant` para
    /// o resultado não depender do humor do agendador).
    seq: u64,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    seq: u64,
}

/// Cofre por `adapter:account_scope`. `Clone` não existe de propósito: um só
/// dono por processo, compartilhado por `Arc`.
pub(crate) struct Vault {
    ttl_ms: i64,
    cap: usize,
    resolve_secret: String,
    inner: Mutex<Inner>,
}

impl Vault {
    pub(crate) fn new(ttl_ms: i64, cap: usize, resolve_secret: impl Into<String>) -> Self {
        Self {
            ttl_ms: ttl_ms.max(1),
            cap: cap.max(1),
            resolve_secret: resolve_secret.into(),
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Réguas e `RESOLVE_SECRET` do operador (o mesmo que o `/resolve` usa para
    /// abrir o selo do `dk`).
    pub(crate) fn from_env(policy: &Policy) -> Self {
        Self::new(
            policy.key_ttl_ms,
            policy.vault_cap,
            std::env::var("RESOLVE_SECRET").unwrap_or_default(),
        )
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Escopo do cofre: `adapter:sha256(chave)`. O digest é o `accountScope` do
    /// Node — a fila, o marker e o `dead:` da conta usam o MESMO valor, então o
    /// escopo aqui casa com o estado já persistido.
    pub(crate) fn scope_of(adapter: &str, api_key: &str) -> Option<String> {
        let adapter = adapter.trim().to_ascii_lowercase();
        if adapter.is_empty() || api_key.is_empty() {
            return None;
        }
        Some(format!(
            "{adapter}:{}",
            account_scope(&Value::from(api_key))
        ))
    }

    /// Guarda a chave e devolve o escopo. Chave/serviço vazios não entram.
    pub(crate) fn put(&self, adapter: &str, api_key: &str, now_ms: i64) -> Option<String> {
        let scope = Self::scope_of(adapter, api_key)?;
        let mut inner = self.lock();
        inner.seq += 1;
        let seq = inner.seq;
        inner.entries.insert(
            scope.clone(),
            Entry {
                secret: Secret(api_key.to_string()),
                expires_at: now_ms.saturating_add(self.ttl_ms),
                seq,
            },
        );
        // LRU: só sai o mais antigo em uso, nunca o recém-inserido.
        while inner.entries.len() > self.cap {
            let Some(victim) = inner
                .entries
                .iter()
                .filter(|(key, _)| key.as_str() != scope.as_str())
                .min_by_key(|(_, entry)| entry.seq)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            inner.entries.remove(&victim);
        }
        Some(scope)
    }

    /// Decodifica o `encoded` da busca e guarda a chave da conta, se houver.
    ///
    /// Caminho ÚNICO de leitura do segmento (o mesmo do `/resolve`), então o
    /// selo do `dk` é aberto com o `RESOLVE_SECRET` do operador. Segmento que
    /// não é config, serviço fora do vocabulário ou chave ausente devolvem
    /// `None` sem log e sem escrita.
    pub(crate) fn ingest(&self, encoded: &str, now_ms: i64) -> Option<String> {
        if encoded.is_empty() {
            return None;
        }
        let config =
            debrid_config(Some(encoded), &self.resolve_secret, &defaults_from_env()).ok()?;
        if !config.has_adapter() {
            return None;
        }
        self.put(&config.service, &config.api_key, now_ms)
    }

    /// A chave do escopo, se viva. Uso conta como toque no LRU. Leitora ÚNICA é
    /// a fábrica por conta (`ports::factory`): o laço nunca guarda a chave.
    pub(crate) fn key(&self, scope: &str, now_ms: i64) -> Option<String> {
        let mut inner = self.lock();
        let expired = inner
            .entries
            .get(scope)
            .is_some_and(|entry| entry.expires_at <= now_ms);
        if expired {
            inner.entries.remove(scope);
            return None;
        }
        inner.seq += 1;
        let seq = inner.seq;
        let entry = inner.entries.get_mut(scope)?;
        entry.seq = seq;
        Some(entry.secret.expose().to_string())
    }

    /// Descarta a conta (fim do lote, logout ou chave recusada pelo serviço).
    #[allow(dead_code)]
    pub(crate) fn forget(&self, scope: &str) -> bool {
        self.lock().entries.remove(scope).is_some()
    }

    /// Poda das expiradas. Devolve quantas saíram.
    pub(crate) fn sweep(&self, now_ms: i64) -> usize {
        let mut inner = self.lock();
        let before = inner.entries.len();
        inner.entries.retain(|_, entry| entry.expires_at > now_ms);
        before - inner.entries.len()
    }

    pub(crate) fn len(&self) -> usize {
        self.lock().entries.len()
    }

    /// `Debug` REDIGIDO: contagem e réguas, nunca escopo nem chave. O escopo é
    /// `sha256` da chave (não reversível), mas nem ele sai num `{:?}` que pode
    /// acabar em log de pânico.
    pub(crate) fn redacted(&self) -> String {
        let inner = self.lock();
        format!(
            "Vault {{ contas: {}, ttl_ms: {}, cap: {} }}",
            inner.entries.len(),
            self.ttl_ms,
            self.cap
        )
    }
}

impl fmt::Debug for Vault {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.redacted())
    }
}

/// Cofre do PROCESSO (um só), criado no boot pelo primeiro `tail_effects`.
///
/// Só existe com `AUTOFETCH_WORKER=on`: sem consumidor, guardar chave de usuário
/// em RAM seria exposição sem uso. O teste injeta o cofre explicitamente
/// (`NativeTailEffects::with_vault`), então esta fábrica não interfere nele.
pub(crate) fn shared() -> Option<std::sync::Arc<Vault>> {
    static SHARED: OnceLock<Option<std::sync::Arc<Vault>>> = OnceLock::new();
    SHARED
        .get_or_init(|| {
            worker_enabled().then(|| std::sync::Arc::new(Vault::from_env(&Policy::from_env())))
        })
        .clone()
}

#[cfg(test)]
#[path = "vault_tests.rs"]
mod tests;
