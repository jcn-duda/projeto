//! Memo do `GET /magnet-bank/status`: o painel lê o status a cada poll, e a
//! agregação (`COUNT`/`MAX`/`GROUP BY`) custa ~2 s com o banco frio, o prazo
//! inteiro da ponte do Node. Mesmo TTL do `status()` TS que este corte aposentou
//! (`MAGNET_BANK_STATUS_TTL_MS`, default 60 s; 0 desliga).
//!
//! A captura NÃO invalida: ela grava a cada busca e deixaria o memo sem efeito
//! justo com o app em uso, e um total do painel atrasado até 60 s não decide
//! nada. Só o import invalida, porque o operador espera ver o resultado dele.
//!
//! O lock fica preso durante o cálculo de propósito: polls simultâneos esperam o
//! primeiro em vez de repetir a agregação. Erro não entra no memo.

use std::sync::Mutex;

use serde_json::Value;

const DEFAULT_TTL_MS: i64 = 60_000;

pub(crate) static STATUS_MEMO: StatusMemo = StatusMemo::new();

pub(crate) struct StatusMemo {
    slot: Mutex<Option<(i64, Value)>>,
}

impl StatusMemo {
    pub(crate) const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
        }
    }

    pub(crate) fn get_or_compute<F>(
        &self,
        now_ms: i64,
        ttl_ms: i64,
        compute: F,
    ) -> Result<Value, String>
    where
        F: FnOnce() -> Result<Value, String>,
    {
        let mut slot = self.slot.lock().unwrap_or_else(|err| err.into_inner());
        if let Some((at, value)) = slot.as_ref() {
            // Idade negativa é relógio que voltou: a foto não vale.
            let age = now_ms - *at;
            if (0..ttl_ms).contains(&age) {
                return Ok(value.clone());
            }
        }
        let value = compute()?;
        *slot = (ttl_ms > 0).then(|| (now_ms, value.clone()));
        Ok(value)
    }

    pub(crate) fn invalidate(&self) {
        *self.slot.lock().unwrap_or_else(|err| err.into_inner()) = None;
    }
}

pub(crate) fn status_ttl_ms() -> i64 {
    parse_ttl_ms(std::env::var("MAGNET_BANK_STATUS_TTL_MS").ok().as_deref())
}

/// Ausente ou ilegível cai no default; negativo vira 0, como o `Math.max` do TS.
fn parse_ttl_ms(raw: Option<&str>) -> i64 {
    raw.and_then(|text| text.trim().parse::<i64>().ok())
        .map_or(DEFAULT_TTL_MS, |ttl| ttl.max(0))
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use serde_json::json;

    use super::*;

    const TTL: i64 = 60_000;

    fn read(memo: &StatusMemo, now: i64, ttl: i64, calls: &Cell<u32>) -> Value {
        memo.get_or_compute(now, ttl, || {
            calls.set(calls.get() + 1);
            Ok(json!({ "call": calls.get() }))
        })
        .unwrap()
    }

    #[test]
    fn dentro_do_ttl_nao_recalcula_e_depois_recalcula() {
        let memo = StatusMemo::new();
        let calls = Cell::new(0);
        assert_eq!(read(&memo, 1_000, TTL, &calls), json!({ "call": 1 }));
        assert_eq!(
            read(&memo, 1_000 + TTL - 1, TTL, &calls),
            json!({ "call": 1 })
        );
        assert_eq!(read(&memo, 1_000 + TTL, TTL, &calls), json!({ "call": 2 }));
    }

    #[test]
    fn ttl_zero_desliga_o_memo() {
        let memo = StatusMemo::new();
        let calls = Cell::new(0);
        read(&memo, 1_000, 0, &calls);
        read(&memo, 1_000, 0, &calls);
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn invalidar_forca_o_proximo_calculo() {
        let memo = StatusMemo::new();
        let calls = Cell::new(0);
        read(&memo, 1_000, TTL, &calls);
        memo.invalidate();
        read(&memo, 1_001, TTL, &calls);
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn erro_nao_entra_no_memo() {
        let memo = StatusMemo::new();
        let calls = Cell::new(0);
        assert!(memo
            .get_or_compute(1_000, TTL, || Err("falhou".to_string()))
            .is_err());
        read(&memo, 1_001, TTL, &calls);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn relogio_que_voltou_recalcula() {
        let memo = StatusMemo::new();
        let calls = Cell::new(0);
        read(&memo, 5_000, TTL, &calls);
        read(&memo, 4_000, TTL, &calls);
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn ttl_do_env_cai_no_default_e_nao_fica_negativo() {
        assert_eq!(parse_ttl_ms(None), DEFAULT_TTL_MS);
        assert_eq!(parse_ttl_ms(Some("lixo")), DEFAULT_TTL_MS);
        assert_eq!(parse_ttl_ms(Some("0")), 0);
        assert_eq!(parse_ttl_ms(Some("-5")), 0);
        assert_eq!(parse_ttl_ms(Some("1500")), 1_500);
    }
}
