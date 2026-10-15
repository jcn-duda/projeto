//! Porte puro de `src/providers/pack-text-totals.ts`.
//!
//! O app Power Movie lê o PRIMEIRO "N GB" de description+title+name quando não
//! há `size` nem `behaviorHints.videoSize`; num pack multi-episódio esse número
//! é o TOTAL do torrent, não o do episódio — por isso ele sai do TEXTO (title e
//! name) e segue interno em `_packBytes`. Nada aqui conhece cache/debrid/trace:
//! a lista de arquivos CHEGA LIDA (o `peekFileSizes` do Node) e o trace vira
//! contador na saída.
//!
//! Paridades ansiosas do porte:
//! - `namesMultipleEpisodes` = `parseTitleSeasonEpisode(title).episodes.length > 1`.
//! - `looksPackByFiles` no TS é IO (`peekFileSizes`): o NÚCLEO (2+ vídeos no
//!   hash) mora no `debrid::looks_pack_by_files` e é reusado; aqui só fica o
//!   wrapper [`files_prove_pack`] que aceita `None` = hash sem lista. A caixa
//!   do Node (`recordFileSizes`) filtra tamanho 0, não-vídeo, sample e
//!   propaganda e baixa o hash antes de gravar — quem alimenta o mapa replica
//!   isso.
//! - O `\b` do TEXT_SIZE_TOKEN vira `(?![A-Z0-9_])` no `js_canon` (padrões
//!   `/i` correm no canon, que é 1:1 por caractere).
//! - `stageTrace(trace, 'episodeSize.packTextDropped', 1)` vira o contador
//!   `pack_text_dropped` na saída; quem chama empurra no trace.
//! - `metrics.count` não existe aqui: é Node-side.
//! - Dedupe futuro: o "quais episódios o pack cobre" aqui vem só do parser de
//!   título (`episode_parse`); se `episode_annotate` expuser um
//!   `episodes_covered` equivalente, avaliar reuso — hoje NÃO dependemos dele
//!   (módulo em porte paralelo).

use std::collections::HashMap;
use std::sync::OnceLock;

use fancy_regex::Regex;
use serde_json::Value;

use crate::br_origin::js_canon;
// `looks_pack_by_files` mora no `debrid` (mesma régua do dedupe de pack; o
// módulo `episode_annotate` também o usa) — aqui é só consumo, sem duplicar.
use crate::debrid::{looks_pack_by_files, DebridFile};
use crate::episode_matching::is_season_pack_release;
use crate::episode_parse::parse_title_season_episode;
use crate::stream_ranking_types::RankingStream;

/// Espaços do `\s` do ECMAScript, como CONTEÚDO de classe de caractere — usar
/// sempre dentro de `[...]`.
const SP: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// Marca de pack anotado: o 💾 dele já é o episódio, não toca.
const PACK_MARK: &str = "\u{1F4E6} pack";

fn compile(pat: &str) -> Regex {
    let src = pat.replace("__SP__", SP);
    Regex::new(&src).expect("padrão de pack-text-totals compila")
}

/// `\s*(?:💾\s*)?\d+(?:[.,]\d+)?\s*(?:GIB|GB|MIB|MB|TIB|TB)\b` (giu). O `\b`
/// barra a p de "1080p" e token colado; KB/B ficam (o app ignora essas
/// unidades — tamanho de .torrent, não de vídeo).
fn text_size_token_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        compile(concat!(
            r"[__SP__]*(?:\x{1F4BE}[__SP__]*)?[0-9]+(?:[.,][0-9]+)?[__SP__]*",
            r"(?:GIB|GB|MIB|MB|TIB|TB)(?![A-Z0-9_])"
        ))
    })
}

/// Primeiro token de tamanho do texto, para o `tokenBytes` do TS.
fn token_size_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| compile(r"([0-9]+(?:[.,][0-9]+)?)[__SP__]*(GIB|GB|MIB|MB|TIB|TB)"))
}

/// Inverso do `bytesToSize` para um token capturado ("30GB", "41.67 GB").
/// `Number` não numérico e unidade fora do mapa devolvem 0 (o "desconhecido").
fn token_bytes(text: &str) -> f64 {
    let canon = js_canon(text);
    let captures = match token_size_re().captures(&canon) {
        Ok(Some(caps)) => caps,
        _ => return 0.0,
    };
    let value_str = captures.get(1).map(|g| g.as_str()).unwrap_or("");
    let unit = captures.get(2).map(|g| g.as_str()).unwrap_or("");
    let power: u32 = match unit {
        "MB" | "MIB" => 2,
        "GB" | "GIB" => 3,
        "TB" | "TIB" => 4,
        _ => return 0.0,
    };
    // `Number("30.5".replace(',', '.'))`: separador vírgula é decimal.
    let Ok(value) = value_str.replace(',', ".").parse::<f64>() else {
        return 0.0;
    };
    if !value.is_finite() {
        return 0.0;
    }
    (value * 1024f64.powi(power as i32)).round()
}

