use super::*;

fn meta<'a>(year: &'a str, released: &'a str, first_aired: &'a str) -> InstantMeta<'a> {
    InstantMeta {
        year,
        released,
        first_aired,
    }
}

#[test]
fn date_parse_subset_utc() {
    assert_eq!(js_date_parse_ms("1970-01-01"), 0);
    assert_eq!(js_date_parse_ms("2027-01-01"), 1_798_761_600_000);
    assert_eq!(js_date_parse_ms("2027"), 1_798_761_600_000);
    assert_eq!(js_date_parse_ms("2027-01"), 1_798_761_600_000);
    assert_eq!(js_date_parse_ms("2027-01-01T00:00:01Z"), 1_798_761_601_000);
    assert_eq!(
        js_date_parse_ms("2027-01-01T00:00:00.5Z"),
        1_798_761_600_500
    );
    // Offset explícito desconta: 00:00 em -03:00 é 03:00 em UTC.
    assert_eq!(
        js_date_parse_ms("2027-01-01T00:00:00-03:00"),
        1_798_772_400_000
    );
    assert_eq!(
        js_date_parse_ms("2027-01-01T00:00:00+0300"),
        1_798_750_800_000
    );
    assert_eq!(js_date_parse_ms("1970-01-02"), DAY_MS);
    // O dia da epoch é válido dentro de um datetime (não colide com o 0).
    assert_eq!(js_date_parse_ms("1970-01-01T00:00:01Z"), 1_000);
}

#[test]
fn date_parse_rejeita_fora_do_subset() {
    assert_eq!(js_date_parse_ms(""), 0);
    assert_eq!(js_date_parse_ms("não é data"), 0);
    // Dia impossível: o JS também reprova.
    assert_eq!(js_date_parse_ms("2027-02-30"), 0);
    assert_eq!(js_date_parse_ms("2027-13-01"), 0);
    // Sem offset é fuso do processo: decisão deliberada (ver cabeçalho).
    assert_eq!(js_date_parse_ms("2027-01-01T00:00:00"), 0);
    assert_eq!(js_date_parse_ms("2027-01-01 00:00:00Z"), 0);
    assert_eq!(js_date_parse_ms("01/13/2027"), 0);
    assert_eq!(js_date_parse_ms("2027-01-01T00:00:00+25:00"), 0);
}

#[test]
fn ano_utc_do_instante() {
    assert_eq!(utc_year(1_799_971_200_000), 2027);
    assert_eq!(utc_year(0), 1970);
    assert_eq!(utc_year(951_782_400_000), 2000);
}

#[test]
fn recente_por_filme_episodio_e_ano() {
    let now = 1_799_971_200_000;
    assert!(is_recent_release(&meta("", "2027-01-01", ""), now));
    assert!(is_recent_release(&meta("", "", "2027-01-10"), now));
    assert!(is_recent_release(&meta("2027", "", ""), now));
    // Sufixo do ano de catálogo ("2024–"): os 4 primeiros caracteres.
    assert!(is_recent_release(&meta("2027–", "", ""), now));
    assert!(!is_recent_release(&meta("", "", ""), now));
    assert!(!is_recent_release(&meta("2026", "", ""), now));
    // Futuro não é recente: estreia que ainda não chegou não abre a janela.
    assert!(!is_recent_release(&meta("", "2027-06-01", ""), now));
}

#[test]
fn pick_source_normaliza_so_a_fonte() {
    let sources = vec![
        SourceRow {
            indexer: "  BLUDV ",
            last_seen: 100,
        },
        SourceRow {
            indexer: "nerd",
            last_seen: 300,
        },
    ];
    let mut failed = HashSet::new();
    failed.insert("bludv".to_string());
    assert_eq!(pick_source(&sources, &failed, false), Some(0));
    // O conjunto do TS não é normalizado: "NERD" não casa com "nerd".
    let mut failed_caixa = HashSet::new();
    failed_caixa.insert("NERD".to_string());
    assert_eq!(pick_source(&sources, &failed_caixa, false), None);
}

#[test]
fn janela_clampa_e_fresh_encurta() {
    let agora = 1_799_971_200_000;
    let empty: [Option<WorkRow>; 0] = [];
    let win = instant_window(
        &empty,
        &meta("", "", ""),
        agora,
        3_600_000,
        86_400_000,
        7_200_000,
    );
    assert_eq!(win.window_ms, 3_600_000);
    assert!(!win.fresh);

    let works = vec![Some(WorkRow {
        passed_filter: 1,
        last_seen: 1_000_000_000_000,
        first_seen: 0,
    })];
    let win = instant_window(
        &works,
        &meta("", "", ""),
        agora,
        3_600_000,
        86_400_000,
        7_200_000,
    );
    assert_eq!(win.stability, 1_000_000_000_000);
    assert_eq!(win.window_ms, 86_400_000);

    // Lançamento recente: teto curto vence mesmo com estabilidade enorme.
    let win = instant_window(
        &works,
        &meta("2027", "", ""),
        agora,
        3_600_000,
        86_400_000,
        7_200_000,
    );
    assert!(win.fresh);
    assert_eq!(win.window_ms, 7_200_000);
}
