import {markdown} from "/markdown.js";

const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1)).get("access");
if (fragment) {
  sessionStorage.setItem("adf-access", fragment);
  history.replaceState(null, "", "/");
}
const token = sessionStorage.getItem("adf-access");
const names = {coordinator: "Coordinator", developer: "Developer"};
const labels = {running: "応答中", idle: "受付中", waiting: "待機中", quota: "利用枠待ち",
  paused: "停止中", interrupted: "中断", draining: "停止処理中", stopping: "即時停止中"};
let role = "coordinator", page = "work", state = null, messages = new Map(), views = new Map();
let selectedIssue = null;
let policiesLoaded = false;
let polling = false, chatRevision = 0, hasOlder = false, modeLoaded = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api(action, args = {}) {
  if (!token) throw Error("GUI を起動した端末の URL で接続してください。");
  const response = await fetch("/api", {
    method: "POST",
    headers: {"Content-Type": "application/json", Authorization: "Bearer " + token},
    body: JSON.stringify({action, args}),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw Error(data.error || "監督との接続を確認してください。");
  return data.value;
}

function notice(text = "") {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}

function action(label, handler) {
  const node = element("button", label);
  node.type = "button";
  node.addEventListener("click", () => execute(handler, node));
  return node;
}

async function execute(handler, button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  notice();
  try {
    await handler();
  } catch (error) {
    notice(error.message);
  } finally {
    if (button) button.disabled = false;
    await refresh();
  }
}

function form(id, handler) {
  const node = $(id);
  node.addEventListener("submit", event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(node));
    execute(() => handler(values, node), node.querySelector("button[type=submit]"));
  });
}

function replace(id, value, render) {
  const key = JSON.stringify(value);
  if (views.get(id) === key) return;
  views.set(id, key);
  $(id).replaceChildren(...render(value));
}

