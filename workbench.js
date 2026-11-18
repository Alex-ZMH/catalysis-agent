(() => {
  "use strict";

  const storageKey = "catalysis-studio:workbench:drafts:v1";
  const suggestions = [
    "如何在同一参考态下比较两个候选位点？",
    "怎样验证反应循环中可能限制速率的步骤？",
    "如何区分本征反应慢与界面输运慢？",
    "设备放大时，怎样验证热点与压降预测？",
  ];
  const mounted = new WeakMap();

  function readDrafts() {
    const drafts = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(drafts)) return [];
    return drafts.filter(draft =>
      typeof draft?.id === "string" && typeof draft.text === "string");
  }

  function mount(root) {
    if (mounted.has(root)) return mounted.get(root);
    root.hidden = true;
    root.innerHTML = `
      <aside class="wb-sidebar" id="wb-sidebar" aria-label="研究草案导航">
        <div class="wb-brand">催化研究 <span>STUDIO</span></div>
        <button type="button" class="wb-new"><span aria-hidden="true">＋</span> 新对话</button>
        <h2>本地最近记录</h2>
        <nav class="wb-history" aria-label="本地研究草案"></nav>
        <a class="wb-back" href="#home"><span aria-hidden="true">←</span> 返回展示页</a>
      </aside>
      <button type="button" class="wb-scrim" aria-label="关闭草案导航" tabindex="-1" hidden></button>
      <main class="wb-main">
        <header class="wb-header">
          <button type="button" class="wb-menu" aria-label="打开草案导航" aria-controls="wb-sidebar" aria-expanded="false">
            <span aria-hidden="true">☰</span>
          </button>
          <strong>催化研究助手</strong>
          <span class="wb-mode">本地草案模式</span>
        </header>
        <div class="wb-stage">
          <div class="wb-content">
            <div class="wb-welcome">
              <span class="wb-mark" aria-hidden="true"></span>
              <h1>今天，想研究什么？</h1>
              <p>写下你的研究问题，整理成可继续编辑的草案。</p>
            </div>
            <form class="wb-composer">
              <textarea rows="3" aria-label="研究问题" placeholder="输入研究问题，或描述你想验证的假设…"></textarea>
              <div class="wb-actions">
                <p role="status" class="wb-status">草案仅保存在当前浏览器。</p>
                <button type="submit" class="wb-save" disabled>保存为本地草案</button>
              </div>
            </form>
            <section class="wb-suggestions" aria-label="建议问题"></section>
          </div>
        </div>
      </main>`;

    const find = selector => root.querySelector(selector);
    const sidebar = find(".wb-sidebar");
    const main = find(".wb-main");
    const menu = find(".wb-menu");
    const scrim = find(".wb-scrim");
    const newButton = find(".wb-new");
    const input = find("textarea");
    const save = find(".wb-save");
    const status = find(".wb-status");
    const history = find(".wb-history");
    const mobile = window.matchMedia("(max-width: 800px)");
    let activeId = null;
    let drawerOpen = false;

    function setDrawer(open) {
      drawerOpen = open && mobile.matches;
      sidebar.inert = mobile.matches && !drawerOpen;
      main.inert = drawerOpen;
      scrim.hidden = !drawerOpen;
      root.classList.toggle("wb-drawer-open", drawerOpen);
      menu.setAttribute("aria-expanded", String(drawerOpen));
    }

    function updateComposer(message = "草案仅保存在当前浏览器。") {
      status.textContent = message;
      save.disabled = !input.value.trim();
      save.textContent = activeId ? "更新本地草案" : "保存为本地草案";
    }

    function renderHistory() {
      history.replaceChildren();
      let drafts;
      let empty = "还没有保存的草案。";
      try {
        drafts = readDrafts();
      } catch {
        drafts = [];
        empty = "暂时无法读取本地草案。";
      }
      if (!drafts.length) {
        const hint = document.createElement("p");
        hint.textContent = empty;
        history.append(hint);
      }
      for (const draft of drafts) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = draft.text.replace(/\s+/g, " ").trim();
        if (draft.id === activeId) button.setAttribute("aria-current", "true");
        button.addEventListener("click", () => {
          activeId = draft.id;
          input.value = draft.text;
          setDrawer(false);
          updateComposer("已恢复本地草案。");
          renderHistory();
          input.focus();
        });
        history.append(button);
      }
    }

    function prefill(value) {
      activeId = null;
      input.value = String(value ?? "");
      updateComposer();
      renderHistory();
    }

    function enter() {
      root.hidden = false;
      setDrawer(false);
      renderHistory();
      input.focus({ preventScroll: true });
    }

    function leave() {
      setDrawer(false);
      root.hidden = true;
    }

    function closeDrawer() {
      setDrawer(false);
      menu.focus();
    }

    newButton.addEventListener("click", () => {
      prefill("");
      setDrawer(false);
      input.focus();
    });
    menu.addEventListener("click", () => {
      setDrawer(true);
      newButton.focus();
    });
    scrim.addEventListener("click", closeDrawer);
    root.addEventListener("keydown", event => {
      if (event.key === "Escape" && drawerOpen) {
        event.preventDefault();
        closeDrawer();
      }
    });
    mobile.addEventListener("change", () => {
      const needsFocus = drawerOpen || sidebar.contains(document.activeElement) ||
        document.activeElement === menu;
      setDrawer(false);
      if (!root.hidden && needsFocus) input.focus();
    });
    find(".wb-back").addEventListener("click", leave);
    input.addEventListener("input", () => updateComposer());
    find("form").addEventListener("submit", event => {
      event.preventDefault();
      if (!input.value.trim()) return;
      try {
        const drafts = readDrafts();
        const id = activeId ?? crypto.getRandomValues(new Uint32Array(4)).join("-");
        const draft = { id, text: input.value };
        localStorage.setItem(storageKey, JSON.stringify([
          draft, ...drafts.filter(item => item.id !== draft.id),
        ]));
        activeId = draft.id;
      } catch {
        updateComposer("无法保存到此浏览器，编辑内容仍在输入框中。");
        return;
      }
      updateComposer("已保存到当前浏览器。");
      renderHistory();
    });

    for (const question of suggestions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = question;
      button.addEventListener("click", () => {
        prefill(question);
        input.focus();
      });
      find(".wb-suggestions").append(button);
    }

    setDrawer(false);
    renderHistory();
    const api = { prefill, enter, leave };
    mounted.set(root, api);
    return api;
  }

  window.CatalysisWorkbench = { mount };
})();
