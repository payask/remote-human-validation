const config = window.REMOTE_HV_CONFIG || {};
const receiver = String(config.receiverBaseUrl || "").replace(/\/$/u, "");
const params = new URLSearchParams(location.search);
const studyId = params.get("study") || "";
const assignmentToken = window.__remoteHvAssignmentToken || "";
const ownerToken = window.__remoteHvOwnerToken || "";
delete window.__remoteHvAssignmentToken;
delete window.__remoteHvOwnerToken;

const byId = (id) => document.getElementById(id);
let assignment = null;
let activeTaskId = null;
let ownerExport = null;

function show(id) {
  ["loading", "error", "assignment", "owner"].forEach((name) => { byId(name).hidden = name !== id; });
}

function fail(message) {
  byId("error-message").textContent = message;
  show("error");
}

function endpoint(path) {
  if (!receiver || receiver.includes("REPLACE_WITH")) throw new Error("The receiver has not been deployed yet.");
  return `${receiver}${path}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

function sessionKey(taskId) {
  return `remote-hv:v1:${assignment.classification}:${assignment.study_id}:${assignment.tester_id}:${taskId}`;
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function loadDraft(taskId) {
  const stored = localStorage.getItem(sessionKey(taskId));
  if (stored) {
    try { return JSON.parse(stored); } catch { localStorage.removeItem(sessionKey(taskId)); }
  }
  const draft = { sessionId:`${assignment.tester_id}-${Date.now().toString(36)}-${randomId()}`, startedAt:new Date().toISOString(), fields:{}, hints:[], submitted:false };
  localStorage.setItem(sessionKey(taskId), JSON.stringify(draft));
  return draft;
}

function saveDraft(taskId, draft) {
  localStorage.setItem(sessionKey(taskId), JSON.stringify(draft));
  updateTaskButtons();
}

function updateTaskButtons() {
  document.querySelectorAll(".task-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.taskId === activeTaskId);
    button.classList.toggle("done", Boolean(loadDraft(button.dataset.taskId).submitted));
  });
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function safeSpecimenUrl(path) {
  if (typeof path !== "string" || !/^assets\/[A-Za-z0-9._/-]+\.png$/u.test(path) || path.split("/").includes("..")) return null;
  const url = new URL(path, document.baseURI);
  return url.origin === location.origin ? url : null;
}

function renderSpecimens(container, specimens = []) {
  if (!specimens.length) return;
  const section = element("section", "section specimen-section");
  section.append(element("h3", "", "Static review specimens"));
  const grid = element("div", "specimen-grid");
  specimens.forEach((specimen) => {
    const figure = element("figure", "specimen-card");
    const url = safeSpecimenUrl(specimen.image_path);
    if (!url || typeof specimen.alt_text !== "string" || typeof specimen.caption !== "string") {
      figure.append(element("p", "specimen-error", "Specimen unavailable: invalid static-asset descriptor."));
    } else {
      const img = element("img", "specimen-image");
      img.src = url.href;
      img.alt = specimen.alt_text;
      img.loading = "eager";
      img.decoding = "async";
      img.dataset.specimenId = specimen.specimen_id;
      img.dataset.expectedSha256 = specimen.sha256;
      figure.append(img, element("figcaption", "specimen-caption", specimen.caption));
    }
    grid.append(figure);
  });
  section.append(grid);
  container.append(section);
}

function renderContent(container, task) {
  const content = task.content;
  container.append(element("p", "safety", content.instructions || ""));
  if (content.scenario_intro) container.append(element("p", "", content.scenario_intro));
  if (content.categories) {
    const grid = element("div", "category-grid section");
    for (const [key, values] of Object.entries(content.categories)) {
      const card = element("div", "category");
      card.append(element("strong", "", content.category_labels?.[key] || key));
      card.append(document.createTextNode(values.join(" · ")));
      grid.append(card);
    }
    container.append(grid);
  }
  if (content.clues?.length) {
    const section = element("section", "section");
    section.append(element("h3", "", "Clues"));
    const list = element("ol", "clues");
    content.clues.forEach((clue) => list.append(element("li", "", clue.text)));
    section.append(list);
    container.append(section);
  }
  for (const item of content.sections || []) {
    const section = element("section", "section");
    section.append(element("h3", "", item.heading));
    section.append(element("p", "", item.body));
    container.append(section);
  }
  renderSpecimens(container, content.specimens || []);
}

function renderPrivileged(container, task) {
  const privileged = task.privileged_content;
  if (!privileged || !Object.keys(privileged).length) return;
  const section = element("section", "section");
  section.append(element("h3", "", "Editorial answer and hint reference"));
  if (privileged.answers?.length) {
    const table = element("table", "answer-table");
    const head = element("tr");
    ["Person", "Activity", "Time", "Location"].forEach((label) => head.append(element("th", "", label)));
    table.append(head);
    privileged.answers.forEach((answer) => {
      const row = element("tr");
      [answer.person, answer.activity, answer.time, answer.location].forEach((value) => row.append(element("td", "", value)));
      table.append(row);
    });
    section.append(table);
  }
  (privileged.hints || []).forEach((hint) => section.append(element("div", "hint-box", `Hint ${hint.level}: ${hint.text}`)));
  container.append(section);
}

function renderHints(container, task, draft) {
  if (!task.hints_available) return;
  const section = element("section", "section");
  section.append(element("h3", "", "Optional hints"));
  const actions = element("div", "hint-actions");
  for (let level = 1; level <= task.hints_available; level += 1) {
    const button = element("button", "secondary", `Reveal Hint ${level}`);
    button.type = "button";
    button.disabled = level === 2 && !draft.hints.some((hint) => hint.level === 1);
    button.addEventListener("click", () => revealHint(task.task_id, level));
    actions.append(button);
  }
  section.append(actions);
  draft.hints.forEach((hint) => section.append(element("div", "hint-box", `Hint ${hint.level}: ${hint.text}`)));
  container.append(section);
}

async function revealHint(taskId, level) {
  const draft = loadDraft(taskId);
  if (draft.hints.some((hint) => hint.level === level)) return;
  try {
    const response = await fetchWithTimeout(endpoint(`/v1/studies/${encodeURIComponent(assignment.study_id)}/assignment/${encodeURIComponent(assignmentToken)}/hints`), {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({task_id:taskId, level}),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== "HINT_REVEALED") throw new Error(body?.message || "Hint unavailable");
    draft.hints.push({ level:body.level, text:body.text });
    saveDraft(taskId, draft);
    renderTask(taskId);
  } catch (error) { alert(error.message || "The hint could not be loaded."); }
}

function renderField(form, field, draft) {
  const wrapper = element("label", "field");
  wrapper.append(element("span", "", `${field.label}${field.required ? " *" : ""}`));
  if (field.type === "textarea") {
    const input = element("textarea");
    input.name = field.id; input.maxLength = field.max_length || 4000; input.required = Boolean(field.required); input.value = draft.fields[field.id] || "";
    wrapper.append(input);
  } else if (field.type === "select") {
    const input = element("select"); input.name = field.id; input.required = Boolean(field.required);
    const blank = element("option", "", "Select…"); blank.value = ""; input.append(blank);
    field.options.forEach((value) => { const option = element("option", "", value); option.value = value; option.selected = draft.fields[field.id] === value; input.append(option); });
    wrapper.append(input);
  } else if (field.type === "radio") {
    const choices = element("div", "choices");
    field.options.forEach((value) => {
      const choice = element("label", "choice");
      const input = element("input"); input.type = "radio"; input.name = field.id; input.value = value; input.required = Boolean(field.required); input.checked = draft.fields[field.id] === value;
      choice.append(input, document.createTextNode(` ${value.replaceAll("_", " ")}`)); choices.append(choice);
    });
    wrapper.append(choices);
  } else {
    const input = element("input"); input.type = field.type === "integer" ? "number" : "text"; input.name = field.id; input.required = Boolean(field.required); input.value = draft.fields[field.id] ?? "";
    if (field.type === "integer") { input.min = field.minimum; input.max = field.maximum; }
    wrapper.append(input);
  }
  form.append(wrapper);
}

function captureForm(form, schema, draft) {
  const data = new FormData(form);
  const fields = {};
  schema.fields.forEach((field) => {
    const value = data.get(field.id);
    if (value !== null && value !== "") fields[field.id] = field.type === "integer" ? Number(value) : String(value);
  });
  draft.fields = fields;
  saveDraft(activeTaskId, draft);
}

function fallbackPayload(taskId, draft) {
  return submissionEnvelope(taskId, draft);
}

function downloadJson(filename, value) {
  const href = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type:"application/json" }));
  const link = element("a"); link.href = href; link.download = filename; link.click(); URL.revokeObjectURL(href);
}

async function copyJson(value, status) {
  try { await navigator.clipboard.writeText(JSON.stringify(value)); status.textContent = "Fallback result copied. Return it to the study owner."; }
  catch { status.textContent = "Copy was unavailable. Use Download Result."; }
}

function submissionEnvelope(taskId, draft) {
  return {
    study_id:assignment.study_id, topic_id:assignment.topic_id, topic_name:assignment.topic_name,
    protocol_version:assignment.protocol_version, source_pack_hash:assignment.source_pack_hash,
    tester_id:assignment.tester_id, role_id:assignment.role_id, assignment_id:assignment.assignment_id,
    session_id:draft.sessionId, task_id:taskId, classification:assignment.classification,
    started_at_utc:draft.startedAt, submitted_at_client_utc:draft.submittedAt,
    elapsed_seconds:draft.elapsedSeconds,
    declared_medium:"REMOTE_BROWSER", user_agent:navigator.userAgent, response:draft.fields,
  };
}

async function submitTask(taskId, draft, button, status, fallback) {
  if (!draft.submittedAt) {
    draft.submittedAt = new Date().toISOString();
    draft.elapsedSeconds = Math.max(0, Math.round((Date.parse(draft.submittedAt) - Date.parse(draft.startedAt)) / 1000));
    saveDraft(taskId, draft);
  }
  button.disabled = true; button.textContent = "Sending…"; status.className = "status"; status.textContent = "Sending…"; fallback.hidden = true;
  const payload = submissionEnvelope(taskId, draft);
  try {
    const response = await fetchWithTimeout(endpoint(`/v1/results/${encodeURIComponent(assignment.study_id)}`), {
      method:"POST", headers:{Authorization:`Bearer ${assignmentToken}`, "Content-Type":"application/json"}, body:JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !["RECEIVED", "ALREADY_RECEIVED"].includes(body?.status)) throw new Error("Receiver did not confirm receipt");
    draft.submitted = true; draft.receipt = body.status; saveDraft(taskId, draft);
    status.className = "status success"; status.textContent = body.status === "RECEIVED" ? "Results received — thank you." : "These results were already received.";
  } catch {
    status.className = "status failure"; status.textContent = "We could not confirm receipt. Your draft is preserved; it has not been marked sent."; fallback.hidden = false;
  } finally { button.disabled = false; button.textContent = "Send this task"; updateTaskButtons(); }
}

function renderForm(container, task, draft) {
  const schema = task.form_schema;
  const form = element("form", "form-stack");
  schema.fields.forEach((field) => renderField(form, field, draft));
  form.addEventListener("input", () => captureForm(form, schema, draft));
  const submission = element("div", "submission");
  const button = element("button", "primary", "Send this task"); button.type = "submit";
  const status = element("p", "status", draft.submitted ? "Results received for this task." : "");
  if (draft.submitted) status.classList.add("success");
  const fallback = element("div", "fallback"); fallback.hidden = true;
  const copy = element("button", "secondary", "Copy Result"); copy.type = "button"; copy.addEventListener("click", () => copyJson(fallbackPayload(task.task_id, draft), status));
  const download = element("button", "secondary", "Download Result"); download.type = "button"; download.addEventListener("click", () => downloadJson(`${assignment.study_id}_${assignment.tester_id}_${draft.sessionId}.json`, fallbackPayload(task.task_id, draft)));
  fallback.append(copy, download); submission.append(button, status, fallback); form.append(submission);
  form.addEventListener("submit", (event) => { event.preventDefault(); captureForm(form, schema, draft); if (form.reportValidity()) submitTask(task.task_id, draft, button, status, fallback); });
  container.append(form);
}

function renderTask(taskId) {
  activeTaskId = taskId;
  const task = assignment.tasks.find((item) => item.task_id === taskId);
  const draft = loadDraft(taskId);
  const container = byId("task"); container.replaceChildren();
  container.append(element("p", "eyebrow", `${assignment.role_label} · ${task.task_id}`));
  container.append(element("h2", "", task.title));
  renderContent(container, task); renderPrivileged(container, task); renderHints(container, task, draft); renderForm(container, task, draft); updateTaskButtons();
  window.scrollTo({ top:0, behavior:"instant" });
}

function renderAssignment() {
  byId("brand").textContent = assignment.topic_name;
  byId("classification").textContent = assignment.classification;
  byId("classification").classList.toggle("fixture", assignment.classification === "TEST_FIXTURE");
  byId("role-label").textContent = `${assignment.role_label} · ${assignment.tester_id}`;
  byId("study-title").textContent = assignment.topic_name;
  const list = byId("task-list"); list.replaceChildren();
  assignment.tasks.forEach((task) => {
    const button = element("button", "task-button", task.title); button.type = "button"; button.dataset.taskId = task.task_id; button.addEventListener("click", () => renderTask(task.task_id)); list.append(button);
  });
  show("assignment"); renderTask(assignment.tasks[0].task_id);
}

async function openAssignment() {
  if (!studyId || !assignmentToken) return fail("The study or assignment token is missing. Ask the owner for your assigned link.");
  try {
    const response = await fetchWithTimeout(endpoint(`/v1/studies/${encodeURIComponent(studyId)}/assignment/${encodeURIComponent(assignmentToken)}`));
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.assignment_id) throw new Error("Assignment not found");
    assignment = body; renderAssignment();
  } catch (error) { fail(error.message || "The assignment could not be loaded."); }
}

async function refreshOwner() {
  const classification = byId("owner-classification").value;
  const status = byId("owner-status"); status.textContent = "Loading raw results…";
  try {
    const response = await fetchWithTimeout(endpoint(`/v1/owner/results/${encodeURIComponent(studyId)}?classification=${encodeURIComponent(classification)}`), { headers:{Authorization:`Bearer ${ownerToken}`} });
    const body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body?.records)) throw new Error("Retrieval failed");
    ownerExport = body; byId("owner-results").textContent = JSON.stringify(body, null, 2); byId("owner-download").disabled = false;
    status.textContent = `${body.record_count} raw ${classification} record(s). No decision computed.`;
  } catch { ownerExport = null; byId("owner-download").disabled = true; status.textContent = "Raw results could not be retrieved."; }
}

function openOwner() {
  if (!studyId || !ownerToken) return fail("The study or owner token is missing.");
  byId("classification").textContent = "OWNER"; byId("owner-title").textContent = `${studyId} raw result retrieval`;
  byId("owner-refresh").addEventListener("click", refreshOwner);
  byId("owner-download").addEventListener("click", () => ownerExport && downloadJson(`${studyId}_${ownerExport.classification}_raw_results.json`, ownerExport));
  show("owner"); refreshOwner();
}

if (ownerToken) openOwner(); else openAssignment();
