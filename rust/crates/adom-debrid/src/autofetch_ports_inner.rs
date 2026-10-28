//! Escritas e leituras de conta das portas: `enqueue`, `check`, `remove`,
//! `evict` e `account`. `status` fica em `autofetch_ports_status.rs`.

use adom_core::PlayHint;
use serde_json::Value;

use super::{
    non_negative, rejected, safe_id, wanted_hashes, AccountEvidence, AutofetchPorts, Backend,
    CacheEvidence, EnqueueEvidence, PortCandidate, PortError,
};
use crate::alldebrid::{CheckOpts, EnqueueOutcome};
use crate::error::now_ms;
use crate::torbox::ACTIVE_LIMIT;

impl AutofetchPorts {
    pub(super) async fn enqueue_inner(
        &self,
        candidate: &PortCandidate,
    ) -> Result<EnqueueEvidence, PortError> {
        let hash = candidate.hash.trim().to_ascii_lowercase();
        if hash.is_empty() {
            return Ok(rejected());
        }
        match &self.backend {
            Backend::AllDebrid { service, facts } => {
                // Sem `cache.db` a guarda `adrm` não é legível: nada é enviado.
                let Some(db_path) = facts.db_path.as_deref() else {
                    return Ok(rejected());
                };
                let outcome = service
                    .enqueue_autofetch(
                        &self.api_key,
                        &hash,
                        db_path,
                        facts.inventory_ready,
                        facts.provenance,
                        now_ms() as i64,
                    )
                    .await?;
                Ok(match outcome {
                    EnqueueOutcome::Uploaded { id, .. } => {
                        self.learn(id.as_deref(), &hash);
                        EnqueueEvidence {
                            accepted: true,
                            transfer_id: id,
                        }
                    }
                    // A prova de ⚡ já existe: não reenvia e, sem id, não há o que
                    // reconhecer depois.
                    EnqueueOutcome::AlreadyReady => EnqueueEvidence {
                        accepted: true,
                        transfer_id: None,
                    },
                    // Bloqueio, guarda ilegível e recusa do serviço: o hash NÃO
                    // entrou, então não há aceite.
                    EnqueueOutcome::Blocked
                    | EnqueueOutcome::GuardUnavailable
                    | EnqueueOutcome::Rejected => rejected(),
                })
            }
            Backend::TorBox(service) => {
                let accepted = service.enqueue(&self.api_key, &hash, None).await?;
                Ok(EnqueueEvidence {
                    accepted,
                    // O primitivo só diz se há id; adivinhar o número seria mentira.
                    transfer_id: None,
                })
            }
            Backend::Premiumize(service) => {
                let id = service.enqueue(&self.api_key, &hash, None).await?;
                self.learn(id.as_deref(), &hash);
                Ok(EnqueueEvidence {
                    accepted: id.is_some(),
                    transfer_id: id,
                })
            }
            Backend::RealDebrid(ports) => {
                let hint = PlayHint {
                    season: candidate.season,
                    episode: candidate.episode,
                    work: None,
                    dubbed: candidate.dubbed,
                };
                let id = ports
                    .manager
                    .enqueue(
                        ports.torrents.clone(),
                        &self.api_key,
                        &hash,
                        None,
                        &hint,
                        ports.poll_wait,
                    )
                    .await
                    .map_err(PortError::Rd)?;
                self.learn(id.as_deref(), &hash);
                Ok(EnqueueEvidence {
                    accepted: id.is_some(),
                    transfer_id: id,
                })
            }
            Backend::DebridLink(service) => {
                let accepted = service
                    .enqueue_autofetch(&self.api_key, &hash, None)
                    .await?;
                Ok(EnqueueEvidence {
                    accepted,
                    transfer_id: None,
                })
            }
        }
    }

