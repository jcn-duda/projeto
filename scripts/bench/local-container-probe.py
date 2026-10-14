#!/usr/bin/env python3
"""Sonda de LEITURA, executada DENTRO do container do addon.

Roda via `docker exec -i -w /app <container> python3 - <modo>`, com o programa
lido do stdin (nada é escrito no filesystem do container). Usa só a stdlib.

Regras de privacidade (invariantes deste script):
  - NUNCA imprime argv, cmdline, env, token, URL de request ou body cru.
  - O token (JACKETT_TEST_TOKEN) vive só na memória deste processo e vai como
    header; nunca aparece no stdout nem em stack.
  - Só o PID + VmRSS do processo do addon, os DOIS timers de /metrics.json e o
    sha256 de 5 arquivos de dist/ saem no JSON.
  - O tamanho da janela só sai se o endpoint /metrics.json o publicar de fato
    (número finito); este checkout não publica, então nada é inventado.
"""

import hashlib
import json
import math
import os
import sys
import urllib.error
import urllib.request

METRICS_URL = "http://127.0.0.1:7000/metrics.json"
TOKEN_ENV = "JACKETT_TEST_TOKEN"
TOKEN_HEADER = "X-Indexer-Test-Token"
# Só estas duas famílias de timer são expostas (allowlist forte).
TIMERS = ("search.response", "search.first.total")
# Subconjunto compilado, relativo ao WORKDIR /app da imagem.
FILES = (
    "dist/src/addon.js",
    "dist/src/app.js",
    "dist/src/utils/title-normalization.js",
    "dist/src/providers/search-orchestrator.js",
    "dist/src/providers/stream-builder.js",
)
# Alvo da busca por processo: o addon roda como `node dist/src/addon.js`.
ADDON_CMDLINE_MARK = "dist/src/addon.js"


def addon_proc():
    """PID + VmRSS do processo do addon. Exclui o próprio PID da sonda."""
    me = os.getpid()
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) == me:
            continue
        try:
            with open("/proc/%s/cmdline" % entry, "rb") as fh:
                cmd = fh.read().replace(b"\x00", b" ").decode("utf-8", "replace")
            if ADDON_CMDLINE_MARK not in cmd:
                continue
            with open("/proc/%s/status" % entry, "r") as fh:
                status = fh.read()
        except OSError:
            # processo saiu no meio da leitura: ignora e segue
            continue
        rss = None
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                rss = int(line.split()[1]) * 1024  # kB -> bytes
                break
        return {"pid": int(entry), "rssBytes": rss}
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Não segue 3xx. Sem isto, um 302 com Location remoto reenviaria o header
    com o token para outro host. Devolver None faz o urllib tratar o 3xx como
    HTTPError (código cru), sem ler o corpo e sem ir ao destino."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def metrics_opener():
    """Opener só para o GET literal do METRICS_URL (127.0.0.1).

    O host literal não basta: `urlopen` honra HTTP_PROXY/http_proxy do ambiente
    e um 3xx poderia levar o token para fora. `ProxyHandler({})` ignora o
    ambiente (sem proxy) e `_NoRedirect` barra redirecionamentos; nenhum ajuste
    de env global nem request externo é feito."""
    return urllib.request.build_opener(_NoRedirect(), urllib.request.ProxyHandler({}))


def metric_number(value):
    # A allowlist de nomes não basta: não exportar texto recebido num campo numérico.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return value if value >= 0 and math.isfinite(value) else None
    except (OverflowError, ValueError):
        return None


def metrics():
    """GET literal em /metrics.json; extrai SÓ os dois timers da allowlist."""
    token = os.environ.get(TOKEN_ENV) or ""
    if not token:
        return {"status": "token_unset", "httpStatus": None, "timers": {}}
    req = urllib.request.Request(METRICS_URL, headers={TOKEN_HEADER: token})
    try:
        with metrics_opener().open(req, timeout=8) as resp:
            body = resp.read()
            http_status = resp.status
    except urllib.error.HTTPError as err:
        # 401/429/503 são estados honestos, não erro de rede: sem segredo no corpo
        label = {401: "auth_failed", 429: "gate_busy", 503: "disabled"}.get(
            err.code, "http_error"
        )
        return {"status": label, "httpStatus": err.code, "timers": {}}
    except Exception:
        return {"status": "network_error", "httpStatus": None, "timers": {}}
    try:
        data = json.loads(body)
    except Exception:
        return {"status": "bad_json", "httpStatus": http_status, "timers": {}}
    src = data.get("timers") if isinstance(data.get("timers"), dict) else {}
    timers = {}
    for name in TIMERS:
        t = src.get(name)
        if not isinstance(t, dict):
            timers[name] = None
            continue
        timers[name] = {
            key: metric_number(t.get(key))
            for key in ("count", "avgMs", "p50Ms", "p95Ms", "maxMs")
        }
    out = {
        "status": "ok",
        "httpStatus": http_status,
        "uptimeS": metric_number(data.get("uptimeS")),
        "timers": timers,
    }
    # Só reporta a janela se o próprio endpoint a publicar (finita). Não
    # substituir por constante: quem não mede não afirma.
    window = metric_number(data.get("windowSize"))
    if window is not None:
        out["windowSize"] = window
    return out


def hashes():
    """sha256 dos 5 artefatos compilados (None se ausente)."""
    out = {}
    for rel in FILES:
        try:
            with open(rel, "rb") as fh:
                out[rel] = hashlib.sha256(fh.read()).hexdigest()
        except OSError:
            out[rel] = None
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "snapshot"
    if mode == "sample":
        result = {"mode": mode, "addonProc": addon_proc()}
    elif mode == "snapshot":
        result = {"mode": mode, "addonProc": addon_proc(), "metrics": metrics()}
    elif mode == "hashes":
        result = {"mode": mode, "files": hashes()}
    else:
        print(json.dumps({"mode": "error", "error": "unknown mode"}))
        sys.exit(2)
    print(json.dumps(result, sort_keys=True))
    sys.exit(0)


main()
