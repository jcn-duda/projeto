//! Descoberta nativa por SITEMAP (fase 6): índice → sitemaps de obra → fila.
//!
//! Porte do `discover()` dos adaptadores TS (`bludv-discover.ts`,
//! `redetorrent-discover.ts`, `vaca.ts`, `nerdfilmes.ts`, `comandotorrents.ts`,
//! `torrentdosfilmes-discovery.ts`), com as diferenças por site isoladas na
//! [`SitemapDiscoveryConfig`](crate::discovery::config::SitemapDiscoveryConfig).
//!
//! A REGRA DURA que este módulo existe para sustentar: `urls: []` com
//! `complete: true` NUNCA sai daqui por engano. Essa combinação faz o cursor do
//! crawler avançar por cima de um acervo que ninguém leu — 17.860 páginas, no
//! pior caso — e ela é silenciosa por definição. Corpo que o parser não
//! reconhece, arquivo sem NENHUMA entrada e arquivo sem URL de obra viram
//! FALHA (parcial com `failures`, ou erro quando não sobrou fonte nenhuma).
//!
//! Lista vazia DEPOIS do corte incremental, ao contrário, é legítima: cada
//! arquivo já provou ter obra antes do corte, então zero é "nada novo desde o
//! cursor". Havia um `throw` ali no TS e ele transformava toda rodada
//! incremental sem novidade em falha — o motor refazia a descoberta no prazo
//! curto de retry, para sempre (medido na VPS em 2026-09-29).
//!
//! Sequencial de propósito (constraint `crawl.search_isolation`): um pedido por
//! vez. O prazo da RODADA inteira é aplicado pelo chamador.

use std::sync::Arc;
use std::time::Duration;

use tokio::time::timeout;

use crate::discovery::config::{discovery_config, EntryShape, KindModel, SitemapDiscoveryConfig};
use crate::discovery::fetch::SitemapFetch;
use crate::discovery::rules::should_keep;
use crate::discovery::types::{DiscoveredUrl, DiscoveryOptions, DiscoveryReport};
use crate::net::allowlist::Allowlist;
use crate::site_profiles::{self, SiteNetworkConfig};
use crate::sitemap::{
    is_xml_sitemap_shape, parse_sitemap_entries, parse_sitemap_rows, sitemap_failure_message,
    sitemap_shape, CrawlPageKind, SitemapShape,
};

/// Motivo de recusa compartilhado, para log e painel lerem igual.
const SHAPE_MOTIVE: &str = "formato de sitemap não reconhecido (nem XML de sitemap)";

/// Descoberta por sitemap: um fetcher e o prazo da rodada.
pub struct SitemapDiscovery {
    fetcher: Arc<dyn SitemapFetch>,
    deadline: Duration,
}

impl SitemapDiscovery {
    pub fn new(fetcher: Arc<dyn SitemapFetch>, deadline: Duration) -> Self {
        Self { fetcher, deadline }
    }

    /// UMA rodada de descoberta do site. Erro = nenhuma fonte utilizável; as
    /// falhas parciais viajam no relatório e travam só o cursor do kind afetado.
    pub async fn discover(
        &self,
        site: &str,
        opts: &DiscoveryOptions,
    ) -> Result<DiscoveryReport, String> {
        let Some(cfg) = discovery_config(site) else {
            return Err(format!("{site}: site sem descoberta de sitemap"));
        };
        match timeout(self.deadline, self.run(cfg, site, opts)).await {
            Ok(result) => result,
            Err(_) => Err(format!(
                "{site}: descoberta estourou o prazo de {}ms",
                self.deadline.as_millis()
            )),
        }
    }

