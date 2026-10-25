//! O laço da página: identificação quando a página não declara IMDb e UMA
//! gravação por locação (grupos primeiro, depois as releases avulsas).
//!
//! É o corpo de `POST /internal/crawl-result` (`src/routes/internal-crawl-result.ts`)
//! sem HTTP: o sidecar chama [`Ingest::apply_many`] direto.

use std::collections::HashSet;

use super::catalog::{IdentifyRequest, ObraCatalog, PageVerdict, StreamInvalidator};
use super::locate::{has_releases_to_record, page_locations};
use super::record::Ingest;
use super::store::IngestStore;
use super::{check_abort, CrawlObra, IngestError, IngestOptions, PageMark, PageReport, WorkKind};
use crate::motor::types::{CrawlResultStatus, CrawlWorkResult};

impl<S, C, I> Ingest<S, C, I>
where
    S: IngestStore,
    C: ObraCatalog,
    I: StreamInvalidator,
{
    /// Página inteira, sem cerca de passo (o `200` da rota do Node).
    pub async fn apply(
        &self,
        site: &str,
        pages: &[CrawlWorkResult],
        now_ms: i64,
    ) -> Result<PageReport, IngestError> {
        self.apply_many(site, pages, now_ms, IngestOptions::default())
            .await
    }

    /// Página(s) com a cerca do passo — é o que o loop do motor chama.
    pub async fn apply_many(
        &self,
        site: &str,
        pages: &[CrawlWorkResult],
        now_ms: i64,
        options: IngestOptions<'_>,
    ) -> Result<PageReport, IngestError> {
        let mut total = PageReport::default();
        for page in pages {
            let one = self.apply_page(site, page, now_ms, options).await?;
            total.works += one.works;
            total.releases += one.releases;
            total.index_rows += one.index_rows;
            total.retryable |= one.retryable;
            if one.mark.is_some() {
                total.mark = one.mark;
            }
            if one.reason.is_some() {
                total.reason = one.reason;
            }
            if one.imdb.is_some() {
                total.imdb = one.imdb;
            }
        }
        Ok(total)
    }

    /// O laço de `POST /internal/crawl-result`: status terminal, identificação
    /// quando a página não declara IMDb e UMA gravação por locação.
    ///
    /// `unlocated` fica de fora (sem temporada não há locação) e a invalidação
    /// é compartilhada entre as locações: a obra é invalidada UMA vez.
    pub async fn apply_page(
        &self,
        site: &str,
        page: &CrawlWorkResult,
        now_ms: i64,
        options: IngestOptions<'_>,
    ) -> Result<PageReport, IngestError> {
        // Status terminal do motor: a rota do Node responde `200` e não grava.
        match page.status {
            CrawlResultStatus::Error => {
                return Ok(PageReport {
                    mark: Some(PageMark::Error),
                    ..PageReport::default()
                })
            }
            CrawlResultStatus::NoWork => {
                return Ok(PageReport {
                    mark: Some(PageMark::NoWork),
                    ..PageReport::default()
                })
            }
            _ => {}
        }

        let locations = page_locations(page);
        let mut imdb = page.imdb.clone().filter(|id| !id.is_empty());
        // A cerca do passo vale ANTES da identificação: um passo fora do prazo
        // não gasta rede do catálogo (o `record` do TS já saía aqui).
        check_abort(&options)?;
        if imdb.is_none() {
            // Sem nenhuma release não se gasta identificação (o `no-torrent` do
            // motor Node também não gastava).
            if !has_releases_to_record(page) {
                return Ok(PageReport {
                    mark: Some(PageMark::NoImdb),
                    ..PageReport::default()
                });
            }
            let request = IdentifyRequest {
                kind: WorkKind::from_page_kind(&page.kind),
                title: page.title.clone().unwrap_or_default(),
                year: page.year,
                original_title: None,
                season: locations
                    .first()
                    .and_then(|location| location.target.season),
            };
            let verdict = self.catalog.identify(&request).await;
            match verdict.outcome {
                PageVerdict::Identified => {
                    let found = verdict.imdb.clone().filter(|id| !id.is_empty());
                    let Some(found) = found else {
                        // `identified` sem IMDb é bug do adaptador: não grava.
                        return Ok(PageReport {
                            mark: Some(PageMark::Unidentified),
                            reason: Some("identified-sem-imdb".to_string()),
                            ..PageReport::default()
                        });
                    };
                    imdb = Some(found);
                }
                PageVerdict::Unavailable => {
                    // Catálogo fora NÃO é veredito: o motor reentrega com backoff.
                    return Ok(PageReport {
                        mark: Some(PageMark::Unavailable),
                        reason: Some(verdict.reason),
                        retryable: true,
                        ..PageReport::default()
                    });
                }
                PageVerdict::Ambiguous => {
                    return Ok(PageReport {
                        mark: Some(PageMark::Ambiguous),
                        reason: Some(verdict.reason),
                        ..PageReport::default()
                    });
                }
                PageVerdict::Unidentified => {
                    return Ok(PageReport {
                        mark: Some(PageMark::Unidentified),
                        reason: Some(verdict.reason),
                        ..PageReport::default()
                    });
                }
            }
        }
        let Some(imdb) = imdb else {
            return Ok(PageReport {
                mark: Some(PageMark::NoImdb),
                ..PageReport::default()
            });
        };
        if locations.is_empty() {
            return Ok(PageReport {
                imdb: Some(imdb),
                ..PageReport::default()
            });
        }

        let obra = CrawlObra {
            imdb: imdb.clone(),
            title: page
                .title
                .clone()
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| page.url_key.clone()),
            year: page.year,
            kind: WorkKind::from_page_kind(&page.kind),
        };
        check_abort(&options)?;
        let names = self.names_for(&obra).await?;
        check_abort(&options)?;

        // A invalidação é por OBRA: a segunda locação da mesma página não
        // repete a chamada (o cache do gateway é por obra, não por episódio).
        let mut invalidated: HashSet<String> = HashSet::new();
        let mut report = PageReport {
            imdb: Some(imdb),
            ..PageReport::default()
        };
        for location in locations {
            let one = self
                .write_one(
                    site,
                    &obra,
                    &names,
                    location.releases,
                    location.target,
                    now_ms,
                    &options,
                    &mut invalidated,
                )
                .await?;
            report.works = 1;
            report.releases += one.kept;
            report.index_rows += one.added;
        }
        Ok(report)
    }
}
