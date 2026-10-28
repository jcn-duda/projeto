//! Memo da sonda de conta (`debrid.account()`) usada pelo gate `pauseAt`.
//!
//! # Por que existe
//!
//! `classify_enqueue` consulta `accountBlocked` ANTES de `tryBudget`
//! (`src/providers/autofetch-gates.ts:57`), e o runner pergunta ao provedor a
//! cada candidato. O TS corta essa repetição com um memo de PROCESSO
//! (`accountGateMemo`, `src/providers/autofetch-gate.ts`): a chave é
//! `adapter.id:accountScope(apiKey)` e a validade é
//! `Date.now() - memo.at < live.autoFetchPauseRefreshMs`. Sem o memo, cada lote
//! paga uma chamada HTTP de conta mesmo com `pauseAt` configurado.
//!
//! # Divergências declaradas (TS → aqui)
//!
//! - **onde mora**: o TS usa um `Map` de módulo; aqui o memo vai para o KV do
//!   worker, no namespace já usado pelo orçamento
//!   (`autofetch-worker:v1:budget:`), com a chave pedida no contrato
//!   (`autofetch-worker:v1:account:<sha256(adapter:account)>`). Motivo: o
//!   worker nativo é um processo de vida longa COM store durável, e o dreno
//!   (`enqueue_drain`) roda em outro passo lógico — um memo só de processo
//!   faria a mesma conta ser perguntada duas vezes na mesma janela;
//! - **memo frio**: o TS responde FAIL-OPEN e atualiza em background; aqui a
//!   primeira leitura pergunta ao serviço e espera a resposta. Motivo: este
//!   caminho NUNCA está na resposta ao usuário (o lote já chegou pelo canal),
//!   então esperar não custa latência percebida e evita decidir com evidência
//!   que o processo ainda não tem;
//! - **resposta de erro**: nunca é cacheada. `Err` do adaptador devolve
//!   `None` (fail-open, o mesmo do `account_is_blocked` sem medição) e deixa o
//!   memo como estava — a próxima leva pergunta de novo. Só um `Ok` com
//!   evidência vira memo.
//!
//! `autoFetchPauseRefreshMs = 0` desliga o memo: o TS com janela zero nunca
//! considera o memo fresco, e aqui não se escreve nada (TTL `<= 0` no KV é
//! permanente — escrever com janela zero seria cachear para sempre).

use adom_autofetch::v3::{sha256_hex, AutofetchDebrid};
use adom_index::NativeKv;
use serde_json::{json, Value};

const ACCOUNT_PREFIX: &str = "autofetch-worker:v1:account:";

/// Leitura do memo: fresco (com o uso medido) ou ausente.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AccountMemo {
    /// Uso medido dentro da janela. `None` = o serviço não publica quota.
    Fresh(Option<u64>),
    /// Sem memo utilizável (inexistente, vencido, ilegível ou janela desligada).
    Absent,
}

pub(super) fn account_key(adapter: &str, account: &str) -> String {
    // O escopo já é digestado; hash novamente evita que delimitadores ou
    // conteúdo externo alterem o prefixo administrativo (mesma régua do
    // `budget_key`).
    format!(
        "{ACCOUNT_PREFIX}{}",
        sha256_hex(&format!("{adapter}:{account}"))
    )
}

/// Lê o memo. NUNCA devolve erro: KV ilegível é memo ausente (fail-open — quem
/// responde é o serviço).
pub(super) fn read(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    refresh_ms: i64,
    now_ms: i64,
) -> AccountMemo {
    if refresh_ms <= 0 {
        return AccountMemo::Absent;
    }
    let Ok(Some(value)) = kv.get_json(&account_key(adapter, account), now_ms) else {
        return AccountMemo::Absent;
    };
    parse(&value, refresh_ms, now_ms).unwrap_or(AccountMemo::Absent)
}

fn parse(value: &Value, refresh_ms: i64, now_ms: i64) -> Option<AccountMemo> {
    let at = value.get("at")?.as_i64()?;
    // O TTL do KV é arredondado para segundos; a janela REAL é esta conta.
    if now_ms.saturating_sub(at) >= refresh_ms {
        return None;
    }
    let slot = value.get("used")?;
    if slot.is_null() {
        return Some(AccountMemo::Fresh(None));
    }
    Some(AccountMemo::Fresh(Some(slot.as_u64()?)))
}

/// Grava o memo medido. Erro de escrita é descartado de propósito: o memo é
/// OTIMIZAÇÃO, não fato do lote — derrubar o enfileiramento porque o cache.db
/// recusou uma linha seria pior que repetir a pergunta.
pub(super) fn write(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    used: Option<u64>,
    refresh_ms: i64,
    now_ms: i64,
) {
    if refresh_ms <= 0 {
        return;
    }
    let ttl_seconds = (refresh_ms / 1000).max(1);
    let _ = kv.put_json(
        &account_key(adapter, account),
        &json!({ "at": now_ms, "used": used }),
        ttl_seconds,
        now_ms,
    );
}

/// Uso da conta para o gate: memo fresco ou uma pergunta ao serviço.
///
/// `None` = sem medição (gate fail-open, como `account_is_blocked(None, …)`).
pub(super) async fn probe(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    debrid: &dyn AutofetchDebrid<Error = String>,
    refresh_ms: i64,
    now_ms: i64,
) -> Option<u64> {
    if let AccountMemo::Fresh(used) = read(kv, adapter, account, refresh_ms, now_ms) {
        return used;
    }
    // Erro do serviço NÃO vira memo: a próxima leva pergunta de novo.
    let Ok(evidence) = debrid.account().await else {
        return None;
    };
    write(kv, adapter, account, evidence.used, refresh_ms, now_ms);
    evidence.used
}

#[cfg(test)]
#[path = "enqueue_account_tests.rs"]
mod tests;
