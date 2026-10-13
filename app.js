// Job Hunt tracker
// Plain JavaScript, no build step. Data lives in Supabase (see supabase/schema.sql).
// Sections: helpers, data layer, rendering, editor, import/export, sign-in, start-up.
(() => {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const C = window.APP_CONTENT;
  const $ = (sel, root = document) => root.querySelector(sel);
  const DAY = 86400000;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // ---------- fixed lists ----------
  const TRACKS = C.tracks;
  const STATUSES = [
    { id: "saved", label: "To apply", stage: 0, group: "todo" },
    { id: "applied", label: "Applied", stage: 1, group: "active" },
    { id: "assessment", label: "Assessment", stage: 2, group: "active" },
    { id: "interview", label: "Interview", stage: 3, group: "active" },
    { id: "final", label: "Final stage", stage: 4, group: "active" },
    { id: "offer", label: "Offer", stage: 5, group: "offers" },
    { id: "accepted", label: "Accepted", stage: 5, group: "offers" },
    { id: "rejected", label: "Rejected", stage: null, group: "closed" },
    { id: "noresponse", label: "No response", stage: null, group: "closed" },
    { id: "withdrawn", label: "Withdrawn", stage: null, group: "closed" }
  ];
  const STAGES = ["Not applied yet", "Applied", "Assessment or tests", "Interview", "Final stage", "Offer"];
  const CVS = ["", ...C.cvs];

  // ---------- helpers ----------
  // h("div", {class: "x", onclick: fn}, child, "text") builds an element. Text is always inserted as text, never HTML.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function sv(tag, attrs, text) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (text != null) el.textContent = text;
    return el;
  }
  function today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function parseD(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function monday(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function diff(a, b) { return Math.round((b - a) / DAY); }
  function fmt(d) { return d ? d.getDate() + " " + MON[d.getMonth()] : "—"; }
  const GOAL = parseD(C.goalDate);
  const PLAN_START = parseD(C.planStart);
  const trackName = id => (TRACKS.find(t => t.id === id) || { name: "Other" }).name;
  const statusOf = id => STATUSES.find(s => s.id === id) || STATUSES[1];
  const furthest = a => Number.isFinite(+a.furthest) ? Math.max(0, Math.min(5, +a.furthest)) : (statusOf(a.status).stage || 0);
  const isClosed = a => ["rejected", "noresponse", "withdrawn", "accepted"].includes(a.status);
  const heardBack = a => furthest(a) >= 2 || a.status === "rejected";
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  // ---------- state ----------
  let sb = null;            // Supabase client
  let session = null;       // signed-in session
  let apps = [];            // applications, in app (camelCase) shape
  let loaded = false;
  let lastLoad = 0;
  let settings = { weeklyTarget: C.defaultWeeklyTarget || 8, checks: {} };
  let editing = null;
  let recovering = false;   // true while the user is setting a new password after a reset email

  // ---------- data layer ----------
  // Database columns are snake_case; the app uses camelCase.
  const COLS = {
    company: "company", role: "role", track: "track", location: "location", status: "status", furthest: "furthest",
    dateApplied: "date_applied", closingDate: "closing_date", source: "source", cv: "cv", ref: "ref", salary: "salary",
    url: "url", nextAction: "next_action", nextActionDate: "next_action_date", feedback: "feedback", notes: "notes",
    needsUpdate: "needs_update", checkNote: "check_note"
  };
  const DATE_FIELDS = new Set(["dateApplied", "closingDate", "nextActionDate"]);
  const VALID_STATUS = new Set(STATUSES.map(s => s.id));
  const VALID_TRACK = new Set(TRACKS.map(t => t.id));

  function fromRow(r) {
    const a = { id: r.id, createdAt: r.created_at, updatedAt: r.updated_at };
    for (const [k, col] of Object.entries(COLS)) {
      const v = r[col];
      a[k] = v == null ? (k === "furthest" ? 0 : k === "needsUpdate" ? false : "") : v;
    }
    return a;
  }
  function toRow(a) {
    const row = {};
    for (const [k, col] of Object.entries(COLS)) {
      let v = a[k];
      if (k === "furthest") v = Math.max(0, Math.min(5, Math.round(+v || 0)));
      else if (k === "needsUpdate") v = !!v;
      else if (DATE_FIELDS.has(k)) v = parseD(v) ? v : null;
      else v = v == null ? null : String(v).trim();
      row[col] = v;
    }
    if (!VALID_STATUS.has(row.status)) row.status = "saved";
    if (!VALID_TRACK.has(row.track)) row.track = "other";
    return row;
  }

  async function loadData() {
    try {
      const [apRes, stRes] = await Promise.all([
        sb.from("applications").select("*").order("created_at", { ascending: true }),
        sb.from("settings").select("*").maybeSingle()
      ]);
      if (apRes.error) throw apRes.error;
      if (stRes.error) throw stRes.error;
      apps = (apRes.data || []).map(fromRow);
      if (stRes.data) settings = {
        weeklyTarget: stRes.data.weekly_target || C.defaultWeeklyTarget || 8,
        checks: stRes.data.checks && typeof stRes.data.checks === "object" ? stRes.data.checks : {}
      };
      loaded = true; lastLoad = Date.now();
      $("#storeBanner").hidden = true;
      renderAll();
    } catch (err) {
      console.error(err);
      showBanner("Your applications couldn't load. Check your connection, then reload the page. If this keeps happening, your free Supabase project may be paused: open the Supabase dashboard and click Resume project.");
      loaded = true; renderAll();
    }
  }
  async function saveApplication(body, id) {
    const row = toRow(body);
    const query = id
      ? sb.from("applications").update(row).eq("id", id)
      : sb.from("applications").insert({ ...row, user_id: session.user.id });
    const { data, error } = await query.select().single();
    if (error) throw error;
    const saved = fromRow(data);
    apps = id ? apps.map(a => (a.id === id ? saved : a)) : [...apps, saved];
    renderAll();
  }
  async function deleteApplication(id) {
    const { error } = await sb.from("applications").delete().eq("id", id);
    if (error) throw error;
    apps = apps.filter(a => a.id !== id);
    renderAll();
  }
  let settingsChain = Promise.resolve();
  function saveSettings() {
    const body = { user_id: session.user.id, weekly_target: settings.weeklyTarget, checks: settings.checks || {} };
    settingsChain = settingsChain
      .then(async () => { const { error } = await sb.from("settings").upsert(body); if (error) throw error; })
      .catch(err => { console.error(err); toast("Your plan settings didn't save. Try again."); });
  }

  // ---------- rendering: header ----------
  function renderHeader() {
    const name = C.ownerName ? `${C.ownerName}'s Job Hunt` : "Job Hunt";
    document.title = name;
    document.querySelectorAll(".js-title").forEach(el => { el.textContent = name; });
    if (GOAL) {
      const goalText = `${GOAL.getDate()} ${MONTH_LONG[GOAL.getMonth()]} ${GOAL.getFullYear()}`;
      $("#goalLine").textContent = `Application tracker · goal: a job offer by ${goalText}`;
      $("#cdGoal").textContent = `days to ${GOAL.getDate()} ${MONTH_LONG[GOAL.getMonth()]}`;
    }
  }
  function renderCountdown() {
    const t = today();
    const days = Math.max(0, diff(t, GOAL));
    $("#cdDays").textContent = days;
    $("#cdWeeks").textContent = `${Math.floor(days / 7)} weeks and ${days % 7} days left`;
    const strip = $("#weekStrip");
    strip.replaceChildren();
    const thisMon = monday(t);
    const target = settings.weeklyTarget;
    for (let m = monday(PLAN_START); m <= GOAL; m = addDays(m, 7)) {
      const end = addDays(m, 7);
      const n = apps.filter(a => { const d = parseD(a.dateApplied); return d && d >= m && d < end; }).length;
      let cls = "wk", label;
      if (+m === +thisMon) { cls += " now"; label = `This week (from ${fmt(m)}): ${n} of ${target} sent`; }
      else if (m < thisMon) { cls += n >= target ? " hit" : " miss"; label = `Week of ${fmt(m)}: ${n} of ${target} sent`; }
      else label = `Week of ${fmt(m)}: ahead`;
      strip.append(h("div", { class: cls, title: label, "aria-label": label }));
    }
    const weeks = Math.round((monday(GOAL) - monday(PLAN_START)) / (7 * DAY)) + 1;
    $("#pl-h").textContent = `${weeks} weeks to an offer`;
  }

  // ---------- rendering: overview ----------
  function renderKpis() {
    const sent = apps.filter(a => furthest(a) >= 1);
    const heard = sent.filter(heardBack).length;
    const iv = sent.filter(a => furthest(a) >= 3).length;
    const off = sent.filter(a => furthest(a) >= 5).length;
    const m = monday(today()), e = addDays(m, 7);
    const wk = apps.filter(a => { const d = parseD(a.dateApplied); return d && d >= m && d < e; }).length;
    const rate = sent.length ? Math.round(heard / sent.length * 100) : 0;
    const vals = [
      [String(sent.length), "applications submitted"],
      [sent.length ? rate + "%" : "—", sent.length ? `${heard} of ${sent.length} replied` : "replies of any kind"],
      [String(iv), "reached interview stage"],
      [String(off), off === 1 ? "offer received" : "offers received"],
      [null, wk >= settings.weeklyTarget ? "Target hit for this week" : `${settings.weeklyTarget - wk} more to hit your target`]
    ];
    const tiles = $("#kpis").children;
    vals.forEach(([v, s], i) => {
      const vEl = tiles[i].querySelector(".v");
      if (i === 4) vEl.replaceChildren(String(wk), h("small", null, " / " + settings.weeklyTarget));
      else vEl.textContent = loaded ? v : "—";
      tiles[i].querySelector(".s").textContent = s;
    });
  }

  function renderWeekChart() {
    const box = $("#weekChart");
    const W = Math.max(300, Math.round(box.clientWidth || 600)), H = 220;
    const M = { l: 30, r: 12, t: 22, b: 30 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const thisMon = monday(today());
    const dated = apps.map(a => ({ a, d: parseD(a.dateApplied) })).filter(x => x.d);
    const earliest = dated.length ? Math.min(...dated.map(x => +x.d)) : +addDays(thisMon, -42);
    const start = monday(new Date(Math.min(earliest, +addDays(thisMon, -42))));
    const end = monday(GOAL);
    const weeks = [];
    for (let m = new Date(start); m <= end; m = addDays(m, 7)) weeks.push({ mon: new Date(m), items: [] });
    for (const x of dated) {
      const i = Math.round((monday(x.d) - start) / (7 * DAY));
      if (weeks[i]) weeks[i].items.push(x.a);
    }
    const target = settings.weeklyTarget;
    const maxN = Math.max(target, ...weeks.map(w => w.items.length));
    const step = maxN <= 6 ? 1 : maxN <= 12 ? 2 : 5;
    const ymax = Math.ceil((maxN + 1) / step) * step;
    const y = v => M.t + ih - (v / ymax) * ih;
    const band = iw / weeks.length;
    const bw = Math.max(3, Math.min(24, band * 0.62));
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Applications per week from ${fmt(start)} to ${fmt(end)}. Weekly target ${target}.` });

    const nowIdx = Math.round((thisMon - start) / (7 * DAY));
    if (nowIdx < weeks.length - 1) {                       // shade the weeks still ahead
      const fx = M.l + (nowIdx + 1) * band;
      svg.append(sv("rect", { x: fx, y: M.t, width: M.l + iw - fx, height: ih, fill: "var(--soft)", opacity: 0.6, rx: 4 }));
      svg.append(sv("text", { x: M.l + iw - 4, y: M.t + 12, "text-anchor": "end" }, "Ahead to goal"));
    }
    for (let v = 0; v <= ymax; v += step) {               // gridlines and y labels
      svg.append(sv("line", { x1: M.l, x2: M.l + iw, y1: y(v), y2: y(v), stroke: "var(--line)", "stroke-width": 1 }));
      svg.append(sv("text", { x: M.l - 8, y: y(v) + 3.5, "text-anchor": "end" }, v));
    }
    weeks.forEach((w, i) => {                             // month labels
      if (w.mon.getDate() <= 7) svg.append(sv("text", { x: M.l + i * band + band / 2, y: H - 10, "text-anchor": "middle" }, MON[w.mon.getMonth()]));
    });
    weeks.forEach((w, i) => {                             // bars, rounded at the top only
      const n = w.items.length;
      if (!n) return;
      const x = M.l + i * band + (band - bw) / 2, top = y(n), base = y(0), r = Math.min(4, bw / 2, base - top);
      const d = `M${x},${base} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + bw - r},${top} Q${x + bw},${top} ${x + bw},${top + r} L${x + bw},${base} Z`;
      svg.append(sv("path", { d, fill: i === nowIdx ? "var(--accent)" : "var(--blue)" }));
    });
    svg.append(sv("line", { x1: M.l, x2: M.l + iw, y1: y(target), y2: y(target), stroke: "var(--ink)", "stroke-width": 1.5, "stroke-dasharray": "5 4", opacity: 0.55 }));
    svg.append(sv("text", { x: M.l + 4, y: y(target) - 6 }, `Target ${target} a week`));
    if (nowIdx >= 0 && nowIdx < weeks.length) {
      const nx = M.l + nowIdx * band + band / 2;
      svg.append(sv("line", { x1: nx, x2: nx, y1: M.t - 6, y2: M.t + ih, stroke: "var(--accent)", "stroke-width": 1 }));
      svg.append(sv("text", { x: nx, y: M.t - 9, "text-anchor": "middle", fill: "var(--accent-ink)" }, "Now"));
    }
    const tip = h("div", { class: "tip", hidden: true });
    weeks.forEach((w, i) => {                             // hover and focus targets for the tooltip
      const hit = sv("rect", { x: M.l + i * band, y: M.t, width: band, height: ih, fill: "transparent", tabindex: 0 });
      const show = () => {
        const n = w.items.length;
        tip.replaceChildren(h("b", null, `Week of ${fmt(w.mon)}`), h("br"), `${n} ${n === 1 ? "application" : "applications"}` + (w.mon > thisMon ? " (ahead)" : ""));
        w.items.slice(0, 4).forEach(a => tip.append(h("br"), "· " + (a.company || "") + (a.role ? ", " + a.role : "")));
        if (n > 4) tip.append(h("br"), `+ ${n - 4} more`);
        tip.hidden = false;
        const bx = box.getBoundingClientRect();
        const px = (M.l + i * band + band / 2) / W * bx.width;
        tip.style.left = Math.max(0, Math.min(bx.width - tip.offsetWidth, px - tip.offsetWidth / 2)) + "px";
        tip.style.top = "0px";
      };
      const hide = () => { tip.hidden = true; };
      hit.addEventListener("pointerenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("pointerleave", hide); hit.addEventListener("blur", hide);
      svg.append(hit);
    });
    box.replaceChildren(svg, tip);
    $("#weekCaption").textContent = dated.length
      ? `Each bar is one week, Monday to Sunday. The dashed line is your target of ${target} a week. Applications without a date are left out.`
      : "Bars appear here as you log application dates. The dashed line is your weekly target.";
  }

  function renderAttention() {
    const t = today(), items = [];
    for (const a of apps) {
      if (a.needsUpdate) items.push({ a, kind: "check", tag: "Check status", why: a.checkNote || "Confirm the latest status.", prio: 1 });
      const na = parseD(a.nextActionDate);
      if (a.nextAction && na && !isClosed(a) && diff(t, na) <= 7) {
        const late = diff(t, na) < 0;
        items.push({ a, kind: late ? "overdue" : "due", tag: late ? "Overdue" : (diff(t, na) === 0 ? "Due today" : "Due " + fmt(na)), why: a.nextAction, when: +na, prio: late ? 0 : 2 });
      }
      const cl = parseD(a.closingDate);
      if (a.status === "saved" && cl && diff(t, cl) >= 0 && diff(t, cl) <= 21) items.push({ a, kind: "closing", tag: "Closes " + fmt(cl), why: "Not submitted yet.", when: +cl, prio: 1 });
      const ap = parseD(a.dateApplied);
      if (a.status === "applied" && ap && !a.needsUpdate && diff(ap, t) > 21) items.push({ a, kind: "stale", tag: "Follow up", why: `No reply in ${diff(ap, t)} days. Chase it, or mark it No response.`, prio: 3 });
    }
    items.sort((x, y) => x.prio - y.prio || (x.when || 0) - (y.when || 0));
    const ul = $("#attention");
    ul.replaceChildren();
    if (!loaded) { ul.append(h("li", { class: "empty" }, "Loading your applications…")); return; }
    if (!items.length) { ul.append(h("li", { class: "empty" }, "All clear. Nothing is overdue or waiting on you.")); return; }
    for (const it of items.slice(0, 8)) {
      ul.append(h("li", null, h("button", { type: "button", onclick: () => openEditor(it.a) },
        h("span", { class: "chip nodot k-" + it.kind }, it.tag),
        h("span", { class: "what" }, `${it.a.role || "Role"} · ${it.a.company || "Company"}`),
        h("span", { class: "why" }, it.why))));
    }
    if (items.length > 8) ul.append(h("li", { class: "empty" }, `${items.length - 8} more in the table below.`));
  }

  // ---------- rendering: applications table ----------
  function filteredApps() {
    const q = $("#q").value.trim().toLowerCase();
    const fs = $("#fStatus").value, ft = $("#fTrack").value, sort = $("#fSort").value;
    const list = apps.filter(a => {
      if (fs !== "all" && statusOf(a.status).group !== fs) return false;
      if (ft !== "all" && (a.track || "other") !== ft) return false;
      if (q && ![a.company, a.role, a.ref, a.location].some(v => (v || "").toLowerCase().includes(q))) return false;
      return true;
    });
    const key = a => +(parseD(a.dateApplied) || parseD((a.createdAt || "").slice(0, 10)) || 0);
    if (sort === "recent") list.sort((x, y) => key(y) - key(x));
    if (sort === "closing") list.sort((x, y) => (+(parseD(x.closingDate) || 9e15)) - (+(parseD(y.closingDate) || 9e15)));
    if (sort === "stage") list.sort((x, y) => furthest(y) - furthest(x) || key(y) - key(x));
    return list;
  }
  function renderTable() {
    const tb = $("#rows");
    tb.replaceChildren();
    if (!loaded) { tb.append(h("tr", null, h("td", { colspan: 6, class: "empty" }, "Loading your applications…"))); $("#countLbl").textContent = ""; return; }
    const list = filteredApps();
    $("#countLbl").textContent = `${list.length} of ${apps.length}`;
    if (!apps.length) { tb.append(h("tr", null, h("td", { colspan: 6, class: "empty" }, "No applications yet. Use Add application to log your first one, or Import applications under Your data."))); return; }
    if (!list.length) { tb.append(h("tr", null, h("td", { colspan: 6, class: "empty" }, "Nothing matches these filters."))); return; }
    const t = today();
    for (const a of list) {
      const st = statusOf(a.status);
      const cl = parseD(a.closingDate), na = parseD(a.nextActionDate);
      const tags = [];
      if (a.needsUpdate) tags.push(h("span", { class: "chip nodot k-check" }, "Check status"));
      if (a.feedback) tags.push(h("span", { class: "chip nodot" }, "Feedback"));
      if (st.stage === null && furthest(a) >= 2) tags.push(h("span", { class: "chip nodot" }, "Reached " + STAGES[furthest(a)].toLowerCase()));
      tb.append(h("tr", { tabindex: 0, onclick: () => openEditor(a), onkeydown: e => { if (e.key === "Enter") openEditor(a); } },
        h("td", null,
          h("span", { class: "role" }, a.role || "Untitled role"),
          h("span", { class: "co" }, [a.company, a.location].filter(Boolean).join(" · ")),
          a.ref ? h("span", { class: "ref" }, " · " + a.ref) : null,
          tags.length ? h("div", { class: "tags" }, tags) : null),
        h("td", null, trackName(a.track)),
        h("td", null, h("span", { class: "chip s-" + st.id }, st.label)),
        h("td", { class: "date" }, fmt(parseD(a.dateApplied))),
        h("td", { class: "date" }, cl ? fmt(cl) + (a.status === "saved" && diff(t, cl) >= 0 ? ` (${diff(t, cl)}d)` : "") : "—"),
        h("td", null, a.nextAction ? h("span", null, a.nextAction, na ? h("span", { class: "co" }, " · " + fmt(na)) : null) : h("span", { class: "co" }, "—"))
      ));
    }
  }

  // ---------- rendering: feedback and trends ----------
  function renderFunnel() {
    const box = $("#funnel");
    box.replaceChildren();
    const sent = apps.filter(a => furthest(a) >= 1);
    if (!sent.length) { box.append(h("p", { class: "empty" }, "Your funnel fills in once you log applications as Applied.")); return; }
    const steps = [["Sent", sent.length], ["Heard back", sent.filter(heardBack).length], ["Interview", sent.filter(a => furthest(a) >= 3).length], ["Offer", sent.filter(a => furthest(a) >= 5).length]];
    for (const [lbl, n] of steps) {
      const pct = Math.round(n / sent.length * 100);
      const fill = h("div", { class: "bar-fill" });
      fill.style.width = (n ? Math.max(2, pct) : 0) + "%";
      box.append(h("div", { class: "bar-row" }, h("span", { class: "lbl" }, lbl),
        h("div", { class: "bar-track", role: "img", "aria-label": `${lbl}: ${n}, ${pct}% of sent` }, fill),
        h("span", { class: "num" }, `${n} · ${pct}%`)));
    }
  }
  function renderDrop() {
    const t = today();
    const closed = apps.filter(a => ["rejected", "noresponse", "withdrawn"].includes(a.status));
    const stale = apps.filter(a => a.status === "applied" && !a.needsUpdate && parseD(a.dateApplied) && diff(parseD(a.dateApplied), t) > 21);
    const cv = closed.filter(a => furthest(a) <= 1).length + stale.length;
    const tests = closed.filter(a => furthest(a) === 2).length;
    const iv = closed.filter(a => furthest(a) >= 3).length;
    const max = Math.max(cv, tests, iv);
    const box = $("#drop");
    box.replaceChildren();
    for (const [n, l] of [[cv, "at CV screen or no reply"], [tests, "after tests"], [iv, "after interview"]]) {
      box.append(h("div", { class: max > 0 && n === max ? "top-stop" : "" }, h("span", { class: "n" }, n), h("span", { class: "l" }, l)));
    }
    let msg;
    if (cv + tests + iv < 3) msg = "Too early to call. Once three or more applications close, this shows where you tend to drop out. Mark rejections and silent applications as you hear.";
    else if (max === cv) msg = "Most applications stop before any test or interview. Sharpen the CV match: mirror the advert's keywords, lead with your most relevant project, and use the right CV for the track.";
    else if (max === tests) msg = "You pass the CV screen but stop at tests. Practise numerical, verbal and situational judgement tests for 20 minutes a day.";
    else msg = "You reach interviews but are not converting. Rehearse STAR answers out loud, record a mock video interview, and ask every employer for feedback.";
    $("#verdict").textContent = msg;
  }
  function renderByTrack() {
    const box = $("#byTrack");
    box.replaceChildren();
    const rows = TRACKS.map(tk => {
      const list = apps.filter(a => (a.track || "other") === tk.id && furthest(a) >= 1);
      return { tk, sent: list.length, heard: list.filter(heardBack).length, iv: list.filter(a => furthest(a) >= 3).length };
    }).filter(r => r.sent).sort((a, b) => b.sent - a.sent);
    if (!rows.length) { box.append(h("p", { class: "empty" }, "Each track gets a bar once you send an application in it.")); return; }
    const max = Math.max(...rows.map(r => r.sent));
    for (const r of rows) {
      const s = h("div", { class: "bar-fill sent" }); s.style.width = (r.sent / max * 100) + "%";
      const hb = h("div", { class: "bar-fill heard" }); hb.style.width = (r.heard / max * 100) + "%";
      box.append(h("div", { class: "bar-row" }, h("span", { class: "lbl" }, r.tk.name),
        h("div", { class: "bar-track", role: "img", "aria-label": `${r.tk.name}: ${r.sent} sent, ${r.heard} heard back` }, s, hb),
        h("span", { class: "num" }, `${r.heard}/${r.sent} replied` + (r.iv ? ` · ${r.iv} int.` : ""))));
    }
  }
  function renderFeedback() {
    const ul = $("#fbList");
    ul.replaceChildren();
    const list = apps.filter(a => (a.feedback || "").trim()).sort((x, y) => (y.updatedAt || "").localeCompare(x.updatedAt || ""));
    if (!list.length) { ul.append(h("li", { class: "empty" }, "No feedback logged yet. When an employer tells you why, paste it into that application.")); return; }
    for (const a of list.slice(0, 8)) {
      ul.append(h("li", null, h("span", { class: "small muted" }, `${a.role} · ${a.company} · ${statusOf(a.status).label}`), h("span", { class: "q" }, a.feedback)));
    }
  }

  // ---------- rendering: tracks and plan ----------
  function renderTracks() {
    const box = $("#trackCards");
    box.replaceChildren();
    for (const tk of TRACKS.filter(t => t.fit)) {
      const list = apps.filter(a => (a.track || "other") === tk.id);
      const sent = list.filter(a => furthest(a) >= 1);
      const heard = sent.filter(heardBack).length;
      const todo = list.filter(a => a.status === "saved").length;
      box.append(h("article", { class: "track" + (tk.best ? " best" : "") },
        h("div", { class: "meta" }, tk.best ? h("span", { class: "chip nodot s-interview" }, "Best bet before your goal") : null, h("span", { class: "chip nodot" }, tk.pace)),
        h("h3", null, tk.name),
        h("p", { class: "fit" }, tk.fit),
        h("div", null, h("p", { class: "eyebrow sub" }, "Search for"), h("ul", null, tk.titles.map(x => h("li", null, x)))),
        h("p", { class: "small" }, h("span", { class: "muted" }, "Use: "), tk.cv),
        h("p", { class: "live" }, loaded ? `${sent.length} sent · ${heard} heard back` + (todo ? ` · ${todo} to apply` : "") : "—")));
    }
  }
  function renderPlan() {
    const box = $("#phases");
    box.replaceChildren();
    const t = today();
    for (const p of C.phases) {
      const s = parseD(p.start), e = parseD(p.end);
      const state = t > e ? "past" : (t >= s ? "current" : "");
      const tasks = p.tasks.map((task, i) => {
        const key = p.id + "-" + i;
        const cb = h("input", { type: "checkbox", id: "chk-" + key });
        cb.checked = !!settings.checks[key];
        cb.addEventListener("change", () => { settings.checks = { ...settings.checks, [key]: cb.checked }; saveSettings(); renderPlan(); });
        return h("li", null, h("label", { for: "chk-" + key }, cb, h("span", null, task)));
      });
      const done = p.tasks.filter((_, i) => settings.checks[p.id + "-" + i]).length;
      box.append(h("article", { class: "phase " + state },
        h("div", { class: "meta" }, h("span", { class: "dates" }, `${fmt(s)} to ${fmt(e)}`),
          state === "current" ? h("span", { class: "chip nodot s-interview" }, "Now") : h("span", { class: "count" }, `${done}/${p.tasks.length}`)),
        h("h3", null, p.name),
        h("p", { class: "goal muted" }, p.goal),
        h("ul", { class: "checks" }, tasks)));
    }
    const tgt = $("#target");
    if (document.activeElement !== tgt) tgt.value = settings.weeklyTarget;
  }

  function renderAll() {
    renderHeader(); renderCountdown(); renderKpis(); renderWeekChart(); renderAttention(); renderTable();
    renderFunnel(); renderDrop(); renderByTrack(); renderFeedback(); renderTracks(); renderPlan();
    $("#whoLbl").textContent = session ? "Signed in as " + session.user.email : "";
  }
  function showBanner(text) { const b = $("#storeBanner"); b.textContent = text; b.hidden = false; }

  // ---------- editor ----------
  function fillSelect(sel, opts) { sel.replaceChildren(...opts.map(([v, l]) => h("option", { value: v }, l))); }
  function openEditor(a) {
    editing = a || null;
    $("#edTitle").textContent = a ? (a.role || "Application") : "Add application";
    $("#edEyebrow").textContent = a ? (a.company || "Application") : "New application";
    const chk = $("#edCheck");
    if (a && a.needsUpdate) { chk.hidden = false; chk.textContent = (a.checkNote || "Confirm the latest status.") + " Saving clears this reminder."; }
    else chk.hidden = true;
    const v = a || { track: "data", status: "saved", furthest: 0, cv: "" };
    $("#f-company").value = v.company || "";
    $("#f-role").value = v.role || "";
    $("#f-track").value = VALID_TRACK.has(v.track) ? v.track : "other";
    $("#f-location").value = v.location || "";
    $("#f-status").value = v.status || "saved";
    $("#f-furthest").value = String(furthest(v));
    $("#f-applied").value = v.dateApplied || "";
    $("#f-closing").value = v.closingDate || "";
    $("#f-source").value = v.source || "";
    $("#f-cv").value = CVS.includes(v.cv || "") ? (v.cv || "") : "Other";
    $("#f-ref").value = v.ref || "";
    $("#f-salary").value = v.salary || "";
    $("#f-url").value = v.url || "";
    $("#f-next").value = v.nextAction || "";
    $("#f-nextdate").value = v.nextActionDate || "";
    $("#f-feedback").value = v.feedback || "";
    $("#f-notes").value = v.notes || "";
    const del = $("#edDelete");
    del.hidden = !a; del.classList.remove("armed"); del.textContent = "Delete";
    $("#editor").hidden = false;
    setTimeout(() => $("#f-company").focus(), 30);
  }
  function closeEditor() { $("#editor").hidden = true; editing = null; }
  async function saveEditor() {
    const company = $("#f-company").value.trim(), role = $("#f-role").value.trim();
    if (!company || !role) { toast("Add a company and a role first."); (company ? $("#f-role") : $("#f-company")).focus(); return; }
    const status = $("#f-status").value;
    let fur = +$("#f-furthest").value;
    const stg = statusOf(status).stage;
    if (stg !== null) fur = Math.max(fur, stg);
    if (["rejected", "noresponse"].includes(status)) fur = Math.max(fur, 1);
    let applied = $("#f-applied").value;
    if (!applied && fur >= 1 && !editing) applied = iso(today());
    const body = {
      company, role, track: $("#f-track").value, location: $("#f-location").value, status, furthest: fur,
      dateApplied: applied, closingDate: $("#f-closing").value, source: $("#f-source").value, cv: $("#f-cv").value,
      ref: $("#f-ref").value, salary: $("#f-salary").value, url: $("#f-url").value,
      nextAction: $("#f-next").value, nextActionDate: $("#f-nextdate").value,
      feedback: $("#f-feedback").value, notes: $("#f-notes").value, needsUpdate: false, checkNote: ""
    };
    const btn = $("#edSave");
    btn.disabled = true;
    try {
      const wasEditing = !!editing;
      await saveApplication(body, editing && editing.id);
      closeEditor();
      toast(wasEditing ? "Application updated" : "Application added");
    } catch (err) {
      console.error(err);
      toast("That didn't save. Check your connection and try again.");
    } finally { btn.disabled = false; }
  }
  async function deleteEditing() {
    const del = $("#edDelete");
    if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Tap again to delete"; return; }
    try { await deleteApplication(editing.id); closeEditor(); toast("Application deleted"); }
    catch (err) { console.error(err); toast("That didn't delete. Try again."); }
  }

  // ---------- import, export and summary ----------
  function exportBackup() {
    const strip = ({ id, createdAt, updatedAt, ...rest }) => rest;
    const data = { app: "job-hunt-tracker", version: 1, exportedAt: new Date().toISOString(), settings, applications: apps.map(strip) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: `job-hunt-backup-${iso(today())}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Backup downloaded");
  }
  async function importFile(file) {
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch { toast("That file isn't a valid backup."); return; }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.applications) ? parsed.applications : null;
    if (!list) { toast("No applications found in that file."); return; }
    const seen = new Set(apps.map(a => (a.company + "|" + a.role).toLowerCase()));
    const rows = [];
    let skipped = 0;
    for (const item of list) {
      if (!item || typeof item !== "object" || !item.company || !item.role) { skipped++; continue; }
      const k = (item.company + "|" + item.role).toLowerCase();
      if (seen.has(k)) { skipped++; continue; }
      seen.add(k);
      rows.push({ ...toRow(item), user_id: session.user.id });
    }
    try {
      if (rows.length) {
        const { data, error } = await sb.from("applications").insert(rows).select();
        if (error) throw error;
        apps = [...apps, ...data.map(fromRow)];
      }
      if (parsed.settings && Number.isFinite(+parsed.settings.weeklyTarget)) {
        settings = { weeklyTarget: Math.max(1, Math.min(30, Math.round(+parsed.settings.weeklyTarget))), checks: { ...(parsed.settings.checks || {}), ...settings.checks } };
        saveSettings();
      }
      renderAll();
      toast(`Imported ${rows.length}` + (skipped ? `, skipped ${skipped} already here or incomplete` : ""));
    } catch (err) {
      console.error(err);
      toast("The import didn't finish. Nothing was added. Try again.");
    }
  }
  function buildSummary() {
    const sent = apps.filter(a => furthest(a) >= 1);
    const lines = [
      `Job search summary (${fmt(today())} ${today().getFullYear()})`,
      `Goal: a job offer by ${fmt(GOAL)} ${GOAL.getFullYear()}`,
      `Sent: ${sent.length} · Heard back: ${sent.filter(heardBack).length} · Interviews: ${sent.filter(a => furthest(a) >= 3).length} · Offers: ${sent.filter(a => furthest(a) >= 5).length}`,
      "",
      "Applications:"
    ];
    for (const a of [...apps].sort((x, y) => (y.dateApplied || "").localeCompare(x.dateApplied || ""))) {
      lines.push(`- ${a.role} at ${a.company} (${trackName(a.track)}): ${statusOf(a.status).label}, furthest stage ${STAGES[furthest(a)]}` +
        (a.dateApplied ? `, applied ${a.dateApplied}` : "") + (a.feedback ? `. Feedback: ${a.feedback.replace(/\s+/g, " ")}` : ""));
    }
    return lines.join("\n");
  }
  async function copySummary() {
    const text = buildSummary();
    try { await navigator.clipboard.writeText(text); toast("Summary copied"); }
    catch {
      const ta = h("textarea", { class: "field" }); ta.value = text;
      document.body.append(ta); ta.select();
      const ok = document.execCommand && document.execCommand("copy");
      ta.remove();
      toast(ok ? "Summary copied" : "Couldn't copy. Your browser blocked it.");
    }
  }

  // ---------- sign-in ----------
  function showView(name) {
    for (const v of ["setupView", "signinView", "recoverView", "appView"]) $("#" + v).hidden = v !== name;
  }
  function setMsg(el, text, kind) { el.textContent = text; el.className = "msg" + (kind ? " " + kind : ""); el.hidden = !text; }
  async function signIn(e) {
    e.preventDefault();
    const email = $("#si-email").value.trim(), password = $("#si-password").value;
    const msg = $("#si-msg");
    if (!email || !password) { setMsg(msg, "Enter your email and password.", "err"); return; }
    $("#si-submit").disabled = true;
    setMsg(msg, "Signing in…");
    const { error } = await sb.auth.signInWithPassword({ email, password });
    $("#si-submit").disabled = false;
    if (error) setMsg(msg, error.message === "Invalid login credentials" ? "That email and password don't match." : error.message, "err");
    else setMsg(msg, "");
  }
  async function forgotPassword() {
    const email = $("#si-email").value.trim();
    const msg = $("#si-msg");
    if (!email) { setMsg(msg, "Type your email above first, then tap Forgot your password again.", "err"); return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    setMsg(msg, error ? error.message : "If that email has an account, a reset link is on its way.", error ? "err" : "ok");
  }
  async function setNewPassword(e) {
    e.preventDefault();
    const password = $("#rc-password").value;
    const msg = $("#rc-msg");
    if (password.length < 8) { setMsg(msg, "Use at least 8 characters.", "err"); return; }
    const { error } = await sb.auth.updateUser({ password });
    if (error) { setMsg(msg, error.message, "err"); return; }
    setMsg(msg, "");
    recovering = false;
    showView("appView");
    toast("Password updated");
    if (!loaded) loadData();
  }
  async function signOut() {
    await sb.auth.signOut();
    toast("Signed out");
  }

  // ---------- start-up ----------
  function wire() {
    fillSelect($("#f-track"), TRACKS.map(t => [t.id, t.name]));
    fillSelect($("#f-status"), STATUSES.map(s => [s.id, s.label]));
    fillSelect($("#f-furthest"), STAGES.map((s, i) => [String(i), s]));
    fillSelect($("#f-cv"), CVS.map(c => [c, c || "Not set"]));
    $("#fTrack").append(...TRACKS.map(t => h("option", { value: t.id }, t.name)));
    $("#f-status").addEventListener("change", () => {
      const stg = statusOf($("#f-status").value).stage;
      if (stg !== null && stg > +$("#f-furthest").value) $("#f-furthest").value = String(stg);
      if (stg !== null && stg >= 1 && !$("#f-applied").value) $("#f-applied").value = iso(today());
    });
    ["q", "fStatus", "fTrack", "fSort"].forEach(id => $("#" + id).addEventListener(id === "q" ? "input" : "change", renderTable));
    $("#addTop").addEventListener("click", () => openEditor(null));
    $("#addMain").addEventListener("click", () => openEditor(null));
    $("#edClose").addEventListener("click", closeEditor);
    $("#edCancel").addEventListener("click", closeEditor);
    $("#edSave").addEventListener("click", saveEditor);
    $("#edDelete").addEventListener("click", deleteEditing);
    $("#edForm").addEventListener("submit", e => { e.preventDefault(); saveEditor(); });
    $("#editor").addEventListener("click", e => { if (e.target.id === "editor") closeEditor(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#editor").hidden) closeEditor(); });
    $("#copySummary").addEventListener("click", copySummary);
    $("#exportBtn").addEventListener("click", exportBackup);
    $("#importBtn").addEventListener("click", () => $("#importFile").click());
    $("#importFile").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); });
    $("#signOut").addEventListener("click", signOut);
    $("#signinForm").addEventListener("submit", signIn);
    $("#si-forgot").addEventListener("click", forgotPassword);
    $("#recoverForm").addEventListener("submit", setNewPassword);
    let tgtTimer;
    $("#target").addEventListener("input", () => {
      const n = Math.round(+$("#target").value);
      if (!Number.isFinite(n) || n < 1 || n > 30) return;
      settings.weeklyTarget = n;
      renderCountdown(); renderKpis(); renderWeekChart();
      clearTimeout(tgtTimer); tgtTimer = setTimeout(saveSettings, 700);
    });
    let rsTimer;
    if (window.ResizeObserver) new ResizeObserver(() => { clearTimeout(rsTimer); rsTimer = setTimeout(renderWeekChart, 80); }).observe($("#weekChart"));
    // Pick up changes made on another device when you come back to this tab.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && session && Date.now() - lastLoad > 30000) loadData();
    });
  }

  function start() {
    renderHeader();
    const configured = /^https:\/\/.+/.test(CFG.supabaseUrl || "") && CFG.supabaseKey && !/PASTE_/.test(CFG.supabaseKey);
    if (!configured || !window.supabase) { showView("setupView"); return; }
    wire();
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
    sb.auth.onAuthStateChange((event, s) => {
      session = s;
      if (event === "PASSWORD_RECOVERY") { recovering = true; showView("recoverView"); return; }
      if (!s) { recovering = false; apps = []; loaded = false; showView("signinView"); return; }
      if (recovering) return;
      showView("appView");
      // Load outside the auth callback, as Supabase recommends.
      if (!loaded && (event === "INITIAL_SESSION" || event === "SIGNED_IN")) setTimeout(loadData, 0);
      else renderAll();
    });
  }

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(err => console.warn("Offline mode unavailable", err)));
  }
  start();
})();
