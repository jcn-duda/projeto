//! Coalescing `inFlight` da busca — porte do mapa de buscas idênticas
//! simultâneas de `src/providers/search-cache.ts` (oráculo: branch `esm`).
//!
//! Stremio pede o stream de vários clientes ao mesmo tempo: requisições
//! simultâneas para a MESMA chave de cache dividem UMA só busca — a primeira
//! computa, as demais esperam o mesmo resultado (`stream.coalesced` no TS).
//!
//! Regra do TS reproduzida aqui: **metadado dentro do inFlight usa prazo
//! duro** (`fetchJsonWithin`, nunca `fetch` cru) — quem coalesca não pode
//! ficar refém de um passo sem prazo. A variante [`InFlight::coalesce_within`]
//! encena isso: a computação compartilhada corre sob `tokio::time::timeout`
//! com o prazo do chamador, e o estouro devolve o fallback para TODOS os
//! esperando (o líder remove a chave; sem líder, os demais não ficariam
//! presos). Divergência conhecida do TS, documentada: lá o `raceWithDeadline`
//! devolve parcial por requisição e a busca SEGUE em fundo (task viva);
//! aqui, nesta fatia sem runtime de fundo, o timeout cancela a computação —
//! a busca de fundo volta com o orquestrador.
//!
//! O refresh SWR do TS usa um mapa PRÓPRIO (`refreshing`), separado do
//! inFlight — a revalidação não coalesce com a busca síncrona nem a impede de
//! começar. Mesmo padrão aqui: quem revalida usa o store direto, não este
//! mapa.
//!
//! A instância tipa pelo VALOR da busca (`InFlight<StreamsEntry>`), não por
//! chamada — um mapa por serviço, como o `inFlight` do módulo TS.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

/// Slot compartilhado de uma computação em voo.
struct Slot<T> {
    /// Resultado, preenchido uma única vez pelo líder que criou o slot.
    cell: Mutex<Option<T>>,
    /// Acorda os esperando quando o resultado fica pronto.
    done: Notify,
}

impl<T> Slot<T> {
    fn new() -> Self {
        Self {
            cell: Mutex::new(None),
            done: Notify::new(),
        }
    }
}

/// Mapa chave → busca em voo. Todos os esperando seguram o mesmo `Arc<Slot>`.
pub struct InFlight<T> {
    map: Mutex<HashMap<String, Arc<Slot<T>>>>,
}

impl<T> Default for InFlight<T> {
    fn default() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}