    async fn run(
        &self,
        cfg: &SitemapDiscoveryConfig,
        site: &str,
        opts: &DiscoveryOptions,
    ) -> Result<DiscoveryReport, String> {
        let profile = site_profiles::site_network_config(site)
            .ok_or_else(|| format!("{site}: site sem perfil de rede"))?;
        let allow = site_profiles::resolve_allowlist(profile);
        let mut cost = 0u32;

        // 1. Índice de sitemaps (com failover de host candidato).
        let (base, index_body) = self
            .read_index(cfg, site, profile, &allow, &mut cost)
            .await?;

        // 2. Plano de leitura. No site de sitemap por KIND o arquivo de série
        //    nem é pedido com as séries desligadas (economiza a requisição da
        //    rodada); no misto não há como pular meia fonte.
        let mut planned: Vec<(String, Option<CrawlPageKind>)> = Vec::new();
        for loc in cfg
            .sitemap
            .parse_sitemap_index_locs(&index_body, &base, |h| allow.is_detail_host(h))
        {
            let series = cfg.is_series_loc(&loc);
            if series && !opts.emit_series {
                continue;
            }
            let kind_of_file = match cfg.kind_model {
                KindModel::PerKind => Some(if series {
                    CrawlPageKind::TvShow
                } else {
                    CrawlPageKind::Movie
                }),
                KindModel::Mixed { .. } => None,
            };
            planned.push((loc, kind_of_file));
        }
        if planned.is_empty() {
            // Índice só com sitemap de SÉRIE e séries desligadas: não existe
            // fonte de filme nesta rodada, e "vazio e completo" declararia o
            // acervo de filme lido quando ele não foi tocado.
            return Err(format!(
                "{site}: o índice não tem sitemap de obra para esta rodada (séries desligadas?)"
            ));
        }

        // 3. Leitura sequencial: arquivo que falha vira descoberta PARCIAL.
        let mut all: Vec<DiscoveredUrl> = Vec::new();
        let mut failures: Vec<String> = Vec::new();
        let (mut failed_movie, mut failed_tv) = (false, false);
        for (loc, kind_of_file) in &planned {
            match self
                .read_work_sitemap(cfg, site, loc, *kind_of_file, opts, &allow, &mut cost)
                .await
            {
                Ok(urls) => all.extend(urls),
                Err(msg) => {
                    failures.push(sitemap_failure_message(loc, &msg));
                    eprintln!("[crawl] {site}: sitemap falhou ({loc}): {msg}");
                    match kind_of_file {
                        Some(CrawlPageKind::Movie) => failed_movie = true,
                        Some(CrawlPageKind::TvShow) => failed_tv = true,
                        None => {
                            failed_movie = true;
                            failed_tv = true;
                        }
                    }
                }
            }
        }
        if failures.len() == planned.len() {
            return Err(format!(
                "{site}: todos os sitemaps de obra falharam ({})",
                failures.join(" | ")
            ));
        }

        // 4. Completude: geral e POR KIND (o cursor de um não é refém do outro).
        let complete = failures.is_empty();
        let (complete_movie, complete_tv_show) = match cfg.kind_model {
            KindModel::PerKind => (!failed_movie, !failed_tv),
            KindModel::Mixed { tv_hidden_off } => (
                complete,
                if !opts.emit_series && tv_hidden_off {
                    true
                } else {
                    complete
                },
            ),
        };

        // 5. Portão das séries aplicado sobre a LISTA final: o `post-sitemap` é
        //    misto, então o tipo sai do slug de cada linha.
        let urls: Vec<DiscoveredUrl> = if opts.emit_series {
            all
        } else {
            all.into_iter()
                .filter(|u| u.kind == CrawlPageKind::Movie)
                .collect()
        };
        Ok(DiscoveryReport {
            urls,
            complete,
            complete_movie,
            complete_tv_show,
            failures,
            request_cost: cost,
        })
    }

