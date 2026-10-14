//! Controle de taxa e medição de custo do motor de raspagem.
//!
//! Equivalente Rust a `src/providers/crawl-rate.ts`.
//! Fornece:
//! - [`HourCounter`]: contador de requisições/páginas por hora civil (epoch / 3_600_000).
//!   Descarta baldes anteriores na leitura e suporta injeção de timestamp para testes com relógio falso.
//! - [`CostMeter`]: medição do custo médio observado por página (requisições ÷ páginas).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Duração de uma hora civil em milissegundos.
pub const HOUR_MS: i64 = 3_600_000;

/// Calcula o índice do balde de hora civil correspondente ao timestamp `now_ms`.
/// Utiliza divisão euclidiana (`div_euclid`) equivalente a `floor(now_ms / 3_600_000)`.
#[inline]
pub fn hour_of(now_ms: i64) -> i64 {
    now_ms.div_euclid(HOUR_MS)
}

/// Contador de páginas/requisições por hora civil do raspador.
///
/// Balde indexado por `floor(now_ms / 3_600_000)`. Baldes anteriores à hora corrente
/// são descartados na leitura (`current`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HourCounter {
    buckets: BTreeMap<i64, i64>,
}

impl HourCounter {
    /// Cria um novo contador de hora vazio.
    pub fn new() -> Self {
        Self {
            buckets: BTreeMap::new(),
        }
    }

    /// Retorna a contagem acumulada no balde da hora civil de `now_ms`.
    /// Descarta quaisquer baldes anteriores à hora corrente (`bucket < hour`).
    pub fn current(&mut self, now_ms: i64) -> i64 {
        let hour = hour_of(now_ms);
        self.buckets.retain(|&bucket, _| bucket >= hour);
        self.buckets.get(&hour).copied().unwrap_or(0)
    }

    /// Anota `amount` unidades no balde da hora civil de `now_ms`.
    ///
    /// Se `amount <= 0`, o valor é tratado como no mínimo 1 (comportamento idêntico ao TS).
    pub fn note(&mut self, amount: i64, now_ms: i64) {
        let n = amount.max(1);
        let hour = hour_of(now_ms);
        *self.buckets.entry(hour).or_insert(0) += n;
    }

    /// Zera todos os baldes registrados.
    pub fn clear(&mut self) {
        self.buckets.clear();
    }

    /// Quantidade de baldes ativos em memória (útil para asserções e monitoramento).
    pub fn bucket_count(&self) -> usize {
        self.buckets.len()
    }
}

/// Cria uma instância padrão de [`HourCounter`].
pub fn create_hour_counter() -> HourCounter {
    HourCounter::new()
}

/// Custo médio observado por página (requisições ÷ páginas desde o boot).
///
/// Sem páginas medidas, `avg()` devolve `None`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CostMeter {
    /// Total de requisições / custo acumulado.
    pub total: i64,
    /// Total de páginas processadas.
    pub pages: i64,
}

impl CostMeter {
    /// Cria um novo medidor de custo zerado.
    pub fn new() -> Self {
        Self { total: 0, pages: 0 }
    }

    /// Anota o custo de uma página processada.
    ///
    /// Se `cost <= 0`, é tratado como no mínimo 1 (comportamento idêntico ao TS).
    pub fn note(&mut self, cost: i64) {
        let c = cost.max(1);
        self.total += c;
        self.pages += 1;
    }

    /// Retorna a média `total / pages` arredondada para 2 casas decimais,
    /// ou `None` caso `pages == 0`.
    pub fn avg(&self) -> Option<f64> {
        if self.pages == 0 {
            None
        } else {
            let ratio = (self.total as f64) / (self.pages as f64);
            Some((ratio * 100.0).round() / 100.0)
        }
    }

    /// Zera as medições acumuladas.
    pub fn reset(&mut self) {
        self.total = 0;
        self.pages = 0;
    }

    /// Alias para `reset()`.
    pub fn clear(&mut self) {
        self.reset();
    }
}

