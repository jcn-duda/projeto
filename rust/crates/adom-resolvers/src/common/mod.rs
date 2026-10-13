//! Fachada do núcleo BR. A implementação mora em `adom_crawl::br_core` (crate de
//! baixo, que o raspador também consome) — ver o doc de lá. Reexportar em vez de
//! mover os `use` dos 30 arquivos de `sites`/`flows` mantém `crate::common::…`
//! valendo e o golden do resolver como teste de regressão da mudança.

pub use adom_crawl::br_core::*;
