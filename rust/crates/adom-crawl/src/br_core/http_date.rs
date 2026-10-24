//! `Date.prototype.toUTCString()` sem crate de data: um instante vira a HTTP
//! date que o feed torznab carimba no `<pubDate>` — "Tue, 13 Oct 2026
//! 12:00:00 GMT", com o **dia da semana calculado**, nunca fixo.
//!
//! O feed é o que o Jackett lê byte a byte, então cada site que reimplementou
//! o "civil from days" à mão abriu espaço para divergir do TS em silêncio: a
//! cópia do BLUDV escrevia `"Sun"` para qualquer data e o golden não via
//! porque nenhuma fixture tem `dd/mm/aaaa`. A formatação mora aqui uma única
//! vez; os sites só chamam (e mantêm um wrapper fino quando a assinatura local
//! já é superfície pública de teste).
//!
//! Convenção de unidades: `http_date` recebe **milissegundos** (o que o JS usa
//! internamente), `http_date_secs` recebe **segundos** (o que o relógio do
//! sistema devolve). Nome explícito para não haver troca silenciosa entre as
//! duas — é o erro que transformaria "terça" em "quinta".

use std::time::{SystemTime, UNIX_EPOCH};

/// Milissegundos de um dia: divisor de `epoch_ms`.
const DAY_MS: i64 = 86_400_000;

/// Nomes do dia da semana no formato HTTP, com domingo na posição 0 (a mesma
/// do `toUTCString()`); 1970-01-01 foi quinta, hence o deslocamento em `+4`.
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// Nomes curtos dos meses, janeiro na posição 0.
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `Date.UTC(y, m0, d)` em ms: mês e dia "estourados" rolam para a frente, como
/// no JS (`m0 = -1` é dezembro do ano anterior, `d = 0` é o último dia do mês
/// anterior). Usado pelos sites que montam a data a partir de `dd/mm/aaaa`.
pub fn date_utc_ms(year: i64, month0: i64, day: i64) -> i64 {
    let shifted = year + month0.div_euclid(12);
    let month = month0.rem_euclid(12) + 1;
    (days_from_civil(shifted, month, 1) + day - 1) * DAY_MS
}

/// Dias desde 1970-01-01 (algoritmo civil de Howard Hinnant, sem dependência).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverso de `days_from_civil`: (ano, mês 1..=12, dia, dia da semana).
fn civil_from_days(days: i64) -> (i64, i64, i64, &'static str) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let weekday = WEEKDAYS[(days + 4).rem_euclid(7) as usize];
    (year, month, day, weekday)
}

/// `new Date(epoch_ms).toUTCString()`: "Tue, 13 Oct 2026 12:00:00 GMT".
/// Os milissegundos além do segundo são truncados, como no JS.
pub fn http_date(epoch_ms: i64) -> String {
    let (year, month, day, weekday) = civil_from_days(epoch_ms.div_euclid(DAY_MS));
    let rem = epoch_ms.rem_euclid(DAY_MS);
    let month_name = MONTHS[(month - 1) as usize];
    format!(
        "{weekday}, {day:02} {month_name} {year:04} {:02}:{:02}:{:02} GMT",
        rem / 3_600_000,
        rem % 3_600_000 / 60_000,
        rem % 60_000 / 1000,
    )
}

/// `new Date(epoch_secs * 1000).toUTCString()` — para relógios em segundos.
pub fn http_date_secs(epoch_secs: i64) -> String {
    http_date(epoch_secs.saturating_mul(1000))
}

/// `new Date().toUTCString()`: o relógio corrente. Os sites usam quando o post
/// não publica data; o golden injeta a data congelada pelo oráculo.
pub fn http_date_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0));
    http_date_secs(secs)
}

#[cfg(test)]
mod tests {
    use super::{date_utc_ms, http_date, http_date_secs};

