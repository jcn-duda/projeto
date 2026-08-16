# Project: ComandoTorrents Jackett Indexer & Microservice Resolver Enhancement

## Architecture
- **Resolver Microservice**: `comandotorrents-resolver/server.js` (Express/HTTP server running on port 8701 in container loopback).
- **Jackett Cardigann Definition**: `jackett-bludv/comandotorrents.yml` (queries `http://127.0.0.1:8701/search` and resolves downloads via `http://127.0.0.1:8701/resolve`).
- **Test Infrastructure**: `node:test` based suites in `test/`, registered in `package.json` (`scripts.test`), validated by `scripts/check-test-list.js`.

## Code Layout
- `comandotorrents-resolver/server.js`: Microservice server for scraping, HTML parsing, link unrolling, and caching.
- `jackett-bludv/comandotorrents.yml`: Cardigann definition for Jackett integration.
- `test/fixtures/comandotorrents-*.html`: Frozen mock HTML fixtures representing real-world WordPress posts and search pages.
- `test/comandotorrents-parser.test.js`: Dedicated parser unit tests covering HTML extraction, audio classification, resolution, episode numbering, season packs, and title cleaning.
- `test/comandotorrents-resolver.test.js`: Dedicated resolver unit tests covering redirect traversal, link protectors, JS variables, domain allowlist, error handling, and timeout resilience.
- `test/adversarial-m1-parser-harness.js`: Empirical adversarial test harness (69 test cases).
- `test/m1-protector-adversarial-stress.js`: Adversarial protector stress harness (42 test cases).
- `test/br-parsers.test.js`: Regression tests for Brazilian resolvers and format utilities.
- `test/br-resolvers.test.js`: Regression tests for Brazilian protector resolvers.
- `package.json`: Test script manifest registering all test files.

## Feature Inventory
Every feature from the Survey phase appears here with its assigned milestone.
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Direct Magnet Support | Allow direct `magnet:?` hrefs without requiring `isProtectorHost` check | M1 | Survey |
| 2 | Robust Audio Extraction | Inspect both `segment` and `anchorText`, support `DUAL[-\s]+[AÁ]UDIO`, `DUBLAD\w*`, `LEGENDAD\w*`, `NACIONAL`, `[DUB]`, `[LEG]`, isolate post headers | M1 | Survey |
| 3 | Resolution & Codec Extraction | Normalize `4K`/`2160p`/`UHD`, `1080p`/`FULL HD`, `720p`/`HD`, `SD`/`480p`, and canonical source codecs (`REMUX`, `BluRay`, `WEB-DL`, `WEBRip`, `HDTV`, `CAM`) | M1 | Survey |
| 4 | Episode Numbering vs Season Pack Reset | Support `E01`, `EP.01`, `EPISÓDIO 01` across `segment` and `anchorText`, reset episode to `null` on `TEMPORADA COMPLETA` in either | M1 | Survey |
| 5 | Clean Release Titles | Decode entities, strip SEO fluff (`Torrent`, `Download`, `Grátis`, `Baixar`, `5.1 /`, `7.1 /`), remove trailing punctuation artifacts | M1 | Survey |
| 6 | Portuguese Size Extraction & Sentinels | Parse PT units (`GB`, `MB`, `KB`, `TB`), safely default to `1 KB` sentinel when missing | M1 | Survey |
| 7 | Generalized URL-Encoded Magnet Regex | Support `/magnet%3A%3F[^"'<>\s]+/i` invariant to parameter ordering and literal `&` delimiters | M1 | Survey |
| 8 | Expanded JS Variable Extraction | Support `DEST_URL`, `DOWNLOAD_URL`, `MAGNET_URL`, `LINK_DOWNLOAD`, `URL_DOWNLOAD`, `DOWNLOAD`, `REDIRECT_URL`, `NEXT_URL`, `LINK_FINAL`, `TARGET_URL`, `DESTINO` | M1 | Survey |
| 9 | Invariant Meta Refresh Extraction | Support meta refresh regardless of `http-equiv` vs `content` attribute order and nested quotes | M1 | Survey |
| 10 | Strict Domain Allowlist & Hop Limits | Enforce `ALLOWED_SUFFIXES`, protocol checks, and max 6 hops to prevent SSRF and loops | M1 | Survey |
| 11 | Defensive Error Handling & Timeout Resilience | Return null/1 KB sentinels on unreachable/malformed protectors without crashing process | M1 | Survey |
| 12 | In-Memory Caching & Coalescing | Implement search and magnet caching (`SEARCH_CACHE_MS`, `MAGNET_CACHE_MS`) and request coalescing | M1 | Survey |
| 13 | Cardigann YAML Sync | Verify `jackett-bludv/comandotorrents.yml` search paths, filters, and fields | M1 | Survey |
| 14 | Mock HTML Fixture Suite | Create 5 comprehensive fixtures covering movies, series episodes, season packs, legendado-only, and search | M1 | Survey |
| 15 | Dedicated Parser Test Suite | Create `test/comandotorrents-parser.test.js` validating all parsing edge cases | M1 | Survey |
| 16 | Dedicated Resolver Test Suite | Create `test/comandotorrents-resolver.test.js` validating protector unrolling, JS redirects, and allowlist | M1 | Survey |
| 17 | Test Manifest & Regression Verification | Update `package.json` test script and ensure 100% pass across all 579+ tests with zero regressions | M1 | Survey |
| 18 | E2E & Adversarial Coverage Hardening | Run adversarial testing, verify against full Stremio pipeline and check with Forensic Auditor | M2 | Survey |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | ComandoTorrents Parser, Resolver & Fixture Test Suite Enhancement | Features 1–17 in `comandotorrents-resolver/server.js`, `jackett-bludv/comandotorrents.yml`, `test/fixtures/`, `test/comandotorrents-*.test.js`, and `package.json` | none | DONE |
| 2 | Final Verification & Adversarial Coverage Hardening | Feature 18: Full regression validation (`npm test`, `npm run test:complete`, `npm run smoke`), white-box adversarial stress testing, and forensic audit | M1 | DONE |

## Interface Contracts
### `comandotorrents-resolver/server.js` ↔ Jackett Cardigann (`comandotorrents.yml`)
- `GET /search?q=<query>`: Returns JSON array `[ { title, details, download, size, seeders, peers, publishDate, category } ]`.
- `GET /resolve?url=<targetUrl>`: Returns JSON `{ url: <magnetUri> }` or HTTP error if unresolvable.
- Field rules:
  - `size`: Always string with unit (e.g. `2.4 GB`, `1 KB`). Never `0 B`.
  - `seeders`: Default `1` if not found.
  - `download`: Either direct magnet URI or resolve URL (`http://127.0.0.1:8701/resolve?url=...`).
