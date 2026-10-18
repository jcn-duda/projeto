use serde_json::{json, Value};

use super::*;

pub(super) fn movie_item(imdb: &str, en: bool) -> Value {
    let (id, pt_title, en_title, original, lang, date) = match imdb {
        MOVIE_OK => (101, "Coringa", "Joker", "Joker", "en", "2019-10-02"),
        ALIASES => (102, "Lioness", "Lioness", "Lioness", "en", "2018-07-22"),
        ORIGINAL_IGNORED => (
            103,
            "Django Kill",
            "Django Kill",
            "Se sei vivo spara",
            "it",
            "1967-01-27",
        ),
        MULTIWORK => (
            104,
            "The Hunger Games",
            "The Hunger Games",
            "The Hunger Games",
            "en",
            "2012-03-23",
        ),
        ONE_PART => (
            107,
            "Solo Adventures",
            "Solo Adventures",
            "Solo Adventures",
            "en",
            "2018-05-25",
        ),
        HOME_RELEASE => (
            105,
            "The Odyssey",
            "The Odyssey",
            "The Odyssey",
            "en",
            "2026-07-15",
        ),
        YEAR_DIVERGE => (113, "Monster", "Monster", "Monster", "en", "2021-09-17"),
        ALIASES_FAIL => (
            112,
            "Filme Teste",
            "Test Movie",
            "Test Movie",
            "en",
            "2020-01-01",
        ),
        _ => (
            120,
            "Filme Teste",
            "Test Movie",
            "Test Movie",
            "en",
            "2020-01-01",
        ),
    };
    let mut item = json!({
        "id": id,
        "title": if en { en_title } else { pt_title },
        "original_title": original,
        "original_language": lang,
        "release_date": date
    });
    if imdb == MULTIWORK {
        item["belongs_to_collection"] = json!({ "id": 7, "name": "The Hunger Games Collection" });
    }
    if imdb == ONE_PART {
        item["belongs_to_collection"] = json!({ "id": 8, "name": "Solo Adventures Collection" });
    }
    item
}

pub(super) fn tv_item(en: bool) -> Value {
    let _ = en; // título igual nos dois idiomas neste cenário
    json!({
        "id": 106,
        "name": "Lioness",
        "original_name": "Lioness",
        "original_language": "en",
        "first_air_date": "2018-07-22"
    })
}

pub(super) fn cinemeta_meta(imdb: &str) -> Value {
    match imdb {
        SERIES => json!({
            "name": "Lioness",
            "year": "2018–",
            "type": "series",
            "firstAired": "2018-07-22",
            "videos": [
                { "season": 0, "episode": 1, "released": "2019-12-01" },
                { "season": 1, "episode": 1, "released": "2020-01-01" },
                { "season": 1, "episode": 2, "firstAired": "2020-01-08" },
                { "season": 2, "episode": 1 }
            ]
        }),
        YEAR_DIVERGE => json!({ "name": "Monster", "year": "2018", "type": "movie" }),
        ORIGINAL_IGNORED => {
            json!({ "name": "Django Kill", "year": "1967", "type": "movie" })
        }
        HOME_RELEASE => json!({
            "name": "The Odyssey",
            "year": "2026",
            "type": "movie",
            "released": "2026-07-15T00:00:00.000Z"
        }),
        MULTIWORK => json!({ "name": "Jogos Vorazes", "year": "2012", "type": "movie" }),
        ONE_PART => json!({ "name": "Solo Adventures", "year": "2018", "type": "movie" }),
        MOVIE_OK => json!({
            "name": "Coringa",
            "year": "2019",
            "type": "movie",
            "released": "2019-10-02T00:00:00.000Z"
        }),
        _ => json!({ "name": "Filme Teste", "year": "2020", "type": "movie" }),
    }
}

pub(super) fn br_aliases(id: &str) -> Value {
    if id != "102" {
        return json!([]);
    }
    json!([
        { "iso_3166_1": "BR", "title": "Operação: Lioness" },
        { "iso_3166_1": "BR", "title": "Kill" },
        { "iso_3166_1": "US", "title": "US Alias" },
        { "iso_3166_1": "BR", "title": "Agente Lioness" },
        { "iso_3166_1": "BR", "title": "Lioness" }
    ])
}

pub(super) fn detail(id: &str) -> Value {
    if id == "104" {
        json!({
            "id": 104,
            "belongs_to_collection": { "id": 7, "name": "The Hunger Games Collection" }
        })
    } else {
        json!({ "id": id.parse::<u64>().unwrap_or(0) })
    }
}

pub(super) fn collection(id: &str) -> Value {
    match id {
        "7" => json!({
            "name": "The Hunger Games Collection",
            "parts": [
                { "release_date": "2012-03-23" },
                { "release_date": "2013-11-22" },
                { "release_date": "2014-11-21" }
            ]
        }),
        "8" => json!({
            "name": "Solo Adventures Collection",
            "parts": [{ "release_date": "2018-05-25" }]
        }),
        _ => json!({ "name": "", "parts": [] }),
    }
}

pub(super) fn release_dates() -> Value {
    json!({
        "results": [
            {
                "iso_3166_1": "US",
                "release_dates": [
                    { "type": 3, "release_date": "2026-07-15" },
                    { "type": 4, "release_date": "2026-11-15" },
                    { "type": 6, "release_date": "2026-12-01" }
                ]
            },
            {
                "iso_3166_1": "BR",
                "release_dates": [{ "type": 5, "release_date": "2026-11-20" }]
            }
        ]
    })
}
