//! Dreno DURAVEL da outbox de invalidacao (T1-B2).
//! O drain grava o indice e pode morrer antes de invalidar a lista em `streams`:
//! o alvo fica na outbox e este dreno o propaga mesmo sem busca no colhedor.

use adom_harvest::OutboxItem;

/// Resultado de uma passagem do dreno (uma linha no relatorio/status).
#[derive(Debug, Default)]
pub(super) struct OutboxReport {
    /// Alvos que rodaram contra `streams` e sairam da outbox.
    pub acked: usize,
    /// Alvos NAO propagados: invalidacao falhou ou o prefixo e lixo antigo.
    pub failed: usize,
    /// Tamanho da lista morta (alvos que estouraram as 5 tentativas).
    pub dead: usize,
    /// Erro do proprio store (SQLite): sem ack, o alvo continua na outbox.
    pub store_error: Option<String>,
}

/// Propaga o lote pendente e devolve a contabilidade.
///
/// Fail-closed: sem `streams` ou com erro do store nada e ackado — o alvo
/// continua na outbox e a dead-letter acontece sozinha depois de 5 tentativas.
pub(super) fn drain_outbox(
    store: &adom_harvest::HarvestStore,
    streams: Option<&std::sync::Arc<adom_store::StreamsStore>>,
    limit: usize,
    now_ms: i64,
) -> OutboxReport {
    // O take ja incrementou e persistiu `tries`; se ele falha, nao ha lote.
    let batch = match store.outbox_take(limit, now_ms) {
        Ok(batch) => batch,
        Err(err) => {
            return OutboxReport {
                store_error: Some(err),
                ..OutboxReport::default()
            }
        }
    };

    let mut report = OutboxReport::default();

    let Some(streams) = streams else {
        // Sem o store de streams a invalidacao nao existe. Nao acar: os tries
        // ja subiram e a dead-letter acontece depois de 5 (nada some calado).
        if !batch.is_empty() {
            eprintln!(
                "[harvest] outbox: store de streams ausente; {} alvo(s) aguardando",
                batch.len()
            );
        }
        report.failed = batch.len();
        // Ler a lista morta mesmo assim: o painel mostra o que ja parou.
        let (dead, err) = dead_count(store, now_ms);
        report.dead = dead;
        note_store_error(&mut report, err);
        return report;
    };

    let mut ok_items: Vec<OutboxItem> = Vec::new();
    for item in batch {
        let job: Result<(), String>;
        if let Some(rest) = item.target.strip_prefix("obra:") {
            job = streams.invalidate_for_obra(rest).map(|_| ());
        } else if let Some(rest) = item.target.strip_prefix("hash:") {
            job = streams.invalidate_for_hash(rest).map(|_| ());
        } else {
            // Lixo de versao antiga: sai por ack individual — deixa-lo na
            // outbox o prenderia em dead-letter para sempre.
            eprintln!(
                "[harvest] outbox: alvo desconhecido (descartado): {}",
                item.target
            );
            report.failed = report.failed.saturating_add(1);
            if let Err(err) = store.outbox_ack(std::slice::from_ref(&item), now_ms) {
                note_store_error(&mut report, Some(err));
            }
            continue;
        }
        match job {
            Ok(()) => ok_items.push(item),
            Err(err) => {
                // Um alvo ruim nao impede os outros: segue o laco.
                eprintln!(
                    "[harvest] outbox: invalidacao de {} falhou: {err}",
                    item.target
                );
                report.failed = report.failed.saturating_add(1);
            }
        }
    }

    // Um unico ack para o lote que deu certo (idempotente do lado do store).
    if !ok_items.is_empty() {
        match store.outbox_ack(&ok_items, now_ms) {
            Ok(()) => report.acked = ok_items.len(),
            // Sem ack os alvos voltam no proximo ciclo; a invalidacao e
            // idempotente, entao repetir nao machuca.
            Err(err) => note_store_error(&mut report, Some(err)),
        }
    }

    let (dead, err) = dead_count(store, now_ms);
    report.dead = dead;
    note_store_error(&mut report, err);
    report
}

/// Tamanho da lista morta; erro vira `store_error` sem derrubar o dreno.
fn dead_count(store: &adom_harvest::HarvestStore, now_ms: i64) -> (usize, Option<String>) {
    match store.outbox_dead(now_ms) {
        Ok(items) => (items.len(), None),
        Err(err) => (0, Some(err)),
    }
}

/// Guarda o PRIMEIRO erro do store: o resto do lote ainda pode ser util.
fn note_store_error(report: &mut OutboxReport, err: Option<String>) {
    if report.store_error.is_none() {
        report.store_error = err;
    }
}
