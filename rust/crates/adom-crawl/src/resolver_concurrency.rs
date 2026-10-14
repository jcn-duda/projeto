//! Concorrência com teto para resolvers BR.
//! Port de `resolvers/concurrency.ts`.
//!
//! O `map_limit` executa uma função assíncrona para cada item de uma fatia,
//! com no máximo `limit` tarefas simultâneas. Falhas individuais são isoladas:
//! o item vira `None` e não derruba o lote (mesmo comportamento do TS).

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Executa `f` para cada item com no máximo `limit` tarefas simultâneas.
///
/// Cada item que falha (resultado `Err`) é removido da saída — o lote continua.
/// O callback `on_error` é opcional e recebe o erro e o item original.
///
/// A ordem relativa dos resultados bem-sucedidos é preservada (como no TS).
///
/// # Exemplo
///
/// ```ignore
/// let items: Vec<i32> = (0..10).collect();
/// let resultados = map_limit(
///     &items,
///     3,
///     |x| async move { Ok::<i32, String>(x * 2) },
///     None,
/// )
/// .await;
/// assert_eq!(resultados.len(), 10);
/// ```
pub async fn map_limit<T, R, E, F, Fut>(
    items: &[T],
    limit: usize,
    f: F,
    on_error: Option<fn(&E, &T)>,
) -> Vec<R>
where
    T: Clone + Send + Sync + 'static,
    R: Send + 'static,
    E: Send + 'static,
    F: Fn(T) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<R, E>> + Send,
{
    if items.is_empty() {
        return Vec::new();
    }

    // Limita o número de workers ao mínimo entre limit e o total de items.
    let effective_limit = limit.min(items.len());

    // Contador compartilhado: cada worker avança o índice atomicamente.
    let next_index = Arc::new(AtomicUsize::new(0));

    // Slots de resultado: índice i corresponde a items[i].
    // Some(R) = sucesso, None = falha ou ainda não processado.
    let slots: Arc<Mutex<Vec<Option<R>>>> =
        Arc::new(Mutex::new(items.iter().map(|_| None).collect()));

    // Arc<F> permite compartilhar a função entre workers sem exigir Clone de F.
    // Movemos `f` para o Arc (não borramos) para satisfazer o 'static do spawn.
    let f = Arc::new(f);
    let mut handles = Vec::with_capacity(effective_limit);

    for _ in 0..effective_limit {
        let next_index = Arc::clone(&next_index);
        let slots = Arc::clone(&slots);
        let f = Arc::clone(&f);
        // Clona a fatia para dentro do worker (tokio::spawn exige 'static).
        let owned_items: Vec<T> = items.to_vec();

        let handle = tokio::spawn(async move {
            loop {
                // Avança o contador e pega o próximo índice disponível.
                let idx = next_index.fetch_add(1, Ordering::Relaxed);
                if idx >= owned_items.len() {
                    break;
                }

                let item = owned_items[idx].clone();
                match f(item).await {
                    Ok(value) => {
                        // Trava o mutex apenas para escrever o resultado.
                        if let Ok(mut guard) = slots.lock() {
                            guard[idx] = Some(value);
                        }
                    }
                    Err(err) => {
                        if let Some(handler) = on_error {
                            handler(&err, &owned_items[idx]);
                        }
                        // Slot permanece None (equivalente ao null do TS).
                    }
                }
            }
        });
        handles.push(handle);
    }

    // Aguarda todos os workers terminarem.
    for handle in handles {
        let _ = handle.await;
    }

    // Coleta resultados Some, preservando ordem relativa (como o TS).
    let mut guard = slots.lock().expect("mutex de slots não envenenado");
    guard.iter_mut().filter_map(|slot| slot.take()).collect()
}

// ── Testes ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// 10 items, limit=3 → todos processados, ordem preservada.
    #[tokio::test]
    async fn map_limit_todos_processados_com_limite() {
        let items: Vec<i32> = (0..10).collect();
        let results = map_limit(
            &items,
            3,
            |x: i32| async move { Ok::<i32, String>(x * 2) },
            None::<fn(&String, &i32)>,
        )
        .await;

        assert_eq!(results.len(), 10);
        for (i, val) in results.iter().enumerate() {
            assert_eq!(*val, (i as i32) * 2);
        }
    }

    /// Falha individual não derruba o lote; resultado exclui o item falho.
    #[tokio::test]
    async fn map_limit_falha_individual_isolada() {
        let items: Vec<i32> = (0..5).collect();
        let results = map_limit(
            &items,
            3,
            |x: i32| async move {
                if x == 2 {
                    Err(format!("item {} falhou", x))
                } else {
                    Ok(x * 10)
                }
            },
            None::<fn(&String, &i32)>,
        )
        .await;

        // 5 items - 1 falha = 4 resultados
        assert_eq!(results.len(), 4);
        // O item 2 (que falhou) não está na saída; os demais mantêm ordem.
        assert_eq!(results, vec![0, 10, 30, 40]);
    }

    /// limit=1 → execução estritamente serial (máximo 1 tarefa por vez).
    #[tokio::test]
    async fn map_limit_serial_quando_limite_1() {
        let max_concurrent = Arc::new(AtomicUsize::new(0));
        let current = Arc::new(AtomicUsize::new(0));

        let items: Vec<i32> = (0..5).collect();
        let mc = Arc::clone(&max_concurrent);
        let cur = Arc::clone(&current);

        let results = map_limit(
            &items,
            1,
            move |x: i32| {
                let mc = Arc::clone(&mc);
                let cur = Arc::clone(&cur);
                async move {
                    let c = cur.fetch_add(1, Ordering::SeqCst) + 1;
                    // Atualiza o máximo observado.
                    mc.fetch_max(c, Ordering::SeqCst);
                    // Pequena pausa para permitir detecção de concorrência.
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    cur.fetch_sub(1, Ordering::SeqCst);
                    Ok::<i32, String>(x)
                }
            },
            None::<fn(&String, &i32)>,
        )
        .await;

        assert_eq!(results.len(), 5);
        // Com limit=1, nunca mais de 1 tarefa simultânea.
        assert_eq!(max_concurrent.load(Ordering::SeqCst), 1);
    }

    /// Vetor vazio → resultado vazio, sem spawn de workers.
    #[tokio::test]
    async fn map_limit_vazio() {
        let items: Vec<i32> = vec![];
        let results = map_limit(
            &items,
            3,
            |x: i32| async move { Ok::<i32, String>(x) },
            None::<fn(&String, &i32)>,
        )
        .await;
        assert_eq!(results.len(), 0);
    }

    /// limit maior que o total → todos processados (workers = items.len()).
    #[tokio::test]
    async fn map_limit_maior_que_total() {
        let items: Vec<i32> = vec![1, 2, 3];
        let results = map_limit(
            &items,
            100,
            |x: i32| async move { Ok::<i32, String>(x + 1) },
            None::<fn(&String, &i32)>,
        )
        .await;
        assert_eq!(results, vec![2, 3, 4]);
    }
}
