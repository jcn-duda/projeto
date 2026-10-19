//! Paridade EXECUTÁVEL com o `toStremioStream` do TS (oráculo: worktree
//! `E:/adom-esm`, branch `esm`, commit do golden `stream-display`). Cada valor
//! esperado abaixo foi capturado rodando a função TS com o MESMO `RawItem`,
//! não inferido do código:
//!
//! ```text
//! node -e "import('file:///E:/adom-esm/dist/src/utils/search-names.js')..."
//! ```
//!
//! Cobre as duas divergências comprovadas do `/stream` nativo:
//! 1. sem seeders, o TS SEMPRE publica `👤 0` na linha do título;
//! 2. o blob de tags do HDRTorrent sai do título EXIBIDO
//!    (`stripQualityTagBlob`), mas a qualidade continua sendo lida do título
//!    cru (o classificador já corta o blob) — exibir limpo não muda o ranking.

use super::test_common::*;
use adom_core::{RankingStream, StreamNameStyle};
use serde_json::json;

use crate::list_builder::helpers::{display_source, display_tracker, map_stream, stats_line};

fn item(value: serde_json::Value) -> RawItem {
    crate::raw_item::raw_item_from_value(&value)
}

fn mapped(item: &RawItem, display: &StreamDisplayConfig) -> RankingStream {
    map_stream(item, display, &AudioAudit::default()).expect("item tem infoHash")
}

fn compact() -> StreamDisplayConfig {
    StreamDisplayConfig::default()
}

fn full() -> StreamDisplayConfig {
    StreamDisplayConfig {
        stream_name_style: StreamNameStyle::Full,
        stream_name_show_source: true,
    }
}

/// TS: `seederBit = stored ? … : \`👤 ${seeders}\`` — zero NÃO some.
#[test]
fn sem_seeders_exibe_icone_zero_como_o_ts() {
    let raw = item(json!({
        "title": "Filme Teste (2024) 1080p WEB-DL Dublado",
        "infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "seeders": 0,
        "size": 1234567890,
        "indexer": "redetorrent",
        "tracker": "Rede Torrent",
    }));

    let stream = mapped(&raw, &compact());

    assert_eq!(
        stream.title.as_deref(),
        Some(
            "Filme Teste (2024) 1080p WEB-DL Dublado\n\
             👤 0 💾 1.15 GB ⚙️ Rede Torrent"
        ),
        "linha do título do TS (toStremioStream) para seeders=0"
    );
    assert_eq!(
        stream.name.as_deref(),
        Some("1080p WEB-DL BR · Rede Torrent"),
        "nome compacto do TS"
    );
    assert_eq!(stream.quality.as_deref(), Some("1080p"));
    assert_eq!(stream.seeders, Some(0.0));
    assert_eq!(display_tracker(&raw), Some("Rede Torrent"));
    assert_eq!(display_source(&raw, raw.title_text()), "WEB-DL");
}

/// Blob do HDRTorrent: `1080p, 2160p, 720p, HD, WEB-DL` no fim do POST não é a
/// qualidade do botão. O TS exibe `stripQualityTagBlob(title)` e mantém a
/// qualidade 720p (o classificador já ignora o blob).
#[test]
fn blob_de_qualidade_do_hdr_sai_do_titulo_exibido_sem_mudar_a_qualidade() {
    let raw = item(json!({
        "title": "Fallout 1ª Temporada Completa LEGENDADA 720P 1080p, 2160p, 720p, HD, WEB-DL",
        "infoHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "seeders": 12,
        "size": 3221225472u64,
        "indexer": "hdrtorrents",
        "tracker": "HDR Torrents",
    }));

    let stream = mapped(&raw, &compact());

    assert_eq!(
        stream.title.as_deref(),
        Some(
            "Fallout 1ª Temporada Completa LEGENDADA 720P\n\
             👤 12 💾 3.00 GB ⚙️ HDR Torrents"
        ),
        "título exibido limpo (blob cortado) e linha de stats do TS"
    );
    assert_eq!(
        stream.name.as_deref(),
        Some("720p WEB-DL LEG · HDR Torrents · 👤 12"),
        "nome compacto do TS"
    );
    assert_eq!(
        stream.quality.as_deref(),
        Some("720p"),
        "qualidade continua vindo do título cru via núcleo (blob ignorado no cálculo)"
    );
    assert_eq!(display_source(&raw, raw.title_text()), "WEB-DL");

    // No estilo `full` o título também aparece no `name`; o TS usa o limpo.
    assert_eq!(
        mapped(&raw, &full()).name.as_deref(),
        Some(
            "Fallout 1ª Temporada Completa LEGENDADA 720P\n\
             720p WEB-DL LEG · HDR Torrents · 👤 12"
        ),
        "nome full do TS usa displayTitle"
    );
}

