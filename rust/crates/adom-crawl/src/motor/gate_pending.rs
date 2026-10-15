//! Pendência de portão no loop do motor (post só-com-portão do BLUDV).
//!
//! Separado do `loop.rs` pela catraca de 400 linhas. O fluxo inteiro do
//! resultado `GatePending` vive aqui: gravação do estado (sem queimar
//! tentativa) e fallback de erro retentável quando o href do portão não veio.

use super::r#loop::{with_store, BatchCtx, TaskReport};
use super::types::{error_work, now_ms, CrawlResultStatus, CrawlWorkResult};
use crate::store::ops::{GatePendingRecord, MarkResult, UrlRow};

/// Post pendente de portão (BLUDV): NADA a entregar ao Node ainda — a
/// gravação no acervo acontece quando o executor de fundo pagar o portão
/// (fora do passo, fora deste prazo). Aqui só o estado é gravado, sem
/// queimar tentativa: a pendência é custo deferido, não erro da página.
/// Sem href do portão a pendência ficaria ÓRFÃ (linha `gate-pending` que
/// ninguém paga, presa em inflight): volta como erro retentável para a
/// página ser re-raspeada e o portão re-extraído. Nada a reportar ao Node
/// — só o store.
pub(super) async fn handle_gate_pending(
    ctx: &BatchCtx,
    row: &UrlRow,
    work: &CrawlWorkResult,
) -> TaskReport {
    debug_assert!(matches!(work.status, CrawlResultStatus::GatePending));
    match gate_pending_report(ctx, row, work).await {
        Ok(cost) => TaskReport {
            cost,
            delivered: true,
        },
        Err(e) => {
            eprintln!(
                "[motor] {} {}: portão pendente sem href: {e}",
                row.site, row.url_key
            );
            let erro = error_work(row, &format!("portão pendente sem href: {e}"));
            let mark = MarkResult::from_work(row, &erro, false, &ctx.cfg, now_ms());
            let (site, url_key) = (row.site.clone(), row.url_key.clone());
            if let Err(e2) = with_store(ctx.store.clone(), move |db| {
                db.mark_result(&site, &url_key, &mark)
            })
            .await
            {
                eprintln!("[motor] falha ao marcar {} {}: {e2}", row.site, row.url_key);
            }
            TaskReport {
                cost: work.request_cost,
                delivered: false,
            }
        }
    }
}

/// Grava a pendência de portão no store (`crawl_url` status `gate-pending` +
/// `crawl_gate` com o href e os metadados de obra já colhidos). Erro de store
/// NÃO transforma a página em falha de rede: o TaskReport preserva o custo e
/// a entrega é considerada feita (o estado é local; a fila não perde a linha).
async fn gate_pending_report(
    ctx: &BatchCtx,
    row: &UrlRow,
    work: &CrawlWorkResult,
) -> Result<u32, String> {
    let gate = work
        .gate
        .clone()
        .filter(|g| !g.trim().is_empty())
        .ok_or_else(|| "parser não devolveu o href".to_string())?;
    let rec = GatePendingRecord {
        gate,
        title: work.title.clone().unwrap_or_default(),
        year: work.year.unwrap_or(0),
        imdb: work.imdb.clone().unwrap_or_default(),
        kind: row.kind.clone(),
    };
    let (site, url_key) = (row.site.clone(), row.url_key.clone());
    let alvo = format!("{site} {url_key}");
    let cost = work.request_cost;
    with_store(ctx.store.clone(), move |db| {
        db.mark_gate_pending(&site, &url_key, &rec)
    })
    .await
    .map_err(|e| e.to_string())
    .map(|()| {
        eprintln!("[motor] {alvo}: pendente de portão (executor de fundo paga depois)");
        cost
    })
}