/// Troca os tokens de tamanho por vazio no texto ORIGINAL. O padrão (maiúsculo)
/// corre no `js_canon` e os índices voltam pelo caractere: o canon é 1:1.
fn strip_size_tokens(text: &str) -> String {
    let subject = js_canon(text);
    let chars: Vec<char> = text.chars().collect();
    debug_assert_eq!(subject.chars().count(), chars.len());
    let mut out = String::new();
    let mut last = 0usize;
    for found in text_size_token_re().find_iter(&subject) {
        let Ok(found) = found else { continue };
        if found.start() == found.end() {
            continue;
        }
        let start = subject[..found.start()].chars().count();
        let end = subject[..found.end()].chars().count();
        if start < last {
            continue;
        }
        out.extend(chars[last..start].iter().copied());
        last = end;
    }
    out.extend(chars[last..].iter().copied());
    out
}

/// Título que nomeia VÁRIOS episódios ("S01.Dub E01-E08", "Capítulo 086 ao 123"
/// de novela): não é pack de temporada para o `isSeasonPackRelease`, mas o
/// torrent cobre vários episódios — nenhum tamanho do texto é o do episódio.
pub fn names_multiple_episodes(title: &str) -> bool {
    parse_title_season_episode(title).episodes.len() > 1
}

/// Pack provado pela LISTA DE ARQUIVOS, não pelo título: o post BR silencioso
/// ("Jesus Novela [720p HDTV DUBLADO]") não declara temporada nem episódio, e o
/// 💾 do tracker é o total dos capítulos. 2+ vídeos no hash = pack de fato
/// (mesmo critério do dedupe de pack, `duplicate_pack`). `None` = hash sem
/// lista (o `peekFileSizes` do Node devolve null) — o re-teste de vídeo/sample
/// é o [`crate::debrid::looks_pack_by_files`], reusado do seletor.
pub fn files_prove_pack(files: Option<&[DebridFile]>) -> bool {
    files.is_some_and(looks_pack_by_files)
}

/// `Boolean(stream.infoHash)`: hash vazio é falsy no JS.
fn hash_of(s: &RankingStream) -> Option<&str> {
    s.info_hash.as_deref().filter(|h| !h.is_empty())
}

/// Entrada do corte. `files` é a caixa do `peekFileSizes` do Node: chave é o
/// hash MINÚSCULO (o `recordFileSizes` baixa antes de gravar) e o valor é a
/// lista já FILTRADA (tamanho > 0, vídeo, sem sample, sem propaganda).
#[derive(Debug, Clone, Default)]
pub struct PackTextTotalsInput {
    pub streams: Vec<RankingStream>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub files: HashMap<String, Vec<DebridFile>>,
}

/// Saída: streams com `title`/`name` limpos e `_packBytes` no `extra`, mais o
/// contador do estágio `episodeSize.packTextDropped` do trace.
#[derive(Debug, Clone, Default)]
pub struct PackTextTotalsOutput {
    pub streams: Vec<RankingStream>,
    pub pack_text_dropped: i64,
}