    /// Índice de sitemaps: o primeiro caminho que renderiza sitemap de obra
    /// vale como resposta. Host candidato entra como FAILOVER — o perfil Rust
    /// não guarda a base ativa (no TS ela vem do `siteSelector`), e domínio de
    /// site BR muda sem aviso.
    async fn read_index(
        &self,
        cfg: &SitemapDiscoveryConfig,
        site: &str,
        profile: &SiteNetworkConfig,
        allow: &Allowlist,
        cost: &mut u32,
    ) -> Result<(String, String), String> {
        let mut failures: Vec<String> = Vec::new();
        for host in &profile.candidate_hosts {
            let base = format!("https://{host}");
            for path in cfg.sitemap.index_paths {
                let url = join_url(&base, path);
                *cost = cost.saturating_add(1);
                match self.fetcher.fetch(site, &url).await {
                    Ok(body) => {
                        let locs = cfg
                            .sitemap
                            .parse_sitemap_index_locs(&body, &base, |h| allow.is_detail_host(h));
                        if !locs.is_empty() {
                            return Ok((base, body));
                        }
                        failures.push(format!(
                            "{url}: {}",
                            if is_xml_sitemap_shape(&body) {
                                "nenhum sitemap de obra no índice"
                            } else {
                                SHAPE_MOTIVE
                            }
                        ));
                    }
                    Err(e) => failures.push(format!("{url}: {e}")),
                }
            }
        }
        Err(format!(
            "{site}: índice de sitemaps ilegível ({})",
            failures.join(" | ")
        ))
    }

    /// Um sitemap de obra: as páginas (URL + lastmod + kind). As recusas viram
    /// ERRO — são exatamente as formas silenciosas de o cursor avançar sobre
    /// acervo nunca lido. A contagem de obra é feita ANTES do corte
    /// incremental, senão toda rodada sem novidade acusaria falha.
    #[allow(clippy::too_many_arguments)]
    async fn read_work_sitemap(
        &self,
        cfg: &SitemapDiscoveryConfig,
        site: &str,
        loc: &str,
        kind_of_file: Option<CrawlPageKind>,
        opts: &DiscoveryOptions,
        allow: &Allowlist,
        cost: &mut u32,
    ) -> Result<Vec<DiscoveredUrl>, String> {
        *cost = cost.saturating_add(1);
        let body = self.fetcher.fetch(site, loc).await?;
        let rows = match cfg.shape {
            EntryShape::Xml => {
                if !is_xml_sitemap_shape(&body) {
                    return Err(SHAPE_MOTIVE.to_string());
                }
                parse_sitemap_entries(&body)
            }
            EntryShape::XmlOrViewer => {
                if sitemap_shape(&body) == SitemapShape::Unknown {
                    return Err(SHAPE_MOTIVE.to_string());
                }
                parse_sitemap_rows(&body)
            }
        };
        if rows.is_empty() {
            return Err("sitemap sem nenhuma entrada".to_string());
        }
        let total_rows = rows.len();
        let mut out: Vec<DiscoveredUrl> = Vec::new();
        let mut accepted = 0usize;
        let mut of_kind = 0usize;
        for row in rows {
            // Loc de post é INPUT do site: a home `/`, taxonomia e host de
            // fora saem aqui, sem virar requisição nem linha de fila.
            let Some(href) = cfg
                .sitemap
                .to_work_url(&row.loc, loc, |h| allow.is_detail_host(h))
            else {
                continue;
            };
            accepted += 1;
            let kind = cfg.sitemap.kind_from_slug(href.as_str());
            if kind_of_file == Some(kind) {
                of_kind += 1;
            }
            if !should_keep(&row.lastmod, opts.since(kind)) {
                continue;
            }
            out.push(DiscoveredUrl {
                url: href.to_string(),
                lastmod: row.lastmod,
                kind,
            });
        }
        if accepted == 0 {
            return Err(format!(
                "sitemap sem URL de obra ({total_rows} entrada(s), nenhuma de página de post)"
            ));
        }
        if kind_of_file.is_some() && of_kind == 0 {
            return Err(format!(
                "sitemap sem URL do kind do arquivo ({total_rows} entrada(s), nenhuma do tipo)"
            ));
        }
        Ok(out)
    }
}

/// `base` + caminho sem barra dobrada.
fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}
