//! Cache FIFO com TTL e coalescing inFlight para resolvers BR.
//!
//! Port de `resolvers/cache.ts`. Cada profile tem o próprio cache
//! (postCache, searchCache, magnetCache) com limite e TTL próprios.
//! O `inFlight` pode ser compartilhado entre caches irmãs via
//! [`ResolverCache::with_shared_inflight`].

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use tokio::sync::Mutex;

/// Entrada do cache: valor + prazo de validade (epoch ms).
struct CacheEntry<V> {
    value: V,
    expires_at: i64,
}

/// Estado de uma requisição em andamento.
///
/// Usa `tokio::sync::Notify` para sinalizar conclusão a todos os
/// waiters simultaneamente (equivalente ao `.finally()` da TS que
/// remove a Promise do `inFlight`).
pub struct PendingEntry {
    notify: Arc<tokio::sync::Notify>,
}

/// Cache FIFO com TTL e coalescing de requisições simultâneas.
///
/// # Contrato
///
/// * Hit dentro do TTL → retorna sem chamar o loader.
/// * Hit expirado → remove e recarrega.
/// * Chave em `in_flight` → aguarda o loader compartilhado.
/// * Miss total → executa o loader, grava no cache, notifica waiters.
/// * Evicção FIFO quando `len() > limit` após inserção.
///
/// # Concorrência
///
/// O mutex `values` é mantido durante todo o caminho síncrono e liberado
/// antes de qualquer `.await`. A ordem de aquisição é sempre
/// `values → in_flight`, o que previne deadlocks entre caches que
/// compartilham o mesmo `in_flight`.
pub struct ResolverCache<V: Clone + Send + 'static> {
    values: Mutex<HashMap<String, CacheEntry<V>>>,
    in_flight: Arc<Mutex<HashMap<String, PendingEntry>>>,
    insert_order: Mutex<VecDeque<String>>,
    limit: usize,
}

impl<V: Clone + Send + 'static> ResolverCache<V> {
    /// Cria um cache com limite de entradas e `inFlight` próprio.
    pub fn new(limit: usize) -> Self {
        Self {
            values: Mutex::new(HashMap::new()),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            insert_order: Mutex::new(VecDeque::new()),
            limit,
        }
    }

    /// Cria um cache compartilhando o mapa `inFlight` com outras caches irmãs.
    ///
    /// Útil quando um profile tem postCache/searchCache/magnetCache e quer
    /// deduplicar requisições entre eles.
    pub fn with_shared_inflight(
        limit: usize,
        in_flight: Arc<Mutex<HashMap<String, PendingEntry>>>,
    ) -> Self {
        Self {
            values: Mutex::new(HashMap::new()),
            in_flight: Arc::clone(&in_flight),
            insert_order: Mutex::new(VecDeque::new()),
            limit,
        }
    }

    /// Retorna o valor em cache para `key`, executando `loader` apenas em miss.
    ///
    /// 1. Verifica `values` — se hit e não expirado, retorna.
    /// 2. Se expirado, remove.
    /// 3. Verifica `in_flight` — se existe, aguarda a notificação.
    /// 4. Senão, cria entrada pendente, executa o loader, grava em `values`,
    ///    remove de `in_flight` e notifica waiters.
    /// 5. Se `values.len() > limit`, remove o mais antigo (FIFO).
    pub async fn cached<F, Fut>(&self, key: &str, ttl_ms: i64, loader: F) -> V
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = V>,
    {
        let now = now_ms();

        // --- caminho rápido: hit válido ---
        {
            let values = self.values.lock().await;
            if let Some(entry) = values.get(key) {
                if entry.expires_at > now {
                    return entry.value.clone();
                }
            }
        }
        // solta o lock antes de adquirir o próximo

        // --- lock ordenado: values → in_flight ---
        let mut values = self.values.lock().await;
        let mut in_flight = self.in_flight.lock().await;

        // Re-checa após adquirir o lock (outra task pode ter preenchido).
        let now = now_ms();
        if let Some(entry) = values.get(key) {
            if entry.expires_at > now {
                return entry.value.clone();
            }
            // Expirado — remove.
            values.remove(key);
            self.remove_from_insert_order(key).await;
        }

        // Verifica se outra task já está carregando esta chave.
        if let Some(pending) = in_flight.get(key) {
            let notify = Arc::clone(&pending.notify);
            drop(in_flight);
            drop(values);
            // Aguarda o loader compartilhado terminar.
            // Loop protege contra spurious wakeups do Notify.
            loop {
                notify.notified().await;
                let values = self.values.lock().await;
                if let Some(entry) = values.get(key) {
                    if entry.expires_at > now_ms() {
                        return entry.value.clone();
                    }
                }
                // Valor ainda não gravado ou já expirou — continua aguardando.
            }
        }

        // --- miss total: cria entrada pendente e executa o loader ---
        let notify = Arc::new(tokio::sync::Notify::new());
        in_flight.insert(
            key.to_string(),
            PendingEntry {
                notify: Arc::clone(&notify),
            },
        );
        drop(in_flight);
        drop(values);
        // Todos os locks liberados antes do .await do loader.

        let value = loader().await;

        // Re-adquire na mesma ordem: values → in_flight.
        let mut values = self.values.lock().await;
        let mut in_flight = self.in_flight.lock().await;

        // Evita sobrescrever valor mais recente inserido por outra task.
        if !values.contains_key(key) {
            self.insert_order.lock().await.push_back(key.to_string());
        }
        values.insert(
            key.to_string(),
            CacheEntry {
                value: value.clone(),
                expires_at: now_ms() + ttl_ms,
            },
        );

        // Evicção FIFO: remove a chave mais antiga até caber no limite.
        let mut order = self.insert_order.lock().await;
        while values.len() > self.limit {
            if let Some(oldest) = order.pop_front() {
                values.remove(&oldest);
            } else {
                break;
            }
        }
        drop(order);

        // Remove de in_flight e notifica waiters.
        in_flight.remove(key);
        drop(in_flight);
        drop(values);
        notify.notify_waiters();

        value
    }

    /// Limpa todas as entradas do cache.
    pub async fn clear(&self) {
        self.values.lock().await.clear();
        self.insert_order.lock().await.clear();
    }

    /// Número de entradas atualmente em cache (para diagnóstico).
    pub async fn len(&self) -> usize {
        self.values.lock().await.len()
    }

    /// Retorna `true` se o cache está vazio.
    pub async fn is_empty(&self) -> bool {
        self.values.lock().await.is_empty()
    }

    /// Remove uma chave da fila de inserção (auxiliar para limpeza de expirados).
    async fn remove_from_insert_order(&self, key: &str) {
        let mut order = self.insert_order.lock().await;
        if let Some(pos) = order.iter().position(|k| k == key) {
            order.remove(pos);
        }
    }
}

