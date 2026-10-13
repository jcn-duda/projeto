//! Loop principal do motor do raspador (C4).
//!
//! Responsável por:
//! - Tick periódico com `delay_ms` configurável
//! - Seleção de batch de URLs due (respeitando `max_parallel`)
//! - Despacho assíncrono com prazo duro (`step_deadline_ms`)
//! - Respeito à janela de ociosidade do usuário (`idle_window_ms`)
//! - Tolerância a erros — erro de rede não derruba o motor

use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{interval, Duration};

use super::types::{MotorConfig, MotorStatus, SiteStatus};

/// Erros do motor do raspador.
#[derive(Debug)]
pub enum MotorError {
    /// Erro vindo do store (Agente 2).
    StoreError(String),
    /// Erro vindo da camada HTTP (Agente 3).
    HttpError(String),
    /// Motor foi parado graciously.
    Shutdown,
}

impl std::fmt::Display for MotorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MotorError::StoreError(msg) => write!(f, "erro no store: {msg}"),
            MotorError::HttpError(msg) => write!(f, "erro HTTP: {msg}"),
            MotorError::Shutdown => write!(f, "motor parado"),
        }
    }
}

impl std::error::Error for MotorError {}

/// Motor do raspador — loop principal.
///
/// O loop consome URLs pendentes do store, despacha tarefas com prazo duro,
/// grava resultados e respeita tanto o limite de requisições por hora quanto
/// a janela de ociosidade (não raspia enquanto o usuário está navegando).
pub struct CrawlMotor {
    config: MotorConfig,
    running: Arc<Mutex<bool>>,
    pages_this_hour: Arc<Mutex<u32>>,
    global_paused: Arc<Mutex<bool>>,
    // TODO(Agente 2): store: Arc<Mutex<dyn CrawlStore>>,
    // TODO(Agente 3): http_client: CrawlHttpClient,
}

impl CrawlMotor {
    /// Cria um novo motor com a configuração fornecida.
    pub fn new(config: MotorConfig) -> Self {
        Self {
            config,
            running: Arc::new(Mutex::new(false)),
            pages_this_hour: Arc::new(Mutex::new(0)),
            global_paused: Arc::new(Mutex::new(false)),
        }
    }

    /// Inicia o loop principal. Retorna quando [`stop()`](Self::stop) é chamado.
    ///
    /// Fluxo de cada tick:
    /// 1. Verifica `running` — se false, break
    /// 2. Verifica pausa global — se true, pula
    /// 3. Verifica janela de ociosidade — se usuário navegou recentemente, pula
    /// 4. Consulta store: `take_next_batch(max_parallel)` → URLs due
    /// 5. Para cada URL: spawn task com `tokio::time::timeout(step_deadline_ms)`
    /// 6. Cada task: fetch → parse → produz `CrawlWorkResult` → POST ao Node
    /// 7. Grava resultado no store: `mark_result(url, status, ...)`
    pub async fn run(&self) -> Result<(), MotorError> {
        {
            let mut r = self.running.lock().await;
            *r = true;
        }

        let mut tick_interval = interval(Duration::from_millis(self.config.delay_ms));

        loop {
            tick_interval.tick().await;

            // (a) Verifica se ainda está rodando
            if !*self.running.lock().await {
                break;
            }

            // (b) Verifica pausa global
            if *self.global_paused.lock().await {
                continue;
            }

            // (c) Verifica limite de páginas por hora
            {
                let count = *self.pages_this_hour.lock().await;
                if count >= self.config.max_per_hour {
                    // Limite atingido, espera próximo tick
                    continue;
                }
            }

            // (d) Verifica janela de ociosidade do usuário
            // TODO(Agente 2): consultar `recent_user_traffic(idle_window_ms)` no store
            // Por enquanto, não pula — o store ainda não existe.

            // (e) Busca batch de URLs pendentes
            // TODO(Agente 2): `let batch = store.take_next_batch(config.max_parallel).await?;`
            let batch: Vec<String> = Vec::new(); // placeholder

            if batch.is_empty() {
                // Nada para fazer agora
                continue;
            }

            // (f) Despacha cada URL com prazo duro
            let deadline = Duration::from_millis(self.config.step_deadline_ms);
            let mut handles = Vec::with_capacity(batch.len());

            for url in batch {
                let _url = url.clone();
                // TODO(Agente 3): http_client.fetch_and_parse(url.clone())
                // TODO(Agente 2): store.mark_result(url, status, ...)

                // Spawn com timeout — o prazo duro garante que uma página lenta
                // não bloqueia o motor inteiro.
                let handle = tokio::time::timeout(deadline, async {
                    // Placeholder: a tarefa real será implementada quando
                    // store (Agente 2) e HTTP (Agente 3) estiverem prontos.
                    let _ = _url;
                    Ok::<(), MotorError>(())
                });

                handles.push(handle);
            }

            // Aguarda todas as tasks do batch (cada uma já tem timeout individual)
            for handle in handles {
                match handle.await {
                    Ok(Ok(())) => {
                        // TODO(Agente 2): incrementa `pages_this_hour`
                    }
                    Ok(Err(e)) => {
                        // Erro dentro da task — loga e continua
                        eprintln!("[motor] erro na task: {e}");
                    }
                    Err(_) => {
                        // Timeout — prazo duro estourado
                        eprintln!("[motor] prazo duro estourado para URL");
                    }
                }
            }
        }

        Ok(())
    }

    /// Para o loop gracioso (termina o passo atual e sai).
    pub async fn stop(&self) {
        let mut r = self.running.lock().await;
        *r = false;
    }

    /// Status atual do motor (para o painel).
    pub async fn status(&self) -> MotorStatus {
        let active = *self.running.lock().await;
        let pages_this_hour = *self.pages_this_hour.lock().await;
        let global_paused = *self.global_paused.lock().await;

        // TODO(Agente 2): consultar store para os SiteStatus reais
        let sites: Vec<SiteStatus> = Vec::new();

        MotorStatus {
            active,
            sites,
            pages_this_hour,
            global_paused,
        }
    }
}