/// Cria uma instância padrão de [`CostMeter`].
pub fn create_cost_meter() -> CostMeter {
    CostMeter::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hour_of_calculation() {
        assert_eq!(hour_of(0), 0);
        assert_eq!(hour_of(3_599_999), 0);
        assert_eq!(hour_of(3_600_000), 1);
        assert_eq!(hour_of(7_199_999), 1);
        assert_eq!(hour_of(7_200_000), 2);
        // Teste de timestamp negativo para verificar div_euclid
        assert_eq!(hour_of(-1), -1);
        assert_eq!(hour_of(-3_600_000), -1);
        assert_eq!(hour_of(-3_600_001), -2);
    }

    #[test]
    fn test_hour_counter_empty_initial() {
        let mut counter = HourCounter::new();
        assert_eq!(counter.current(0), 0);
        assert_eq!(counter.current(1_000_000), 0);
        assert_eq!(counter.bucket_count(), 0);
    }

    #[test]
    fn test_hour_counter_accumulates_in_same_hour() {
        let mut counter = create_hour_counter();
        let t0 = 1_000_000; // hora 0

        counter.note(1, t0);
        assert_eq!(counter.current(t0), 1);

        counter.note(5, t0 + 200);
        assert_eq!(counter.current(t0 + 500), 6);

        counter.note(10, t0 + 1_500_000);
        assert_eq!(counter.current(t0 + 2_000_000), 16);
        assert_eq!(counter.bucket_count(), 1);
    }

    #[test]
    fn test_hour_counter_civil_hour_rollover() {
        let mut counter = HourCounter::new();
        let end_of_hour_0 = 3_599_999;
        let start_of_hour_1 = 3_600_000;

        counter.note(10, end_of_hour_0);
        assert_eq!(counter.current(end_of_hour_0), 10);

        // Virada da hora civil: novo balde começa zerado
        assert_eq!(counter.current(start_of_hour_1), 0);

        // Adiciona na hora 1
        counter.note(4, start_of_hour_1 + 50_000);
        assert_eq!(counter.current(start_of_hour_1 + 100_000), 4);
    }

    #[test]
    fn test_hour_counter_discards_old_buckets_on_read() {
        let mut counter = HourCounter::new();
        let h1_ms = 3_600_000;
        let h2_ms = 7_200_000;
        let h3_ms = 10_800_000;

        counter.note(5, h1_ms);
        counter.note(8, h2_ms);
        assert_eq!(counter.bucket_count(), 2);

        // Leitura em h2 descarta h1 mas preserva h2
        assert_eq!(counter.current(h2_ms), 8);
        assert_eq!(counter.bucket_count(), 1);

        // Leitura em h3 descarta h2 também
        assert_eq!(counter.current(h3_ms), 0);
        assert_eq!(counter.bucket_count(), 0);
    }

    #[test]
    fn test_hour_counter_jump_multiple_hours() {
        let mut counter = HourCounter::new();
        let h5_ms = 5 * HOUR_MS;
        let h50_ms = 50 * HOUR_MS;

        counter.note(42, h5_ms);
        assert_eq!(counter.bucket_count(), 1);

        // Salto direto para hora 50
        assert_eq!(counter.current(h50_ms), 0);
        assert_eq!(counter.bucket_count(), 0);
    }

    #[test]
    fn test_hour_counter_amount_clamping() {
        let mut counter = HourCounter::new();
        let t = 1_000;

        // amount <= 0 é tratado como no mínimo 1 (igual a Math.max(1, amount))
        counter.note(0, t);
        assert_eq!(counter.current(t), 1);

        counter.note(-10, t);
        assert_eq!(counter.current(t), 2);

        counter.note(15, t);
        assert_eq!(counter.current(t), 17);
    }

    #[test]
    fn test_hour_counter_clear() {
        let mut counter = HourCounter::new();
        counter.note(10, HOUR_MS);
        counter.note(20, 2 * HOUR_MS);
        assert_eq!(counter.bucket_count(), 2);

        counter.clear();
        assert_eq!(counter.bucket_count(), 0);
        assert_eq!(counter.current(2 * HOUR_MS), 0);
    }

    #[test]
    fn test_hour_counter_serde() {
        let mut counter = HourCounter::new();
        counter.note(12, 10 * HOUR_MS);
        counter.note(24, 11 * HOUR_MS);

        let json = serde_json::to_string(&counter).expect("serialize");
        let mut deserialized: HourCounter = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(deserialized.current(11 * HOUR_MS), 24);
    }

    #[test]
    fn test_cost_meter_empty() {
        let meter = CostMeter::new();
        assert_eq!(meter.total, 0);
        assert_eq!(meter.pages, 0);
        assert_eq!(meter.avg(), None);

        let default_meter = CostMeter::default();
        assert_eq!(default_meter.avg(), None);

        let created = create_cost_meter();
        assert_eq!(created.avg(), None);
    }

    #[test]
    fn test_cost_meter_notes_and_avg() {
        let mut meter = CostMeter::new();
        meter.note(1);
        assert_eq!(meter.total, 1);
        assert_eq!(meter.pages, 1);
        assert_eq!(meter.avg(), Some(1.0));

        meter.note(2);
        assert_eq!(meter.total, 3);
        assert_eq!(meter.pages, 2);
        assert_eq!(meter.avg(), Some(1.5));
    }

    #[test]
    fn test_cost_meter_clamping_non_positive_costs() {
        let mut meter = CostMeter::new();
        meter.note(0); // vira 1
        assert_eq!(meter.total, 1);
        assert_eq!(meter.pages, 1);

        meter.note(-5); // vira 1
        assert_eq!(meter.total, 2);
        assert_eq!(meter.pages, 2);
        assert_eq!(meter.avg(), Some(1.0));
    }

    #[test]
    fn test_cost_meter_decimal_rounding() {
        let mut meter = CostMeter::new();

        // 10 / 3 = 3.333333333... -> 3.33
        meter.note(4);
        meter.note(3);
        meter.note(3);
        assert_eq!(meter.total, 10);
        assert_eq!(meter.pages, 3);
        assert_eq!(meter.avg(), Some(3.33));

        // 5 / 3 = 1.666666666... -> 1.67
        let mut meter2 = CostMeter::new();
        meter2.note(2);
        meter2.note(2);
        meter2.note(1);
        assert_eq!(meter2.total, 5);
        assert_eq!(meter2.pages, 3);
        assert_eq!(meter2.avg(), Some(1.67));

        // 10 / 7 = 1.4285714... -> 1.43
        let mut meter3 = CostMeter::new();
        meter3.total = 10;
        meter3.pages = 7;
        assert_eq!(meter3.avg(), Some(1.43));

        // 1 / 8 = 0.125 -> 0.13
        let mut meter4 = CostMeter::new();
        meter4.total = 1;
        meter4.pages = 8;
        assert_eq!(meter4.avg(), Some(0.13));
    }

    #[test]
    fn test_cost_meter_reset_and_clear() {
        let mut meter = CostMeter::new();
        meter.note(15);
        meter.note(25);
        assert_eq!(meter.pages, 2);
        assert_eq!(meter.total, 40);

        meter.reset();
        assert_eq!(meter.total, 0);
        assert_eq!(meter.pages, 0);
        assert_eq!(meter.avg(), None);

        meter.note(5);
        assert_eq!(meter.pages, 1);
        meter.clear();
        assert_eq!(meter.total, 0);
        assert_eq!(meter.pages, 0);
        assert_eq!(meter.avg(), None);
    }

    #[test]
    fn test_cost_meter_serde() {
        let mut meter = CostMeter::new();
        meter.note(10);
        meter.note(20);

        let json = serde_json::to_string(&meter).expect("serialize");
        let deserialized: CostMeter = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(meter, deserialized);
        assert_eq!(deserialized.avg(), Some(15.0));
    }
}