/// `tracker || Tracker || Indexer || indexer` do Jackett: o `RawItem` do Rust já
/// normaliza os PascalCase para `tracker` (não mexer sem teste que reproduza).
#[test]
fn tracker_pascal_case_e_indexer_viram_rotulo_de_exibicao() {
    let com_tracker = item(json!({
        "Title": "Filme Teste (2024) 720p WEBRip",
        "Tracker": "Rede Torrent",
        "seeders": 7,
        "size": 2147483648u64,
        "infoHash": "cccccccccccccccccccccccccccccccccccccccc",
    }));
    let sem_tracker = item(json!({
        "title": "Filme Teste (2024) 720p WEBRip",
        "Indexer": "Nerd Filmes",
        "seeders": 7,
        "size": 2147483648u64,
        "infoHash": "cccccccccccccccccccccccccccccccccccccccc",
    }));

    assert_eq!(display_tracker(&com_tracker), Some("Rede Torrent"));
    assert_eq!(display_tracker(&sem_tracker), Some("Nerd Filmes"));
    assert_eq!(
        mapped(&com_tracker, &compact()).name.as_deref(),
        Some("720p WEBRip · Rede Torrent · 👤 7"),
        "nome compacto do TS"
    );
    assert_eq!(
        mapped(&com_tracker, &compact()).title.as_deref(),
        Some("Filme Teste (2024) 720p WEBRip\n👤 7 💾 2.00 GB ⚙️ Rede Torrent")
    );
}

/// O `dn=` do magnet é prova do arquivo real e vence o título do post silencioso.
#[test]
fn fonte_vem_do_dn_do_magnet_como_no_ts() {
    let raw = item(json!({
        "title": "Resident Evil (2026) [1080p 2.60 GB]",
        "infoHash": "dddddddddddddddddddddddddddddddddddddddd",
        "seeders": 3,
        "size": 2791728742u64,
        "indexer": "bludv",
        "tracker": "BLUDV",
        "magnet": "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd&dn=Resident.Evil.2026.1080p.CAMRip",
    }));

    assert_eq!(display_source(&raw, raw.title_text()), "CAM");
    assert_eq!(
        mapped(&raw, &compact()).name.as_deref(),
        Some("1080p CAM · BLUDV · 👤 3"),
        "nome compacto do TS"
    );
    assert_eq!(
        mapped(&raw, &compact()).title.as_deref(),
        Some(
            "Resident Evil (2026) [1080p 2.60 GB]\n\
             👤 3 💾 2.60 GB ⚙️ BLUDV"
        )
    );
}

/// Reserva/foto (`stored`): `📦` + seeders `~N` (ou `👤 ~` sem medição), como o
/// TS — e o zero continua presente na forma de til.
#[test]
fn reserva_sem_seeders_mostra_til_como_no_ts() {
    let raw = item(json!({
        "title": "Filme Teste (2024) 1080p Dublado",
        "infoHash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "seeders": 0,
        "size": 1073741824u64,
        "indexer": "redetorrent",
        "tracker": "Rede Torrent",
        "fromFallback": true,
    }));

    let stream = mapped(&raw, &compact());

    assert_eq!(
        stream.title.as_deref(),
        Some(
            "Filme Teste (2024) 1080p Dublado\n\
             📦 👤 ~ 💾 1.00 GB ⚙️ Rede Torrent"
        )
    );
    assert_eq!(
        stream.name.as_deref(),
        Some("📦 · 1080p BR · Rede Torrent · 👤 ~"),
        "nome compacto do TS"
    );
}

/// O mínimo do `stats_line`: sem tamanho nem tracker, o TS ainda tem `👤 0`, e a
/// linha do título nunca fica sem o separador `\n`.
#[test]
fn stats_line_sem_seeders_nunca_omite_o_icone() {
    let raw = item(json!({
        "title": "Filme Teste (2024) 1080p",
        "infoHash": "ffffffffffffffffffffffffffffffffffffffff",
    }));

    assert_eq!(stats_line(&raw), "👤 0");
    assert_eq!(
        mapped(&raw, &compact()).title.as_deref(),
        Some("Filme Teste (2024) 1080p\n👤 0")
    );
}
