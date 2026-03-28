const state = {
    engine: null,
    uiTasks: [],
    legacyTasks: [],
    statuses: new Map(),
    changes: [],
    taskSearch: "",
    taskFilter: "all",
    activeTab: "overview",
    collapsed: false,
    editingTaskId: null,
    outputDirTouched: false,
    runtimeDirty: false,
    hasHydrated: false,
    newChangeKeys: new Set(),
    confirmDeleteTaskId: null,
    confirmRuntimeApply: false,
    noticeHideTimer: 0,
    pending: {
        refresh: false,
        start: false,
        stop: false,
        save: false,
        applyRuntime: false,
        deleteTaskIds: new Set(),
        unblockTaskIds: new Set(),
        toggleTaskIds: new Set(),
    },
};

const refs = {
    metricEngine: document.querySelector("#metricEngine"),
    metricRisk: document.querySelector("#metricRisk"),
    metricTasks: document.querySelector("#metricTasks"),
    metricFreshness: document.querySelector("#metricFreshness"),
    composeFromStageBtn: document.querySelector("#composeFromStageBtn"),
    stageTaskPreview: document.querySelector("#stageTaskPreview"),
    stageChangePreview: document.querySelector("#stageChangePreview"),
    commandPanel: document.querySelector("#commandPanel"),
    panelSummaryBtn: document.querySelector("#panelSummaryBtn"),
    panelStateDot: document.querySelector("#panelStateDot"),
    panelSummaryLine: document.querySelector("#panelSummaryLine"),
    collapseBtn: document.querySelector("#collapseBtn"),
    panelProgress: document.querySelector("#panelProgress"),
    tabButtons: Array.from(document.querySelectorAll("[data-tab-button]")),
    panes: Array.from(document.querySelectorAll("[data-pane]")),
    inlineFeedback: document.querySelector("#inlineFeedback"),
    feedbackTitle: document.querySelector("#feedbackTitle"),
    feedbackMessage: document.querySelector("#feedbackMessage"),
    feedbackCloseBtn: document.querySelector("#feedbackCloseBtn"),
    startBtn: document.querySelector("#startBtn"),
    stopBtn: document.querySelector("#stopBtn"),
    newTaskBtn: document.querySelector("#newTaskBtn"),
    engineBadge: document.querySelector("#engineBadge"),
    overviewStatusHint: document.querySelector("#overviewStatusHint"),
    taskSearchInput: document.querySelector("#taskSearchInput"),
    taskFilterSelect: document.querySelector("#taskFilterSelect"),
    uiTaskCount: document.querySelector("#uiTaskCount"),
    taskList: document.querySelector("#taskList"),
    composeEyebrow: document.querySelector("#composeEyebrow"),
    formTitle: document.querySelector("#formTitle"),
    resetFormBtn: document.querySelector("#resetFormBtn"),
    formIntro: document.querySelector("#formIntro"),
    taskForm: document.querySelector("#taskForm"),
    nameInput: document.querySelector("#taskName"),
    urlInput: document.querySelector("#taskUrl"),
    urlHint: document.querySelector("#urlHint"),
    intervalInput: document.querySelector("#taskInterval"),
    waitLoadInput: document.querySelector("#taskWaitLoad"),
    waitSelectorInput: document.querySelector("#taskWaitSelector"),
    waitTimeoutInput: document.querySelector("#taskWaitTimeout"),
    compareSelectorInput: document.querySelector("#taskCompareSelector"),
    requiredKeywordInput: document.querySelector("#taskRequiredKeyword"),
    ignoreSelectorsInput: document.querySelector("#taskIgnoreSelectors"),
    ignoreTextRegexInput: document.querySelector("#taskIgnoreTextRegex"),
    outputDirInput: document.querySelector("#taskOutputDir"),
    enabledInput: document.querySelector("#taskEnabled"),
    submitTaskBtn: document.querySelector("#submitTaskBtn"),
    cancelEditBtn: document.querySelector("#cancelEditBtn"),
    runtimeDirtyBadge: document.querySelector("#runtimeDirtyBadge"),
    engineStatus: document.querySelector("#engineStatus"),
    modeStatus: document.querySelector("#modeStatus"),
    riskStatus: document.querySelector("#riskStatus"),
    controlUrl: document.querySelector("#controlUrl"),
    taskCounts: document.querySelector("#taskCounts"),
    latestDiffStatus: document.querySelector("#latestDiffStatus"),
    runtimeHint: document.querySelector("#runtimeHint"),
    focusRiskHint: document.querySelector("#focusRiskHint"),
    configLoadHint: document.querySelector("#configLoadHint"),
    headlessToggle: document.querySelector("#headlessToggle"),
    includeLegacyToggle: document.querySelector("#includeLegacyToggle"),
    maxConcurrencyInput: document.querySelector("#maxConcurrencyInput"),
    userAgentInput: document.querySelector("#userAgentInput"),
    acceptLanguageInput: document.querySelector("#acceptLanguageInput"),
    runtimeConfirm: document.querySelector("#runtimeConfirm"),
    runtimeConfirmBtn: document.querySelector("#runtimeConfirmBtn"),
    runtimeCancelBtn: document.querySelector("#runtimeCancelBtn"),
    applyRuntimeBtn: document.querySelector("#applyRuntimeBtn"),
    legacyCount: document.querySelector("#legacyCount"),
    legacyList: document.querySelector("#legacyList"),
    attentionList: document.querySelector("#attentionList"),
    changeCount: document.querySelector("#changeCount"),
    changeList: document.querySelector("#changeList"),
};

