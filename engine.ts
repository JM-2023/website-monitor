import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import puppeteerCore from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import { formatISO9075 } from "date-fns";
import { createDiffReportHtml } from "./diff-report.js";
import { calculateSimilarity, injectDOMHelpers, sanitizeFilename } from "./helpers.js";
import type {
    ChangeRecord,
    ExtractedResource,
    RuntimeOptions,
    RuntimeMode,
    RuntimeTaskStatus,
    TaskOptions,
    UiTaskConfig,
} from "./types.js";

interface TasksModule {
    TASKS: TaskOptions[];
}

interface RuntimeTask {
    id: string;
    source: "ui" | "legacy";
    name: string;
    url: string;
    outputDir: string;
    enabled: boolean;
    options: TaskOptions;
    active: boolean;
    timer?: ReturnType<typeof setTimeout>;
    lastText: string;
    lastRenderedHtml: string;
    lastResources: string[];
    blocked: boolean;
    blockedReason: string | null;
    blockedAt: string | null;
}

interface EngineSnapshot {
    running: boolean;
    browserConnected: boolean;
    mode: RuntimeOptions["mode"];
    launchHeadless: boolean;
    browserUrl: string;
    includeLegacyTasks: boolean;
    userAgent?: string;
    acceptLanguage?: string;
    uiTaskCount: number;
    legacyTaskCount: number;
    taskCount: number;
    lastError: string | null;
}