/// Multi-episódio sem medida do episódio: o total do torrent sai do TEXTO, não
/// só do 💾. No TS roda ANTES do `fillMissingSizes`: quem perde o 💾 aqui e
/// ganhar lista de arquivos depois sai com o tamanho MEDIDO do episódio.
pub fn drop_pack_text_totals(input: &PackTextTotalsInput) -> PackTextTotalsOutput {
    let mut out_streams = Vec::with_capacity(input.streams.len());
    let mut dropped = 0i64;
    let (Some(season), Some(episode)) = (input.season, input.episode) else {
        out_streams.extend(input.streams.iter().cloned());
        return PackTextTotalsOutput {
            streams: out_streams,
            pack_text_dropped: 0,
        };
    };

    for s in &input.streams {
        // `typeof stream.title !== 'string'`: stream sem título não toca.
        let Some(title) = s.title.as_deref() else {
            out_streams.push(s.clone());
            continue;
        };
        // Pack anotado: o 💾 dele já é o episódio e o `size` publicado vence o
        // fallback de texto do app.
        if title.contains(PACK_MARK) {
            out_streams.push(s.clone());
            continue;
        }
        // O 💾 do Torrentio é o tamanho do ARQUIVO escolhido: não é total de
        // torrent, não sai.
        if s.indexer.as_deref() == Some("torrentio") {
            out_streams.push(s.clone());
            continue;
        }
        let parsed_episodes = parse_title_season_episode(title).episodes;
        // Release que DECLARA o episódio pedido: o total dela é dele, fica.
        if parsed_episodes.len() == 1 && parsed_episodes[0] == episode {
            out_streams.push(s.clone());
            continue;
        }
        // Todo o resto é multi-episódio ou título SILÊNCIOSO: pack de
        // temporada, faixa nomeada, pack provado pela lista de arquivos, ou
        // post que não declara episódio nenhum — no silencioso o total não
        // está provado ser o do episódio, e o app o exibiria como se fosse.
        let hash = hash_of(s);
        // `isSeasonPackRelease(stream, season)` lê `title || name || ''`:
        // título vazio cai para o name.
        let pack_title = if title.is_empty() {
            s.name.as_deref().unwrap_or("")
        } else {
            title
        };
        let files = hash.and_then(|h| input.files.get(h)).map(Vec::as_slice);
        let multi = hash.is_some() && is_season_pack_release(pack_title, Some(season))
            || (parsed_episodes.len() > 1 && parsed_episodes.contains(&episode))
            || (hash.is_some() && files_prove_pack(files))
            || parsed_episodes.is_empty();
        if !multi {
            out_streams.push(s.clone());
            continue;
        }
        // `Number(_bytes) || tokenBytes(title)`: o total declarado pelo tracker
        // (idx:v14) vence o lido do texto.
        let total = match s.bytes {
            Some(b) if b.is_finite() && b != 0.0 => b,
            _ => token_bytes(title),
        };
        let new_title = strip_size_tokens(title);
        let new_name = s.name.as_deref().map(strip_size_tokens);
        if new_title == title && new_name.as_deref() == s.name.as_deref() {
            out_streams.push(s.clone());
            continue;
        }
        dropped += 1;
        let mut next = s.clone();
        next.title = Some(new_title);
        next.name = new_name;
        if total > 0.0 {
            // Número inteiro no JSON (o `JSON.stringify` do JS imprime sem
            // casas quando frac == 0); o golden canoniza com `js_num`.
            next.extra.insert(
                "_packBytes".to_string(),
                serde_json::Number::from_f64(total)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
            );
        }
        out_streams.push(next);
    }

    PackTextTotalsOutput {
        streams: out_streams,
        pack_text_dropped: dropped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, size: f64) -> DebridFile {
        DebridFile {
            path: path.to_string(),
            size,
        }
    }

    #[test]
    fn faixa_de_novela_e_multi_episodio() {
        assert!(names_multiple_episodes(
            "Jesus Capítulo 001 ao 154 Dublado 720p"
        ));
        assert!(names_multiple_episodes("S01.Dub E01-E08"));
        assert!(!names_multiple_episodes("Show S01E02 720p x265"));
        assert!(!names_multiple_episodes("Temporada Completa"));
    }

    #[test]
    fn pack_pela_lista_de_arquivos() {
        let dois = vec![file("a/T01E01.mkv", 1.0), file("a/T01E02.mkv", 2.0)];
        assert!(files_prove_pack(Some(&dois)));
        assert!(!files_prove_pack(Some(&[file("a/f.mkv", 1.0)])));
        // Sample não conta como vídeo do pack.
        let com_sample = vec![
            file("a/f.mkv", 1.0),
            file("a/sample.mkv", 2.0),
            file("a/g.mkv", 3.0),
        ];
        assert!(files_prove_pack(Some(&com_sample)));
        assert!(!files_prove_pack(None));
    }

    #[test]
    fn token_bytes_inverso_do_bytes_to_size() {
        assert_eq!(token_bytes("Temporada Completa 30GB"), 32_212_254_720.0);
        assert_eq!(
            token_bytes("total 41.67 gb"),
            (41.67 * 1024f64.powi(3)).round()
        );
        assert_eq!(token_bytes("cap 500 MB"), 524_288_000.0);
        assert_eq!(token_bytes("1 TB total"), 1_099_511_627_776.0);
        assert_eq!(token_bytes("4,5 GB"), (4.5 * 1024f64.powi(3)).round());
        // KB/B ficam: o app ignora essas unidades no próprio regex.
        assert_eq!(token_bytes("torrent 65.95 KB"), 0.0);
        assert_eq!(token_bytes("sem tamanho"), 0.0);
    }

    #[test]
    fn strip_remove_so_o_token_de_tamanho() {
        assert_eq!(strip_size_tokens("Título 30GB 720p"), "Título 720p");
        assert_eq!(
            strip_size_tokens("👤 5 💾 30.00 GB ⚙️ Apache"),
            "👤 5 ⚙️ Apache"
        );
        // "1080p" não é token de tamanho (o \b barra a p).
        assert_eq!(strip_size_tokens("movie 1080p"), "movie 1080p");
        assert_eq!(strip_size_tokens("sem tamanho"), "sem tamanho");
    }
}
