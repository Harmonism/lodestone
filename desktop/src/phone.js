const D = window.desktop;
const $ = s => document.querySelector(s);
let pairShown = null, pairTimer = null;
async function render(st) {
  $("#lan").checked = st.lan;
  // The Lodestone app for Android
  $("#pairOff").hidden = !!st.pair; $("#pairOn").hidden = !st.pair;
  if (st.pair && st.pair.url !== pairShown) { pairShown = st.pair.url; $("#pairCode").textContent = st.pair.code; $("#pairBase").textContent = st.pair.base; $("#pairQr").src = await D.qr(st.pair.url); }
  $("#pairedBox").hidden = !(st.paired || []).length;
  const ul = $("#pairedList"); ul.innerHTML = "";
  for (const d of st.paired || []) {
    const li = document.createElement("li");
    li.textContent = `${d.name} — paired ${new Date(d.created).toLocaleDateString()}, last seen ${new Date(d.seen).toLocaleString()} `;
    const b = document.createElement("button"); b.className = "link"; b.textContent = "Forget";
    b.onclick = async () => { if (confirm(`Forget ${d.name}? It will no longer reach this computer until paired again.`)) render(await D.unpair(d.id)); };
    li.append(b); ul.append(li);
  }
  clearTimeout(pairTimer);
  pairTimer = setTimeout(async () => render(await D.phoneStatus()), 5000);
  const addr = st.addresses[0] ? `http://${st.addresses[0]}:${st.port}/lodestone-app/` : null;
  $("#on").hidden = !(st.lan && addr);
  $("#none").hidden = !(st.lan && !addr);
  if (st.lan && addr) { $("#addr").textContent = addr; $("#qr").src = await D.qr(addr); }
}
$("#lan").onchange = async e => render(await D.setLan(e.target.checked));
D.phoneStatus().then(render);

// ─── Telegram ────────────────────────────────────────────────────────────────
const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
let tgTimer = null;
function tgRender(st) {
  $("#tgOff").hidden = st.on;
  $("#tgPair").hidden = !(st.on && !st.paired);
  $("#tgOn").hidden = !(st.on && st.paired);
  $("#tgForgetRow").hidden = !st.on;
  if (st.bot) { $("#tgLink").textContent = "@" + st.bot; $("#tgLink").onclick = ev => { ev.preventDefault(); window.open(`https://t.me/${st.bot}?start=${st.pairCode || ""}`); }; }
  $("#tgCode").textContent = st.pairCode || "";
  $("#tgOnText").textContent = `Connected to @${st.bot || "your bot"}. ${st.status === "listening" ? "Listening." : st.status === "waiting" ? "Reconnecting…" : ""}`;
  $("#tgOutreach").checked = st.outreach;
  $("#tgErr").hidden = !st.error; $("#tgErr").textContent = st.error || "";
  clearTimeout(tgTimer);
  if (st.on && !st.paired) tgTimer = setTimeout(async () => tgRender(await D.tgStatus()), 3000);
}
$("#tgConnect").onclick = async () => {
  const b = $("#tgConnect"); b.disabled = true; b.textContent = "Checking…"; $("#tgErr").hidden = true;
  try { tgRender(await D.tgSetToken($("#tgToken").value)); $("#tgToken").value = ""; }
  catch (e) { $("#tgErr").hidden = false; $("#tgErr").textContent = clean(e); }
  finally { b.disabled = false; b.textContent = "Connect"; }
};
$("#tgOutreach").onchange = async e => tgRender(await D.tgOutreach(e.target.checked));
$("#tgForget").onclick = async () => { if (confirm("Disconnect the Telegram bot from Lodestone?")) tgRender(await D.tgForget()); };
D.tgStatus().then(tgRender);