function slugify(input) {
    return String(input || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
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

function fmtDate(value) {
    if (!value) {
        return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
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

function formatNextCheckLabel(nextCheckAt, running, queued, enabled, blocked) {
    if (!enabled) {
        return "Disabled";
    }
    if (blocked) {
        return "Blocked";
    }
    if (running) {
        return "Checking now...";
    }
    if (queued) {
        return "Queued";
    }
    if (!nextCheckAt) {
        return "-";
    }

    const target = new Date(nextCheckAt);
    if (Number.isNaN(target.getTime())) {
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
        const queued = element.dataset.queued === "1";
        const enabled = element.dataset.enabled !== "0";
        const blocked = element.dataset.blocked === "1";
        element.textContent = formatNextCheckLabel(nextCheckAt, running, queued, enabled, blocked);
    });
}

function normalizeOutputsPath(value) {
    return String(value || "")
        .replaceAll("\\", "/")
        .replace(/^\.?\//, "")
        .trim();
}

function outputsHrefForPath(value, { isDir = false } = {}) {
    const normalized = normalizeOutputsPath(value);
    if (!normalized) {
        return null;
    }

    const withoutLeading = normalized.replace(/^\/+/, "");
    if (withoutLeading !== "outputs" && !withoutLeading.startsWith("outputs/")) {
        return null;
    }

    const segments = withoutLeading.split("/").filter(Boolean).map((segment) => encodeURIComponent(segment));
    const base = `/${segments.join("/")}`;
    if (!isDir) {
        return base;
    }
    return base.endsWith("/") ? base : `${base}/`;
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

function formatTaskCount(count) {
    return `${count} task${count === 1 ? "" : "s"}`;
}

function formatVisibleTaskCount(visibleCount, totalCount) {
    if (visibleCount === totalCount) {
        return formatTaskCount(totalCount);
    }
    return `${visibleCount} of ${formatTaskCount(totalCount)}`;
}

function hostLabel(url) {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

function changeKey(item) {
    return `${item.timestamp || ""}::${item.savedPath || ""}`;
}

function basenameForPath(filePath) {
    const normalized = String(filePath || "").replaceAll("\\", "/");
    const segments = normalized.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : normalized || "-";
}

function totalTaskCount() {
    if (state.engine) {
        return Number(state.engine.taskCount || 0);
    }
    return state.uiTasks.length + state.legacyTasks.length;
}

function hasAnyTasks() {
    return totalTaskCount() > 0;
}

function getStatus(taskId) {
    return state.statuses.get(taskId) || null;
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

function attentionStatuses() {
    return Array.from(state.statuses.values())
        .filter((item) => item.blocked || item.lastError)
        .sort((a, b) => {
            const aScore = (a.blocked ? 2 : 0) + (a.lastError ? 1 : 0);
            const bScore = (b.blocked ? 2 : 0) + (b.lastError ? 1 : 0);
            if (aScore !== bScore) {
                return bScore - aScore;
            }
            return String(a.name).localeCompare(String(b.name));
        });
}

function stagePreviewTasks() {
    return state.uiTasks
        .slice()
        .sort((left, right) => {
            const leftStatus = getStatus(`ui-${left.id}`);
            const rightStatus = getStatus(`ui-${right.id}`);
            const leftScore =
                (leftStatus?.blocked ? 8 : 0) +
                (leftStatus?.lastError ? 4 : 0) +
                (leftStatus?.running ? 3 : 0) +
                (left.enabled ? 1 : 0);
            const rightScore =
                (rightStatus?.blocked ? 8 : 0) +
                (rightStatus?.lastError ? 4 : 0) +
                (rightStatus?.running ? 3 : 0) +
                (right.enabled ? 1 : 0);

            if (leftScore !== rightScore) {
                return rightScore - leftScore;
            }
            return left.name.localeCompare(right.name);
        })
        .slice(0, 6);
}

async function request(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || `Request failed: ${response.status}`);
    }
    return data;
}

function hideNotice() {
    window.clearTimeout(state.noticeHideTimer);
    refs.inlineFeedback.hidden = true;
}

function showNotice(message, options = {}) {
    const {
        title = "Update",
        tone = "info",
        duration = tone === "error" ? 4500 : 3200,
    } = options;

    window.clearTimeout(state.noticeHideTimer);
    refs.feedbackTitle.textContent = title;
    refs.feedbackMessage.textContent = message;
    refs.inlineFeedback.dataset.tone = tone;
    refs.inlineFeedback.hidden = false;

    if (duration > 0) {
        state.noticeHideTimer = window.setTimeout(() => {
            refs.inlineFeedback.hidden = true;
        }, duration);
    }
}

function showErrorNotice(error, title = "Request failed") {
    const message = error instanceof Error ? error.message : String(error);
    showNotice(message, {
        title,
        tone: "error",
        duration: 5000,
    });
}

function currentHeaderTone() {
    const hasAttention = attentionStatuses().length > 0;
    if (hasAttention) {
        return "danger";
    }
    if (
        state.pending.refresh ||
        state.pending.start ||
        state.pending.stop ||
        state.pending.save ||
        state.pending.applyRuntime ||
        state.engine?.running
    ) {
        return "warning";
    }
    return "success";
}

function setActiveTab(tab) {
    state.activeTab = tab;
    refs.tabButtons.forEach((button) => {
        button.classList.toggle("is-active", button.dataset.tabButton === tab);
    });
    refs.panes.forEach((pane) => {
        pane.classList.toggle("is-active", pane.dataset.pane === tab);
    });
}

function setCollapsed(nextValue) {
    state.collapsed = nextValue;
    refs.commandPanel.dataset.collapsed = nextValue ? "true" : "false";
    refs.panelSummaryBtn.setAttribute("aria-expanded", String(!nextValue));
    refs.collapseBtn.textContent = nextValue ? "+" : "−";
}

function ensurePanelOpen() {
    if (state.collapsed) {
        setCollapsed(false);
    }
}

function renderHeader() {
    const engine = state.engine;
    const uiCount = engine ? engine.uiTaskCount : state.uiTasks.length;
    const legacyCount = engine ? engine.legacyTaskCount : state.legacyTasks.length;
    const summary = engine
        ? `${engine.running ? "RUNNING" : "STOPPED"} | ${uiCount} UI · ${legacyCount} legacy · :${engine.port}`
        : "Loading control surface...";

    refs.panelSummaryLine.textContent = summary;
    refs.panelStateDot.dataset.tone = currentHeaderTone();
    refs.panelProgress.classList.toggle(
        "is-active",
        Boolean(
            state.pending.refresh ||
                state.pending.start ||
                state.pending.stop ||
                state.pending.save ||
                state.pending.applyRuntime ||
                engine?.running
        )
    );

    refs.engineBadge.textContent = engine?.running ? "Live" : "Idle";
    refs.engineBadge.classList.toggle("metric-chip-live", Boolean(engine?.running));

    refs.metricEngine.textContent = engine?.running ? "Running" : "Stopped";
    refs.metricRisk.textContent = String(inferFocusRisk(engine)).toUpperCase();
    refs.metricTasks.textContent = String(totalTaskCount());
    refs.metricFreshness.textContent = state.changes[0] ? fmtDate(state.changes[0].timestamp) : "Awaiting first diff";
}

function renderComposeState() {
    const editing = Boolean(state.editingTaskId);

    refs.composeEyebrow.textContent = editing ? "Fine-tune the watch" : "Steady first pass";
    refs.formTitle.textContent = editing ? "Edit Monitor" : "Create Monitor";
    refs.formIntro.textContent = editing
        ? "Adjust timing, selectors, or output details without changing more than you need."
        : "Start with one stable page. You can tighten selectors after the first baseline is saved.";
    refs.resetFormBtn.textContent = editing ? "Reset Draft" : "Reset";
    refs.cancelEditBtn.hidden = !editing;
    refs.submitTaskBtn.textContent = state.pending.save
        ? editing
            ? "Saving..."
            : "Creating..."
        : editing
          ? "Save Monitor"
          : "Create Monitor";

    refreshUrlHint();
    refreshFormValidity();
}

function renderOverview() {
    const filtered = filteredUiTasks();

    refs.startBtn.textContent = state.pending.start
        ? "Starting..."
        : state.engine?.running
          ? "Monitoring Live"
          : "Start Monitoring";
    refs.stopBtn.textContent = state.pending.stop ? "Stopping..." : state.engine?.running ? "Stop" : "Stopped";

    refs.startBtn.disabled =
        state.pending.start || state.pending.stop || state.pending.applyRuntime || Boolean(state.engine?.running) || !hasAnyTasks();
    refs.stopBtn.disabled = state.pending.stop || state.pending.start || !state.engine?.running;

    refs.uiTaskCount.textContent = formatVisibleTaskCount(filtered.length, state.uiTasks.length);

    if (!hasAnyTasks()) {
        refs.overviewStatusHint.textContent = "Add a monitor first. The engine has nothing to schedule yet.";
    } else if (state.engine?.running) {
        refs.overviewStatusHint.textContent =
            "Monitoring is live. Fresh diffs and task status changes will keep updating in place.";
    } else {
        refs.overviewStatusHint.textContent =
            "The queue is configured and ready. Start monitoring when you want the next cycle to begin.";
    }

    renderTaskList();
    renderStageTaskPreview();
}

function renderRuntime() {
    const engine = state.engine;

    refreshRuntimeDirty();

    if (!engine) {
        refs.engineStatus.textContent = "Loading...";
        refs.modeStatus.textContent = "-";
        refs.riskStatus.textContent = "-";
        refs.controlUrl.textContent = "-";
        refs.taskCounts.textContent = "-";
        refs.latestDiffStatus.textContent = "-";
        refs.runtimeHint.textContent = "Loading runtime settings...";
        refs.focusRiskHint.textContent = "Focus risk: -";
        refs.configLoadHint.hidden = true;
        refs.applyRuntimeBtn.disabled = true;
        refs.headlessToggle.disabled = true;
        refs.includeLegacyToggle.disabled = true;
        refs.maxConcurrencyInput.disabled = true;
        refs.userAgentInput.disabled = true;
        refs.acceptLanguageInput.disabled = true;
        refs.runtimeConfirm.hidden = true;
        refs.runtimeDirtyBadge.textContent = "Synced";
        refs.runtimeDirtyBadge.classList.remove("metric-chip-live");
        return;
    }

    const focusRisk = inferFocusRisk(engine);
    refs.engineStatus.textContent = engine.running ? "Running" : "Stopped";
    refs.modeStatus.textContent =
        engine.mode === "attach"
            ? `${engine.mode} (${engine.browserConnected ? "connected" : "idle"})`
            : `${engine.mode} (${engine.launchHeadless ? "headless" : "visible"})`;
    refs.riskStatus.textContent = String(focusRisk).toUpperCase();
    refs.controlUrl.textContent = engine.controlUrl || "-";
    refs.taskCounts.textContent = `UI ${engine.uiTaskCount} / Legacy ${engine.legacyTaskCount} / Total ${engine.taskCount}`;
    refs.latestDiffStatus.textContent = state.changes[0] ? fmtDate(state.changes[0].timestamp) : "No diff yet";
    refs.focusRiskHint.textContent = `Focus risk: ${String(focusRisk).toUpperCase()}`;

    if (engine.configLoadError) {
        refs.configLoadHint.hidden = false;
        refs.configLoadHint.textContent = String(engine.configLoadError);
    } else {
        refs.configLoadHint.hidden = true;
        refs.configLoadHint.textContent = "";
    }

    refs.headlessToggle.disabled = engine.mode === "attach";
    refs.includeLegacyToggle.disabled = false;
    refs.maxConcurrencyInput.disabled = engine.mode === "attach";
    refs.userAgentInput.disabled = false;
    refs.acceptLanguageInput.disabled = false;

    if (state.runtimeDirty) {
        refs.runtimeHint.textContent = "Pending runtime changes. Apply them when you are ready.";
    } else if (engine.mode === "attach") {
        refs.runtimeHint.textContent =
            "Attach mode uses your existing Chrome session and forces max concurrency to 1.";
    } else if (engine.launchHeadless) {
        refs.runtimeHint.textContent =
            `Headless mode is active. Legacy tasks are ${engine.includeLegacyTasks ? "enabled" : "disabled"}. ` +
            `Max concurrency: ${engine.maxConcurrency}.`;
    } else {
        refs.runtimeHint.textContent =
            `Visible mode is active for debugging and can steal focus. Legacy tasks are ${engine.includeLegacyTasks ? "enabled" : "disabled"}. ` +
            `Max concurrency: ${engine.maxConcurrency}.`;
    }

    refs.applyRuntimeBtn.textContent = state.pending.applyRuntime ? "Applying..." : "Apply Runtime";
    refs.applyRuntimeBtn.disabled = !state.runtimeDirty || state.pending.applyRuntime;
    refs.runtimeConfirm.hidden = !state.confirmRuntimeApply;
    refs.runtimeDirtyBadge.textContent = state.runtimeDirty ? "Pending" : "Synced";
    refs.runtimeDirtyBadge.classList.toggle("metric-chip-live", state.runtimeDirty);
}

function renderLegacyTasks() {
    refs.legacyCount.textContent = String(state.legacyTasks.length);

    if (state.legacyTasks.length === 0) {
        refs.legacyList.innerHTML = `
      <div class="empty-card">
        <h3>No legacy tasks attached</h3>
        <p>Enable legacy tasks in runtime settings if you want to load the read-only TASKS_FILE queue.</p>
      </div>
    `;
        return;
    }

    refs.legacyList.innerHTML = state.legacyTasks
        .map((item) => {
            const outputHref = outputsHrefForPath(item.outputDir, { isDir: true });
            const outputMarkup = outputHref
                ? `<a class="task-action-link" href="${outputHref}" target="_blank" rel="noreferrer">Open output</a>`
                : "";

            return `
        <div class="legacy-card">
          <div class="task-head">
            <div class="task-title">
              <p>Legacy task</p>
              <h3>${escapeHtml(item.name)}</h3>
              <a class="task-url" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(hostLabel(item.url))}</a>
            </div>
            <div class="task-summary">
              ${item.blocked ? '<span class="status-pill danger">Blocked</span>' : ""}
              ${item.running ? '<span class="status-pill warning">Running</span>' : ""}
              ${!item.blocked && !item.running ? '<span class="status-pill success">Ready</span>' : ""}
            </div>
          </div>
          <div class="legacy-grid">
            ${metaCell("Interval", `${item.intervalSec}s`)}
            ${nextCheckMetaCell(item)}
            ${metaCell("Last Check", fmtDate(item.lastCheckAt))}
            ${metaCell("Last Error", item.lastError ? escapeHtml(item.lastError) : "-")}
          </div>
          <div class="legacy-actions">
            ${outputMarkup}
          </div>
        </div>
      `;
        })
        .join("");

    updateCountdownLabels();
}

function renderAttention() {
    const items = attentionStatuses();

    if (items.length === 0) {
        refs.attentionList.innerHTML = `
      <div class="empty-card">
        <h3>No tasks need review</h3>
        <p>Blocked tasks and recent task errors will surface here so they stay visible without taking over the whole panel.</p>
      </div>
    `;
        return;
    }

    refs.attentionList.innerHTML = items
        .map((item) => {
            const rawTaskId = item.source === "ui" ? item.id.replace(/^ui-/, "") : null;
            const unblockDisabled = state.pending.unblockTaskIds.has(rawTaskId);

            return `
        <div class="attention-card">
          <div class="task-head">
            <div class="task-title">
              <p>${escapeHtml(item.source.toUpperCase())} attention</p>
              <h3>${escapeHtml(item.name)}</h3>
              <p>${escapeHtml(hostLabel(item.url))}</p>
            </div>
            <div class="task-summary">
              ${item.blocked ? '<span class="status-pill danger">Blocked</span>' : ""}
              ${item.lastError ? '<span class="status-pill warning">Error</span>' : ""}
            </div>
          </div>
          ${item.blockedReason ? `<p>${escapeHtml(item.blockedReason)}</p>` : ""}
          ${item.lastError ? `<p>${escapeHtml(item.lastError)}</p>` : ""}
          <div class="button-row">
            ${rawTaskId ? `<button class="btn btn-ghost" type="button" data-action="edit-task" data-id="${escapeHtml(rawTaskId)}">Edit</button>` : ""}
            ${
                rawTaskId && item.blocked
                    ? `<button class="btn btn-danger" type="button" data-action="unblock-task" data-id="${escapeHtml(rawTaskId)}" ${unblockDisabled ? "disabled" : ""}>${unblockDisabled ? "Unblocking..." : "Unblock"}</button>`
                    : ""
            }
          </div>
        </div>
      `;
        })
        .join("");
}

function renderChanges() {
    refs.changeCount.textContent = String(state.changes.length);

    if (state.changes.length === 0) {
        const emptyMarkup = `
      <div class="empty-card">
        <h3>No saved changes yet</h3>
        <p>The first run establishes a baseline. Saved diff reports will appear here when a page actually changes.</p>
      </div>
    `;
        refs.stageChangePreview.innerHTML = emptyMarkup;
        refs.changeList.innerHTML = emptyMarkup;
        return;
    }

    const renderItem = (item, { compact = false } = {}) => {
        const href = outputsHrefForPath(item.savedPath, { isDir: false });
        const isNew = state.newChangeKeys.has(changeKey(item));
        const sourceLabel = escapeHtml(item.source.toUpperCase());
        const taskName = escapeHtml(item.taskName);
        const fileLabel = escapeHtml(compact ? basenameForPath(item.savedPath) : item.savedPath);
        const titleLabel = compact ? fileLabel : taskName;
        const subLabel = compact ? taskName : sourceLabel;
        const fileMarkup = href
            ? `<a class="task-url" href="${href}" target="_blank" rel="noreferrer">${fileLabel}</a>`
            : `<span class="task-url">${fileLabel}</span>`;

        return `
      <div class="signal-item${isNew ? " is-new" : ""}">
        <div class="signal-head">
          <div class="signal-title">
            <p>${subLabel}</p>
            <h3>${titleLabel}</h3>
          </div>
          ${isNew ? '<span class="status-pill success">New</span>' : ""}
        </div>
        <div class="signal-meta">${fmtDate(item.timestamp)}</div>
        ${fileMarkup}
      </div>
    `;
    };

    refs.stageChangePreview.innerHTML = state.changes.slice(0, 5).map((item) => renderItem(item, { compact: true })).join("");
    refs.changeList.innerHTML = state.changes.slice(0, 20).map((item) => renderItem(item)).join("");
}

function renderStageTaskPreview() {
    const tasks = stagePreviewTasks();

    if (tasks.length === 0) {
        refs.stageTaskPreview.innerHTML = `
      <div class="empty-card">
        <h3>No monitors yet</h3>
        <p>Create the first watch target, then start the engine when you want the baseline cycle to begin.</p>
        <div class="button-row">
          <button class="btn btn-primary" type="button" data-action="create-task">Create first monitor</button>
        </div>
      </div>
    `;
        return;
    }

    refs.stageTaskPreview.innerHTML = tasks
        .map((task) => {
            const status = getStatus(`ui-${task.id}`);
            const tonePill = status?.blocked
                ? '<span class="status-pill danger">Blocked</span>'
                : status?.running
                  ? '<span class="status-pill warning">Running</span>'
                  : task.enabled
                    ? '<span class="status-pill success">Ready</span>'
                    : '<span class="status-pill muted">Disabled</span>';

            return `
        <div class="preview-item">
          <div class="preview-head">
            <div class="preview-title">
              <p>${escapeHtml(hostLabel(task.url))}</p>
              <h3>${escapeHtml(task.name)}</h3>
            </div>
            ${tonePill}
          </div>
          <div class="signal-meta">
            <span class="next-check" data-next-check="${escapeHtml(status?.nextCheckAt ?? "")}" data-running="${status?.running ? "1" : "0"}" data-queued="${status?.queued ? "1" : "0"}" data-enabled="${task.enabled ? "1" : "0"}" data-blocked="${status?.blocked ? "1" : "0"}">-</span>
          </div>
          <div class="button-row">
            <button class="btn btn-ghost" type="button" data-action="edit-task" data-id="${escapeHtml(task.id)}">Edit</button>
          </div>
        </div>
      `;
        })
        .join("");

    updateCountdownLabels();
}

function renderTaskList() {
    const tasks = filteredUiTasks();

    if (tasks.length === 0 && state.uiTasks.length === 0) {
        refs.taskList.innerHTML = `
      <div class="empty-card">
        <h3>No tasks yet</h3>
        <p>Start with one stable page, save it, and let the first run establish a baseline.</p>
        <div class="button-row">
          <button class="btn btn-primary" type="button" data-action="create-task">Create your first task</button>
        </div>
      </div>
    `;
        return;
    }

    if (tasks.length === 0) {
        refs.taskList.innerHTML = `
      <div class="empty-card">
        <h3>No tasks match this view</h3>
        <p>Try a broader search or switch the filter back to all tasks.</p>
        <div class="button-row">
          <button class="btn btn-ghost" type="button" data-action="clear-filters">Clear filters</button>
        </div>
      </div>
    `;
        return;
    }

    refs.taskList.innerHTML = tasks.map((task) => taskCardHtml(task)).join("");
    updateCountdownLabels();
}

function metaCell(label, valueHtml) {
    return `
    <div class="meta-cell">
      <span>${escapeHtml(label)}</span>
      <strong>${valueHtml}</strong>
    </div>
  `;
}

function nextCheckMetaCell(item) {
    return metaCell(
        "Next Check",
        `<span class="next-check" data-next-check="${escapeHtml(item.nextCheckAt ?? "")}" data-running="${item.running ? "1" : "0"}" data-queued="${item.queued ? "1" : "0"}" data-enabled="${item.enabled ? "1" : "0"}" data-blocked="${item.blocked ? "1" : "0"}">-</span>`
    );
}

function taskCardHtml(task) {
    const status = getStatus(`ui-${task.id}`);
    const outputHref = outputsHrefForPath(task.outputDir, { isDir: true });
    const toggleDisabled = state.pending.toggleTaskIds.has(task.id);
    const unblockDisabled = state.pending.unblockTaskIds.has(task.id);
    const deleteDisabled = state.pending.deleteTaskIds.has(task.id);
    const confirmDelete = state.confirmDeleteTaskId === task.id;
    const classes = [
        "task-card",
        task.enabled ? "" : "is-disabled",
        status?.blocked || status?.lastError ? "is-attention" : "",
        status?.running ? "is-running" : "",
    ]
        .filter(Boolean)
        .join(" ");
    const lastErrorMarkup = status?.lastError
        ? `<div class="task-alert danger">${escapeHtml(status.lastError)}</div>`
        : "";
    const blockedMarkup = status?.blockedReason
        ? `<div class="task-alert warning">${escapeHtml(status.blockedReason)}</div>`
        : "";

    return `
    <div class="${classes}">
      <div class="task-head">
        <div class="task-title">
          <p>${escapeHtml(hostLabel(task.url))}</p>
          <h3>${escapeHtml(task.name)}</h3>
          <a class="task-url" href="${escapeHtml(task.url)}" target="_blank" rel="noreferrer">${escapeHtml(task.url)}</a>
        </div>
        <label class="toggle-pill">
          <input type="checkbox" data-action="toggle-task" data-id="${escapeHtml(task.id)}" ${task.enabled ? "checked" : ""} ${toggleDisabled ? "disabled" : ""} />
          <span>${toggleDisabled ? "Updating" : task.enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>

      <div class="task-summary">
        ${status?.running ? '<span class="status-pill warning">Running</span>' : ""}
        ${status?.queued ? '<span class="status-pill">Queued</span>' : ""}
        ${status?.blocked ? '<span class="status-pill danger">Blocked</span>' : ""}
        ${!status?.running && !status?.queued && !status?.blocked && task.enabled ? '<span class="status-pill success">Ready</span>' : ""}
        ${!task.enabled ? '<span class="status-pill muted">Disabled</span>' : ""}
      </div>

      <div class="task-meta-grid">
        ${metaCell("Interval", `${task.intervalSec}s`)}
        ${metaCell("Wait", escapeHtml(formatWaitSummary(task)))}
        ${nextCheckMetaCell({
            nextCheckAt: status?.nextCheckAt ?? "",
            running: Boolean(status?.running),
            queued: Boolean(status?.queued),
            enabled: Boolean(task.enabled),
            blocked: Boolean(status?.blocked),
        })}
        ${metaCell("Output", outputHref ? `<a href="${outputHref}" target="_blank" rel="noreferrer">${escapeHtml(task.outputDir)}</a>` : escapeHtml(task.outputDir))}
        ${metaCell("Last Check", escapeHtml(fmtDate(status?.lastCheckAt ?? null)))}
        ${metaCell("Last Change", escapeHtml(fmtDate(status?.lastChangeAt ?? null)))}
      </div>

      ${blockedMarkup}
      ${lastErrorMarkup}

      <div class="task-actions">
        <a class="task-action-link" href="${escapeHtml(task.url)}" target="_blank" rel="noreferrer">Open page</a>
        ${outputHref ? `<a class="task-action-link" href="${outputHref}" target="_blank" rel="noreferrer">Open output</a>` : ""}
        <button class="btn btn-ghost" type="button" data-action="edit-task" data-id="${escapeHtml(task.id)}">Edit</button>
        ${
            status?.blocked
                ? `<button class="btn btn-danger" type="button" data-action="unblock-task" data-id="${escapeHtml(task.id)}" ${unblockDisabled ? "disabled" : ""}>${unblockDisabled ? "Unblocking..." : "Unblock"}</button>`
                : ""
        }
        <button class="btn btn-danger" type="button" data-action="delete-task" data-id="${escapeHtml(task.id)}" ${deleteDisabled ? "disabled" : ""}>${deleteDisabled ? "Deleting..." : "Delete"}</button>
      </div>

      ${
          confirmDelete
              ? `
        <div class="confirm-card">
          <p class="confirm-copy">Delete this monitor from the active queue? Existing output files stay on disk.</p>
          <div class="button-row">
            <button class="btn btn-danger" type="button" data-action="confirm-delete-task" data-id="${escapeHtml(task.id)}" ${deleteDisabled ? "disabled" : ""}>${deleteDisabled ? "Deleting..." : "Delete Monitor"}</button>
            <button class="btn btn-ghost" type="button" data-action="cancel-delete-task" data-id="${escapeHtml(task.id)}" ${deleteDisabled ? "disabled" : ""}>Cancel</button>
          </div>
        </div>
      `
              : ""
      }
    </div>
  `;
}

function syncRuntimeInputsFromEngine(force = false) {
    if (!state.engine) {
        return;
    }
    if (state.runtimeDirty && !force) {
        return;
    }

    refs.headlessToggle.checked = Boolean(state.engine.launchHeadless);
    refs.includeLegacyToggle.checked = Boolean(state.engine.includeLegacyTasks);

    if (state.engine.mode === "attach") {
        refs.maxConcurrencyInput.value = "1";
    } else {
        const concurrency = Number(state.engine.configuredMaxConcurrency ?? state.engine.maxConcurrency ?? 3);
        refs.maxConcurrencyInput.value = Number.isFinite(concurrency) && concurrency > 0 ? String(Math.floor(concurrency)) : "3";
    }

    refs.userAgentInput.value = String(state.engine.userAgent ?? "");
    refs.acceptLanguageInput.value = String(state.engine.acceptLanguage ?? "");
}

function getRuntimeFormValues() {
    const rawConcurrency = refs.maxConcurrencyInput.value.trim();
    const parsedConcurrency = rawConcurrency ? Number(rawConcurrency) : Number.NaN;
    return {
        launchHeadless: refs.headlessToggle.checked,
        includeLegacyTasks: refs.includeLegacyToggle.checked,
        maxConcurrency: Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? Math.floor(parsedConcurrency) : null,
        userAgent: refs.userAgentInput.value.trim(),
        acceptLanguage: refs.acceptLanguageInput.value.trim(),
    };
}

function refreshRuntimeDirty() {
    if (!state.engine) {
        state.runtimeDirty = false;
        return;
    }

    const values = getRuntimeFormValues();
    const launchChanged =
        state.engine.mode !== "attach" && Boolean(state.engine.launchHeadless) !== Boolean(values.launchHeadless);
    const legacyChanged = Boolean(state.engine.includeLegacyTasks) !== Boolean(values.includeLegacyTasks);
    const concurrencyChanged =
        state.engine.mode !== "attach" &&
        values.maxConcurrency !== null &&
        Number(state.engine.configuredMaxConcurrency ?? state.engine.maxConcurrency ?? 1) !== values.maxConcurrency;
    const userAgentChanged = String(state.engine.userAgent ?? "").trim() !== values.userAgent;
    const acceptLanguageChanged = String(state.engine.acceptLanguage ?? "").trim() !== values.acceptLanguage;

    state.runtimeDirty = launchChanged || legacyChanged || concurrencyChanged || userAgentChanged || acceptLanguageChanged;
}

function refreshUrlHint() {
    const urlValue = refs.urlInput.value.trim();
    if (!urlValue) {
        refs.urlInput.classList.remove("input-invalid", "input-valid");
        refs.urlHint.textContent = "Paste the page you want to watch. Use an http:// or https:// address.";
        refs.urlHint.classList.remove("micro-copy-danger");
        return;
    }

    if (isHttpUrl(urlValue)) {
        refs.urlInput.classList.remove("input-invalid");
        refs.urlInput.classList.add("input-valid");
        refs.urlHint.textContent = "Looks good. The task name and output folder can follow from this.";
        refs.urlHint.classList.remove("micro-copy-danger");
        return;
    }

    refs.urlInput.classList.add("input-invalid");
    refs.urlInput.classList.remove("input-valid");
    refs.urlHint.textContent = "Invalid URL. Use an http:// or https:// address.";
    refs.urlHint.classList.add("micro-copy-danger");
}

function maybeAutoFillNameFromUrl() {
    if (refs.nameInput.value.trim()) {
        return;
    }
    const urlValue = refs.urlInput.value.trim();
    if (!isHttpUrl(urlValue)) {
        return;
    }

    try {
        const parsed = new URL(urlValue);
        refs.nameInput.value = parsed.hostname.replace(/^www\./, "");
    } catch {
        // Ignore parse failures; the inline hint already shows the invalid state.
    }
}

function updateSuggestedOutputDir() {
    if (state.outputDirTouched) {
        return;
    }
    const slug = slugify(refs.nameInput.value);
    refs.outputDirInput.value = slug ? `outputs/${slug}` : "";
}

function refreshFormValidity() {
    const hasName = Boolean(refs.nameInput.value.trim());
    const hasUrl = isHttpUrl(refs.urlInput.value.trim());
    const interval = Number(refs.intervalInput.value);
    const waitTimeoutValue = refs.waitTimeoutInput.value.trim();
    const waitTimeout = waitTimeoutValue ? Number(waitTimeoutValue) : 0;
    const validWaitTimeout = Number.isFinite(waitTimeout) && waitTimeout >= 0;
    const validInterval = Number.isFinite(interval) && interval > 0;

    refs.submitTaskBtn.disabled = !hasName || !hasUrl || !validInterval || !validWaitTimeout || state.pending.save;
}

function resetForm() {
    state.editingTaskId = null;
    state.outputDirTouched = false;
    refs.taskForm.reset();
    refs.intervalInput.value = "60";
    refs.waitLoadInput.value = "load";
    refs.waitTimeoutInput.value = "0";
    refs.enabledInput.checked = true;
    renderComposeState();
}

function fillForm(task) {
    state.editingTaskId = task.id;
    state.outputDirTouched = true;

    refs.nameInput.value = task.name;
    refs.urlInput.value = task.url;
    refs.intervalInput.value = `${task.intervalSec}`;
    refs.waitLoadInput.value = task.waitLoad || "load";
    refs.waitSelectorInput.value = task.waitSelector || "";
    refs.waitTimeoutInput.value = task.waitTimeoutSec ? `${task.waitTimeoutSec}` : "0";
    refs.compareSelectorInput.value = task.compareSelector || "";
    refs.requiredKeywordInput.value = task.requiredKeyword || "";
    refs.ignoreSelectorsInput.value = Array.isArray(task.ignoreSelectors) ? task.ignoreSelectors.join("\n") : "";
    refs.ignoreTextRegexInput.value = task.ignoreTextRegex || "";
    refs.outputDirInput.value = task.outputDir || "";
    refs.enabledInput.checked = Boolean(task.enabled);

    renderComposeState();
}

function renderAll() {
    renderHeader();
    setActiveTab(state.activeTab);
    renderComposeState();
    renderOverview();
    renderRuntime();
    renderLegacyTasks();
    renderAttention();
    renderChanges();
    updateCountdownLabels();
}

async function refresh() {
    if (state.pending.refresh) {
        return;
    }

    state.pending.refresh = true;
    renderHeader();

    try {
        const previousChangeKeys = new Set(state.changes.map((item) => changeKey(item)));
        const wasHydrated = state.hasHydrated;

        const [engine, taskData, changeData] = await Promise.all([
            request("/api/state"),
            request("/api/tasks"),
            request("/api/changes?limit=30"),
        ]);

        state.engine = engine;
        state.uiTasks = taskData.uiTasks || [];
        state.legacyTasks = taskData.legacyTasks || [];
        state.statuses = new Map((taskData.statuses || []).map((item) => [item.id, item]));
        state.changes = changeData.changes || [];

        const newChanges = wasHydrated
            ? state.changes.filter((item) => !previousChangeKeys.has(changeKey(item)))
            : [];

        state.newChangeKeys = new Set(newChanges.map((item) => changeKey(item)));
        if (!state.hasHydrated) {
            state.hasHydrated = true;
        }

        syncRuntimeInputsFromEngine();
        if (state.editingTaskId && !state.uiTasks.some((task) => task.id === state.editingTaskId)) {
            resetForm();
            showNotice("The task being edited no longer exists, so the draft was reset.", {
                title: "Draft reset",
                tone: "info",
            });
        }

        renderAll();

        if (wasHydrated && newChanges.length > 0) {
            showNotice(
                newChanges.length === 1
                    ? "A fresh diff report is ready in the signal feed."
                    : `${newChanges.length} fresh diff reports are ready in the signal feed.`,
                {
                    title: newChanges.length === 1 ? "New change saved" : "New changes saved",
                    tone: "success",
                }
            );
        }
    } catch (error) {
        showErrorNotice(error);
    } finally {
        state.pending.refresh = false;
        renderHeader();
        updateCountdownLabels();
    }
}

async function startMonitoring() {
    if (!hasAnyTasks()) {
        showNotice("Create a task first. The engine will not start with an empty queue.", {
            title: "Nothing to run",
            tone: "error",
        });
        openCompose();
        return;
    }

    state.pending.start = true;
    renderOverview();
    renderHeader();

    try {
        await request("/api/engine/start", { method: "POST" });
        showNotice("Checks are running. Fresh diffs will appear here as they land.", {
            title: "Monitoring live",
            tone: "success",
        });
        await refresh();
    } catch (error) {
        showErrorNotice(error);
    } finally {
        state.pending.start = false;
        renderOverview();
        renderHeader();
    }
}

async function stopMonitoring() {
    state.pending.stop = true;
    renderOverview();
    renderHeader();

    try {
        await request("/api/engine/stop", { method: "POST" });
        showNotice("The queue is preserved. Start monitoring again when you want the next pass to begin.", {
            title: "Monitoring paused",
            tone: "info",
        });
        await refresh();
    } catch (error) {
        showErrorNotice(error);
    } finally {
        state.pending.stop = false;
        renderOverview();
        renderHeader();
    }
}

async function applyRuntimeChanges() {
    if (!state.engine) {
        return;
    }

    refreshRuntimeDirty();
    if (!state.runtimeDirty) {
        showNotice("There are no runtime changes to apply right now.", {
            title: "No runtime changes",
            tone: "info",
        });
        renderRuntime();
        return;
    }

    const values = getRuntimeFormValues();
    if (state.engine.mode !== "attach" && (!Number.isFinite(values.maxConcurrency) || values.maxConcurrency <= 0)) {
        showNotice("Max concurrency must be a positive number.", {
            title: "Invalid runtime value",
            tone: "error",
        });
        return;
    }

    if (state.engine.running && !state.confirmRuntimeApply) {
        state.confirmRuntimeApply = true;
        renderRuntime();
        return;
    }

    const payload = {
        includeLegacyTasks: values.includeLegacyTasks,
    };

    if (state.engine.mode !== "attach") {
        payload.launchHeadless = values.launchHeadless;
        payload.maxConcurrency = values.maxConcurrency;
    }

    if (String(state.engine.userAgent ?? "").trim() !== values.userAgent) {
        payload.userAgent = values.userAgent;
    }
    if (String(state.engine.acceptLanguage ?? "").trim() !== values.acceptLanguage) {
        payload.acceptLanguage = values.acceptLanguage;
    }

    state.pending.applyRuntime = true;
    state.confirmRuntimeApply = false;
    renderRuntime();
    renderHeader();

    try {
        const result = await request("/api/runtime", {
            method: "PUT",
            body: JSON.stringify(payload),
        });

        if (result?.state) {
            state.engine = result.state;
        }

        syncRuntimeInputsFromEngine(true);
        refreshRuntimeDirty();
        showNotice("The updated runtime settings are active for the next checks.", {
            title: "Runtime updated",
            tone: "success",
        });
        await refresh();
    } catch (error) {
        showErrorNotice(error);
    } finally {
        state.pending.applyRuntime = false;
        state.confirmRuntimeApply = false;
        renderRuntime();
        renderHeader();
    }
}

function buildTaskPayload() {
    const waitTimeoutRaw = refs.waitTimeoutInput.value.trim();
    const waitTimeoutSec = waitTimeoutRaw ? Number(waitTimeoutRaw) : 0;

    return {
        waitTimeoutSec,
        payload: {
            name: refs.nameInput.value.trim(),
            url: refs.urlInput.value.trim(),
            intervalSec: Number(refs.intervalInput.value),
            waitLoad: refs.waitLoadInput.value,
            waitSelector: refs.waitSelectorInput.value.trim(),
            waitTimeoutSec,
            compareSelector: refs.compareSelectorInput.value.trim(),
            requiredKeyword: refs.requiredKeywordInput.value.trim(),
            ignoreSelectors: refs.ignoreSelectorsInput.value,
            ignoreTextRegex: refs.ignoreTextRegexInput.value.trim(),
            outputDir: refs.outputDirInput.value.trim(),
            enabled: refs.enabledInput.checked,
        },
    };
}

async function handleTaskSubmit(event) {
    event.preventDefault();
    refreshFormValidity();
    if (refs.submitTaskBtn.disabled) {
        showNotice("Name, URL, and interval are required before this monitor can be saved.", {
            title: "Incomplete task",
            tone: "error",
        });
        return;
    }

    const { waitTimeoutSec, payload } = buildTaskPayload();
    if (!Number.isFinite(waitTimeoutSec) || waitTimeoutSec < 0) {
        showNotice("Extra wait must be a number greater than or equal to 0.", {
            title: "Invalid task value",
            tone: "error",
        });
        return;
    }

    const editing = Boolean(state.editingTaskId);

    state.pending.save = true;
    renderComposeState();
    renderHeader();

    try {
        if (editing) {
            await request(`/api/tasks/${encodeURIComponent(state.editingTaskId)}`, {
                method: "PUT",
                body: JSON.stringify(payload),
            });
            showNotice("The updated monitor settings will apply on the next check.", {
                title: "Task updated",
                tone: "success",
            });
        } else {
            await request("/api/tasks", {
                method: "POST",
                body: JSON.stringify(payload),
            });
            showNotice("This monitor is now part of the active queue.", {
                title: "Task created",
                tone: "success",
            });
        }

        resetForm();
        setActiveTab("overview");
        await refresh();
    } catch (error) {
        showErrorNotice(error);
    } finally {
        state.pending.save = false;
        renderComposeState();
        renderHeader();
    }
}

function openCompose(task = null) {
    ensurePanelOpen();
    setActiveTab("compose");
    if (task) {
        fillForm(task);
    } else {
        resetForm();
    }
    refs.nameInput.focus();
}

function clearTaskFilters() {
    state.taskSearch = "";
    state.taskFilter = "all";
    refs.taskSearchInput.value = "";
    refs.taskFilterSelect.value = "all";
    renderOverview();
}

async function deleteTask(taskId) {
    state.pending.deleteTaskIds.add(taskId);
    renderTaskList();

    try {
        await request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
        if (state.editingTaskId === taskId) {
            resetForm();
        }
        state.confirmDeleteTaskId = null;
        showNotice("This monitor has been removed from the queue.", {
            title: "Task deleted",
            tone: "info",
        });
        await refresh();
    } catch (error) {
        showErrorNotice(error);
    } finally {
        state.pending.deleteTaskIds.delete(taskId);
        renderTaskList();
    }
}

async function unblockTask(taskId) {
    state.pending.unblockTaskIds.add(taskId);
    renderTaskList();
    renderAttention();

    try {
        await request(`/api/tasks/${encodeURIComponent(taskId)}/unblock`, { method: "POST" });
        showNotice("The monitor can retry on its next scheduled pass.", {
            title: "Task unblocked",
            tone: "success",
        });
        await refresh();
    } catch (error) {
        showErrorNotice(error);
    } finally {
        state.pending.unblockTaskIds.delete(taskId);
        renderTaskList();
        renderAttention();
    }
}

async function toggleTask(taskId, enabled) {
    state.pending.toggleTaskIds.add(taskId);
    renderTaskList();

    try {
        await request(`/api/tasks/${encodeURIComponent(taskId)}`, {
            method: "PUT",
            body: JSON.stringify({ enabled }),
        });
        await refresh();
    } catch (error) {
        showErrorNotice(error);
        await refresh();
    } finally {
        state.pending.toggleTaskIds.delete(taskId);
        renderTaskList();
    }
}

function findTaskById(taskId) {
    return state.uiTasks.find((item) => item.id === taskId) || null;
}

function handleActionClick(event) {
    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) {
        return;
    }

    const action = actionElement.dataset.action;
    const taskId = actionElement.dataset.id;

    if (action === "create-task") {
        openCompose();
        return;
    }

    if (action === "clear-filters") {
        clearTaskFilters();
        return;
    }

    if (action === "edit-task" && taskId) {
        const task = findTaskById(taskId);
        if (!task) {
            showNotice("That task is no longer available.", {
                title: "Task missing",
                tone: "error",
            });
            return;
        }
        openCompose(task);
        return;
    }

    if (action === "delete-task" && taskId) {
        state.confirmDeleteTaskId = taskId;
        renderTaskList();
        return;
    }

    if (action === "cancel-delete-task") {
        state.confirmDeleteTaskId = null;
        renderTaskList();
        return;
    }

    if (action === "confirm-delete-task" && taskId) {
        void deleteTask(taskId);
        return;
    }

    if (action === "unblock-task" && taskId) {
        void unblockTask(taskId);
    }
}

function handleActionChange(event) {
    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) {
        return;
    }

    const action = actionElement.dataset.action;
    const taskId = actionElement.dataset.id;

    if (action === "toggle-task" && taskId) {
        void toggleTask(taskId, actionElement.checked);
    }
}

refs.feedbackCloseBtn.addEventListener("click", hideNotice);

refs.panelSummaryBtn.addEventListener("click", () => {
    setCollapsed(!state.collapsed);
});

refs.collapseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setCollapsed(!state.collapsed);
});

refs.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
        ensurePanelOpen();
        setActiveTab(button.dataset.tabButton);
    });
});

