//! Outbox de invalidação (`harvest:v1:outbox`) — o que o colhedor precisa
//! invalidar no índice depois de gravar.
//!
//! UMA chave com a lista JSON inteira (não uma chave por alvo): o lote é pequeno,
//! a escrita é uma só e o `ack` é um filtro. O cemitério
//! ([`OUTBOX_DEAD_KEY`]) existe para o alvo que estourou as tentativas aparecer
//! no painel em vez de sumir em silêncio.
//!
//! Lista ausente, expirada ou ilegível vale lista vazia: outbox é entrega
//! best-effort, não pode derrubar o drain.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::store::HarvestStore;

/// Lista viva: alvos ainda não confirmados pelo índice.
pub const OUTBOX_KEY: &str = "harvest:v1:outbox";

/// Cemitério: alvos que passaram de [`OUTBOX_MAX_TRIES`].
pub const OUTBOX_DEAD_KEY: &str = "harvest:v1:outbox:dead";

/// Tentativas antes da morte; a `OUTBOX_MAX_TRIES + 1`ª move para o cemitério.
pub const OUTBOX_MAX_TRIES: u32 = 5;

/// 30 dias: alvo que ninguém drenou por um mês é lixo, mas o painel ainda o vê.
pub const OUTBOX_TTL_SECONDS: u64 = 2_592_000;

/// Teto de um lote de drain.
pub const OUTBOX_BATCH_LIMIT: usize = 20;

/// Um alvo a invalidar, com o relógio do pedido original e as tentativas gastas.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    /// `obra:<imdb>` ou `hash:<hex>`.
    pub target: String,
    /// Epoch ms do pedido. O dedupe NÃO o renova (a idade é do primeiro pedido).
    pub at_ms: i64,
    /// Quantas vezes o drain já tentou entregar.
    pub tries: u32,
}

impl HarvestStore {
    /// Enfileira o alvo. Dedupe por `target`: repetido mantém `at_ms`/`tries` do
    /// existente e não duplica (o TTL renova de qualquer forma).
    pub fn outbox_push(&self, target: &str, now_ms: i64) -> Result<(), String> {
        let mut list = self.read_outbox(OUTBOX_KEY, now_ms)?;
        if !list.iter().any(|item| item.target == target) {
            list.push(OutboxItem {
                target: target.to_string(),
                at_ms: now_ms,
                tries: 0,
            });
        }
        self.write_outbox(OUTBOX_KEY, &list, now_ms)
    }

    /// Pega até `limit` alvos para entregar, DEBITANDO uma tentativa de cada um.
    ///
    /// O alvo que passa de [`OUTBOX_MAX_TRIES`] sai da outbox e vai para
    /// [`OUTBOX_DEAD_KEY`] na MESMA chamada — nunca some em silêncio. Morto não
    /// ocupa vaga do lote: o próximo vivo é tentado nesta mesma passagem.
    pub fn outbox_take(&self, limit: usize, now_ms: i64) -> Result<Vec<OutboxItem>, String> {
        let list = self.read_outbox(OUTBOX_KEY, now_ms)?;
        if limit == 0 || list.is_empty() {
            return Ok(Vec::new());
        }
        let mut batch = Vec::new();
        let mut kept = Vec::new();
        let mut dead = Vec::new();
        for mut item in list {
            if batch.len() >= limit {
                kept.push(item);
                continue;
            }
            item.tries = item.tries.saturating_add(1);
            if item.tries > OUTBOX_MAX_TRIES {
                dead.push(item);
            } else {
                batch.push(item.clone());
                kept.push(item);
            }
        }
        if !dead.is_empty() {
            let mut buried = self.read_outbox(OUTBOX_DEAD_KEY, now_ms)?;
            buried.extend(dead);
            // Cemitério primeiro: se o `save` da outbox falhar, o item está nos
            // dois lados (reentrega) em vez de não estar em nenhum.
            self.write_outbox(OUTBOX_DEAD_KEY, &buried, now_ms)?;
        }
        self.write_outbox(OUTBOX_KEY, &kept, now_ms)?;
        Ok(batch)
    }

    /// Confirma o lote: remove os `target` devolvidos. Idempotente — alvo já
    /// removido não é erro (o drain pode repetir o ack depois de um restart).
    pub fn outbox_ack(&self, batch: &[OutboxItem], now_ms: i64) -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        let list = self.read_outbox(OUTBOX_KEY, now_ms)?;
        if list.is_empty() {
            return Ok(());
        }
        let done: HashSet<&str> = batch.iter().map(|item| item.target.as_str()).collect();
        let kept: Vec<OutboxItem> = list
            .into_iter()
            .filter(|item| !done.contains(item.target.as_str()))
            .collect();
        self.write_outbox(OUTBOX_KEY, &kept, now_ms)
    }

    /// Lista viva sem debitar tentativa (painel/diagnóstico).
    pub fn outbox_pending(&self, now_ms: i64) -> Result<Vec<OutboxItem>, String> {
        self.read_outbox(OUTBOX_KEY, now_ms)
    }

    /// O cemitério — alvos que estouraram as tentativas.
    pub fn outbox_dead(&self, now_ms: i64) -> Result<Vec<OutboxItem>, String> {
        self.read_outbox(OUTBOX_DEAD_KEY, now_ms)
    }

    /// Lista ausente, expirada ou ilegível → vazia (o drain segue).
    fn read_outbox(&self, key: &str, now_ms: i64) -> Result<Vec<OutboxItem>, String> {
        let Some(raw) = self.get_value(key, now_ms)? else {
            return Ok(Vec::new());
        };
        Ok(serde_json::from_str(&raw).unwrap_or_default())
    }

    /// Uma chave por lista, TTL renovado em toda escrita; lista vazia apaga a
    /// linha (chave vazia não precisa viver 30 dias).
    fn write_outbox(&self, key: &str, items: &[OutboxItem], now_ms: i64) -> Result<(), String> {
        if items.is_empty() {
            return self.forget_key(key).map(|_| ());
        }
        let encoded =
            serde_json::to_string(items).map_err(|err| format!("serializar outbox: {err}"))?;
        self.put_value(key, &encoded, OUTBOX_TTL_SECONDS, now_ms)
    }
}
