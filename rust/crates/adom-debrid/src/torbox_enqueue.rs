//! Enqueue TorBox para o futuro worker: só aceita ou recusa, não faz poll.
//! O chamador precisa estabelecer hold e gates antes da operação.

use std::collections::BTreeMap;

use reqwest::Method;
use serde_json::Value;

use super::{account_rows, create_body, is_ready, magnet_for, DebridError, TorBox, CALL_TIMEOUT};

#[derive(Clone, Debug, PartialEq)]
pub struct TorboxStatus {
    pub state: &'static str,
    pub stalled: bool,
    pub id: Option<Value>,
}

impl TorBox {
    /// Mesmo `createtorrent` usado no play, mas sem aguardar download.
    /// A URI opcional só é usada se carregar o hash solicitado.
    pub async fn enqueue(
        &self,
        api_key: &str,
        hash: &str,
        magnet: Option<&str>,
    ) -> Result<bool, DebridError> {
        let magnet = magnet_for(hash, magnet);
        let created = self
            .call(
                api_key,
                "/torrents/createtorrent",
                Method::POST,
                &[],
                Some(create_body(&magnet)),
                CALL_TIMEOUT,
            )
            .await?;
        let id = created.get("data").and_then(|data| {
            data.get("torrent_id")
                .filter(|value| !value.is_null())
                .or_else(|| data.get("id").filter(|value| !value.is_null()))
        });
        Ok(id.is_some())
    }

    /// Foto da conta para o recheck. Estado desconhecido não condena o hash.
    pub async fn torrent_status(
        &self,
        api_key: &str,
    ) -> Result<BTreeMap<String, TorboxStatus>, DebridError> {
        let response = self
            .call(
                api_key,
                "/torrents/mylist",
                Method::GET,
                &[],
                None,
                CALL_TIMEOUT,
            )
            .await?;
        let mut out = BTreeMap::new();
        for row in account_rows(&response) {
            let Some(hash) = row
                .get("hash")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let raw = row
                .get("download_state")
                .and_then(Value::as_str)
                .unwrap_or("");
            let lower = raw.to_lowercase();
            let (state, stalled) = if ["error", "failed", "broken", "dead"]
                .iter()
                .any(|s| lower.contains(s))
            {
                ("dead", false)
            } else if is_ready(&row) {
                ("ready", false)
            } else if raw == "stalled" {
                ("downloading", true)
            } else if ["downloading", "queued", "processing", "uploading"]
                .iter()
                .any(|s| lower.contains(s))
            {
                ("downloading", false)
            } else {
                ("unknown", false)
            };
            out.insert(
                hash.to_lowercase(),
                TorboxStatus {
                    state,
                    stalled,
                    id: row.get("id").cloned(),
                },
            );
        }
        Ok(out)
    }

    /// Remoção por id; falhas retornam falso. Bloqueia caracteres que poderiam
    /// alterar o caminho para não permitir que o id seja uma rota arbitrária.
    pub async fn remove_torrent(&self, api_key: &str, id: &str) -> bool {
        if id.is_empty()
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return false;
        }
        self.call(
            api_key,
            &format!("/torrents/delete/{id}"),
            Method::DELETE,
            &[],
            None,
            CALL_TIMEOUT,
        )
        .await
        .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::super::torbox_tests::{listen, open, Kind, Mode, H1, KEY};

    #[tokio::test]
    async fn aceita_sem_poll_com_magnet_rico() {
        let (addr, mock) = listen(Mode::Resolve(Kind::Happy), 200, "", None).await;
        let svc = open(addr);
        let magnet = format!("magnet:?xt=urn:btih:{H1}&dn=Filme");
        assert!(svc.enqueue(KEY, H1, Some(&magnet)).await.unwrap());
        let hits = mock.hits.lock().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            (hits[0].method.as_str(), hits[0].path.as_str()),
            ("POST", "/torrents/createtorrent")
        );
        assert!(hits[0].auth_ok);
        assert!(hits[0].body.contains("dn%3DFilme"));
        assert!(hits[0].body.ends_with("&seed=3&allow_zip=false"));
        assert!(!hits[0].body.contains(KEY));
    }

    #[tokio::test]
    async fn sem_identificador_nao_alega_aceite() {
        let (addr, mock) = listen(Mode::Resolve(Kind::NoId), 200, "", None).await;
        assert!(!open(addr).enqueue(KEY, H1, None).await.unwrap());
        assert_eq!(mock.hits.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn magnet_de_outro_hash_e_descartado() {
        let (addr, mock) = listen(Mode::Resolve(Kind::Happy), 200, "", None).await;
        assert!(open(addr)
            .enqueue(
                KEY,
                H1,
                Some("magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=alheio")
            )
            .await
            .unwrap());
        let hits = mock.hits.lock().unwrap();
        assert!(hits[0].body.contains(H1));
        assert!(!hits[0].body.contains("alheio"));
    }

    #[tokio::test]
    async fn status_distingue_morto_pronto_parado_e_desconhecido() {
        let body = r#"{"success":true,"data":[{"hash":"AA","id":1,"download_state":"error","download_finished":true},{"hash":"BB","id":2,"download_present":true},{"hash":"CC","id":3,"download_state":"stalled"},{"hash":"DD","download_state":"QUEUED"},{"hash":"EE"}]}"#;
        let (addr, mock) = listen(Mode::Fixed, 200, body, None).await;
        let status = open(addr).torrent_status(KEY).await.unwrap();
        assert_eq!(status["aa"].state, "dead");
        assert_eq!(status["bb"].state, "ready");
        assert_eq!(
            (status["cc"].state, status["cc"].stalled),
            ("downloading", true)
        );
        assert_eq!(status["dd"].state, "downloading");
        assert_eq!(status["ee"].state, "unknown");
        assert_eq!(mock.hits.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn remove_somente_por_id_valido_e_recusa_erro() {
        let (addr, mock) = listen(Mode::Fixed, 200, r#"{"success":true}"#, None).await;
        let svc = open(addr);
        assert!(!svc.remove_torrent(KEY, "../foo").await);
        assert!(svc.remove_torrent(KEY, "123").await);
        {
            let hits = mock.hits.lock().unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(
                (hits[0].method.as_str(), hits[0].path.as_str()),
                ("DELETE", "/torrents/delete/123")
            );
        }
        let (addr2, _) = listen(Mode::Fixed, 403, "", None).await;
        assert!(!open(addr2).remove_torrent(KEY, "123").await);
    }
}