/// Epoch em milissegundos (equivalente ao `Date.now()` do JS).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ────────────────────────────────────────────────────────────────────────────
// Testes
// ────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::time::{self, Duration};

    /// 1. Hit dentro do TTL retorna o valor sem chamar loader novamente.
    #[tokio::test]
    async fn hit_within_ttl_returns_cached_value() {
        let cache = ResolverCache::<String>::new(10);
        let calls = AtomicUsize::new(0);

        let v1 = cache
            .cached("k", 60_000, || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { "primeiro".to_string() }
            })
            .await;
        assert_eq!(v1, "primeiro");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let v2 = cache
            .cached("k", 60_000, || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { "segundo".to_string() }
            })
            .await;
        // Loader NÃO foi chamado novamente; valor veio do cache.
        assert_eq!(v2, "primeiro");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// 2. Hit expirado chama loader de novo.
    #[tokio::test]
    async fn expired_hit_calls_loader_again() {
        let cache = ResolverCache::<String>::new(10);
        let calls = AtomicUsize::new(0);

        let loader = || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move { format!("v{n}") }
        };

        // TTL de 1ms — vai expirar antes da próxima chamada.
        let v1 = cache.cached("k", 1, loader).await;
        assert_eq!(v1, "v0");

        time::sleep(Duration::from_millis(10)).await;

        let v2 = cache.cached("k", 60_000, loader).await;
        assert_eq!(v2, "v1");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    /// 3. Coalescing: duas chamadas simultâneas → loader chamado uma vez só.
    #[tokio::test]
    async fn coalescing_deduplicates_concurrent_loaders() {
        let cache = Arc::new(ResolverCache::<String>::new(10));
        let calls = Arc::new(AtomicUsize::new(0));

        let barrier = Arc::new(tokio::sync::Barrier::new(2));

        let (h1, h2) = tokio::join!(
            {
                let c = Arc::clone(&cache);
                let n = Arc::clone(&calls);
                let b = Arc::clone(&barrier);
                async move {
                    b.wait().await;
                    c.cached("k", 60_000, || {
                        n.fetch_add(1, Ordering::SeqCst);
                        async { "valor".to_string() }
                    })
                    .await
                }
            },
            {
                let c = Arc::clone(&cache);
                let n = Arc::clone(&calls);
                let b = Arc::clone(&barrier);
                async move {
                    b.wait().await;
                    c.cached("k", 60_000, || {
                        n.fetch_add(1, Ordering::SeqCst);
                        async { "valor".to_string() }
                    })
                    .await
                }
            },
        );

        assert_eq!(h1, "valor");
        assert_eq!(h2, "valor");
        // Loader executou apenas uma vez graças ao coalescing inFlight.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// 4. FIFO: com limit=3, inserir 4 itens → o primeiro é evictado.
    #[tokio::test]
    async fn fifo_eviction_removes_oldest_when_over_limit() {
        let cache = ResolverCache::<i32>::new(3);

        cache.cached("a", 60_000, || async { 1 }).await;
        cache.cached("b", 60_000, || async { 2 }).await;
        cache.cached("c", 60_000, || async { 3 }).await;
        assert_eq!(cache.len().await, 3);

        // Inserção do 4º item → "a" deve ser evictado.
        cache.cached("d", 60_000, || async { 4 }).await;
        assert_eq!(cache.len().await, 3);

        // "a" foi evictado → loader é chamado novamente.
        let calls = AtomicUsize::new(0);
        let val = cache
            .cached("a", 60_000, || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { 99 }
            })
            .await;
        assert_eq!(val, 99);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// 5. clear() zera o cache.
    #[tokio::test]
    async fn clear_empties_the_cache() {
        let cache = ResolverCache::<i32>::new(10);

        cache.cached("x", 60_000, || async { 1 }).await;
        cache.cached("y", 60_000, || async { 2 }).await;
        assert_eq!(cache.len().await, 2);

        cache.clear().await;
        assert_eq!(cache.len().await, 0);
        assert!(cache.is_empty().await);
    }
}
