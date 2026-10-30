//! Credencial do warmer: cofre da sessão + conta do operador (painel > `.env`).
//!
//! O painel grava `cfg:v1:harvesterDebrid` com a chave selada pelo
//! `secret-box` do Node (`enc.v1.` + AES-256-GCM derivado do `RESOLVE_SECRET`).
//! O `adom_core::unseal_dk` abre o MESMO formato; aqui só se decide QUAL conta
//! vale e com qual escopo.
//!
//! # Precedência
//!
//! 1. chave vinda de uma requisição (cofre em RAM, TTL 6 h) para o próprio
//!    escopo `realdebrid:<sha256>`;
//! 2. painel (`cfg:v1:harvesterDebrid`) — fonte ÚNICA do conceito: gravar outro
//!    serviço DESLIGA o warm e NÃO cai no `.env` por baixo;
//! 3. `.env` com `DEBRID_ALLOW_ENV_KEY`/`DEBRID_OPERATOR_ENV_ACCOUNT` e
//!    `DEBRID_SERVICE=realdebrid`.
//!
//! A chave nunca entra em log, `Debug` ou JSON de status. O cache é por
//! impressão digital do painel/env: troca no painel vale na drenagem seguinte,
//! sem derivar o scrypt a cada tick.

use std::sync::{Arc, Mutex, PoisonError};

use adom_core::{prefix, unseal_dk};
use adom_index::NativeKv;
use serde_json::Value;

use super::{env_flag_default, env_text};
use crate::autofetch::Vault;
use crate::rd_warmer::WarmKey;

#[derive(Clone)]
struct OperatorAccount {
    key: String,
    scope: String,
    source: &'static str,
}

pub(super) struct OperatorAccounts {
    vault: Option<Arc<Vault>>,
    kv: Option<Arc<NativeKv>>,
    resolve_secret: String,
    /// `(impressão digital, conta)` — `None` também é cacheado (painel que
    /// aponta para outro serviço não pode cair no `.env`).
    cache: Mutex<Option<(String, Option<OperatorAccount>)>>,
}

impl OperatorAccounts {
    pub(super) fn new(vault: Option<Arc<Vault>>, kv: Option<Arc<NativeKv>>) -> Self {
        Self {
            vault,
            kv,
            resolve_secret: std::env::var("RESOLVE_SECRET").unwrap_or_default(),
            cache: Mutex::new(None),
        }
    }

    fn panel(&self, now_ms: i64) -> Option<Value> {
        self.kv
            .as_deref()?
            .get_json(&format!("{}harvesterDebrid", prefix("cfg")), now_ms)
            .ok()
            .flatten()
    }

    fn operator(&self, now_ms: i64) -> Option<OperatorAccount> {
        let panel = self.panel(now_ms);
        let fingerprint = match panel.as_ref() {
            Some(value) => format!(
                "panel:{}:{}",
                value.get("service").and_then(Value::as_str).unwrap_or(""),
                value.get("sealedKey").and_then(Value::as_str).unwrap_or("")
            ),
            None => format!(
                "env:{}:{}:{}:{}",
                env_flag_default("DEBRID_ALLOW_ENV_KEY", true),
                env_flag_default("DEBRID_OPERATOR_ENV_ACCOUNT", false),
                env_text("DEBRID_SERVICE"),
                env_text("DEBRID_API_KEY")
            ),
        };
        {
            let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some((known, account)) = cache.as_ref() {
                if *known == fingerprint {
                    return account.clone();
                }
            }
        }
        let account = self.resolve(panel.as_ref());
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        *cache = Some((fingerprint, account.clone()));
        account
    }

    fn resolve(&self, panel: Option<&Value>) -> Option<OperatorAccount> {
        if let Some(value) = panel {
            let service = value
                .get("service")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let sealed = value.get("sealedKey").and_then(Value::as_str).unwrap_or("");
            // Painel gravado = fonte ÚNICA do conceito: serviço não-RD (ou
            // selo que não abre) desliga o warm e NÃO cai no `.env` por baixo.
            if service != "realdebrid" || sealed.is_empty() {
                return None;
            }
            let key = unseal_dk(sealed, &self.resolve_secret);
            return account_from("panel", &key);
        }
        let gate = env_flag_default("DEBRID_ALLOW_ENV_KEY", true)
            || env_flag_default("DEBRID_OPERATOR_ENV_ACCOUNT", false);
        if !gate {
            return None;
        }
        if !env_text("DEBRID_SERVICE").eq_ignore_ascii_case("realdebrid") {
            return None;
        }
        account_from("env", &env_text("DEBRID_API_KEY"))
    }

    fn vault_key(&self, scope: &str, now_ms: i64) -> Option<String> {
        let account = scope.strip_prefix("realdebrid:")?;
        if account.is_empty() {
            return None;
        }
        self.vault.as_deref()?.key(scope, now_ms)
    }
}

fn account_from(source: &'static str, key: &str) -> Option<OperatorAccount> {
    if key.is_empty() {
        return None;
    }
    Some(OperatorAccount {
        key: key.to_string(),
        scope: Vault::scope_of("realdebrid", key)?,
        source,
    })
}

impl WarmKey for OperatorAccounts {
    fn rd_key(&self, scope: &str, now_ms: i64) -> Option<String> {
        // Escopo com credencial de requisição manda no próprio escopo.
        if let Some(key) = self.vault_key(scope, now_ms) {
            return Some(key);
        }
        let operator = self.operator(now_ms)?;
        if scope.is_empty() || scope == operator.scope {
            Some(operator.key)
        } else {
            None
        }
    }

    fn default_scope(&self, now_ms: i64) -> Option<String> {
        self.operator(now_ms).map(|operator| operator.scope)
    }

    fn account_source(&self, now_ms: i64) -> &'static str {
        self.operator(now_ms)
            .map(|operator| operator.source)
            .unwrap_or("none")
    }
}
