const state = {
    engine: null,
    uiTasks: [],
    legacyTasks: [],
    statuses: new Map(),
    changes: [],
    editingTaskId: null,
    taskSearch: "",
    taskFilter: "all",
    outputDirTouched: false,
    runtimeDirty: false,
    isTaskDrawerOpen: false,
};

const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const form = document.querySelector("#taskForm");
const cancelEditBtn = document.querySelector("#cancelEditBtn");
const submitTaskBtn = document.querySelector("#submitTaskBtn");
const formTitle = document.querySelector("#formTitle");
const taskSearchInput = document.querySelector("#taskSearchInput");
const taskFilterSelect = document.querySelector("#taskFilterSelect");
const uiTaskCount = document.querySelector("#uiTaskCount");
const urlHint = document.querySelector("#urlHint");
const headlessToggle = document.querySelector("#headlessToggle");
const includeLegacyToggle = document.querySelector("#includeLegacyToggle");
const applyRuntimeBtn = document.querySelector("#applyRuntimeBtn");
const runtimeHint = document.querySelector("#runtimeHint");
const focusRiskHint = document.querySelector("#focusRiskHint");
const openTaskDrawerBtn = document.querySelector("#openTaskDrawerBtn");
const closeTaskDrawerBtn = document.querySelector("#closeTaskDrawerBtn");
const taskDrawer = document.querySelector("#taskDrawer");
const taskDrawerBackdrop = document.querySelector("#taskDrawerBackdrop");

const nameInput = document.querySelector("#taskName");
const urlInput = document.querySelector("#taskUrl");
const intervalInput = document.querySelector("#taskInterval");
const waitLoadInput = document.querySelector("#taskWaitLoad");
const waitSelectorInput = document.querySelector("#taskWaitSelector");
const waitTimeoutInput = document.querySelector("#taskWaitTimeout");
const outputDirInput = document.querySelector("#taskOutputDir");
const enabledInput = document.querySelector("#taskEnabled");

function slugify(input) {
    return input
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

function fmtDate(value) {
    if (!value) {
        return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(+date)) {
        return value;
    }
    return date.toLocaleString();
}

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    const remainSeconds = seconds % 60;
    if (minutes <= 0) {
        return `${remainSeconds}s`;
    }
    if (minutes < 60) {
        return `${minutes}m ${remainSeconds}s`;
    }
    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return `${hours}h ${remainMinutes}m`;
}

function formatNextCheckLabel(nextCheckAt, running, enabled) {
    if (!enabled) {
        return "Disabled";
    }
    if (running) {
        return "Checking now...";
    }
    if (!nextCheckAt) {
        return "-";
    }
    const target = new Date(nextCheckAt);
    if (Number.isNaN(+target)) {
        return "-";
    }
    const remainSeconds = Math.ceil((target.getTime() - Date.now()) / 1000);
    if (remainSeconds <= 0) {
        return "Due now";
    }
    return `${formatDuration(remainSeconds)} (${target.toLocaleTimeString()})`;
}

function updateCountdownLabels() {
    document.querySelectorAll(".next-check").forEach((element) => {
        const nextCheckAt = element.dataset.nextCheck || "";
        const running = element.dataset.running === "1";
        const enabled = element.dataset.enabled !== "0";
        element.textContent = formatNextCheckLabel(nextCheckAt, running, enabled);
    });
}

function showToast(message, duration = 2200) {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.hidden = false;
    setTimeout(() => {
        toast.hidden = true;
    }, duration);
}

