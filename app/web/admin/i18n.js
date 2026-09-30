// Centralized i18n (docs/i18n.md). Every admin page includes this script
// before its own — it detects/persists the language, loads the matching
// dictionary from i18n/<locale>.json, and applies it to any element tagged
// with data-i18n / data-i18n-placeholder / data-i18n-title /
// data-i18n-aria-label. Pages whose own scripts render text dynamically
// (app.js, gps.js, etc.) call `AkbalI18n.t(key)` directly and can listen
// for the "akbal:locale-changed" event to re-render on switch.
"use strict";

(function () {
  const SUPPORTED = ["es", "en"];
  const DEFAULT_LOCALE = "en"; // spec: unsupported browser language → English
  const STORAGE_KEY = "akbal_lang";

  const dictionaries = {};
  let currentLocale = null;

  function detectBrowserLocale() {
    const langs =
      (navigator.languages && navigator.languages.length && navigator.languages) ||
      [navigator.language || navigator.userLanguage || ""];
    for (const l of langs) {
      const base = String(l).slice(0, 2).toLowerCase();
      if (base === "es") return "es";
      if (base === "en") return "en";
    }
    return DEFAULT_LOCALE;
  }

  function getStoredLocale() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED.includes(v) ? v : null;
    } catch {
      return null; // private mode / storage blocked — fall back to detection every load
    }
  }

  function storeLocale(locale) {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // best-effort only — a missing persistence is not worth surfacing
    }
  }

  async function loadDictionary(locale) {
    if (dictionaries[locale]) return dictionaries[locale];
    try {
      const res = await fetch(`/i18n/${locale}.json`, { cache: "no-store" });
      dictionaries[locale] = res.ok ? await res.json() : {};
    } catch {
      dictionaries[locale] = {};
    }
    return dictionaries[locale];
  }

  function dig(obj, dottedKey) {
    return dottedKey.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
  }

  function t(key, vars) {
    let str = dig(dictionaries[currentLocale], key);
    if (str === undefined) str = dig(dictionaries[DEFAULT_LOCALE], key);
    if (str === undefined) return key; // missing translation: show the key, never crash
    if (vars) {
      for (const k of Object.keys(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(vars[k]));
      }
    }
    return str;
  }

  function applyTranslations(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    // Only for strings whose dictionary value is trusted, hand-written HTML
    // (e.g. a <strong> emphasis) — never for anything derived from user or
    // device data.
    scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label")));
    });
    scope.querySelectorAll("[data-i18n-alt]").forEach((el) => {
      el.setAttribute("alt", t(el.getAttribute("data-i18n-alt")));
    });
    document.documentElement.setAttribute("lang", currentLocale);
  }

  function updateLangToggle() {
    document.querySelectorAll("#lang-toggle [data-lang]").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-lang") === currentLocale);
    });
  }

  async function setLocale(locale, opts) {
    if (!SUPPORTED.includes(locale)) return;
    currentLocale = locale;
    if (!opts || opts.persist !== false) storeLocale(locale);
    await Promise.all([loadDictionary(locale), loadDictionary(DEFAULT_LOCALE)]);
    applyTranslations(document);
    updateLangToggle();
    document.dispatchEvent(new CustomEvent("akbal:locale-changed", { detail: { locale } }));
  }

  function getLocale() {
    return currentLocale;
  }

  function wireLangToggle() {
    const toggle = document.getElementById("lang-toggle");
    if (!toggle) return;
    toggle.addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-lang]");
      if (!el || el.getAttribute("data-lang") === currentLocale) return;
      void setLocale(el.getAttribute("data-lang"));
    });
    updateLangToggle();
  }

  // Manual selection always wins over browser detection (spec); detection
  // only runs when nothing has been explicitly chosen yet.
  const ready = (async function init() {
    const stored = getStoredLocale();
    await setLocale(stored || detectBrowserLocale(), { persist: false });
    if (stored) storeLocale(stored);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", wireLangToggle);
    } else {
      wireLangToggle();
    }
  })();

  window.AkbalI18n = { t, setLocale, getLocale, applyTranslations, ready, SUPPORTED };
})();
