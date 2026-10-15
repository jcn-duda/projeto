//! Porte puro das funções de rótulo de tamanho de `src/providers/episode-size.ts`.
//!
//! O `💾` do título do stream anuncia o tamanho do download e o `📦 pack` o total
//! da temporada/coleção; o Power Movie lê o PRIMEIRO "N GB" do texto, por isso o
//! rótulo do `💾` precisa ser extraível para o campo `size` da resposta. Nada
//! aqui conhece cache/debrid: só regex e aritmética de bytes, com paridade de
//! comportamento com o TS (que é o oráculo dos goldens).

use std::sync::OnceLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;

/// `💾 1.55 GB` — o rótulo que o app Power Movie consegue ler no texto.
fn size_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new("\u{1F4BE} (\\d+(?:\\.\\d+)? (?:B|KB|MB|GB|TB))").expect("regex SIZE_MARK")
    })
}

/// `📦 pack 12.41 GB` — total do torrent em pack anotado (o `💾` lá é o episódio).
fn pack_total_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new("\u{1F4E6} pack (\\d+(?:\\.\\d+)? (?:B|KB|MB|GB|TB))")
            .expect("regex PACK_TOTAL_MARK")
    })
}

/// `💾` que não é tamanho de vídeo: o tracker às vezes publica o do .torrent
/// ("65.95 KB" num 1080p). Lookahead do TS — por isso o `fancy-regex`.
fn bogus_size_mark_re() -> &'static FancyRegex {
    static RE: OnceLock<FancyRegex> = OnceLock::new();
    RE.get_or_init(|| {
        FancyRegex::new("\u{1F4BE} \\d+(?:\\.\\d+)? (?:B|KB)(?=\\s|$)")
            .expect("regex BOGUS_SIZE_MARK")
    })
}

/// Inverso do `bytesToSize` para o rótulo capturado pelo SIZE_MARK ("5.20 GB").
///
/// Paridade com o TS: `Number(value)` não numérico e unidade fora do mapa
/// devolvem 0 (o "desconhecido"), e o resultado é arredondado como `Math.round`.
pub fn parse_size_label(label: &str) -> f64 {
    // O TS faz `label.split(' ')` e desestrutura: sem espaço (ou espaço a mais
    // no meio) a unidade cai fora do mapa e vira 0.
    let Some((value_str, unit)) = label.split_once(' ') else {
        return 0.0;
    };
    // `Number("")` do JS dá 0; o parse do Rust recusa — mesmo destino (0.0),
    // porque 0 * 1024^power arredonda para 0 de qualquer forma.
    let Ok(value) = value_str.parse::<f64>() else {
        return 0.0;
    };
    if !value.is_finite() {
        return 0.0;
    }
    let power: u32 = match unit {
        "B" => 0,
        "KB" => 1,
        "MB" => 2,
        "GB" => 3,
        "TB" => 4,
        _ => return 0.0,
    };
    (value * 1024f64.powi(power as i32)).round()
}

/// Tamanho do DOWNLOAD que o título do stream anuncia (💾 ou 📦 pack).
///
/// O `📦 pack` vence: em pack anotado o `💾` já é o EPISÓDIO, e o total fica no
/// marcador separado. `None`/vazio → 0 (paridade com `String(title || '')`).
pub fn stream_title_bytes(title: Option<&str>) -> f64 {
    let text = title.unwrap_or("");
    if let Some(caps) = pack_total_mark_re().captures(text) {
        return parse_size_label(&caps[1]);
    }
    if let Some(caps) = size_mark_re().captures(text) {
        return parse_size_label(&caps[1]);
    }
    0.0
}

/// Rótulo do `💾` ("1.55 GB") para o campo `size` da resposta. Só MB/GB/TB: o
/// tracker às vezes publica o tamanho do .torrent ("65.95 KB" num 1080p) e o
/// app, que ignora KB no próprio regex, hoje não mostra chip nenhum ali —
/// publicar o KB trocaria "sem tamanho" por um tamanho errado.
pub fn stream_size_label(title: &str) -> Option<String> {
    let caps = size_mark_re().captures(title)?;
    let label = caps.get(1)?.as_str();
    // Equivalente ao `/ (?:MB|GB|TB)$/.test(label)` do TS: o capture termina
    // sempre na unidade, então basta checar o sufixo com espaço.
    if !(label.ends_with(" MB") || label.ends_with(" GB") || label.ends_with(" TB")) {
        return None;
    }
    Some(label.to_string())
}

/// O título carrega um `💾` de .torrent (B/KB seguido de fim ou espaço)?
pub fn has_bogus_size_mark(title: &str) -> bool {
    bogus_size_mark_re().is_match(title).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotulo_do_episodio_em_pack() {
        let t = "True Detective 1ª Temporada (2014) [1080p DUBLADO 12.41 GB]\n\u{1F446}\u{1F3FB} 1 \u{1F4BE} 1.55 GB \u{1F4E6} pack 12.41 GB (média)";
        // Pack anotado: o total do 📦 vence para o download; o 💾 é o episódio.
        assert_eq!(stream_title_bytes(Some(t)), parse_size_label("12.41 GB"));
        assert_eq!(stream_size_label(t).as_deref(), Some("1.55 GB"));
    }

    #[test]
    fn pack_total_vence_o_episodio() {
        let t = "x \u{1F4BE} 1.55 GB \u{1F4E6} pack 12.41 GB";
        assert_eq!(stream_title_bytes(Some(t)), parse_size_label("12.41 GB"));
    }

    #[test]
    fn kb_sentinela_nao_vira_chip() {
        // Fontes BR mandam "1 KB" sentinela — tamanho desconhecido, não 1024 chips.
        let t = "post \u{1F4BE} 1 KB";
        assert_eq!(stream_title_bytes(Some(t)), 1024.0);
        assert_eq!(stream_size_label(t), None);
        assert!(has_bogus_size_mark(t));
    }

    #[test]
    fn invalidos_devolvem_zero() {
        assert_eq!(stream_title_bytes(None), 0.0);
        assert_eq!(stream_title_bytes(Some("sem marca")), 0.0);
        assert_eq!(parse_size_label("nada"), 0.0);
        assert_eq!(parse_size_label("abc GB"), 0.0);
        assert_eq!(parse_size_label("1.5 XB"), 0.0);
    }

    #[test]
    fn potencias_de_unidade() {
        assert_eq!(parse_size_label("1 B"), 1.0);
        assert_eq!(parse_size_label("2 KB"), 2048.0);
        assert_eq!(parse_size_label("1.5 GB"), 1_610_612_736.0);
        assert_eq!(parse_size_label("1 TB"), 1_099_511_627_776.0);
        assert_eq!(
            stream_size_label("x \u{1F4BE} 450.9 MB").as_deref(),
            Some("450.9 MB")
        );
    }
}