function escapeHtml(input) {
    return String(input)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function isHttpUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

function inferFocusRisk(engine) {
    if (!engine) {
        return "-";
    }
    if (typeof engine.focusRisk === "string") {
        return engine.focusRisk;
    }
    if (engine.mode === "attach") {
        return "high";
    }
    return engine.launchHeadless ? "low" : "medium";
}

function getRuntimeFormValues() {
    return {
        launchHeadless: headlessToggle.checked,
        includeLegacyTasks: includeLegacyToggle.checked,
    };
}

function refreshRuntimeDirty() {
    if (!state.engine) {
        state.runtimeDirty = false;
        return;
    }

    const form = getRuntimeFormValues();
    const launchChanged =
        state.engine.mode !== "attach" && Boolean(state.engine.launchHeadless) !== Boolean(form.launchHeadless);
    const legacyChanged = Boolean(state.engine.includeLegacyTasks) !== Boolean(form.includeLegacyTasks);
    state.runtimeDirty = launchChanged || legacyChanged;
}

function formatWaitSummary(task) {
    const waitLoad = task.waitLoad || "load";
    const parts = [waitLoad];

    if (task.waitSelector) {
        parts.push(`selector: ${task.waitSelector}`);
    }
    if (typeof task.waitTimeoutSec === "number" && task.waitTimeoutSec > 0) {
        parts.push(`+${task.waitTimeoutSec}s`);
    }

    return parts.join(" | ");
}

function filteredUiTasks() {
    const query = state.taskSearch.trim().toLowerCase();
    return state.uiTasks.filter((task) => {
        if (state.taskFilter === "enabled" && !task.enabled) {
            return false;
        }
        if (state.taskFilter === "disabled" && task.enabled) {
            return false;
        }
        if (!query) {
            return true;
        }
        return task.name.toLowerCase().includes(query) || task.url.toLowerCase().includes(query);
    });
}

async function request(path, options = {}) {
    const res = await fetch(path, {
        headers: {
            "Content-Type": "application/json",
        },
        ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return data;
}

function getStatus(taskId) {
    return state.statuses.get(taskId) || null;
}

function renderEngine() {
    const engineStatus = document.querySelector("#engineStatus");
    const modeStatus = document.querySelector("#modeStatus");
    const controlUrl = document.querySelector("#controlUrl");
    const taskCounts = document.querySelector("#taskCounts");

    if (!state.engine) {
        engineStatus.textContent = "Unknown";
        modeStatus.textContent = "-";
        controlUrl.textContent = "-";
        taskCounts.textContent = "-";
        runtimeHint.textContent = "Loading runtime settings...";
        focusRiskHint.textContent = "Focus risk: -";
        headlessToggle.disabled = true;
        includeLegacyToggle.disabled = true;
        applyRuntimeBtn.disabled = true;
        return;
    }

    engineStatus.textContent = state.engine.running ? "Running" : "Stopped";
    engineStatus.className = `status-value ${state.engine.running ? "status-running" : "status-stopped"}`;

    if (state.engine.mode === "launch") {
        const modeLabel = state.engine.launchHeadless ? "headless" : "visible";
        modeStatus.textContent = `${state.engine.mode} (${modeLabel})`;
    } else {
        modeStatus.textContent = `${state.engine.mode} (${state.engine.browserConnected ? "connected" : "idle"})`;
    }

    controlUrl.textContent = state.engine.controlUrl;
    taskCounts.textContent = `UI ${state.engine.uiTaskCount} / Legacy ${state.engine.legacyTaskCount} / Total ${state.engine.taskCount}`;

    const focusRisk = inferFocusRisk(state.engine);
    focusRiskHint.textContent = `Focus risk: ${String(focusRisk).toUpperCase()}`;
    focusRiskHint.className = `inline-hint focus-risk risk-${focusRisk}`;

    if (!state.runtimeDirty) {
        headlessToggle.checked = Boolean(state.engine.launchHeadless);
        includeLegacyToggle.checked = Boolean(state.engine.includeLegacyTasks);
    }

    headlessToggle.disabled = state.engine.mode === "attach";
    includeLegacyToggle.disabled = false;

    refreshRuntimeDirty();
    applyRuntimeBtn.disabled = !state.runtimeDirty;

    if (state.runtimeDirty) {
        runtimeHint.textContent = "Pending runtime changes. Click Apply Runtime to take effect.";
        runtimeHint.classList.remove("invalid");
        return;
    }

    if (state.engine.mode === "attach") {
        runtimeHint.textContent = "Attach mode uses your existing Chrome and may steal focus.";
        runtimeHint.classList.add("invalid");
        return;
    }

    runtimeHint.classList.remove("invalid");
    const legacyHint = state.engine.includeLegacyTasks ? "Legacy tasks enabled." : "Legacy tasks disabled.";
    if (state.engine.launchHeadless) {
        runtimeHint.textContent = `Headless mode is active and minimizes foreground interruption. ${legacyHint}`;
    } else {
        runtimeHint.textContent = `Visible mode is active for debugging and can steal focus. ${legacyHint}`;
    }
}

function renderUiTasks() {
    const tbody = document.querySelector("#uiTaskTable tbody");
    tbody.innerHTML = "";

    const tasks = filteredUiTasks();
    uiTaskCount.textContent = `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;

    if (tasks.length === 0) {
        const emptyRow = document.createElement("tr");
        emptyRow.innerHTML = '<td colspan="10">No tasks match the current search/filter.</td>';
        tbody.appendChild(emptyRow);
        return;
    }

    for (const task of tasks) {
        const row = document.createElement("tr");
        const status = getStatus(`ui-${task.id}`);
        row.innerHTML = `
      <td><input type="checkbox" data-action="toggle" data-id="${escapeHtml(task.id)}" ${task.enabled ? "checked" : ""}></td>
      <td>${escapeHtml(task.name)}</td>
      <td><a href="${escapeHtml(task.url)}" target="_blank" rel="noreferrer">${escapeHtml(task.url)}</a></td>
      <td>${task.intervalSec}s</td>
      <td>${escapeHtml(formatWaitSummary(task))}</td>
      <td><span class="next-check" data-next-check="${escapeHtml(status?.nextCheckAt ?? "")}" data-running="${status?.running ? "1" : "0"}" data-enabled="${task.enabled ? "1" : "0"}">-</span></td>
      <td>${escapeHtml(task.outputDir)}</td>
      <td>${fmtDate(status?.lastCheckAt ?? null)}</td>
      <td>${fmtDate(status?.lastChangeAt ?? null)}</td>
      <td>
        <button class="btn btn-mini" data-action="edit" data-id="${escapeHtml(task.id)}">Edit</button>
        <button class="btn btn-mini" data-action="delete" data-id="${escapeHtml(task.id)}">Delete</button>
      </td>
    `;
        tbody.appendChild(row);
    }

    tbody.querySelectorAll("button[data-action],input[data-action]").forEach((element) => {
        element.addEventListener("click", handleTableAction);
        element.addEventListener("change", handleTableAction);
    });

    updateCountdownLabels();
}

function renderLegacyTasks() {
    const tbody = document.querySelector("#legacyTable tbody");
    tbody.innerHTML = "";
    for (const item of state.legacyTasks) {
        const row = document.createElement("tr");
        row.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a></td>
      <td>${item.intervalSec}s</td>
      <td><span class="next-check" data-next-check="${escapeHtml(item.nextCheckAt ?? "")}" data-running="${item.running ? "1" : "0"}" data-enabled="${item.enabled ? "1" : "0"}">-</span></td>
      <td>${escapeHtml(item.outputDir)}</td>
      <td>${fmtDate(item.lastCheckAt)}</td>
      <td>${item.lastError ? escapeHtml(item.lastError) : "-"}</td>
    `;
        tbody.appendChild(row);
    }

    updateCountdownLabels();
}

function renderChanges() {
    const changeList = document.querySelector("#changeList");
    changeList.innerHTML = "";
    if (state.changes.length === 0) {
        const empty = document.createElement("li");
        empty.className = "change-item";
        empty.textContent = "No changes yet.";
        changeList.appendChild(empty);
        return;
    }

    for (const item of state.changes) {
        const li = document.createElement("li");
        li.className = "change-item";
        li.innerHTML = `
      <div><span class="badge">${escapeHtml(item.source)}</span>${escapeHtml(item.taskName)}</div>
      <div class="meta">${fmtDate(item.timestamp)}</div>
      <div>${escapeHtml(item.savedPath)}</div>
    `;
        changeList.appendChild(li);
    }
}

function refreshUrlHint() {
    const urlValue = urlInput.value.trim();
    if (!urlValue) {
        urlInput.classList.remove("input-invalid");
        urlHint.textContent = "URL must start with http:// or https://";
        urlHint.classList.remove("invalid");
        return;
    }

    if (isHttpUrl(urlValue)) {
        urlInput.classList.remove("input-invalid");
        urlHint.textContent = "Looks good.";
        urlHint.classList.remove("invalid");
        return;
    }

    urlInput.classList.add("input-invalid");
    urlHint.textContent = "Invalid URL. Use an http:// or https:// address.";
    urlHint.classList.add("invalid");
}

function maybeAutoFillNameFromUrl() {
    if (nameInput.value.trim()) {
        return;
    }
    const urlValue = urlInput.value.trim();
    if (!isHttpUrl(urlValue)) {
        return;
    }
    try {
        const parsed = new URL(urlValue);
        nameInput.value = parsed.hostname.replace(/^www\./, "");
    } catch {
        // Ignore parser errors; live hint already covers invalid URLs.
    }
}

function updateSuggestedOutputDir() {
    if (state.outputDirTouched && !state.editingTaskId) {
        return;
    }
    const slug = slugify(nameInput.value);
    outputDirInput.value = slug ? `outputs/${slug}` : "";
}

function syncDrawerState() {
    document.body.classList.toggle("drawer-open", state.isTaskDrawerOpen);
    openTaskDrawerBtn.setAttribute("aria-expanded", state.isTaskDrawerOpen ? "true" : "false");
    taskDrawer.setAttribute("aria-hidden", state.isTaskDrawerOpen ? "false" : "true");
    taskDrawerBackdrop.hidden = !state.isTaskDrawerOpen;
}

function openTaskDrawer({ editing = false } = {}) {
    state.isTaskDrawerOpen = true;
    syncDrawerState();
    if (!editing) {
        // Start create flow from a clean form every time.
        resetForm();
    }
    window.requestAnimationFrame(() => {
        nameInput.focus();
    });
}

function closeTaskDrawer({ resetForm: shouldReset = false } = {}) {
    const activeInsideDrawer = document.activeElement && taskDrawer.contains(document.activeElement);
    state.isTaskDrawerOpen = false;
    syncDrawerState();
    if (shouldReset) {
        resetForm();
    }
    if (activeInsideDrawer) {
        openTaskDrawerBtn.focus();
    }
}

function resetForm() {
    state.editingTaskId = null;
    state.outputDirTouched = false;
    formTitle.textContent = "Create Task";
    submitTaskBtn.textContent = "Create Task";
    cancelEditBtn.hidden = true;
    form.reset();
    intervalInput.value = "60";
    waitLoadInput.value = "load";
    waitSelectorInput.value = "";
    waitTimeoutInput.value = "0";
    enabledInput.checked = true;
    refreshUrlHint();
}

function fillForm(task) {
    state.editingTaskId = task.id;
    state.outputDirTouched = true;
    formTitle.textContent = "Edit Task";
    submitTaskBtn.textContent = "Save Task";
    cancelEditBtn.hidden = false;
    nameInput.value = task.name;
    urlInput.value = task.url;
    intervalInput.value = `${task.intervalSec}`;
    waitLoadInput.value = task.waitLoad || "load";
    waitSelectorInput.value = task.waitSelector || "";
    waitTimeoutInput.value = task.waitTimeoutSec ? `${task.waitTimeoutSec}` : "0";
    outputDirInput.value = task.outputDir;
    enabledInput.checked = task.enabled;
    refreshUrlHint();
}

async function applyRuntimeChanges() {
    if (!state.engine) {
        return;
    }

    const nextHeadless = headlessToggle.checked;
    const nextIncludeLegacy = includeLegacyToggle.checked;
    const launchChanged =
        state.engine.mode !== "attach" && Boolean(state.engine.launchHeadless) !== Boolean(nextHeadless);
    const legacyChanged = Boolean(state.engine.includeLegacyTasks) !== Boolean(nextIncludeLegacy);

    if (!launchChanged && !legacyChanged) {
        state.runtimeDirty = false;
        renderEngine();
        showToast("Runtime unchanged.");
        return;
    }

    if (state.engine.running) {
        const confirmed = window.confirm("Applying runtime will briefly restart monitoring. Continue?");
        if (!confirmed) {
            return;
        }
    }

    const payload = {
        includeLegacyTasks: nextIncludeLegacy,
    };
    if (state.engine.mode !== "attach") {
        payload.launchHeadless = nextHeadless;
    }

    const result = await request("/api/runtime", {
        method: "PUT",
        body: JSON.stringify(payload),
    });

    state.runtimeDirty = false;
    if (result?.state) {
        state.engine = result.state;
    }
    showToast("Runtime updated");
    await refresh();
}

async function handleTableAction(event) {
    const target = event.currentTarget;
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (!action || !id) {
        return;
    }

    const task = state.uiTasks.find((item) => item.id === id);
    if (!task) {
        return;
    }

    try {
        if (action === "edit") {
            fillForm(task);
            openTaskDrawer({ editing: true });
            return;
        }
        if (action === "delete") {
            if (!window.confirm(`Delete task "${task.name}"?`)) {
                return;
            }
            await request(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
            if (state.editingTaskId === id) {
                resetForm();
            }
            showToast("Task deleted");
            await refresh();
            return;
        }
        if (action === "toggle") {
            await request(`/api/tasks/${encodeURIComponent(id)}`, {
                method: "PUT",
                body: JSON.stringify({ enabled: target.checked }),
            });
            await refresh();
            return;
        }
    } catch (error) {
        if (state.editingTaskId && String(error.message || error).includes("not found")) {
            resetForm();
        }
        showToast(error.message || String(error), 3500);
    }
}

async function refresh() {
    try {
        const [engine, taskData, changeData] = await Promise.all([
            request("/api/state"),
            request("/api/tasks"),
            request("/api/changes?limit=30"),
        ]);
        state.engine = engine;
        state.uiTasks = taskData.uiTasks || [];
        if (state.editingTaskId && !state.uiTasks.some((task) => task.id === state.editingTaskId)) {
            resetForm();
            showToast("Edited task no longer exists. Switched back to Create mode.", 3000);
        }
        state.legacyTasks = taskData.legacyTasks || [];
        state.statuses = new Map((taskData.statuses || []).map((item) => [item.id, item]));
        state.changes = changeData.changes || [];
        renderEngine();
        renderUiTasks();
        renderLegacyTasks();
        renderChanges();
        updateCountdownLabels();
    } catch (error) {
        showToast(error.message || String(error), 4000);
    }
}

async function onFormSubmit(event) {
    event.preventDefault();

    const waitTimeoutRaw = waitTimeoutInput.value.trim();
    const waitTimeoutSec = waitTimeoutRaw ? Number(waitTimeoutRaw) : 0;
    if (!Number.isFinite(waitTimeoutSec) || waitTimeoutSec < 0) {
        showToast("Extra Wait must be a number greater than or equal to 0");
        return;
    }

    const payload = {
        name: nameInput.value.trim(),
        url: urlInput.value.trim(),
        intervalSec: Number(intervalInput.value),
        waitLoad: waitLoadInput.value,
        waitSelector: waitSelectorInput.value.trim(),
        waitTimeoutSec,
        outputDir: outputDirInput.value.trim(),
        enabled: enabledInput.checked,
    };

    try {
        if (state.editingTaskId) {
            await request(`/api/tasks/${encodeURIComponent(state.editingTaskId)}`, {
                method: "PUT",
                body: JSON.stringify(payload),
            });
            showToast("Task updated");
        } else {
            await request("/api/tasks", {
                method: "POST",
                body: JSON.stringify(payload),
            });
            showToast("Task created");
        }
        resetForm();
        await refresh();
        closeTaskDrawer({ resetForm: false });
    } catch (error) {
        if (state.editingTaskId && String(error.message || error).includes("not found")) {
            resetForm();
        }
        showToast(error.message || String(error), 3500);
    }
}

nameInput.addEventListener("input", () => {
    updateSuggestedOutputDir();
});

outputDirInput.addEventListener("input", () => {
    state.outputDirTouched = Boolean(outputDirInput.value.trim());
});

urlInput.addEventListener("input", () => {
    refreshUrlHint();
    maybeAutoFillNameFromUrl();
    updateSuggestedOutputDir();
});

taskSearchInput.addEventListener("input", () => {
    state.taskSearch = taskSearchInput.value;
    renderUiTasks();
});

taskFilterSelect.addEventListener("change", () => {
    state.taskFilter = taskFilterSelect.value;
    renderUiTasks();
});

headlessToggle.addEventListener("change", () => {
    refreshRuntimeDirty();
    renderEngine();
});

includeLegacyToggle.addEventListener("change", () => {
    refreshRuntimeDirty();
    renderEngine();
});

applyRuntimeBtn.addEventListener("click", async () => {
    try {
        await applyRuntimeChanges();
    } catch (error) {
        showToast(error.message || String(error), 3500);
    }
});

form.addEventListener("submit", onFormSubmit);
openTaskDrawerBtn.addEventListener("click", () => {
    openTaskDrawer({ editing: false });
});
closeTaskDrawerBtn.addEventListener("click", () => {
    closeTaskDrawer({ resetForm: true });
});
taskDrawerBackdrop.addEventListener("click", () => {
    closeTaskDrawer({ resetForm: false });
});
cancelEditBtn.addEventListener("click", () => {
    resetForm();
    closeTaskDrawer({ resetForm: false });
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.isTaskDrawerOpen) {
        closeTaskDrawer({ resetForm: false });
    }
});

startBtn.addEventListener("click", async () => {
    try {
        await request("/api/engine/start", { method: "POST" });
        showToast("Monitoring started");
        await refresh();
    } catch (error) {
        showToast(error.message || String(error), 3500);
    }
});

stopBtn.addEventListener("click", async () => {
    try {
        await request("/api/engine/stop", { method: "POST" });
        showToast("Monitoring stopped");
        await refresh();
    } catch (error) {
        showToast(error.message || String(error), 3500);
    }
});

resetForm();
syncDrawerState();
void refresh();
setInterval(() => {
    void refresh();
}, 3000);

setInterval(() => {
    updateCountdownLabels();
}, 1000);
