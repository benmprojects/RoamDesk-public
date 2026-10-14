// The inbox, routines and health-check dialogs. The helper owns all of the data; this only shows it and sends changes.
import { $, clear, h } from "./dom.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const when = (ts) => new Date(ts).toLocaleString("en-AU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function describeSchedule(s) {
  const t = s.time;
  if (s.kind === "daily") return `Every day at ${t}`;
  if (s.kind === "weekdays") return `Weekdays at ${t}`;
  if (s.kind === "weekly") return `Every ${DAYS[s.day] ?? "week"} at ${t}`;
  const [y, m, d] = String(s.date ?? "").split("-");
  return `Once, ${d}/${m}/${y} at ${t}`;
}

export function initExtras({ state, link, toast }) {
  const send = (type, payload = {}) => {
    if (!link.send(type, payload)) toast("Not connected to the PC.");
  };

  // ---- inbox
  const inboxBtn = $("#inboxBtn");
  const inboxList = $("#inboxList");
  function renderInbox() {
    const { items, unread } = state.inbox;
    inboxBtn.textContent = unread ? `Inbox (${unread})` : "Inbox";
    inboxBtn.classList.toggle("has-unread", unread > 0);
    clear(inboxList);
    if (!items.length) inboxList.append(h("li", { class: "muted" }, "Nothing yet. Reconnects, routine results and updates show up here."));
    for (const i of items) {
      inboxList.append(h("li", { class: `inbox-item ${i.kind}${i.read ? "" : " unread"}` }, h("div", { class: "row" }, h("b", { text: i.title }), h("span", { class: "muted small", text: when(i.ts) })), h("div", { class: "inbox-text", text: i.text })));
    }
  }
  inboxBtn.addEventListener("click", () => {
    $("#inboxDlg").showModal();
    if (state.inbox.unread) send("inbox.read");
  });
  $("#inboxClear").addEventListener("click", () => {
    if (confirm("Clear the whole inbox?")) send("inbox.clear");
  });

  // ---- routines
  const routineList = $("#routineList");
  const form = {
    id: null,
    name: h("input", { type: "text", maxlength: "80", placeholder: "Name, e.g. Tenders closing this week", "aria-label": "Routine name" }),
    prompt: h("textarea", { rows: "3", maxlength: "2000", placeholder: "What should Claude look up? It can read and search only; it can't send, change or run anything.", "aria-label": "What to do" }),
    kind: h("select", { "aria-label": "How often" }, h("option", { value: "daily" }, "Every day"), h("option", { value: "weekdays" }, "Weekdays"), h("option", { value: "weekly" }, "Every week"), h("option", { value: "once" }, "Once")),
    time: h("input", { type: "time", value: "07:00", "aria-label": "Time" }),
    day: h("select", { "aria-label": "Day" }, DAYS.map((d, i) => h("option", { value: String(i) }, d))),
    date: h("input", { type: "date", "aria-label": "Date" }),
    enabled: h("input", { type: "checkbox", checked: true }),
  };
  const saveBtn = h("button", { type: "button", class: "primary" }, "Save routine");
  const resetBtn = h("button", { type: "button" }, "New");
  function syncKind() {
    form.day.hidden = form.kind.value !== "weekly";
    form.date.hidden = form.kind.value !== "once";
  }
  function fill(r) {
    form.id = r?.id ?? null;
    form.name.value = r?.name ?? "";
    form.prompt.value = r?.prompt ?? "";
    form.kind.value = r?.schedule.kind ?? "daily";
    form.time.value = r?.schedule.time ?? "07:00";
    form.day.value = String(r?.schedule.day ?? 1);
    form.date.value = r?.schedule.date ?? "";
    form.enabled.checked = r ? r.enabled : true;
    saveBtn.textContent = r ? "Save changes" : "Save routine";
    syncKind();
  }
  form.kind.addEventListener("change", syncKind);
  resetBtn.addEventListener("click", () => fill(null));
  saveBtn.addEventListener("click", () => {
    const kind = form.kind.value;
    const schedule = { kind, time: form.time.value, ...(kind === "weekly" ? { day: Number(form.day.value) } : {}), ...(kind === "once" ? { date: form.date.value } : {}) };
    if (!form.name.value.trim() || !form.prompt.value.trim()) return toast("Give it a name and something to do.");
    send("routine.save", { ...(form.id ? { id: form.id } : {}), name: form.name.value, prompt: form.prompt.value, schedule, enabled: form.enabled.checked });
    fill(null);
  });
  $("#routineForm").append(
    form.name, form.prompt,
    h("div", { class: "row wrap" }, form.kind, form.day, form.date, form.time),
    h("label", { class: "check" }, form.enabled, " On"),
    h("div", { class: "row end" }, resetBtn, saveBtn),
  );
  syncKind();

  function renderRoutines() {
    clear(routineList);
    if (!state.routines.length) routineList.append(h("li", { class: "muted" }, "No routines yet."));
    for (const r of state.routines) {
      const status = r.lastStatus === "running" ? "Running now…" : r.lastRunAt ? `Last run ${when(r.lastRunAt)}${r.lastStatus === "failed" ? " (didn't finish)" : ""}` : "Hasn't run yet";
      const next = r.enabled && r.nextRunAt ? `Next ${when(r.nextRunAt)}` : "Off";
      routineList.append(
        h("li", { class: "routine" },
          h("div", { class: "grow" }, h("b", { text: r.name }), h("div", { class: "muted small", text: `${describeSchedule(r.schedule)} · ${next}` }), h("div", { class: "muted small", text: status })),
          h("div", { class: "row wrap" },
            h("button", { type: "button", onclick: () => send("routine.run", { id: r.id }) }, "Run now"),
            h("button", { type: "button", onclick: () => fill(r) }, "Edit"),
            h("button", { type: "button", class: "danger", onclick: () => confirm(`Delete "${r.name}"?`) && send("routine.delete", { id: r.id }) }, "Delete"))),
      );
    }
  }
  $("#routinesBtn").addEventListener("click", () => {
    fill(null);
    $("#routinesDlg").showModal();
  });

  // ---- health check
  const doctorList = $("#doctorList");
  const doctorBtn = $("#doctorBtn");
  function renderDoctor() {
    clear(doctorList);
    const d = state.doctor;
    if (!d) return;
    doctorBtn.textContent = "Check everything again";
    doctorBtn.disabled = false;
    for (const c of d.checks) {
      doctorList.append(h("li", { class: "doctor-item" }, h("span", { class: `dot ${c.status === "ok" ? "ok" : c.status === "warn" ? "wait" : "bad"}` }), h("div", { class: "grow" }, h("b", { text: c.name }), h("div", { class: "small", text: c.detail }), c.fix && h("div", { class: "muted small", text: `Fix: ${c.fix}` }))));
    }
  }
  doctorBtn.addEventListener("click", () => {
    doctorBtn.disabled = true;
    doctorBtn.textContent = "Checking…";
    send("doctor.run");
    setTimeout(() => {
      doctorBtn.disabled = false;
      if (doctorBtn.textContent === "Checking…") doctorBtn.textContent = "Check everything";
    }, 90_000);
  });

  return {
    render() {
      renderInbox();
      renderRoutines();
      renderDoctor();
    },
  };
}