    pub(super) async fn check_inner(&self, hashes: &[String]) -> Result<CacheEvidence, PortError> {
        let wanted = wanted_hashes(hashes);
        if wanted.is_empty() {
            // Nada perguntado não prova nada: `known:true` sem pergunta seria
            // "lista de misses" disfarçada.
            return Ok(CacheEvidence {
                known: false,
                cached: Vec::new(),
            });
        }
        match &self.backend {
            Backend::AllDebrid { service, .. } => {
                // `CheckOpts::default()` é read-only (`CleanupMode::Off`): o porto
                // consulta; apagar é do dono do inventário e dos holds.
                let report = service
                    .check_cached(&self.api_key, &wanted, &CheckOpts::default())
                    .await?;
                Ok(CacheEvidence {
                    known: report.complete,
                    cached: report.cached,
                })
            }
            Backend::TorBox(service) => {
                let report = service
                    .check_cached(&self.api_key, &wanted, &[], None)
                    .await?;
                Ok(CacheEvidence {
                    known: report.complete,
                    cached: report.cached,
                })
            }
            Backend::Premiumize(service) => {
                let report = service.check_cached(&self.api_key, &wanted, None).await?;
                Ok(CacheEvidence {
                    known: report.complete,
                    cached: report.cached,
                })
            }
            Backend::RealDebrid(ports) => match &ports.ledger {
                Some(peek) => {
                    let list = ports.torrents.check_cached(&wanted, |hash| peek(hash));
                    Ok(CacheEvidence {
                        known: list.complete,
                        cached: list.cached,
                    })
                }
                // Sem o ledger do chamador não há prova de cache.
                None => Ok(CacheEvidence {
                    known: false,
                    cached: Vec::new(),
                }),
            },
            // `CACHE_CHECK = false` no adaptador: a resposta seria inventada.
            Backend::DebridLink(_) => Ok(CacheEvidence {
                known: false,
                cached: Vec::new(),
            }),
        }
    }

    pub(super) async fn remove_inner(&self, transfer_id: &str) -> Result<bool, PortError> {
        let id = transfer_id.trim();
        if id.is_empty() {
            return Err(PortError::InvalidInput("remove sem id de transferência"));
        }
        match &self.backend {
            Backend::AllDebrid { service, .. } => {
                if !safe_id(id) {
                    return Err(PortError::InvalidInput("id do AllDebrid fora do formato"));
                }
                service.remove_torrent(&self.api_key, id).await?;
                Ok(true)
            }
            Backend::TorBox(service) => Ok(service.remove_torrent(&self.api_key, id).await),
            Backend::Premiumize(service) => {
                service.remove_torrent(&self.api_key, id).await?;
                Ok(true)
            }
            Backend::RealDebrid(ports) => {
                let Some(hash) = self.hash_of_id(id) else {
                    // Sem o hash não há prova de posse do id: nada é escrito.
                    // O chamador roda `status` (que aprende o par) antes.
                    return Ok(false);
                };
                ports
                    .manager
                    .remove(ports.torrents.clone(), &self.api_key, &hash, id)
                    .await
                    .map_err(PortError::Rd)
            }
            Backend::DebridLink(service) => Ok(service
                .remove_autofetch(&self.api_key, &Value::String(id.to_string()))
                .await),
        }
    }

    pub(super) async fn evict_inner(&self, _hashes: &[String]) -> Result<Vec<String>, PortError> {
        // Nenhum dos cinco apaga POR HASH. Lista vazia seria "nada a apagar";
        // a capacidade está desligada e isso é dito.
        Err(PortError::Unsupported("evict"))
    }

    pub(super) async fn account_inner(&self) -> Result<AccountEvidence, PortError> {
        match &self.backend {
            Backend::AllDebrid { service, .. } => {
                let status = service.account_status(&self.api_key).await?;
                // O teto de 1000 magnets é MEDIDO, não publicado pela API:
                // inferir limite aqui faria o gate pausar por número inventado.
                Ok(AccountEvidence {
                    used: Some(status.magnets as u64),
                    max: None,
                })
            }
            Backend::TorBox(service) => {
                let status = service.account_status(&self.api_key).await?;
                // Ocupação = vagas ativas do plano, não o total do mylist.
                Ok(AccountEvidence {
                    used: Some(status.active),
                    max: Some(ACTIVE_LIMIT as u64),
                })
            }
            Backend::Premiumize(service) => {
                let status = service.account_status(&self.api_key).await?;
                // `limit_used` é FRAÇÃO (0..1); aqui vira milésimo de 1000 para
                // caber em `used`/`max` inteiros sem perder resolução.
                Ok(AccountEvidence {
                    used: status
                        .limit_used
                        .map(|fraction| (fraction * 1000.0).round() as u64),
                    max: Some(1000),
                })
            }
            Backend::RealDebrid(ports) => {
                let Some(count) = ports.torrents.active_count(&self.api_key).await? else {
                    return Ok(AccountEvidence {
                        used: None,
                        max: None,
                    });
                };
                Ok(AccountEvidence {
                    used: Some(non_negative(count.nb)),
                    max: Some(non_negative(count.limit)),
                })
            }
            // Debrid-Link não publica `accountStatus`.
            Backend::DebridLink(_) => Err(PortError::Unsupported("account")),
        }
    }
}
