//! Rotas do `/stream` (`handle`): SWR, coalescing, prazo e resposta.
//!
//! Separado de `mod.rs` apenas pelo teto de linhas (split mecanico).

use std::time::Duration;

use serde_json::Value;

use crate::cache::{swr_lookup, SwrLookup};
use crate::contract::StreamResponse;
use crate::request::{encoded_for_internal, reply_deadline_ms, request_cache_key};

use super::effects;
use super::finish::{self, SearchInput};
use super::respond::{as_ms, empty_response, now_ms, StreamRequest, NOTICE_SEARCHING};
use super::stream_cache_metrics;
use super::tail;
use super::Orchestrator;
impl Orchestrator {
    /// A rota: devolve SEMPRE `StreamResponse` (o `/stream` quase não usa
    /// status de erro — não-200 é "addon quebrado" para o Stremio).
    pub async fn handle(&self, req: StreamRequest) -> StreamResponse {
        let now = req.now_ms.unwrap_or_else(now_ms);
        if !req.id.starts_with("tt") {
            return empty_response();
        }
        let prefix = req.prefix();
        let options = self.resolve_options(&req.encoded);
        let key = request_cache_key(&req.kind, &req.id, &self.key_options(&options));
        // ANTES do SWR, como o `findStreams` do Node (`search-cache.ts:66-72`).
        self.emit_season_key(&req, &options, &key);
        let reply_ms = reply_deadline_ms(
            req.user_agent.as_deref(),
            self.config.stremio_reply_ms,
            self.config.app_reply_ms,
        );
        let deadline_at = Some(now.saturating_add(reply_ms as i64));

        // SWR: `getWithStale` (não `get`) — a entrada expirada DENTRO da graça
        // é justamente a que o SWR quer servir enquanto revalida.
        //
        // A geração vem do MESMO instante da leitura (`get_fenced`): capturá-la
        // antes ou depois abriria a janela em que a invalidação passaria
        // despercebida, e é essa fence que autoriza o commit no fim da busca.
        let (hit, fence) = self
            .store
            .get_fenced(&key, self.config.stale_grace_seconds, as_ms(now));
        // Contadores `stream.cache.*` são SÓ do caminho do usuário: leitores
        // de fundo (`refresh.rs`) e o `/streams/trace` não entram no hit-rate.
        match swr_lookup(hit) {
            SwrLookup::Serve { entry, revalidate } => {
                if revalidate {
                    stream_cache_metrics::global_metrics()
                        .inc(stream_cache_metrics::STALE_SERVED, 1);
                    self.spawn_stale_refresh(key.clone(), req.clone(), options.clone());
                } else {
                    stream_cache_metrics::global_metrics().inc(stream_cache_metrics::HIT, 1);
                }
                return self.respond_entry(&entry, &req);
            }
            SwrLookup::Miss => {
                stream_cache_metrics::global_metrics().inc(stream_cache_metrics::MISS, 1);
            }
        }

        let input = SearchInput {
            kind: req.kind.clone(),
            id: req.id.clone(),
            encoded: Some(encoded_for_internal(req.encoded.as_deref())),
            prefix: prefix.clone(),
            options,
            key: key.clone(),
            now_ms: now,
            deadline_at,
            fence,
        };
        // A busca corre numa TASK própria: o `timeout` abaixo corta só a
        // ESPERA. Se o prazo vencer, a task continua e o passe tardio grava.
        let task = tokio::spawn({
            let this = self.clone();
            let in_flight = self.in_flight.clone();
            let key = key.clone();
            async move {
                in_flight
                    .coalesce(&key, || async move { this.run_search(input).await })
                    .await
            }
        });
        let outcome = match tokio::time::timeout(Duration::from_millis(reply_ms), task).await {
            Ok(Ok(outcome)) => outcome,
            // Corrida perdida (prazo) ou task que panicou: o cliente recebe o
            // estado parcial do Node — aviso + cacheMaxAge 0.
            Ok(Err(_)) | Err(_) => {
                eprintln!(
                    "[search] prazo de {reply_ms}ms atingido para {}; segue em background",
                    req.id
                );
                return self.respond_notice(&req, NOTICE_SEARCHING);
            }
        };
        self.respond_outcome(&outcome, &req)
    }

    /// `registerSeasonSearchKey` (`search-cache.ts:66-72`): série com debrid
    /// registra a chave da lista por temporada ANTES de olhar o cache — o hit
    /// do SWR também registra. Fire-and-forget: a resposta nunca espera.
    fn emit_season_key(&self, req: &StreamRequest, options: &Value, key: &str) {
        if !self.config.effects_enabled || req.kind != "series" {
            return;
        }
        let parsed = adom_core::parse_stremio_id(&req.id);
        let imdb = parsed.get("imdbId").and_then(Value::as_str).unwrap_or("");
        let season = parsed.get("season").and_then(Value::as_i64).unwrap_or(0);
        let effect = effects::season_key(
            &finish::str_of(options, "debridService"),
            &finish::str_of(options, "debridApiKey"),
            imdb,
            season,
            key,
        );
        let Some(effect) = effect else {
            return;
        };
        let tail = self.tail.clone();
        let encoded = encoded_for_internal(req.encoded.as_deref());
        tokio::spawn(async move {
            if let Err(err) = tail
                .effects(tail::EffectsBatch {
                    encoded,
                    effects: vec![effect],
                })
                .await
            {
                eprintln!("[search] effects (season_key) falhou: {err}");
            }
        });
    }

    /// Config do usuário: overlay do segmento sobre os defaults do operador.
    /// Sem segmento, os defaults; config inválida cai nos defaults (o 404 de
    /// config inválida é do roteador HTTP, não deste crate).
    pub(super) fn resolve_options(&self, encoded: &Option<String>) -> Value {
        match encoded {
            Some(segment) => adom_core::decode_config(
                segment,
                &self.config.defaults,
                &self.config.resolve_secret,
            )
            .unwrap_or_else(|| self.config.defaults.clone()),
            None => self.config.defaults.clone(),
        }
    }

    /// Opções que entram na CHAVE: as do usuário + `resolveUncached` do
    /// operador (muda a `url` de cada stream). Nunca o host.
    pub(super) fn key_options(&self, options: &Value) -> Value {
        let mut out = options.clone();
        if let Some(map) = out.as_object_mut() {
            map.insert(
                "resolveUncached".to_string(),
                Value::Bool(self.config.resolve_uncached),
            );
        }
        out
    }
}
