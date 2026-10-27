// ask.js — Lodestone's own question sheet on the setup pages (launcher, phone),
// in place of the browser's grey confirm(), as in the app's window (shell v89).
// Resolves true for the action, false for Cancel, Escape or a click outside.
(function () {
  const DANGER = /^(delete|erase|remove|forget|disconnect|take .* off)\b/i;
  const VERB = { remove: "Remove", forget: "Forget", disconnect: "Disconnect", take: "Take it off", delete: "Delete" };
  window.ask = function ask(text) {
    return new Promise(resolve => {
      const first = String(text).trim();
      const danger = DANGER.test(first);
      const verb = VERB[(first.match(/^[A-Za-z]+/) || [""])[0].toLowerCase()] || "OK";
      const sheet = document.createElement("div"); sheet.className = "ask-sheet";
      const card = document.createElement("div"); card.className = "ask-card"; card.setAttribute("role", "alertdialog"); card.setAttribute("aria-modal", "true");
      const h = document.createElement("p"); h.className = "ask-q"; h.textContent = first;
      const row = document.createElement("div"); row.className = "ask-btns";
      const no = document.createElement("button"); no.type = "button"; no.textContent = "Cancel";
      const yes = document.createElement("button"); yes.type = "button"; yes.className = danger ? "danger-btn" : "primary"; yes.textContent = verb;
      row.append(no, yes); card.append(h, row); sheet.append(card); document.body.append(sheet);
      const done = v => { document.removeEventListener("keydown", key, true); sheet.classList.add("leaving"); setTimeout(() => sheet.remove(), 160); resolve(v); };
      const key = e => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); done(false); } };
      no.onclick = () => done(false); yes.onclick = () => done(true);
      sheet.addEventListener("click", e => { if (e.target === sheet) done(false); });
      document.addEventListener("keydown", key, true);
      (danger ? no : yes).focus();
    });
  };
})();
