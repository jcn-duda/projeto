# Original User Request

## Initial Request — 2026-09-03T22:46:13-03:00

You are the SWE Light orchestrator for the following task.

Task: Restore the VacaTorrent resolver functionality by fixing the protector link resolution chain in `resolvers/profiles/vacatorrent-parsers.js` and `resolvers/profiles/vacatorrent.js`.
Working directory: e:/stremio adom
Agent working directory: e:/stremio adom/.agents/swe_light_2
Integrity mode: development
Original request file: e:/stremio adom/.agents/ORIGINAL_REQUEST.md

## Problem Analysis
- `vaqueirofilmes.com` is online and the search AJAX returns posts.
- For posts (e.g. movies/series), download links lead to protector `systemtech.space/enc/go.php?...`.
- `systemtech.space` redirects (302) to `processar.php`, which renders an HTML page containing `const next = "https:\/\/t.co\/..."` or youtube redirect to `t.co`.
- In `resolvers/profiles/vacatorrent-parsers.js`, `nextProtectedUrl()` checks `if (isProtector(u.hostname))` for `const next = "..."`. However, `t.co` is in `ASSERT_ONLY_SUFFIXES`, not in `ALL_PROTECTOR_SUFFIXES` (`isProtectorHost('t.co')` is false). Therefore, `nextProtectedUrl` returns `null` instead of following to `t.co`, causing resolver to abort with `502 no_magnet`.
- `const next = "..."` must allow both `isProtector(u.hostname)` and `isAssertOnly(u.hostname)` (just like `URL_ETAPA2` in step 2 already does).

## Requirements

### R1. Protector Chain Hop Fix
- Update `resolvers/profiles/vacatorrent-parsers.js` in `createNextProtectedUrl` so `const next = "..."` allows hosts matching either `isProtector(u.hostname)` or `isAssertOnly(u.hostname)`.
- Ensure `nextProtectedUrl` properly returns the destination URL (e.g. `https://t.co/...`) so `followProtectedUrl` can execute the hop through `t.co` to `systemtech.space/enc/relay.php` -> `vacadb.org`.

### R2. Test Suite & Live Regression Verification
- Update or add tests in `test/vacatorrent-resolver.test.ts` verifying that `const next = "https:\/\/t.co\/..."` is properly recognized and returned by `nextProtectedUrl`.
- Verify that `npm run build`, `npm test`, `npm run test:complete`, `npm run typecheck`, and `npm run lint:lines` all pass cleanly.
- Verify live resolution of releases on `vaqueirofilmes.com`.

## Acceptance Criteria

### Verification
- [ ] `vaca.nextProtectedUrl('const next = "https:\\/\\/t.co\\/SFsPRm91bg";', 'https://systemtech.space/enc/processar.php')` returns `'https://t.co/SFsPRm91bg'`.
- [ ] Live resolution on VacaTorrent `/resolve` returns a valid `magnet:?xt=urn:btih:...` URL.
- [ ] `npm test` passes all tests with 0 failures.
- [ ] `npm run typecheck` passes with 0 errors.
- [ ] `npm run lint:lines` passes within limits.

Follow AGENTS.md rules strictly. Maintain your working directory under `.agents/swe_light_2/` with plan.md and progress.md. When complete, send your handoff report to parent.
