//! Orquestração do enqueue do AllDebrid para o worker nativo do Chupim.
//!
//! A ordem é a do worker: guarda durável (`adrm`) → decisão pura → upload →
//! posse. Este módulo NÃO agenda, NÃO segura o hash (hold) e NÃO remove nem
//! limpa magnet: o hold, a liberação da marca, a espera pelo status e a limpeza
//! continuam com quem conhece o inventário e o snapshot da conta. A chave da
//! API nunca é logada nem devolvida.
use std::path::Path;

use super::{enqueue_decision, guard_evidence, mark_owned, AllDebrid, EnqueueDecision, Provenance};
use crate::alldebrid_cleanup::account_scope;
use crate::error::DebridError;

/// O que o worker precisa saber para decidir o próximo passo do hash.
///
/// `Uploaded` é o ÚNICO braço que toca a conta. `AlreadyReady` NÃO limpa a
/// marca (quem a limpa é o worker, depois de conferir o inventário) e
/// `GuardUnavailable` não autoriza requisição nenhuma.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EnqueueOutcome {
    Uploaded { id: Option<String>, ready: bool },
    AlreadyReady,
    Blocked,
    GuardUnavailable,
    Rejected,
}

impl AllDebrid {
    /// Enfileira `hash` na conta passando pela guarda durável de reupload.
    ///
    /// A conta é derivada da chave (o mesmo escopo de `adrm`/`adsub` do Node) e
    /// o hash entra sempre em minúsculas: a AllDebrid devolve caixa alta em
    /// alguns caminhos, e a guarda, o memo de posse e o inventário comparam em
    /// minúsculas. `db_path` é o `cache.db` do Node, lido em modo somente
    /// leitura (nunca criado aqui); `now_ms` vem do chamador porque quem agenda
    /// é o worker. O hold é do chamador e precisa existir ANTES desta chamada.
    ///
    /// Guarda ilegível não vira "sem marca": `GuardUnavailable` e `Rejected`
    /// preservam a regra do resto do adaptador — sem prova, sem envio.
    pub async fn enqueue_autofetch(
        &self,
        key: &str,
        hash: &str,
        db_path: &Path,
        inventory_ready: bool,
        provenance: Provenance,
        now_ms: i64,
    ) -> Result<EnqueueOutcome, DebridError> {
        let account = account_scope(key);
        let hash = hash.trim().to_lowercase();
        if hash.is_empty() {
            // Sem hash não há o que consultar, subir ou marcar.
            return Ok(EnqueueOutcome::Rejected);
        }
        let evidence = guard_evidence(db_path, &account, &hash, inventory_ready, now_ms);
        match enqueue_decision(evidence) {
            // Guarda ilegível é fail-closed: nenhuma requisição sai.
            EnqueueDecision::GuardUnavailable => Ok(EnqueueOutcome::GuardUnavailable),
            EnqueueDecision::Blocked => Ok(EnqueueOutcome::Blocked),
            EnqueueDecision::AlreadyReady => Ok(EnqueueOutcome::AlreadyReady),
            EnqueueDecision::Upload => {
                let uploaded = self.upload_magnet(key, &hash).await?;
                if !uploaded.accepted {
                    // Recusa do serviço não marca posse: o hash não entrou.
                    return Ok(EnqueueOutcome::Rejected);
                }
                // Só chega aqui com aceite, e `mark_owned` ainda exige
                // proveniência `New`; falhar a marca não desfaz o upload.
                let _ = mark_owned(&account, &hash, true, provenance);
                Ok(EnqueueOutcome::Uploaded {
                    id: uploaded.id,
                    ready: uploaded.ready,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::alldebrid::alldebrid_tests::{
        empty_ok, envelope, hash_of, hits, listen, mock, open, values, API_KEY,
    };
    use crate::alldebrid_cleanup::adrm_key;

    /// Instante fixo: a guarda compara `expires_at > now_ms`, e o relógio real
    /// tornaria o teste dependente do tempo de execução.
    const NOW: i64 = 1_000_000;

    /// `cache.db` com o schema do Node (`key`/`value`/`expires_at`), já com as
    /// linhas que o teste precisa: quem escreve é o Node, nunca a guarda.
    fn cache_db(rows: &[(String, i64)]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
        )
        .unwrap();
        for (key, expires_at) in rows {
            conn.execute(
                "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
                rusqlite::params![key, expires_at],
            )
            .unwrap();
        }
        (dir, path)
    }

    /// Marca `adrm` viva (ainda não expirada) da conta da chave de teste.
    fn live_mark(hash: &str) -> (String, i64) {
        (adrm_key(&account_scope(API_KEY), hash), NOW + 60_000)
    }

    /// Upload ACEITO: lista com o magnet, id numérico e `ready` como prova do ⚡.
    fn upload_aceito(hash: &str) -> String {
        envelope(json!({"magnets": [{"id": 77, "hash": hash, "ready": true}]}))
    }

    /// Upload RECUSADO: o serviço devolve lista vazia (não é erro de rede).
    fn upload_recusado() -> String {
        envelope(json!({"magnets": []}))
    }

    #[tokio::test]
    async fn sem_marca_sobe_e_devolve_uploaded() {
        let (_dir, path) = cache_db(&[]);
        let scene = mock(&upload_aceito(&hash_of('a')), &empty_ok(), &empty_ok());
        let ad = open(listen(scene.clone()).await);
        let out = ad
            .enqueue_autofetch(
                API_KEY,
                // Caixa alta na entrada de propósito: o serviço e o memo de
                // posse trabalham com o hash normalizado.
                &hash_of('a').to_uppercase(),
                &path,
                false,
                Provenance::New,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            out,
            EnqueueOutcome::Uploaded {
                id: Some("77".to_string()),
                ready: true,
            }
        );
        let seen = hits(&scene);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].path, "/magnet/upload");
        assert_eq!(values(&seen[0].query, "magnets[]"), vec![hash_of('a')]);
        assert!(seen[0].auth_ok);
        assert!(!seen[0].query.contains(API_KEY), "a chave não vai na URL");
        // A posse positiva não é afirmada aqui: o registro é memória GLOBAL do
        // processo e outro teste pode zerá-lo no meio do assert (a regra
        // `accepted && New` é provada em `alldebrid_owned`).
    }

    #[tokio::test]
    async fn marca_viva_bloqueia_sem_upload() {
        let (_dir, path) = cache_db(&[live_mark(&hash_of('b'))]);
        let scene = mock(&upload_aceito(&hash_of('b')), &empty_ok(), &empty_ok());
        let ad = open(listen(scene.clone()).await);
        let out = ad
            .enqueue_autofetch(API_KEY, &hash_of('b'), &path, false, Provenance::New, NOW)
            .await
            .unwrap();
        assert_eq!(out, EnqueueOutcome::Blocked);
        assert!(hits(&scene).is_empty(), "marca viva não chama o serviço");
    }

    #[tokio::test]
    async fn marca_viva_com_inventario_pronto_nao_reenvia() {
        let (_dir, path) = cache_db(&[live_mark(&hash_of('c'))]);
        let scene = mock(&upload_aceito(&hash_of('c')), &empty_ok(), &empty_ok());
        let ad = open(listen(scene.clone()).await);
        let out = ad
            .enqueue_autofetch(API_KEY, &hash_of('c'), &path, true, Provenance::New, NOW)
            .await
            .unwrap();
        assert_eq!(out, EnqueueOutcome::AlreadyReady);
        assert!(hits(&scene).is_empty(), "já pronto não reenvia");
        // A marca continua no banco: apagá-la (e só depois de conferir o
        // inventário) é decisão do worker, nunca do enqueue.
        assert!(crate::alldebrid::read_adrm_block(
            &path,
            &account_scope(API_KEY),
            &hash_of('c'),
            NOW
        )
        .unwrap());
    }

    #[tokio::test]
    async fn guarda_ilegivel_e_guard_unavailable_sem_upload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ausente.db");
        let scene = mock(&upload_aceito(&hash_of('d')), &empty_ok(), &empty_ok());
        let ad = open(listen(scene.clone()).await);
        let out = ad
            .enqueue_autofetch(API_KEY, &hash_of('d'), &path, false, Provenance::New, NOW)
            .await
            .unwrap();
        assert_eq!(out, EnqueueOutcome::GuardUnavailable);
        assert!(hits(&scene).is_empty(), "sem guarda legível nada é enviado");
        // Leitura somente leitura: a orquestração não cria o banco que faltou.
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn upload_recusado_e_rejected_sem_posse() {
        // Chave própria: a posse é memória GLOBAL por conta, e o `reset` de
        // outro teste não pode mascarar o que esta recusa marcou (ou não).
        const RECUSA_KEY: &str = "ad-enqueue-recusa";
        let (_dir, path) = cache_db(&[]);
        let scene = mock(&upload_recusado(), &empty_ok(), &empty_ok());
        let ad = open(listen(scene.clone()).await);
        let out = ad
            .enqueue_autofetch(
                RECUSA_KEY,
                &hash_of('e'),
                &path,
                false,
                Provenance::New,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(out, EnqueueOutcome::Rejected);
        // A requisição saiu (a recusa é do serviço), mas o hash NÃO vira posse.
        let seen = hits(&scene);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].path, "/magnet/upload");
        assert!(
            !crate::alldebrid_cleanup::submitted_hashes(&account_scope(RECUSA_KEY))
                .contains(&hash_of('e'))
        );
    }

    #[tokio::test]
    async fn hash_vazio_e_rejected_antes_de_qualquer_io() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nao-existe.db");
        let scene = mock(&upload_aceito(&hash_of('f')), &empty_ok(), &empty_ok());
        let ad = open(listen(scene.clone()).await);
        for hash in ["", "   "] {
            let out = ad
                .enqueue_autofetch(API_KEY, hash, &path, true, Provenance::New, NOW)
                .await
                .unwrap();
            assert_eq!(out, EnqueueOutcome::Rejected);
        }
        assert!(hits(&scene).is_empty(), "hash vazio não gera requisição");
        assert!(!path.exists(), "nem a guarda é aberta");
    }
}
