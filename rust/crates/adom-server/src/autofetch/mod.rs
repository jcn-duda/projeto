//! Worker NATIVO do Chupim no gateway — hoje só o ciclo de vida administrativo.
//!
//! Esta fatia (Fase A / A5) sobe o worker **vazio**: ele tem thread própria, um
//! retrato da fila lido no boot e as rotas do painel, mas não escolhe
//! candidato, não consulta indexador, não chama debrid e não escreve em
//! `autofetch:v3:*`. `enabled` é sempre `false` e `phase` é `"prepared"`.
//!
//! # Credencial de usuário
//!
//! A chave do debrid (`dk`) **nunca** entra no KV nem em log. O contrato é o de
//! `docs/autofetch-worker-credential-gate.md`: a fila (`autofetch:v3:q:`),
//! o marker (`autofetch:v3:m:`) e a blacklist (`autofetch:v3:dead:`) não
//! guardam credencial por desenho, e o que o gateway persiste aqui é só
//! `autofetch-worker:v1:config` (`paused` + `intervalMs`). O `POST
//! /autofetch/config` recusa com 400 qualquer campo fora desse par — `dk`,
//! `apiKey` e afins inclusive.
//!
//! # Quando o dreno liga
//!
//! O dreno/recheck só liga quando o **gate de credencial fechar** (o cofre em
//! RAM por `account_scope` alimentado pelo `encoded` da busca). Até lá,
//! `POST /autofetch/drain` e `/autofetch/suppressed-drain` respondem
//! `phase:"prepared"`, `effect:"none"`, `drained:0` e não tocam em nada; o
//! Chupim continua sendo o do Node, que paga o gate com o `RuntimeContext` da
//! requisição.
//!
//! Rotas (montadas na admin do store, `127.0.0.1:8711`, loopback + token):
//! `GET /autofetch`, `POST /autofetch/config|pause|drain|suppressed-drain`.

mod routes;
mod worker;

pub(crate) use routes::router as admin_router;
pub(crate) use worker::{spawn, AutofetchHandle};

#[cfg(test)]
mod tests;
