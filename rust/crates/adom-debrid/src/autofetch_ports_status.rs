//! Foto do estado das transferências (`status`) das portas do autofetch.
//!
//! Regra única e não negociável: hash pedido e NÃO listado sai `unknown`.
//! Ausência no snapshot não condena ninguém — a janela de visibilidade é do
//! serviço, e "sem resposta" nunca é "morto".

use std::collections::{BTreeMap, HashMap};

use super::{
    alldebrid_state, premiumize_state, progress_of, scalar_id, unlisted, wanted_hashes,
    AutofetchPorts, Backend, PortError, TorrentEvidence,
};

impl AutofetchPorts {
    pub(super) async fn status_inner(
        &self,
        hashes: &[String],
        transfer_ids: &BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, TorrentEvidence>, PortError> {
        let wanted = wanted_hashes(hashes);
        let mut out = BTreeMap::new();
        match &self.backend {
            Backend::AllDebrid { service, .. } => {
                let listed = service.torrent_status(&self.api_key).await?;
                for hash in &wanted {
                    let evidence = match listed.get(hash) {
                        Some(row) => TorrentEvidence {
                            state: alldebrid_state(&row.state).to_string(),
                            // O AllDebrid não publica "parado".
                            stalled: false,
                            transfer_id: row.id.clone(),
                            via_id: false,
                            progress: row.progress.as_ref().map(progress_of),
                        },
                        None => unlisted(transfer_ids.get(hash)),
                    };
                    self.remember(&evidence, hash);
                    out.insert(hash.clone(), evidence);
                }
            }
            Backend::TorBox(service) => {
                let listed = service.torrent_status(&self.api_key).await?;
                for hash in &wanted {
                    let evidence = match listed.get(hash) {
                        Some(row) => TorrentEvidence {
                            state: row.state.to_string(),
                            stalled: row.stalled,
                            transfer_id: row.id.as_ref().and_then(scalar_id),
                            via_id: false,
                            progress: None,
                        },
                        None => unlisted(transfer_ids.get(hash)),
                    };
                    self.remember(&evidence, hash);
                    out.insert(hash.clone(), evidence);
                }
            }
            Backend::Premiumize(service) => {
                // O primitivo reconhece a transferência pelo hash do `src` ou
                // pelo id devolvido no enqueue; os dois vêm do chamador.
                let ids: HashMap<String, String> = transfer_ids
                    .iter()
                    .map(|(hash, id)| (hash.to_ascii_lowercase(), id.clone()))
                    .collect();
                let report = service.torrent_status(&self.api_key, &ids).await?;
                for hash in &wanted {
                    let evidence = match report.transfers.get(hash) {
                        Some(row) => TorrentEvidence {
                            state: premiumize_state(&row.state).to_string(),
                            stalled: row.stalled,
                            transfer_id: row.id.clone().or_else(|| ids.get(hash).cloned()),
                            via_id: row.via_id,
                            progress: None,
                        },
                        None => unlisted(transfer_ids.get(hash)),
                    };
                    self.remember(&evidence, hash);
                    out.insert(hash.clone(), evidence);
                }
            }
            Backend::RealDebrid(ports) => {
                let listed = ports.torrents.torrent_status(&self.api_key).await?;
                for hash in &wanted {
                    let evidence = match listed.by_hash.get(hash) {
                        Some(row) => TorrentEvidence {
                            state: row.state.to_string(),
                            stalled: false,
                            transfer_id: row.id.as_ref().and_then(scalar_id),
                            via_id: false,
                            progress: None,
                        },
                        None => unlisted(transfer_ids.get(hash)),
                    };
                    self.remember(&evidence, hash);
                    out.insert(hash.clone(), evidence);
                }
            }
            Backend::DebridLink(service) => {
                let listed = service.autofetch_status(&self.api_key).await?;
                for hash in &wanted {
                    let evidence = match listed.get(hash) {
                        Some(row) => TorrentEvidence {
                            state: row.state.to_string(),
                            stalled: false,
                            transfer_id: row.id.as_ref().and_then(scalar_id),
                            via_id: false,
                            progress: None,
                        },
                        None => unlisted(transfer_ids.get(hash)),
                    };
                    self.remember(&evidence, hash);
                    out.insert(hash.clone(), evidence);
                }
            }
        }
        Ok(out)
    }
}