impl<T> InFlight<T>
where
    T: Clone + Send + 'static,
{
    pub fn new() -> Self {
        Self::default()
    }

    /// Divide a computação: quem chega primeiro executa `compute`; os demais
    /// para a mesma chave esperam o MESMO valor. Por mais esperando que
    /// cheguem, uma única computação acontece.
    pub async fn coalesce<F, Fut>(&self, key: &str, compute: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        self.run(key, None, compute, || {
            unreachable!("fallback só é chamado com prazo")
        })
        .await
    }

    /// Mesmo contrato de [`InFlight::coalesce`], com PRAZO DURO opcional para
    /// a computação compartilhada. No estouro, `fallback` produz o valor que
    /// TODOS (líder incluído) recebem e a chave é liberada.
    pub async fn coalesce_within<F, Fut, B>(
        &self,
        key: &str,
        deadline: Duration,
        compute: F,
        fallback: B,
    ) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
        B: FnOnce() -> T,
    {
        self.run(key, Some(deadline), compute, fallback).await
    }

    async fn run<F, Fut, B>(
        &self,
        key: &str,
        deadline: Option<Duration>,
        compute: F,
        fallback: B,
    ) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
        B: FnOnce() -> T,
    {
        let slot = self.claim(key).await;
        // Resultado já pronto (coalescing: chegamos depois de pronto, entre a
        // notificação e a nossa vez de rechecar): consome e sai.
        if let Some(value) = slot.cell.lock().expect("slot envenenado").clone() {
            return value;
        }
        let fut = compute();
        let result = match deadline {
            Some(d) => match tokio::time::timeout(d, fut).await {
                Ok(value) => value,
                // PRAZO DURO: o estouro vale para todos — o fallback entra no
                // cell compartilhado, lá embaixo, e a chave é liberada.
                Err(_) => fallback(),
            },
            None => fut.await,
        };
        // Único escritor do cell é quem criou o slot; quem chegou depois lê.
        *slot.cell.lock().expect("slot envenenado") = Some(result.clone());
        // Notifica ANTES de remover: os esperando rechecam o cell e saem;
        // quem chegar depois não acha a chave e vira novo líder.
        slot.done.notify_waiters();
        self.release(key, &slot);
        result
    }

    /// Pega o slot existente (esperando) ou instala o nosso (líder). Quem
    /// espera PRENDE no slot que já segurou: mesmo que o líder remova a chave
    /// antes de o esperando rechecar o mapa (estouro de prazo), o resultado
    /// fica no `Arc` que ele tem na mão.
    async fn claim(&self, key: &str) -> Arc<Slot<T>> {
        loop {
            let existing = {
                let map = self.map.lock().expect("mapa envenenado");
                map.get(key).cloned()
            };
            if let Some(slot) = existing {
                loop {
                    let pronto = slot.cell.lock().expect("slot envenenado").clone();
                    if pronto.is_some() {
                        return slot;
                    }
                    slot.done.notified().await;
                }
            }
            let slot = Arc::new(Slot::new());
            let mut map = self.map.lock().expect("mapa envenenado");
            // Corrida dupla: outro líder ganhou o insert enquanto esperávamos
            // o lock. Volta ao laço como esperando.
            if map.contains_key(key) {
                drop(map);
                continue;
            }
            map.insert(key.to_string(), slot.clone());
            return slot;
        }
    }

    /// Remove a chave só se o slot ainda é o nosso (um novo líder que já
    /// reinstalou não pode ser apagado por um líder antigo saindo).
    fn release(&self, key: &str, slot: &Arc<Slot<T>>) {
        let mut map = self.map.lock().expect("mapa envenenado");
        if map
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, slot))
        {
            map.remove(key);
        }
    }

    /// Quantas buscas estão coalescendo agora (o `searchesInFlightCount`).
    pub fn len(&self) -> usize {
        self.map.lock().expect("mapa envenenado").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn key(n: u8) -> String {
        // Chave real do formato streams:v21, para o teste andar junto do
        // contrato (a coalescing é por chave, não por conteúdo).
        format!("streams:v21:movie:tt{n}:{{}}:account:none")
    }

    #[tokio::test]
    async fn duas_esperas_uma_computacao() {
        let in_flight = Arc::new(InFlight::<String>::new());
        let computacoes = Arc::new(AtomicU32::new(0));

        let mut handles = Vec::new();
        for _ in 0..3 {
            let computacoes = computacoes.clone();
            handles.push(tokio::spawn({
                let in_flight = in_flight.clone();
                let key = key(1);
                async move {
                    in_flight
                        .coalesce(&key, || async move {
                            // Só o LÍDER passa aqui: três incrementos seriam
                            // três computações — o teste abaixo reprova.
                            computacoes.fetch_add(1, Ordering::SeqCst);
                            // Janela para os outros dois chegarem e coalescer.
                            tokio::time::sleep(Duration::from_millis(200)).await;
                            "resultado".to_string()
                        })
                        .await
                }
            }));
        }
        for handle in handles {
            assert_eq!(handle.await.expect("task"), "resultado");
        }
        assert_eq!(computacoes.load(Ordering::SeqCst), 1, "uma só computação");
        assert!(in_flight.is_empty(), "chave sai do mapa ao terminar");
    }

    #[tokio::test]
    async fn chaves_diferentes_nao_coalescem() {
        let in_flight: InFlight<u8> = InFlight::new();
        let a = in_flight.coalesce(&key(1), || async move { 1u8 }).await;
        let b = in_flight.coalesce(&key(2), || async move { 2u8 }).await;
        assert_eq!((a, b), (1, 2));
    }

    #[tokio::test]
    async fn prazo_duro_estoura_para_todos_os_esperando() {
        let in_flight = Arc::new(InFlight::<String>::new());
        let key = key(3);
        let lider = tokio::spawn({
            let in_flight = in_flight.clone();
            let key = key.clone();
            async move {
                in_flight
                    .coalesce_within(
                        &key,
                        Duration::from_millis(50),
                        || async {
                            // Computação sem fim: só o prazo a derruba.
                            std::future::pending::<()>().await;
                            "nunca".to_string()
                        },
                        || "parcial".to_string(),
                    )
                    .await
            }
        });
        // Dá tempo de o líder instalar o slot antes dos esperando.
        tokio::time::sleep(Duration::from_millis(10)).await;
        let esperando: Vec<_> = (0..2)
            .map(|_| {
                tokio::spawn({
                    let in_flight = in_flight.clone();
                    let key = key.clone();
                    async move {
                        in_flight
                            .coalesce_within(
                                &key,
                                Duration::from_secs(30),
                                || async { "outro-lider".to_string() },
                                || "outro-fallback".to_string(),
                            )
                            .await
                    }
                })
            })
            .collect();
        assert_eq!(lider.await.expect("task"), "parcial");
        for handle in esperando {
            assert_eq!(handle.await.expect("task"), "parcial");
        }
        assert!(in_flight.is_empty(), "estouro libera a chave");
    }

    #[tokio::test]
    async fn esperando_recebem_o_valor_do_lider_sem_recomputar() {
        let in_flight = Arc::new(InFlight::<u32>::new());
        let computacoes = Arc::new(AtomicU32::new(0));
        let trava = Arc::new(tokio::sync::Notify::new());
        let key = key(4);

        let lider = {
            let computacoes = computacoes.clone();
            let trava = trava.clone();
            let in_flight = in_flight.clone();
            let key = key.clone();
            tokio::spawn(async move {
                in_flight
                    .coalesce(&key, || async move {
                        computacoes.fetch_add(1, Ordering::SeqCst);
                        trava.notified().await;
                        42u32
                    })
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        let esperando = {
            let in_flight = in_flight.clone();
            let key = key.clone();
            let computacoes = computacoes.clone();
            tokio::spawn(async move {
                let resultado = in_flight
                    .coalesce(&key, || async move {
                        computacoes.fetch_add(1, Ordering::SeqCst);
                        7u32
                    })
                    .await;
                // O esperando só sai depois de o líder soltar a computação.
                resultado
            })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        trava.notify_waiters();
        assert_eq!(lider.await.expect("task"), 42);
        assert_eq!(esperando.await.expect("task"), 42, "mesmo valor do líder");
        assert_eq!(computacoes.load(Ordering::SeqCst), 1);
    }
}