    /// Tabela gerada pelo Node (`new Date(ms).toUTCString()`), que é o oráculo:
    /// `node -e "console.log(new Date(Date.UTC(2016,3,5)).toUTCString())"`.
    /// Cobre terça real, domingo, bissexto, pré-época, virada de dezembro,
    /// século não-bissexto, truncamento de ms e o limite do formato.
    const PARIDADE: &[(i64, &str)] = &[
        (1_791_892_800_000, "Tue, 13 Oct 2026 12:00:00 GMT"),
        (1_672_531_200_000, "Sun, 01 Jan 2023 00:00:00 GMT"),
        (1_709_164_800_000, "Thu, 29 Feb 2024 00:00:00 GMT"),
        (1_459_814_400_000, "Tue, 05 Apr 2016 00:00:00 GMT"),
        (-1_000, "Wed, 31 Dec 1969 23:59:59 GMT"),
        (-2_208_988_800_000, "Mon, 01 Jan 1900 00:00:00 GMT"),
        (1_735_603_200_000, "Tue, 31 Dec 2024 00:00:00 GMT"),
        (1_735_689_600_000, "Wed, 01 Jan 2025 00:00:00 GMT"),
        (4_107_456_000_000, "Sun, 28 Feb 2100 00:00:00 GMT"),
        (951_782_400_000, "Tue, 29 Feb 2000 00:00:00 GMT"),
        (253_402_214_400_000, "Fri, 31 Dec 9999 00:00:00 GMT"),
        (0, "Thu, 01 Jan 1970 00:00:00 GMT"),
        (-86_400_000, "Wed, 31 Dec 1969 00:00:00 GMT"),
        (2_147_483_647_000, "Tue, 19 Jan 2038 03:14:07 GMT"),
        (-6_857_222_400_000, "Thu, 14 Sep 1752 00:00:00 GMT"),
        (-12_220_243_200_000, "Mon, 04 Oct 1582 00:00:00 GMT"),
        (-2_077_747_200_000, "Mon, 29 Feb 1904 00:00:00 GMT"),
        (946_684_799_999, "Fri, 31 Dec 1999 23:59:59 GMT"),
        (1_709_251_200_000, "Fri, 01 Mar 2024 00:00:00 GMT"),
        (4_107_542_400_000, "Mon, 01 Mar 2100 00:00:00 GMT"),
        (1_000, "Thu, 01 Jan 1970 00:00:01 GMT"),
        (1_000_000_000_000, "Sun, 09 Sep 2001 01:46:40 GMT"),
    ];

    #[test]
    fn http_date_casa_com_to_utcstring_do_node() {
        for (ms, want) in PARIDADE {
            assert_eq!(http_date(*ms), *want, "ms={ms}");
        }
    }

    #[test]
    fn http_date_secs_recebe_segundos() {
        assert_eq!(
            http_date_secs(1_791_892_800),
            "Tue, 13 Oct 2026 12:00:00 GMT"
        );
        assert_eq!(http_date_secs(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(
            http_date_secs(1_000_000_000),
            "Sun, 09 Sep 2001 01:46:40 GMT"
        );
        assert_eq!(http_date_secs(-1), "Wed, 31 Dec 1969 23:59:59 GMT");
    }

    #[test]
    fn dia_da_semana_nao_e_fixo() {
        // O bug do BLUDV: 05/04/2016 é terça, não domingo.
        assert_eq!(
            http_date(date_utc_ms(2016, 3, 5)),
            "Tue, 05 Apr 2016 00:00:00 GMT"
        );
        assert_eq!(
            http_date(date_utc_ms(2026, 9, 13)),
            "Tue, 13 Oct 2026 00:00:00 GMT"
        );
    }

    /// O `Date.UTC` do JS rola mês e dia estourados em vez de rejeitá-los; os
    /// valores vêm do Node, inclusive os absurdos que `dd/mm/aaaa` pode ler.
    #[test]
    fn date_utc_rola_mes_e_dia_como_o_js() {
        assert_eq!(
            http_date(date_utc_ms(2019, -1, 1)),
            "Sat, 01 Dec 2018 00:00:00 GMT"
        );
        assert_eq!(
            http_date(date_utc_ms(2023, 12, 1)),
            "Mon, 01 Jan 2024 00:00:00 GMT"
        );
        assert_eq!(
            http_date(date_utc_ms(2023, 1, 0)),
            "Tue, 31 Jan 2023 00:00:00 GMT"
        );
        assert_eq!(
            http_date(date_utc_ms(2024, 1, 0)),
            "Wed, 31 Jan 2024 00:00:00 GMT"
        );
        assert_eq!(
            http_date(date_utc_ms(2023, 0, 32)),
            "Wed, 01 Feb 2023 00:00:00 GMT"
        );
        assert_eq!(
            http_date(date_utc_ms(1900, -1, 0)),
            "Thu, 30 Nov 1899 00:00:00 GMT"
        );
    }

    #[test]
    fn aritmetica_de_dezembro_e_virada_de_ano() {
        assert_eq!(
            http_date(date_utc_ms(2024, 11, 31)),
            "Tue, 31 Dec 2024 00:00:00 GMT"
        );
        assert_eq!(
            http_date(date_utc_ms(2025, 0, 1)),
            "Wed, 01 Jan 2025 00:00:00 GMT"
        );
        assert_eq!(
            http_date(date_utc_ms(2023, 11, 1)),
            "Fri, 01 Dec 2023 00:00:00 GMT"
        );
    }
}