refs.composeFromStageBtn.addEventListener("click", () => {
    openCompose();
});

refs.newTaskBtn.addEventListener("click", () => {
    openCompose();
});

refs.startBtn.addEventListener("click", () => {
    void startMonitoring();
});

refs.stopBtn.addEventListener("click", () => {
    void stopMonitoring();
});

refs.resetFormBtn.addEventListener("click", () => {
    resetForm();
});

refs.cancelEditBtn.addEventListener("click", () => {
    resetForm();
});

refs.taskForm.addEventListener("submit", (event) => {
    void handleTaskSubmit(event);
});

refs.taskSearchInput.addEventListener("input", () => {
    state.taskSearch = refs.taskSearchInput.value;
    renderOverview();
});

refs.taskFilterSelect.addEventListener("change", () => {
    state.taskFilter = refs.taskFilterSelect.value;
    renderOverview();
});

refs.nameInput.addEventListener("input", () => {
    updateSuggestedOutputDir();
    refreshFormValidity();
});

refs.urlInput.addEventListener("input", () => {
    refreshUrlHint();
    maybeAutoFillNameFromUrl();
    updateSuggestedOutputDir();
    refreshFormValidity();
});

refs.intervalInput.addEventListener("input", refreshFormValidity);
refs.waitTimeoutInput.addEventListener("input", refreshFormValidity);