function showPage(target) {
  page = target;
  document.querySelectorAll(".page").forEach(section => {section.hidden = section.id !== page;});
  document.querySelectorAll("nav button").forEach(button => {
    if (button.dataset.page === page) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  void refresh();
}

function chooseRole(value) {
  if (role !== value) {
    role = value;
    chatRevision += 1;
    messages = new Map();
    hasOlder = false;
    views.delete("conversation");
    $("conversation").replaceChildren();
    $("message").value = "";
  }
  showPage("work");
}

function textDetail(value) {
  if (typeof value !== "string") return JSON.stringify(value);
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch {
    return value;
  }
}

function renderStatus() {
  const connected = state?.running !== false && !!state;
  const sessions = state?.sessions || [];
  const roles = state?.roles || [];
  const active = sessions.find(item => item.role === role);
  const developer = sessions.find(item => item.role === "developer");
  const run = state?.research_runs?.find(item => item.session === developer?.id);
  const github = state?.github_runs?.find(item => item.session === developer?.id);
  const status = active?.state;
  const canSend = connected && (!status || ["idle", "paused", "interrupted"].includes(status) ||
    (status === "running" && active.turn));
  const developerResearch = role === "developer" && run && !["completed", "blocked"].includes(run.state);
  $("project").textContent = state?.projects?.[0]?.name || "研究コンソール";
  $("connection").textContent = connected ? "監督に接続" : "監督停止";
  $("mission").textContent = state?.mission || "Mission は設定画面で登録できます。";
  $("current").textContent = github ? `Issue #${github.issue} · ${github.phase}` : (run?.state || "");
  $("chat-role").textContent = names[role] || role;
  const last = [...(state?.recent || [])].reverse().find(item => item.role === role &&
    ["error", "paused", "stop", "recovered", "quota", "research_wait", "tracker_pending", "github_pause", "discovery_finished"].includes(item.kind));
  $("role-state").textContent = (labels[status] || "未起動") + (last ? " · " + textDetail(last.detail) : "");
  $("prompt").querySelector("button").disabled = !canSend || (!!developerResearch && status !== "running");
  $("resume").disabled = !connected || !["paused", "interrupted", "quota"].includes(status) ||
    (role === "developer" && run && ["completed", "blocked", "discovering"].includes(run.state));
  $("resume-options").hidden = !developerResearch || $("resume").disabled;
  for (const id of ["stop", "interrupt"]) $(id).disabled = !connected || !active;
  $("open-plan").disabled = !connected || !state.mission?.trim();
  $("shutdown").disabled = !connected;
  const busy = sessions.some(row => ["running", "idle", "waiting", "draining", "stopping", "quota"].includes(row.state));
  for (const id of ["backup", "prepare-update"]) $(id).disabled = !connected || busy;
  replace("roles", roles.map(item => [item.name, sessions.find(row => row.role === item.name)?.state, role]), list =>
    list.map(([name, statusName, selected]) => {
      const button = element("button", undefined);
      button.setAttribute("aria-pressed", name === selected);
      button.append(element("span", names[name] || name), element("small", labels[statusName] || "未起動"));
      button.onclick = () => chooseRole(name);
      return button;
    }));
  if (!modeLoaded && state?.research_preset) {
    const fields = $("mode").elements;
    fields.name.value = state.research_preset.name;
    fields.tokens.value = state.research_preset.tokens ?? "";
    fields.empty_queue.value = state.research_preset.empty_queue || "";
    fields.discovery_issue.value = state.research_preset.discovery_issue || "ask";
    modeLoaded = true;
  }
  if (!policiesLoaded && connected && state.tracker_policy) {
    for (const [kind, level] of Object.entries(state.tracker_policy)) {
      const field = $("policies").elements.namedItem(kind);
      if (field) field.value = level;
    }
    policiesLoaded = true;
  }
  if (page === "issues") renderOperations();
  if (page === "experiments") renderJobs();
  if (page === "history") renderEvents();
}

function renderMessages(preserve = false) {
  const box = $("messages");
  const previousHeight = box.scrollHeight, previousTop = box.scrollTop;
  const nearEnd = previousHeight - previousTop - box.clientHeight < 65;
  $("older").hidden = !hasOlder;
  replace("conversation", [...messages.values()].sort((a, b) => a.id - b.id), list => list.map(row => {
    const bubble = element("article", undefined, "bubble " + row.speaker);
    bubble.append(element("header", row.speaker === "human" ? "人間" : (names[role] || role)), markdown(row.text));
    return bubble;
  }));
  if (preserve) box.scrollTop = previousTop + box.scrollHeight - previousHeight;
  else if (nearEnd) box.scrollTop = box.scrollHeight;
  else box.scrollTop = previousTop;
}

async function refresh() {
  if (polling) return;
  polling = true;
  try {
    state = await api("status");
    if (state.running !== false) {
      state.recent = await api("history");
      if (page === "work") {
        const revision = chatRevision;
        const rows = await api("conversation", {role});
        if (revision === chatRevision) {
          if (!messages.size) hasOlder = rows.length === 40;
          for (const row of rows) messages.set(row.id, row);
          renderMessages();
        }
      }
    }
    renderStatus();
  } catch (error) {
    state = {running: false};
    renderStatus();
    $("connection").textContent = "切断";
    notice(error.message);
  } finally {
    polling = false;
  }
}

function renderOperations() {
  replace("operations", state?.tracker_operations || [], list => list.map(row => {
    const card = element("article", undefined, "panel stack");
    const status = {pending: "承認待ち", sending: "送信中・結果不明", expired: "失効",
      confirmed: "確認済み", declined: "却下", unapplied: "未反映"};
    card.append(element("h3", `${row.kind} · ${status[row.state] || row.state}`),
      element("p", `${row.repository} · ${row.actor}`),
      element("pre", JSON.stringify(JSON.parse(row.payload), null, 2)));
    const buttons = element("div", undefined, "actions");
    const reconcile = async args => {
      const result = await api("tracker-reconcile", {operation: row.id, ...args});
      notice("GitHub の照合結果 " + JSON.stringify(result));
    };
    if (row.state === "pending") {
      buttons.append(action("承認して GitHub に送信", async () => {
        if (confirm(`${row.repository} にこの操作を送信しますか？`)) {
          await api("tracker-review", {operation: row.id, approve: true});
        }
      }), action("却下", () => api("tracker-review", {operation: row.id, approve: false})));
    }
    if (row.state === "sending") {
      buttons.append(action("GitHub で照合", () => reconcile({})));
      if (row.kind === "checklist") {
        buttons.append(action("外部編集後の状態を確認", () => reconcile({accept_external_edit: true})),
          action("未反映を確認", () => reconcile({confirm_unapplied: true})));
      }
    }
    card.append(buttons);
    return card;
  }));
}

function output(title, ...children) {
  $("output").hidden = false;
  $("output").replaceChildren(element("h2", title), ...children);
}

function renderJobs() {
  replace("jobs", state?.jobs || [], list => list.map(row => {
    const card = element("article", undefined, "panel stack");
    const buttons = element("div", undefined, "actions");
    buttons.append(action("ログ", async () => output("実験ログ", element("pre", await api("log", {job: row.id})))),
      action("成果物", async () => {
        const files = await api("artifacts", {job: row.id});
        const items = files.map(file => action(file.name, async () => {
          const content = await api("artifacts", {job: row.id, path: file.name, size: 65536});
          output(file.name, element("pre", content.text),
            element("p", `${content.next.toLocaleString()} / ${content.total.toLocaleString()} バイト`));
        }));
        output("成果物", ...(items.length ? items : [element("p", "成果物はありません。")]));
      }), action("実験条件", async () =>
      output("実験条件", element("pre", JSON.stringify(await api("experiment-inputs", {job: row.id}), null, 2)))));
    card.append(element("h3", `${row.name} · ${row.state}`),
      element("p", `${row.revision.slice(0, 12)} · ${row.id}`), buttons);
    return card;
  }));
}

function renderEvents() {
  replace("events", (state?.recent || []).filter(row => !["user", "assistant"].includes(row.kind)).reverse(),
    list => list.map(row => {
      const card = element("article", undefined, "panel stack");
      card.append(element("small", `${new Date(row.time * 1000).toLocaleString()} · ${row.role || "Core"} · ${row.kind}`),
        element("p", textDetail(row.detail)));
      return card;
    }));
}

document.querySelectorAll("nav button").forEach(button => {button.onclick = () => showPage(button.dataset.page);});
const savedTheme = localStorage.getItem("adf-theme");
if (["dark", "light"].includes(savedTheme)) document.documentElement.dataset.theme = savedTheme;
$("theme").onclick = () => {
  const current = document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const theme = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("adf-theme", theme);
};
$("older").onclick = () => execute(async () => {
  const revision = chatRevision;
  const before = Math.min(...messages.keys());
  const rows = await api("conversation", {role, before});
  if (revision !== chatRevision) return;
  hasOlder = rows.length === 40;
  for (const row of rows) messages.set(row.id, row);
  renderMessages(true);
});
$("open-plan").onclick = () => {$("plan").hidden = !$("plan").hidden;};
form("plan", async values => {
  const tasks = values.issues.trim().split(/\s+/).filter(Boolean).map(Number);
  await api("research-start", {scope: values.scope, tasks, tokens: Number(values.tokens)});
  $("plan").hidden = true;
  chooseRole("developer");
});
form("prompt", async () => {
  await api("send", {role, text: $("message").value});
  $("message").value = "";
});
$("stop").onclick = () => execute(() => api("stop", {role}), $("stop"));
$("interrupt").onclick = () => execute(() => api("stop", {role, immediate: true}), $("interrupt"));
$("resume").onclick = () => execute(() => {
  const developer = state.sessions.find(item => item.role === "developer");
  const run = state.research_runs.find(item => item.session === developer?.id);
  return role === "developer" && run && !["completed", "blocked"].includes(run.state) ?
    api("research-resume") : api("resume", {role});
}, $("resume"));
form("resume-plan", async (values, node) => {
  const args = {accept_issue_changes: values.accept_issue_changes === "on"};
  if (values.scope.trim()) args.scope = values.scope;
  if (values.tokens !== "") args.tokens = Number(values.tokens);
  await api("research-resume", args);
  node.reset();
  $("resume-options").open = false;
});
$("load-issues").onclick = () => execute(async () => {
  const issues = await api("issues");
  $("issue-list").replaceChildren(...issues.map(item => action(`#${item.number} ${item.title} · ${item.state}`, async () => {
    const value = await api("tracker-issue", {issue: item.number});
    selectedIssue = item.number;
    draftFields();
    $("issue-detail").hidden = false;
    $("issue-detail").replaceChildren(element("h2", `#${value.number} ${value.title}`),
      element("p", value.labels.join(" · ")), markdown(value.body),
      ...value.comments.map(markdown));
  })));
}, $("load-issues"));
const drafts = {
  proposal: [["title", "件名"], ["body", "本文", "textarea"], ["priority", "優先度", ["", "P1", "P2", "P3"]]],
  comment: [["body", "コメント", "textarea"]],
  progress: [["status", "進捗", ["ready", "in-progress", "experimenting", "validating", "paused", "blocked", "local-done"]],
    ["priority", "優先度", ["", "P1", "P2", "P3"]]],
  depends: [["blocked_by", "依存先 Issue 番号", "number"]],
  label: [["name", "ラベル名"], ["enabled", "変更", ["追加", "削除"]]],
  checklist: [["criterion", "チェック項目の文言"], ["checked", "状態", ["完了", "未完了"]]],
  complete: [],
};
function draftFields() {
  const kind = $("draft").elements.kind.value;
  const fields = [...drafts[kind]];
  if (kind !== "proposal") fields.unshift(["issue", "Issue 番号", "number"]);
  $("draft-fields").replaceChildren(...fields.map(([name, title, type]) => {
    const label = element("label", title);
    const field = element(Array.isArray(type) ? "select" : type === "textarea" ? "textarea" : "input");
    field.name = name;
    if (field.tagName === "INPUT") {
      field.type = type || "text";
      if (type === "number") field.min = 1;
      if (name === "issue" && selectedIssue) field.value = selectedIssue;
    }
    if (field.tagName === "TEXTAREA") field.rows = 4;
    if (Array.isArray(type)) for (const value of type) {
      const option = element("option", value || "指定しない");
      option.value = value;
      field.append(option);
    }
    field.required = name !== "priority";
    label.append(field);
    return label;
  }));
}
$("draft").elements.kind.onchange = draftFields;
draftFields();
form("draft", ({kind, ...payload}) => {
  for (const key of ["issue", "blocked_by"]) if (key in payload) payload[key] = Number(payload[key]);
  if ("enabled" in payload) payload.enabled = payload.enabled === "追加";
  if ("checked" in payload) payload.checked = payload.checked === "完了";
  return api("tracker-draft", {kind, payload});
});
for (const [id, operation] of [["get-usage", "usage"], ["get-limits", "limits"]]) {
  $(id).onclick = () => execute(async () => {
    $("usage").textContent = JSON.stringify(await api(operation), null, 2);
    $("usage").hidden = false;
  }, $(id));
}
form("mode", values => api("research-preset", {name: values.name, tokens: Number(values.tokens), apply: true,
  empty_queue: values.empty_queue || null, discovery_issue: values.discovery_issue}));
const policyNames = {proposal: "起票", comment: "コメント", progress: "進捗", checklist: "チェック項目",
  complete: "完了", depends: "依存関係", label: "ラベル"};
for (const [kind, title] of Object.entries(policyNames)) {
  const label = element("label", title), select = element("select");
  select.name = kind;
  for (const [level, name] of [["deny", "禁止"], ["ask", "毎回承認"], ["allow", "ポリシー内で許可"]]) {
    const option = element("option", name);
    option.value = level;
    select.append(option);
  }
  label.append(select);
  $("policy-fields").append(label);
}
form("policies", async values => {
  if (confirm("GitHub 操作の権限を変更しますか？")) await api("tracker-policy", {operations: values});
});
form("role-settings", values => api("role", {...values, budget: Number(values.budget)}));
$("load-config").onclick = () => execute(async () => {
  $("config").elements.content.value = await api("config-text");
}, $("load-config"));
form("config", async values => {
  await api("config-save", values);
  notice("設定を保存しました。端末で python3 -m adf restart を実行すると反映されます。");
});
for (const [id, operation] of [["doctor", "doctor"], ["backup", "backup"], ["prepare-update", "update-preflight"]]) {
  $(id).onclick = () => execute(async () => {
    $("maintenance-result").textContent = JSON.stringify(await api(operation), null, 2);
    $("maintenance-result").hidden = false;
  }, $(id));
}
$("shutdown").onclick = () => execute(async () => {
  if (confirm("全ロールを停止し、監督を終了しますか？")) await api("shutdown");
}, $("shutdown"));
void refresh();
setInterval(refresh, 2000);
