/* Adom Power-Movie — /dashboard: navegação por abas e âncoras (Fase 0 + 2).
 * switchTab dirigido por TABELA (Fase 0) + nav de âncoras por aba (Fase 2.3):
 * chips fixos abaixo da faixa de saúde, um por seção da aba ativa, com
 * realce da seção visível no scroll. A troca de aba também dispara o render
 * da aba recém-ativada com o último payload (Fase 2.5) — por isso o hook é
 * typeof-guardado: nos sandboxes de teste só core+nav podem estar presentes.
 * Escopo global compartilhado (sem IIFE). Antes do boot. ES5 puro (Fire TV). */
"use strict";

  // Tabela única de abas: nome lógico, id do botão, id da view e hash da URL.
  // A ordem define o fallback: "geral" é a primeira e a aba default.
  var TAB_ITEMS = [
    { name: "geral", tabId: "tabGeral", viewId: "viewGeral", hash: "#geral" },
    { name: "autofetch", tabId: "tabAutofetch", viewId: "viewAutofetch", hash: "#autofetch" },
    { name: "colhedor", tabId: "tabColhedor", viewId: "viewColhedor", hash: "#colhedor" },
    { name: "trace", tabId: "tabTrace", viewId: "viewTrace", hash: "#trace" }
  ];

  function tabByName(name) {
    var i;
    for (i = 0; i < TAB_ITEMS.length; i += 1) {
      if (TAB_ITEMS[i].name === name) return TAB_ITEMS[i];
    }
    return null;
  }

  function switchTab(name) {
    var active = tabByName(name) || TAB_ITEMS[0];
    var i;
    var entry;
    var isDefault = active === TAB_ITEMS[0];
    // Guarda intacta do comportamento antigo: só comuta com os oito elementos
    // presentes (o painel pode estar truncado em teste/embed).
    for (i = 0; i < TAB_ITEMS.length; i += 1) {
      if (!$(TAB_ITEMS[i].tabId) || !$(TAB_ITEMS[i].viewId)) return;
    }
    for (i = 0; i < TAB_ITEMS.length; i += 1) {
      entry = TAB_ITEMS[i];
      var isActive = entry === active;
      $(entry.tabId).className = "tab-btn" + (isActive ? " active" : "");
      $(entry.tabId).setAttribute("aria-selected", isActive ? "true" : "false");
      $(entry.viewId).className = "tab-view" + (isActive ? "" : " hidden");
    }
    // Comportamento preservado: a aba default só REESCREVE o hash quando ele
    // aponta para outra aba conhecida — um #ancora qualquer na Geral não é
    // sobrescrito; as demais abas sempre refletem a própria hash.
    if (!isDefault) {
      if (window.location.hash !== active.hash) window.location.hash = active.hash;
    } else {
      var known = [];
      for (i = 0; i < TAB_ITEMS.length; i += 1) {
        if (TAB_ITEMS[i] !== TAB_ITEMS[0]) known.push(TAB_ITEMS[i].hash);
      }
      if (known.indexOf(window.location.hash) !== -1) window.location.hash = TAB_ITEMS[0].hash;
    }
    // Fase 2.3: chips de âncora da aba recém-ativada.
    if (typeof renderSectionNav === "function") renderSectionNav(active.name);
    // Fase 2.5: a aba recém-ativada desenha o ÚLTIMO payload conhecido —
    // sem isso ela ficaria vazia até o próximo poll (10 s). Na primeira carga
    // ainda não há payload (lastStatusRoot nasce null no status) e o render
    // que vale é o do polling. typeof-guardado: sandboxes podem carregar só
    // core+nav, sem o módulo de status.
    if (typeof renderActivePanels === "function" && typeof lastStatusRoot !== "undefined" && lastStatusRoot) {
      renderActivePanels(lastStatusRoot);
    }
    if (typeof markActiveSection === "function") markActiveSection();
  }

  function handleHash() {
    var hash = String(window.location.hash || "").replace(/^#/, "");
    var entry = tabByName(hash);
    // Hash desconhecido ou vazio cai na aba default (geral), como antes.
    switchTab(entry ? entry.name : TAB_ITEMS[0].name);
  }

  // ---- Fase 2.3: nav de âncoras por aba ----
  // Uma entrada por SEÇÃO de aba (os ids vivem nos <section> do HTML). A
  // ordem define a leitura: a primeira seção é o topo da aba.
  var SECTION_ITEMS = {
    geral: [
      { id: "secGeral", label: "Geral" },
      { id: "secDebrid", label: "Debrid" },
      { id: "secDebridTest", label: "Testar chave" },
      { id: "secSources", label: "Fontes" },
      { id: "secCache", label: "Cache" },
      { id: "secMagnets", label: "MagnetDB" },
      { id: "secIdx", label: "Índice" },
      { id: "secActions", label: "Ações" },
      { id: "secCatalog", label: "Catálogo" }
    ],
    autofetch: [
      { id: "secAfLive", label: "Visão viva" },
      { id: "secAfSources", label: "Fontes e volume" },
      { id: "secAfProtect", label: "Proteção" },
      { id: "secAfLifecycle", label: "Ciclo de vida" },
      { id: "secAfActions", label: "Presets" }
    ],
    colhedor: [
      { id: "secHarvestLive", label: "Visão viva" },
      { id: "secHarvestDebrid", label: "Conta de debrid" },
      { id: "secHarvestTraffic", label: "Ritmo" },
      { id: "secHarvestQueue", label: "Fila" },
      { id: "secHarvestSeed", label: "Sementes" },
      { id: "secHarvestActions", label: "Presets" }
    ],
    trace: [
      { id: "secTrace", label: "Stream Trace" }
    ]
  };

  function activeTabName() {
    var i;
    var btn;
    for (i = 0; i < TAB_ITEMS.length; i += 1) {
      btn = $(TAB_ITEMS[i].tabId);
      if (btn && String(btn.className).indexOf(" active") !== -1) return TAB_ITEMS[i].name;
    }
    return TAB_ITEMS[0].name;
  }

  function scrollToSection(chip) {
    var id = chip && chip.getAttribute ? chip.getAttribute("data-section") : null;
    var target = id ? $(id) : null;
    if (!target) return;
    // Fase 4: o chip de seção RECOLHIDA expande antes de rolar — scroll para
    // um corpo [hidden] pousaria num cabeçalho seguido de vazio. Seção sem
    // toggle (outras abas, sandbox) falha aberta dentro do guard, sem lançar.
    setSectionExpanded(id, true);
    if (typeof target.scrollIntoView === "function") target.scrollIntoView(true);
  }

  // ---- Fase 4: progressive disclosure nas 9 seções da Geral ----
  // Cada <section> da Visão Geral carrega um corpo .section-body e um botão
  // .section-toggle no cabeçalho. O HTML NASCE com secGeral aberto e as
  // outras 8 fechadas ([hidden]); aqui NÃO há estado próprio — o atributo
  // hidden do corpo é a fonte única e o botão só o espelha (aria-expanded +
  // rótulo). O conteúdo oculto segue sendo pintado a cada poll: nada no
  // render consulta visibilidade, então recolhido não é congelado.
  var TOGGLE_OPEN = "Recolher";
  var TOGGLE_CLOSED = "Expandir";

  function sectionBodyFor(section) {
    return section && section.querySelector ? section.querySelector(".section-body") : null;
  }

  function sectionToggleFor(section) {
    return section && section.querySelector ? section.querySelector(".section-toggle") : null;
  }

  // Expande/recolhe UMA seção por id. Idempotente e fail-open: devolve false
  // sem lançar quando a seção não tem corpo/toggle (outras abas, sandbox) —
  // o chip pode chamá-la em qualquer aba sem ramificar no chamador.
  function setSectionExpanded(id, expanded) {
    var section = $(id);
    var body, toggle;
    if (!section) return false;
    body = sectionBodyFor(section);
    toggle = sectionToggleFor(section);
    if (!body || !toggle) return false;
    if (expanded) body.removeAttribute("hidden");
    else body.setAttribute("hidden", "hidden");
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.textContent = expanded ? TOGGLE_OPEN : TOGGLE_CLOSED;
    return true;
  }

  // Sincroniza o botão com o estado que veio do HTML (a fonte única é o
  // [hidden] do corpo, nunca o rótulo atual): init pode rodar duas vezes.
  function syncSectionToggle(section) {
    var body = sectionBodyFor(section);
    var toggle = sectionToggleFor(section);
    if (!body || !toggle) return;
    var collapsed = body.hasAttribute("hidden");
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.textContent = collapsed ? TOGGLE_CLOSED : TOGGLE_OPEN;
  }

  function initSectionToggles() {
    var sections = document.querySelectorAll ? document.querySelectorAll("#viewGeral section") : [];
    var i;
    for (i = 0; i < sections.length; i += 1) syncSectionToggle(sections[i]);
  }

  function sectionOfToggle(node) {
    if (node && typeof node.closest === "function") return node.closest("section");
    var el = node;
    while (el && el.tagName !== "SECTION") el = el.parentNode;
    return el || null;
  }

  function onSectionToggleClick(event) {
    var btn = event.currentTarget || event.target;
    var section = sectionOfToggle(btn);
    var body = sectionBodyFor(section);
    if (!section || !body) return;
    // Recolhido = [hidden] presente: expandir é remover, e vice-versa.
    setSectionExpanded(section.id, body.hasAttribute("hidden"));
  }

  var sectionTogglesBound = false;

  function bindSectionToggles() {
    if (sectionTogglesBound) return;
    sectionTogglesBound = true;
    var buttons = document.querySelectorAll ? document.querySelectorAll(".section-toggle") : [];
    var i;
    for (i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener("click", onSectionToggleClick);
    }
  }

  // Reconstrói os chips a CADA troca de aba: a aba define as seções, e o
  // container é público (usualmente ~9 chips na Geral, 5 no Chupim).
  function renderSectionNav(tabName) {
    var nav = $("sectionNav");
    var items = SECTION_ITEMS[tabName] || [];
    var i;
    var chip;
    // Sem helper de desenho (sandbox só com core+nav) não há o que fazer.
    if (!nav || typeof element !== "function") return;
    nav.textContent = "";
    for (i = 0; i < items.length; i += 1) {
      chip = element("button", "section-chip" + (i === 0 ? " active" : ""));
      chip.type = "button";
      chip.setAttribute("data-section", items[i].id);
      chip.setAttribute("aria-label", "Ir para " + items[i].label);
      chip.appendChild(document.createTextNode(items[i].label));
      chip.addEventListener("click", function (event) {
        scrollToSection(event.currentTarget || event.target);
      });
      nav.appendChild(chip);
    }
  }

  // Realce da seção visível: último topo que já passou da compensação das
  // duas barras fixas. Scroll listener passivo e barato (compara offsetTop).
  // A lista de seções vem dos CHIPS RENDERIZADOS (data-section) e não de
  // activeTabName(): renderSectionNav é quem define o que está na tela, e
  // derivar de novo da aba poderia realçar contra outra lista.
  function markActiveSection() {
    var nav = $("sectionNav");
    var offset = 170;
    var current = null;
    var chips;
    var i;
    var el;
    var id;
    if (!nav || !nav.children || !nav.children.length) return;
    chips = nav.children;
    for (i = 0; i < chips.length; i += 1) {
      id = chips[i] && chips[i].getAttribute ? chips[i].getAttribute("data-section") : null;
      if (!id) continue;
      el = $(id);
      if (el && (el.offsetTop - offset) <= (window.pageYOffset || 0)) current = id;
    }
    if (!current) current = chips[0] && chips[0].getAttribute ? chips[0].getAttribute("data-section") : null;
    for (i = 0; i < chips.length; i += 1) {
      if (!chips[i].getAttribute) continue;
      chips[i].className = "section-chip" + (chips[i].getAttribute("data-section") === current ? " active" : "");
    }
  }

  var sectionNavBound = false;

  function bindSectionNav() {
    if (sectionNavBound) return;
    sectionNavBound = true;
    window.addEventListener("scroll", markActiveSection, false);
  }
