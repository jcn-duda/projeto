//! Magnet de OUTRA obra publicado no post de um filme.
//!
//! Sites BR colam magnets alheios na página: o bloco fixo "CONVERTER MKV para
//! MP4" é um magnet do programa, e posts antigos têm um segundo link de outro
//! filme do mesmo ano (Kong em "A Grande Muralha", Noé em "Guardiões da
//! Galáxia"). O título do post casa e o ano também, então nenhuma outra guarda
//! pega.
//!
//! O `dn=` sozinho não condena: título traduzido é a regra nos BR e os aliases
//! do TMDB não cobrem tudo ("Ronggeng Kematian" é "Dance of Death"). Medido em
//! 2026-11-01 contra o TMDB: com o hash aprovado em 3 ou mais obras, 59% dos
//! pares divergem e são erro de site; é essa repetição que dá a evidência. Quem
//! não dá para ler NÃO condena: `dn` de site, sem marca de release ou de coleção.

use std::sync::OnceLock;

use regex::Regex;

use crate::decode_entities;
use crate::strip_diacritics;

/// O `dn=` se apresenta como programa, não como vídeo.
fn software_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\bconverter\.mkv\b|\brebox\.?net\b").expect("regex de programa compila")
    })
}

/// Onde o título do `dn=` acaba: ano, resolução ou fonte.
fn release_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:19|20)[0-9]{2}\b|\b(?:480|720|1080|2160)p\b|\b(?:web-?dl|webrip|bluray|brrip|bdrip|hdrip|dvdrip|hdtv)\b",
        )
        .expect("regex de marca de release compila")
    })
}

/// `dn=` que começa pelo site ("COMANDO.TO - …", "[ACESSE x.xyz] …") não diz o
/// título de forma confiável. "Back.To.The.Future" também cai aqui: sem corte.
fn site_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^\W*(?:acesse\b|(?:www\.)?[a-z0-9-]+\.(?:com|org|net|xyz|to|tv|ro|me|info|site|lat)\b)",
        )
        .expect("regex de site compila")
    })
}

fn collection_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)colec|collection|trilog|quadrilog|duolog|tetralog|franquia|saga|antolog|anthology|\bpack\b|todos os filmes")
            .expect("regex de coleção compila")
    })
}

const STOP_WORDS: &[&str] = &[
    "the", "an", "of", "and", "in", "on", "to", "de", "da", "do", "das", "dos", "os", "as", "um",
    "uma", "no", "na", "la", "el", "le",
];

fn significant_tokens(text: &str) -> Vec<String> {
    strip_diacritics(&decode_entities(text))
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 2 && !STOP_WORDS.contains(t))
        .filter(|t| !t.chars().all(|c| c.is_ascii_digit()))
        .map(str::to_string)
        .collect()
}

/// Nome colado também casa ("TiroCerto2021" com "Tiro Certo").
fn tokens_overlap(dn_token: &str, name_token: &str) -> bool {
    dn_token == name_token
        || (name_token.chars().count() >= 4 && dn_token.contains(name_token))
        || (dn_token.chars().count() >= 4 && name_token.contains(dn_token))
}

pub(crate) fn is_software_magnet(dn: &str) -> bool {
    software_re().is_match(dn)
}

/// `true` quando o `dn=` nomeia um título legível que não tem NENHUMA palavra em
/// comum com os nomes da obra. Só vale junto da repetição do hash em outras obras.
pub(crate) fn dn_names_other_work(post_title: &str, dn: &str, names: &[String]) -> bool {
    if site_prefix_re().is_match(dn)
        || collection_re().is_match(&strip_diacritics(dn))
        || collection_re().is_match(&strip_diacritics(post_title))
    {
        return false;
    }
    let Some(mark) = release_mark_re().find(dn).filter(|m| m.start() > 0) else {
        return false;
    };
    let dn_tokens = significant_tokens(&dn[..mark.start()]);
    let name_tokens: Vec<String> = names.iter().flat_map(|n| significant_tokens(n)).collect();
    if dn_tokens.is_empty() || name_tokens.is_empty() {
        return false;
    }
    !dn_tokens
        .iter()
        .any(|d| name_tokens.iter().any(|n| tokens_overlap(d, n)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn other(post: &str, dn: &str, names: &[&str]) -> bool {
        let names: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        dn_names_other_work(post, dn, &names)
    }

    #[test]
    fn programa_no_dn_e_reconhecido_e_filme_nao() {
        assert!(is_software_magnet(
            "Converter.MKV.para.MP4.Rebox.NET v2.9.9.3.comandotorrents.to"
        ));
        assert!(!is_software_magnet("Converter.2024.1080p.WEB-DL"));
        assert!(!is_software_magnet("The.Rebox.2020.1080p"));
    }

    #[test]
    fn outro_filme_no_dn_e_condenado() {
        assert!(other(
            "A Grande Muralha (2017) BluRay | – [LEGENDADO]",
            "Kong.Skull.Island.2017.1080p.KORSUB.HDRip.x264.AAC2.0-STUTTERSHIT",
            &["A Grande Muralha", "The Great Wall"],
        ));
        assert!(other(
            "Guardiões da Galáxia Bluray (2014)",
            "Noe (2014) BluRay 1080p Dual Audio 5.1CH",
            &["Guardiões da Galáxia", "Guardians of the Galaxy"],
        ));
    }

    #[test]
    fn nome_da_obra_no_dn_nao_condena() {
        let names = ["Motel Destino", "Motel Destination"];
        assert!(!other(
            "Motel Destino [1080p]",
            "Motel.Destino.2024.1080p.WEB-DL.NACIONAL.5.1",
            &names,
        ));
        assert!(!other(
            "Dupla Jornada",
            "Day.Shift.2022.720p.NF.WEBRip",
            &["Dupla Jornada", "Day Shift"],
        ));
        assert!(!other(
            "Tiro Certo",
            "TiroCerto2021BluRay1080pDUAL2.0 2021",
            &["Tiro Certo"],
        ));
        assert!(!other(
            "Operação Zodíaco",
            "Opera&ccedil;&atilde;o.Zod&iacute;aco.(2010).1080p",
            &["Operação Zodíaco"],
        ));
    }

    #[test]
    fn dn_ilegivel_nao_condena() {
        let names = ["Nós Somos os Campeões"];
        assert!(!other("Nós Somos os Campeões", "NSOC123.byDuDoG", &names));
        assert!(!other("x", "COMANDO.TO - Outro.Filme.2014.1080p", &names));
        assert!(!other("x", "[ACESSE site.xyz] Outro Filme 2014", &names));
        assert!(!other("x", "2014.1080p.WEB-DL", &names));
        assert!(!other("x", "", &names));
        assert!(!other("x", "Outro.Filme.2014.1080p", &[]));
    }

    #[test]
    fn colecao_no_post_ou_no_dn_nao_condena() {
        let names = ["Rocky II"];
        assert!(!other("Rocky Coleção [1080p]", "PradO.2015.1080p", &names));
        assert!(!other("Filme", "Quadrilogia.Outra.2012.1080p", &names));
        assert!(!other(
            "Filme",
            "Coleção Stallone 2001.1080p",
            &["Outro Nome"],
        ));
    }
}
