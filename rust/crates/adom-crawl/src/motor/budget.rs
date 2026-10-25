//! Orçamento por hora do motor: o teto de REQUISIÇÕES é UM só balde.
//!
//! Páginas, descoberta de sitemap e portão gastam no mesmo contador — a
//! descoberta faz dezenas de requisições por rodada e sem cobrar aqui ela
//! entraria de graça num teto que existe para proteger o site e o FlareSolverr
//! (que atende um pedido por vez e é o mesmo da busca ao vivo).
//!
//! Vive fora do `loop.rs` pela catraca de 400 linhas; a auto-pausa de lotes sem
//! entrega veio junto porque é o outro lado da mesma conta: se o lote não
//! entrega, o gasto continuou e o motor precisa parar de gastar.

use super::r#loop::CrawlMotor;
use super::types::now_ms;

impl CrawlMotor {
    /// Cobra requisições no teto da hora. A descoberta usa o MESMO orçamento
    /// das páginas.
    pub(super) async fn charge_budget(&self, cost: u32) {
        if cost > 0 {
            let mut spent = self.pages_this_hour.lock().await;
            *spent = spent.saturating_add(cost);
        }
    }

    /// Fecha a janela de uma hora e zera o custo quando ela vence.
    pub(super) async fn roll_hour_window(&self, now: i64) {
        let mut start = self.hour_started_at.lock().await;
        if *start == 0 || now - *start >= self.config.hour_window_ms as i64 {
            *start = now;
            *self.pages_this_hour.lock().await = 0;
        }
    }

    /// Cobra o custo real do lote e auto-pausa após lotes sem entrega.
    pub(super) async fn settle_budget(&self, cost: u32, delivered: usize) {
        self.charge_budget(cost).await;
        if delivered > 0 {
            *self.failure_streak.lock().await = 0;
            return;
        }
        let mut streak = self.failure_streak.lock().await;
        *streak = streak.saturating_add(1);
        if *streak >= self.config.error_pause_streak.max(1) {
            // Lotes inteiros sem entrega = Node fora do ar: dorme a janela.
            *self.pause_until.lock().await = now_ms() + self.config.hour_window_ms as i64;
            eprintln!("[motor] {streak} lotes sem entrega; auto-pausando a raspagem");
            *streak = 0;
        }
    }
}
