/* Adom Power-Movie - pagina /configure: casca de aplicacao (Fase 3, PLANO_MELHORIAS 5.9).
 * Elementos (el), estado compartilhado, base64url do segmento, selo da chave de
 * debrid e ligacao de eventos, extraidos do script inline do configure.html.
 * Carregado ANTES do script inline; escopo global compartilhado (por isso sem
 * IIFE) - as funcoes que os testes regexam (collect/apply/render/fromUrl e os
 * blocos de limites/status) continuam no HTML. ES5 puro: WebView de Fire TV e
 * smart TV. Sem build, sem bundler. */
"use strict";

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    presets: $("presets"),
    qualities: $("qualities"),
    brFirst: $("brFirst"),
    torrentioToggle: $("torrentioToggle"), torrentioRow: $("torrentioRow"),
    jackettIndexers: $("jackettIndexers"), indexerPriorityOrder: $("indexerPriorityOrder"),
    brSlots: $("brSlots"), outBr: $("outBr"),
    maxResults: $("maxResults"), outMax: $("outMax"),
    maxPerQuality: $("maxPerQuality"), outPerQuality: $("outPerQuality"),
    maxPerIndexer: $("maxPerIndexer"), outPerIndexer: $("outPerIndexer"),
    minSeeders: $("minSeeders"), outSeed: $("outSeed"),
    maxSizeGb: $("maxSizeGb"), outMaxSize: $("outMaxSize"),
    brOnly: $("brOnly"), dubbedOnly: $("dubbedOnly"),
    preferDubbed: $("preferDubbed"), excludeCam: $("excludeCam"),
    streamNameStyle: $("streamNameStyle"), streamNameShowSource: $("streamNameShowSource"),
    debridService: $("debridService"), debridApiKey: $("debridApiKey"),
    keyHintPlain: $("keyHintPlain"), keyHintSealed: $("keyHintSealed"), debridKeyKept: $("debridKeyKept"),
    debridKeyField: $("debridKeyField"), keyLink: $("keyLink"),
    debridCachedOnly: $("debridCachedOnly"), cachedOnlyRow: $("cachedOnlyRow"),
    showUncachedBr: $("showUncachedBr"), uncachedBrRow: $("uncachedBrRow"),
    autoFetchBr: $("autoFetchBr"), autoFetchRow: $("autoFetchRow"),
    noCacheNotice: $("noCacheNotice"),
    adMagnetNotice: $("adMagnetNotice"),
    installUrl: $("installUrl"), installBtn: $("installBtn"), copyBtn: $("copyBtn")
  };

  // Preenchido por /defaults.json a partir do registry do servidor.
  var services = [];
  var jackettIndexers = [];
  var indexerPriority = [];
  var instanceDefaults = null;
  // Chave cifrada que veio no link aberto. Fica fora do campo (é um blob opaco)
  // e é reaproveitada se o usuário mexer noutra opção sem colar outra chave.
  var sealedKey = "";

  function ancestorWithClass(node, className, stop) {
    while (node && node !== stop) {
      if ((" " + node.className + " ").indexOf(" " + className + " ") !== -1) return node;
      node = node.parentNode;
    }
    return null;
  }

  /* ---------- base64url: mesma codificação que o servidor decodifica ---------- */

  // Espelha o PREFIX de src/utils/secret-box.js.
  function isSealedKey(value) {
    return typeof value === "string" && value.indexOf("enc.v1.") === 0;
  }

  function encodeConfig(obj) {
    var json = JSON.stringify(obj);
    var b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decodeConfig(segment) {
    try {
      var b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (e) { return null; }
  }

  function applySegment(segment) {
    var url = location.origin + "/" + segment + "/manifest.json";
    el.installUrl.textContent = url;
    // O servidor mantém um teto defensivo de 8192. Nunca ofereça um link que
    // sabemos que virará 404 (catálogo enorme selecionado manualmente).
    var tooLong = segment.length > 8000;
    el.installBtn.href = tooLong ? "#" : url.replace(/^https?:/, "stremio:");
    el.installBtn.setAttribute("aria-disabled", tooLong ? "true" : "false");
    el.copyBtn.disabled = tooLong;
    el.copyBtn.setAttribute("data-url", tooLong ? "" : url);
    el.installBtn.setAttribute("tabindex", tooLong ? "-1" : "0");
    if (tooLong) el.installUrl.textContent = "Configuração grande demais: desmarque alguns indexadores.";
  }

  /* ---------- selo da chave de debrid ---------- */

  // O segmento é montado aqui no navegador, que não tem (nem pode ter) o
  // RESOLVE_SECRET. Com o selo ligado no servidor, a URL aparece primeiro com a
  // chave em texto puro e é trocada pela versão cifrada quando a resposta
  // chega. O token descarta resposta atrasada de uma configuração que o usuário
  // já mudou — sem ele, mexer rápido nos controles publicaria um link que não
  // corresponde ao que está na tela.
  var sealToken = 0;
  var sealTimer = null;

  // A URL é remontada a cada tecla; pedir o selo junto renderia uma requisição
  // por caractere digitado na chave. Só o último estado interessa.
  function requestSeal(segment) {
    if (!instanceDefaults || !instanceDefaults.sealKeyEnabled) return;
    // Sem chave no segmento não há o que selar (P2P puro).
    if (!el.debridService.value || !el.debridApiKey.value.trim()) return;

    if (sealTimer) clearTimeout(sealTimer);
    sealTimer = setTimeout(function () { sendSeal(segment); }, 250);
  }

  function sendSeal(segment) {
    var token = ++sealToken;
    fetch("/seal-config", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: segment
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (token !== sealToken || !data || !data.segment) return;
        applySegment(data.segment);
      })
      .catch(function () {
        // Selo indisponível não pode impedir a instalação: o link em texto puro
        // continua válido, e é ele que fica na tela.
      });
  }

  /* ---------- eventos ---------- */

  [el.qualities, el.jackettIndexers].forEach(function (group) {
    group.addEventListener("click", function (ev) {
      var priority = group === el.jackettIndexers ? ancestorWithClass(ev.target, "priority-btn", group) : null;
      if (priority) {
        setPresetChoice("custom");
        togglePriority(priority.getAttribute("data-value"));
        return;
      }
      var chip = ancestorWithClass(ev.target, "chip", group);
      if (!chip) return;
      var value = chip.getAttribute("data-value");
      setOn(chip, !isOn(chip));
      if (group === el.jackettIndexers && !isOn(chip)) {
        var priorityAt = indexerPriority.indexOf(value);
        if (priorityAt !== -1) indexerPriority.splice(priorityAt, 1);
      }
      setPresetChoice("custom");
      render();
    });
  });

  [el.brFirst, el.brOnly, el.dubbedOnly, el.preferDubbed, el.excludeCam, el.debridCachedOnly, el.showUncachedBr, el.autoFetchBr].forEach(function (sw) {
    sw.addEventListener("click", function () { setOn(sw, !isOn(sw)); setPresetChoice("custom"); render(); });
  });

  // Pool global Torrentio: toggle específico sobre a base de provedores. Não
  // existe no schema como opção própria — grava no KEYS.providers ('p'), então
  // a URL carrega a escolha junto das demais fontes, e links antigos continuam.
  if (el.torrentioToggle) {
    el.torrentioToggle.addEventListener("click", function () {
      setOn(el.torrentioToggle, !isOn(el.torrentioToggle));
      torrentioOn = isOn(el.torrentioToggle);
      setPresetChoice("custom");
      render();
    });
  }

  [el.brSlots, el.maxResults, el.maxPerQuality, el.maxPerIndexer, el.minSeeders, el.maxSizeGb].forEach(function (r) {
    r.addEventListener("input", function () { setPresetChoice("custom"); render(); });
  });

  el.debridService.addEventListener("change", function () { setPresetChoice("custom"); render(); });
  if (el.streamNameStyle) el.streamNameStyle.addEventListener("change", function () { setPresetChoice("custom"); render(); });
  if (el.streamNameShowSource) el.streamNameShowSource.addEventListener("change", function () { setPresetChoice("custom"); render(); });
  el.debridApiKey.addEventListener("input", function () {
    // Digitou qualquer coisa: a chave do link antigo deixa de valer. Sem isto,
    // apagar o campo faria a URL voltar a carregar a chave anterior.
    sealedKey = "";
    el.debridKeyKept.hidden = true;
    setPresetChoice("custom");
    render();
  });

  el.presets.addEventListener("click", function (ev) {
    var button = ancestorWithClass(ev.target, "preset", el.presets);
    if (!button) return;
    var name = button.getAttribute("data-preset");
    if (name === "custom") setPresetChoice("custom");
    else applyPreset(name);
  });

  el.copyBtn.addEventListener("click", function () {
    var url = el.copyBtn.getAttribute("data-url") || "";
    if (!url) return;
    var done = function () {
      el.copyBtn.textContent = "Copiado ✓";
      el.copyBtn.classList.add("ok");
      setTimeout(function () {
        el.copyBtn.textContent = "Copiar link";
        el.copyBtn.classList.remove("ok");
      }, 1800);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(done, done);
    } else {
      var ta = document.createElement("textarea");
      ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      done();
    }
  });

  el.installBtn.addEventListener("click", function (ev) {
    if (el.installBtn.getAttribute("aria-disabled") === "true") ev.preventDefault();
  });

