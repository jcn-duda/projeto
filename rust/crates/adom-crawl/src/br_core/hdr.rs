//! Núcleo compartilhado do HDRTorrents (`resolvers/profiles/hdrtorrents-parsers.ts`).
//!
//! Reservado à fase 1: aqui mora a implementação fiel das linhas
//! `.download-row` (áudio, qualidade, fonte, episódio e `dn` do magnet),
//! consumida pelo resolver E pelo raspador. Enquanto o corpo estiver vazio, o
//! parser do resolver continua em `adom-resolvers/src/sites/hdrtorrents.rs`.
