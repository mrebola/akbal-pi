// Sidebar for the web chat: pinned, recents, new chat, per-chat menu,
// delete with confirmation. Talks to /api/chats; app.js owns the messages
// and the send flow. Kept separate so app.js doesn't grow further.
(function () {
  const list = document.getElementById("chat-list");
  const newBtn = document.getElementById("chat-new");
  let activeId = null;
  let metas = [];

  // Keeps no state the server doesn't have.
  async function api(path, options) {
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function relativeDate(iso) {
    const diffMs = Date.now() - Date.parse(iso);
    const min = Math.round(diffMs / 60000);
    if (min < 1) return "ahora";
    if (min < 60) return `hace ${min} min`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `hace ${hours} h`;
    return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
  }

  function row(meta) {
    const el = document.createElement("div");
    el.className = `chat-row${meta.id === activeId ? " active" : ""}`;
    el.dataset.id = meta.id;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "chat-row-main";
    main.addEventListener("click", () => ChatHistory.onOpen && ChatHistory.onOpen(meta.id));

    const title = document.createElement("span");
    title.className = "chat-row-title";
    title.textContent = meta.title;

    const sub = document.createElement("span");
    sub.className = "chat-row-sub";
    const chip = document.createElement("span");
    chip.className = "chat-row-model";
    chip.textContent = meta.model;
    sub.append(chip, document.createTextNode(` · ${relativeDate(meta.updatedAt)}`));

    main.append(title, sub);

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "chat-row-menu";
    menuBtn.setAttribute("aria-label", "Opciones del chat");
    menuBtn.textContent = "⋯";
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(meta, el);
    });

    el.append(main, menuBtn);
    return el;
  }

  function render() {
    list.innerHTML = "";
    const pinned = metas.filter((m) => m.pinned);
    const recent = metas.filter((m) => !m.pinned);
    if (pinned.length) list.append(section("Fijados", pinned));
    if (recent.length) list.append(section("Recientes", recent));
    if (!metas.length) {
      const empty = document.createElement("div");
      empty.className = "chat-list-empty";
      empty.textContent = "Todavía no hay chats guardados.";
      list.append(empty);
    }
  }

  function section(label, items) {
    const wrap = document.createElement("div");
    wrap.className = "chat-section";
    const head = document.createElement("div");
    head.className = "chat-section-label";
    head.textContent = label;
    wrap.append(head, ...items.map(row));
    return wrap;
  }

  // Single shared menu; closed on any outside click.
  let menu = null;
  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }
  document.addEventListener("click", closeMenu);

  function openMenu(meta, anchor) {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "chat-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.append(
      item(meta.pinned ? "Desfijar" : "Fijar", () => togglePin(meta)),
      item("Renombrar", () => rename(meta)),
      item("Eliminar", () => confirmDelete(meta), true),
    );
    anchor.append(menu);
  }

  function item(label, onClick, danger) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (danger) b.className = "danger";
    b.addEventListener("click", () => {
      closeMenu();
      onClick();
    });
    return b;
  }

  async function togglePin(meta) {
    await api(`/api/chats/${meta.id}`, jsonPatch({ pinned: !meta.pinned }));
    await refresh();
  }

  async function rename(meta) {
    const next = window.prompt("Nuevo nombre del chat", meta.title);
    if (next === null) return;
    if (!next.trim()) return;
    await api(`/api/chats/${meta.id}`, jsonPatch({ title: next }));
    await refresh();
  }

  async function confirmDelete(meta) {
    const ok = await ChatHistory.confirm({
      title: `¿Eliminar "${meta.title}"?`,
      body: "Se borra del disco y no se puede recuperar.",
      ok: "Eliminar",
    });
    if (!ok) return;
    await api(`/api/chats/${meta.id}`, { method: "DELETE" });
    if (meta.id === activeId && ChatHistory.onDeleted) ChatHistory.onDeleted(meta.id);
    await refresh();
  }

  // Deletes every saved chat after one confirmation that names the count.
  async function clearAll() {
    if (metas.length === 0) return;
    const ok = await ChatHistory.confirm({
      title: `¿Borrar los ${metas.length} chats?`,
      body: "Se borran todos los chats guardados del disco. No se puede recuperar.",
      ok: "Borrar todos",
    });
    if (!ok) return;
    await api("/api/chats/delete-all", { method: "POST" });
    if (ChatHistory.onAllDeleted) ChatHistory.onAllDeleted();
    await refresh();
  }

  function jsonPatch(body) {
    return {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  async function refresh() {
    try {
      metas = await api("/api/chats");
      render();
    } catch {
      list.textContent = "No se pudo cargar la lista de chats.";
    }
  }

  window.ChatHistory = {
    onOpen: null,
    onNew: null,
    onDeleted: null,
    refresh,
    setActive(id) {
      activeId = id;
      render();
    },
    // Resolves true only when the user presses the OK button.
    confirm({ title, body, ok = "Continuar" }) {
      const dialog = document.getElementById("chat-confirm-dialog");
      const okBtn = document.getElementById("chat-confirm-ok");
      const cancelBtn = document.getElementById("chat-confirm-cancel");
      dialog.querySelector(".chat-confirm-title").textContent = title;
      dialog.querySelector(".chat-confirm-body").textContent = body;
      okBtn.textContent = ok;
      dialog.hidden = false;
      return new Promise((resolve) => {
        const finish = (value) => {
          dialog.hidden = true;
          okBtn.onclick = null;
          cancelBtn.onclick = null;
          resolve(value);
        };
        okBtn.onclick = () => finish(true);
        cancelBtn.onclick = () => finish(false);
      });
    },
    init() {
      newBtn.addEventListener("click", () => ChatHistory.onNew && ChatHistory.onNew());
      document.getElementById("chat-clear-all").addEventListener("click", clearAll);
      refresh();
    },
  };
})();
