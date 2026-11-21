// Loaded synchronously in <head> (external file so the CSP needs no 'unsafe-inline').
// Applies the saved theme before first paint, then wires up the toggle button.
(function () {
  var KEY = "theme";
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  root.dataset.theme = saved === "light" || saved === "dark" ? saved : "dark";

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.querySelector("[data-theme-toggle]");
    if (!btn) return;
    var sync = function () {
      btn.setAttribute("aria-pressed", String(root.dataset.theme === "light"));
    };
    sync();
    btn.addEventListener("click", function () {
      root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
      try { localStorage.setItem(KEY, root.dataset.theme); } catch (e) {}
      sync();
    });
  });
})();