const FALLBACK_INTERVAL_SECONDS = 60;
const MAX_CHANGE_RECORDS = 300;
const DEFAULT_TASKS_FILE = path.resolve(".out/tasks.js");

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function resolveChromeExecutable(explicitPath?: string): Promise<string> {
    const candidates = [
        explicitPath,
        process.env.WM_CHROME_EXECUTABLE,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ].filter((item): item is string => Boolean(item));

    for (const candidate of candidates) {
        if (await pathExists(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        'Chrome executable not found. Set WM_CHROME_EXECUTABLE or install Google Chrome under "/Applications".'
    );
}

function resolveIntervalSeconds(interval: TaskOptions["interval"]): number {
    const value = typeof interval === "function" ? interval() : interval;
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Task interval must be a positive number. Received "${value}".`);
    }
    return Math.max(1, Math.floor(value));
}

function formatTaskName(task: TaskOptions, source: "ui" | "legacy", index: number): string {
    if (source === "ui") {
        return task.url;
    }
    const host = (() => {
        try {
            return new URL(task.url).host;
        } catch {
            return task.url;
        }
    })();
    return `Legacy ${index + 1}: ${host}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

function scheduleAtIso(delayMs: number): string {
    return new Date(Date.now() + Math.max(0, delayMs)).toISOString();
}

async function runTask(page: Page, options: TaskOptions) {
    const timeout = (options.timeout ?? 15) * 1000;

    await page.goto(options.url, {
        waitUntil: options.waitLoad ?? "load",
        timeout,
    });

    if (options.waitSelector) {
        await page.waitForSelector(options.waitSelector, { timeout });
    }

    const waitTimeout = options.waitTimeout;
    if (typeof waitTimeout === "number" && waitTimeout > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTimeout * 1000));
    }

    await page.evaluate(injectDOMHelpers);
    if (options.preprocess) {
        await page.evaluate(options.preprocess);
    }

    const data = (await page.evaluate(options.extract)) ?? "";
    const textToCompare = options.textToCompare ? (await page.evaluate(options.textToCompare)) ?? "" : data;
    const resourcesToCompare = options.resourcesToCompare ? await page.evaluate(options.resourcesToCompare) : [];
    const title = await page.title().catch(() => "");
    const finalUrl = page.url();
    return { data, textToCompare, resourcesToCompare, title, finalUrl };
}

function detectAntiBotPage(input: { title: string; html: string; text: string; finalUrl: string }): string | null {
    const title = input.title.toLowerCase();
    const html = input.html.toLowerCase();
    const text = input.text.toLowerCase();
    const finalUrl = input.finalUrl.toLowerCase();

    const hasCloudflareMarkers =
        html.includes("cf_chl_") ||
        html.includes("/cdn-cgi/challenge-platform/") ||
        html.includes("challenges.cloudflare.com/turnstile");
    if (hasCloudflareMarkers) {
        return "Cloudflare challenge page detected";
    }

    if (title.includes("just a moment")) {
        return "Cloudflare interstitial detected";
    }

    if (finalUrl.includes("/cdn-cgi/challenge-platform/")) {
        return "Cloudflare challenge URL detected";
    }

    return null;
}

async function captureScreenshotDataUrl(page: Page): Promise<string | undefined> {
    try {
        const base64 = (await page.screenshot({
            type: "jpeg",
            quality: 75,
            fullPage: true,
            encoding: "base64",
            captureBeyondViewport: true,
        })) as string;
        if (!base64) {
            return undefined;
        }
        return `data:image/jpeg;base64,${base64}`;
    } catch {
        return undefined;
    }
}

function getNameFromResourceId(id: string): string {
    try {
        return path.basename(new URL(id).pathname) || "resource.bin";
    } catch {
        return path.basename(id) || "resource.bin";
    }
}

export class MonitorEngine {
    private runtimeOptions: RuntimeOptions;
    private uiTasks: UiTaskConfig[] = [];
    private legacyOptions: TaskOptions[] = [];
    private tasks = new Map<string, RuntimeTask>();
    private statuses = new Map<string, RuntimeTaskStatus>();
    private changes: ChangeRecord[] = [];
    private browser: Browser | null = null;
    private browserManaged = false;
    private running = false;
    private lastError: string | null = null;
    private onUpdate: (() => void) | null = null;

    constructor(options: RuntimeOptions) {
        this.runtimeOptions = {
            ...options,
            tasksFile: options.tasksFile ?? DEFAULT_TASKS_FILE,
        };
    }

    setOnUpdate(listener: (() => void) | null): void {
        this.onUpdate = listener;
    }

    private emitUpdate(): void {
        this.onUpdate?.();
    }

    private setLastError(error: unknown): void {
        this.lastError = error instanceof Error ? error.message : String(error);
    }

    private clearLastError(): void {
        this.lastError = null;
    }

    getSnapshot(): EngineSnapshot {
        return {
            running: this.running,
            browserConnected: this.browser ? this.browser.isConnected() : false,
            mode: this.runtimeOptions.mode,
            launchHeadless: this.runtimeOptions.launchHeadless,
            browserUrl: this.runtimeOptions.browserUrl,
            includeLegacyTasks: this.runtimeOptions.includeLegacyTasks,
            userAgent: this.runtimeOptions.userAgent,
            acceptLanguage: this.runtimeOptions.acceptLanguage,
            uiTaskCount: this.uiTasks.length,
            legacyTaskCount: this.runtimeOptions.includeLegacyTasks ? this.legacyOptions.length : 0,
            taskCount: this.tasks.size,
            lastError: this.lastError,
        };
    }

    async applyRuntimeOptions(nextRuntime: {
        mode: RuntimeMode;
        browserUrl: string;
        includeLegacyTasks: boolean;
        launchHeadless: boolean;
        userAgent?: string;
        acceptLanguage?: string;
    }): Promise<void> {
        const unchanged =
            this.runtimeOptions.mode === nextRuntime.mode &&
            this.runtimeOptions.browserUrl === nextRuntime.browserUrl &&
            this.runtimeOptions.includeLegacyTasks === nextRuntime.includeLegacyTasks &&
            this.runtimeOptions.launchHeadless === nextRuntime.launchHeadless &&
            this.runtimeOptions.userAgent === nextRuntime.userAgent &&
            this.runtimeOptions.acceptLanguage === nextRuntime.acceptLanguage;
        if (unchanged) {
            return;
        }

        const wasRunning = this.running;
        if (wasRunning) {
            await this.stop();
        }

        this.runtimeOptions = {
            ...this.runtimeOptions,
            mode: nextRuntime.mode,
            browserUrl: nextRuntime.browserUrl,
            includeLegacyTasks: nextRuntime.includeLegacyTasks,
            launchHeadless: nextRuntime.launchHeadless,
            userAgent: nextRuntime.userAgent,
            acceptLanguage: nextRuntime.acceptLanguage,
        };

        await this.refreshLegacyTasks();
        this.rebuildRuntimeTasks();

        if (wasRunning) {
            await this.start();
        }
    }

    getTaskStatuses(): RuntimeTaskStatus[] {
        return Array.from(this.statuses.values())
            .map((status) => ({ ...status }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    getLegacySummaries(): RuntimeTaskStatus[] {
        return this.getTaskStatuses().filter((status) => status.source === "legacy");
    }

    getChanges(limit: number = 50): ChangeRecord[] {
        const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
        return this.changes.slice(0, safeLimit).map((item) => ({ ...item }));
    }

    setUiTasks(tasks: UiTaskConfig[]): void {
        this.uiTasks = tasks.map((task) => ({ ...task }));
        this.rebuildRuntimeTasks();
    }

    async refreshLegacyTasks(): Promise<void> {
        if (!this.runtimeOptions.includeLegacyTasks) {
            this.legacyOptions = [];
            this.rebuildRuntimeTasks();
            return;
        }

        const filePath = this.runtimeOptions.tasksFile ?? DEFAULT_TASKS_FILE;
        let options: TaskOptions[] = [];

        try {
            const moduleUrl = `${pathToFileURL(path.resolve(filePath)).href}?t=${Date.now()}`;
            const module = (await import(moduleUrl)) as Partial<TasksModule>;
            if (Array.isArray(module.TASKS)) {
                options = module.TASKS;
            } else {
                throw new Error(`Legacy tasks module "${filePath}" must export TASKS`);
            }
        } catch (error) {
            this.setLastError(error);
            options = [];
        }

        this.legacyOptions = options;
        this.rebuildRuntimeTasks();
    }

    private createUiTaskOptions(task: UiTaskConfig): TaskOptions {
        return {
            url: task.url,
            outputDir: task.outputDir,
            waitLoad: task.waitLoad ?? "load",
            waitSelector: task.waitSelector,
            waitTimeout: task.waitTimeoutSec,
            timeout: 20,
            textToCompare() {
                const clone = (document.body ?? document.documentElement).cloneNode(true);
                if (!(clone instanceof Element)) {
                    return "";
                }

                clone.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
                clone.querySelectorAll("[hidden],[aria-hidden='true']").forEach((node) => node.remove());
                clone.querySelectorAll(
                    "#mount,[id^='immersive-translate'],[class*='immersive-translate'],.imt-fb-container"
                ).forEach((node) => node.remove());

                const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
                const comments: Node[] = [];
                while (walker.nextNode()) {
                    comments.push(walker.currentNode);
                }
                comments.forEach((node) => node.parentNode?.removeChild(node));

                return (clone.textContent ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
            },
            extract() {
                const clone = document.documentElement?.cloneNode(true);
                if (!(clone instanceof Element)) {
                    return document.documentElement?.outerHTML ?? document.body.innerHTML;
                }

                clone.querySelectorAll("script,noscript,template").forEach((node) => node.remove());
                clone.querySelectorAll("meta[http-equiv='refresh']").forEach((node) => node.remove());
                clone.querySelectorAll("[nonce]").forEach((element) => element.removeAttribute("nonce"));
                clone.querySelectorAll(
                    "#mount,[id^='immersive-translate'],[class*='immersive-translate'],.imt-fb-container"
                ).forEach((node) => node.remove());
                clone.querySelectorAll("style").forEach((styleNode) => {
                    const content = styleNode.textContent ?? "";
                    if (content.includes("immersive-translate") || content.includes(".imt-fb-container")) {
                        styleNode.remove();
                    }
                });

                const head = clone.querySelector("head");
                if (head) {
                    head.querySelectorAll("base").forEach((node) => node.remove());
                    const base = document.createElement("base");
                    base.setAttribute("href", window.location.href);
                    head.prepend(base);
                }

                const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
                const comments: Node[] = [];
                while (walker.nextNode()) {
                    comments.push(walker.currentNode);
                }
                comments.forEach((node) => node.parentNode?.removeChild(node));

                return `<!doctype html>\n${clone.outerHTML}`;
            },
            interval: task.intervalSec,
        };
    }

    private createDescriptorFromOptions(
        id: string,
        source: "ui" | "legacy",
        name: string,
        enabled: boolean,
        options: TaskOptions
    ): RuntimeTask {
        return {
            id,
            source,
            name,
            url: options.url,
            outputDir: options.outputDir,
            enabled,
            options,
            active: false,
            lastText: "",
            lastRenderedHtml: "",
            lastResources: [],
            blocked: false,
            blockedReason: null,
            blockedAt: null,
        };
    }

    private rebuildRuntimeTasks(): void {
        const nextTasks = new Map<string, RuntimeTask>();

        for (const task of this.uiTasks) {
            const id = `ui-${task.id}`;
            const descriptor = this.createDescriptorFromOptions(
                id,
                "ui",
                task.name,
                task.enabled,
                this.createUiTaskOptions(task)
            );
            const previous = this.tasks.get(id);
            if (previous) {
                descriptor.lastText = previous.lastText;
                descriptor.lastRenderedHtml = previous.lastRenderedHtml;
                descriptor.lastResources = previous.lastResources;
                descriptor.active = previous.active;
                descriptor.blocked = previous.blocked;
                descriptor.blockedReason = previous.blockedReason;
                descriptor.blockedAt = previous.blockedAt;
            }
            nextTasks.set(id, descriptor);
        }

        if (this.runtimeOptions.includeLegacyTasks) {
            for (const [index, options] of this.legacyOptions.entries()) {
                const id = `legacy-${index + 1}`;
                const descriptor = this.createDescriptorFromOptions(
                    id,
                    "legacy",
                    formatTaskName(options, "legacy", index),
                    true,
                    options
                );
                const previous = this.tasks.get(id);
                if (previous) {
                    descriptor.lastText = previous.lastText;
                    descriptor.lastRenderedHtml = previous.lastRenderedHtml;
                    descriptor.lastResources = previous.lastResources;
                    descriptor.active = previous.active;
                    descriptor.blocked = previous.blocked;
                    descriptor.blockedReason = previous.blockedReason;
                    descriptor.blockedAt = previous.blockedAt;
                }
                nextTasks.set(id, descriptor);
            }
        }

        for (const [id, previous] of this.tasks.entries()) {
            if (!nextTasks.has(id) && previous.timer) {
                clearTimeout(previous.timer);
            }
        }

        this.tasks = nextTasks;
        this.syncStatusesWithTasks();

        if (this.running) {
            for (const task of this.tasks.values()) {
                if (task.timer) {
                    clearTimeout(task.timer);
                    task.timer = undefined;
                }
                if (task.enabled && !task.active) {
                    this.scheduleTask(task.id, 250);
                }
            }
        }

        this.emitUpdate();
    }

    private syncStatusesWithTasks(): void {
        const ids = new Set<string>();
        for (const task of this.tasks.values()) {
            ids.add(task.id);
            const current = this.statuses.get(task.id);
            const intervalSec = (() => {
                try {
                    return resolveIntervalSeconds(task.options.interval);
                } catch {
                    return FALLBACK_INTERVAL_SECONDS;
                }
            })();

            const status: RuntimeTaskStatus = {
                id: task.id,
                source: task.source,
                name: task.name,
                url: task.url,
                enabled: task.enabled,
                intervalSec,
                outputDir: task.outputDir,
                running: task.enabled ? current?.running ?? false : false,
                nextCheckAt: task.enabled ? current?.nextCheckAt ?? null : null,
                lastCheckAt: current?.lastCheckAt ?? null,
                lastChangeAt: current?.lastChangeAt ?? null,
                lastError: current?.lastError ?? null,
                lastSavedFile: current?.lastSavedFile ?? null,
                blocked: task.blocked,
                blockedReason: task.blockedReason,
                blockedAt: task.blockedAt,
            };
            if (task.blocked) {
                status.running = false;
                status.nextCheckAt = null;
            }
            this.statuses.set(task.id, status);
        }

        for (const id of Array.from(this.statuses.keys())) {
            if (!ids.has(id)) {
                this.statuses.delete(id);
            }
        }
    }

    async start(): Promise<void> {
        if (this.running) {
            return;
        }

        if (!this.tasks.size) {
            this.rebuildRuntimeTasks();
        }

        this.running = true;
        this.clearLastError();

        for (const task of this.tasks.values()) {
            if (task.enabled) {
                this.scheduleTask(task.id, 100);
            }
        }

        this.emitUpdate();
    }

    async stop(): Promise<void> {
        this.running = false;
        for (const task of this.tasks.values()) {
            if (task.timer) {
                clearTimeout(task.timer);
                task.timer = undefined;
            }
            task.active = false;
        }
        for (const status of this.statuses.values()) {
            status.running = false;
            status.nextCheckAt = null;
        }

        await this.teardownBrowser();
        this.emitUpdate();
    }

    unblockTask(id: string): boolean {
        const task = this.tasks.get(id);
        if (!task) {
            return false;
        }

        task.blocked = false;
        task.blockedReason = null;
        task.blockedAt = null;

        const status = this.statuses.get(id);
        if (status) {
            status.blocked = false;
            status.blockedReason = null;
            status.blockedAt = null;
            status.lastError = null;
            status.nextCheckAt = null;
        }

        if (this.running && task.enabled) {
            this.scheduleTask(id, 250);
        } else {
            this.emitUpdate();
        }

        return true;
    }

    private scheduleTask(id: string, delayMs: number): void {
        if (!this.running) {
            return;
        }

        const task = this.tasks.get(id);
        if (!task) {
            return;
        }

        if (task.timer) {
            clearTimeout(task.timer);
            task.timer = undefined;
        }

        const status = this.statuses.get(id);
        if (!task.enabled || task.blocked) {
            if (status) {
                status.nextCheckAt = null;
            }
            return;
        }

        if (status) {
            status.nextCheckAt = scheduleAtIso(delayMs);
        }

        task.timer = setTimeout(() => {
            void this.executeTask(id);
        }, Math.max(0, delayMs));

        this.emitUpdate();
    }

    private async executeTask(id: string): Promise<void> {
        if (!this.running) {
            return;
        }

        const task = this.tasks.get(id);
        if (!task || !task.enabled) {
            return;
        }

        if (task.blocked) {
            const status = this.statuses.get(id);
            if (status) {
                status.running = false;
                status.nextCheckAt = null;
            }
            return;
        }

        if (task.active) {
            this.scheduleTask(id, 1000);
            return;
        }

        task.active = true;
        const status = this.statuses.get(id);
        if (status) {
            status.running = true;
            status.lastError = null;
            status.nextCheckAt = null;
            this.emitUpdate();
        }

        try {
            await this.checkTask(task);
            this.clearLastError();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (status) {
                status.lastError = message;
            }
            this.setLastError(error);
        } finally {
            task.active = false;
            if (status) {
                status.running = false;
                status.lastCheckAt = nowIso();
            }
            this.emitUpdate();

            if (!this.running) {
                return;
            }

            const latest = this.tasks.get(id);
            if (!latest || !latest.enabled) {
                if (status) {
                    status.nextCheckAt = null;
                }
                return;
            }

            if (latest.blocked) {
                if (status) {
                    status.nextCheckAt = null;
                }
                return;
            }

            let nextSeconds = FALLBACK_INTERVAL_SECONDS;
            try {
                nextSeconds = resolveIntervalSeconds(latest.options.interval);
            } catch (error) {
                if (status) {
                    status.lastError = error instanceof Error ? error.message : String(error);
                }
            }
            if (status) {
                status.intervalSec = nextSeconds;
            }
            this.scheduleTask(id, nextSeconds * 1000);
        }
    }

    private async checkTask(task: RuntimeTask): Promise<void> {
        const browser = await this.ensureBrowser();
        const page = await browser.newPage();
        let savedFile: string | null = null;

        try {
            if (this.runtimeOptions.userAgent) {
                await page.setUserAgent(this.runtimeOptions.userAgent);
            } else if (this.runtimeOptions.mode === "launch" && this.runtimeOptions.launchHeadless) {
                // In headless launch mode, Chrome exposes "HeadlessChrome" in the UA string.
                // Normalize it to "Chrome" as a compatibility default (without hard-coding a UA).
                const ua = await browser.userAgent();
                const patched = ua.replaceAll("HeadlessChrome/", "Chrome/").replaceAll("HeadlessChrome ", "Chrome ");
                if (patched !== ua) {
                    await page.setUserAgent(patched);
                }
            }
            if (this.runtimeOptions.acceptLanguage) {
                await page.setExtraHTTPHeaders({
                    "Accept-Language": this.runtimeOptions.acceptLanguage,
                });
            }

            const time = formatISO9075(new Date()).replaceAll(":", "-");
            const { data, textToCompare, resourcesToCompare, title, finalUrl } = await runTask(page, task.options);
            const antiBotReason = detectAntiBotPage({
                title,
                html: data,
                text: textToCompare,
                finalUrl,
            });
            if (antiBotReason) {
                task.blocked = true;
                task.blockedReason = antiBotReason;
                task.blockedAt = nowIso();

                const status = this.statuses.get(task.id);
                if (status) {
                    status.blocked = true;
                    status.blockedReason = antiBotReason;
                    status.blockedAt = task.blockedAt;
                    status.nextCheckAt = null;
                    status.lastError =
                        `${antiBotReason}. Monitoring paused for this task. ` +
                        "Recommended: switch to attach mode using your regular Chrome session, complete the verification once, then click Unblock.";
                }

                return;
            }
            const previousText = task.lastText;
            const previousRenderedHtml = task.lastRenderedHtml;

            const similarity = calculateSimilarity(task.lastText, textToCompare);
            if (similarity !== 1) {
                const similarityStr = (similarity * 100).toFixed(2).padStart(5, "0");
                await fs.mkdir(task.outputDir, { recursive: true });
                const reportPath = path.join(task.outputDir, `${time} ${similarityStr}.diff.html`);
                const screenshotDataUrl = await captureScreenshotDataUrl(page);
                const diffHtml = createDiffReportHtml({
                    taskName: task.name,
                    url: task.url,
                    similarity,
                    previousText,
                    currentText: textToCompare,
                    screenshotDataUrl,
                    previousRenderedHtml,
                    currentRenderedHtml: data,
                    createdAt: nowIso(),
                });
                await fs.writeFile(reportPath, diffHtml);
                task.lastText = textToCompare;
                task.lastRenderedHtml = data;
                savedFile = reportPath;

                this.recordChange(task, savedFile);
            }

            if (resourcesToCompare.length >= task.lastResources.length) {
                const diff = resourcesToCompare.filter((resource) => !task.lastResources.includes(resource));
                const savedResources = await this.downloadChangedResources(page, task, diff, time);
                if (!savedFile && savedResources.length > 0) {
                    savedFile = savedResources[0];
                }
            }

            task.lastResources = resourcesToCompare;
        } finally {
            try {
                await page.close();
            } catch {}
        }

        const status = this.statuses.get(task.id);
        if (status && savedFile) {
            status.lastSavedFile = savedFile;
            status.lastChangeAt = nowIso();
        }
    }

    private recordChange(task: RuntimeTask, savedPath: string): void {
        const record: ChangeRecord = {
            id: `${task.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            taskId: task.id,
            taskName: task.name,
            source: task.source,
            savedPath,
            timestamp: nowIso(),
        };
        this.changes.unshift(record);
        if (this.changes.length > MAX_CHANGE_RECORDS) {
            this.changes.length = MAX_CHANGE_RECORDS;
        }
    }

    private async downloadChangedResources(
        page: Page,
        task: RuntimeTask,
        ids: string[],
        time: string
    ): Promise<string[]> {
        if (!ids.length) {
            return [];
        }

        if (!task.options.extractResource) {
            await fs.mkdir(task.outputDir, { recursive: true });
            const filePath = path.join(task.outputDir, `${time}.resources.txt`);
            await fs.writeFile(filePath, ids.join("\n"));
            this.recordChange(task, filePath);
            return [filePath];
        }

        const dir = path.join(task.outputDir, time);
        const savedPaths: string[] = [];
        const usedNames = new Set<string>();
        let counter = 0;

        await fs.mkdir(dir, { recursive: true });

        for (const id of ids) {
            const resources = await page.evaluate(task.options.extractResource, id);
            const entries = Array.isArray(resources) ? resources : [resources];

            for (const resource of entries) {
                const item = resource as ExtractedResource;
                counter++;
                const fallback = `resource-${counter}.bin`;
                const baseName = item.filename ?? getNameFromResourceId(id);
                let candidate = sanitizeFilename(baseName, fallback);
                const ext = path.extname(candidate);
                const stem = ext ? candidate.slice(0, -ext.length) : candidate;
                let suffix = 1;

                while (usedNames.has(candidate)) {
                    candidate = `${stem}-${suffix}${ext}`;
                    suffix++;
                }

                usedNames.add(candidate);
                const filePath = path.join(dir, candidate);
                await fs.writeFile(filePath, Buffer.from(item.encodedBuf, "base64"));
                savedPaths.push(filePath);
                this.recordChange(task, filePath);
            }
        }

        return savedPaths;
    }

    private async ensureBrowser(): Promise<Browser> {
        if (this.browser && this.browser.isConnected()) {
            return this.browser;
        }

        if (this.runtimeOptions.mode === "attach") {
            this.browser = await puppeteerCore.connect({
                browserURL: this.runtimeOptions.browserUrl,
                defaultViewport: null,
            });
            this.browserManaged = false;
            return this.browser;
        }

        const executablePath = await resolveChromeExecutable(this.runtimeOptions.chromeExecutable);
        this.browser = await puppeteerCore.launch({
            executablePath,
            headless: this.runtimeOptions.launchHeadless,
            pipe: true,
            defaultViewport: null,
            userDataDir: path.resolve(".chrome-profile"),
            args: ["--no-first-run", "--no-default-browser-check"],
        });
        this.browserManaged = true;
        return this.browser;
    }

    private async teardownBrowser(): Promise<void> {
        if (!this.browser) {
            return;
        }

        try {
            if (this.browserManaged) {
                await this.browser.close();
            } else {
                this.browser.disconnect();
            }
        } catch (error) {
            this.setLastError(error);
        } finally {
            this.browser = null;
            this.browserManaged = false;
        }
    }
}