refs.outputDirInput.addEventListener("input", () => {
    state.outputDirTouched = Boolean(refs.outputDirInput.value.trim());
});

refs.headlessToggle.addEventListener("change", () => {
    refreshRuntimeDirty();
    renderRuntime();
});

refs.includeLegacyToggle.addEventListener("change", () => {
    refreshRuntimeDirty();
    renderRuntime();
});

refs.maxConcurrencyInput.addEventListener("input", () => {
    refreshRuntimeDirty();
    renderRuntime();
});

refs.userAgentInput.addEventListener("input", () => {
    refreshRuntimeDirty();
    renderRuntime();
});

refs.acceptLanguageInput.addEventListener("input", () => {
    refreshRuntimeDirty();
    renderRuntime();
});

refs.applyRuntimeBtn.addEventListener("click", () => {
    void applyRuntimeChanges();
});

refs.runtimeConfirmBtn.addEventListener("click", () => {
    void applyRuntimeChanges();
});

refs.runtimeCancelBtn.addEventListener("click", () => {
    state.confirmRuntimeApply = false;
    renderRuntime();
});

document.addEventListener("click", handleActionClick);
document.addEventListener("change", handleActionChange);

resetForm();
syncRuntimeInputsFromEngine();
renderAll();
void refresh();

window.setInterval(() => {
    void refresh();
}, 3000);

window.setInterval(() => {
    updateCountdownLabels();
}, 1000);
