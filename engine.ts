import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { createHash } from "crypto";
import puppeteerCore from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import { formatISO9075 } from "date-fns";
import { createDiffReport } from "./diff-report.js";
import { injectDOMHelpers, sanitizeFilename } from "./helpers.js";
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
    requiredKeyword?: string;
    requiredKeywordLower?: string;
    options: TaskOptions;
    active: boolean;
    timer?: ReturnType<typeof setTimeout>;
    lastText: string;
    lastRenderedHtml: string;
    lastResources: string[];
    stateLoaded: boolean;
    lastTextHash: string;
    baselineLength: number;
    baselineTruncated: boolean;
    failureCount: number;
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
    configuredMaxConcurrency: number;
    maxConcurrency: number;
    userAgent?: string;
    acceptLanguage?: string;
    uiTaskCount: number;
    legacyTaskCount: number;
    taskCount: number;
    lastError: string | null;
}

const FALLBACK_INTERVAL_SECONDS = 60;
const MAX_CHANGE_RECORDS = 300;
const DEFAULT_MAX_CONCURRENCY = 3;
const MAX_FAILURE_COUNT = 6;
const BASELINE_MAX_CHARS = 200_000;
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

function sha256(input: string): string {
    return createHash("sha256").update(input).digest("hex");
}

function normalizeMaxConcurrency(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.max(1, Math.floor(parsed));
}

function normalizeRequiredKeyword(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}

interface UiDomNoiseConfig {
    compareSelector?: string;
    ignoreSelectors?: string[];
    ignoreTextRegex?: string;
}

interface TaskStateV1 {
    version: 1;
    updatedAt: string;
    textHash: string;
    baselineFile: string;
    baselineLength: number;
    baselineTruncated: boolean;
    resources: string[];
}

function taskStateDir(outputDir: string): string {
    return path.join(outputDir, ".wm");
}

function taskStatePath(outputDir: string): string {
    return path.join(taskStateDir(outputDir), "state.json");
}

function taskBaselinePath(outputDir: string, baselineFile: string = "baseline.txt"): string {
    return path.join(taskStateDir(outputDir), baselineFile);
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
}

function normalizeTaskState(raw: unknown): TaskStateV1 | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const record = raw as Record<string, unknown>;
    if (record.version !== 1) {
        return null;
    }
    if (typeof record.textHash !== "string" || !record.textHash.trim()) {
        return null;
    }

    const baselineFileRaw = typeof record.baselineFile === "string" ? record.baselineFile.trim() : "";
    const baselineFile = baselineFileRaw && path.basename(baselineFileRaw) === baselineFileRaw ? baselineFileRaw : "baseline.txt";

    const baselineLengthRaw = typeof record.baselineLength === "number" ? record.baselineLength : 0;
    const baselineLength = Number.isFinite(baselineLengthRaw) && baselineLengthRaw >= 0 ? baselineLengthRaw : 0;

    const baselineTruncated = typeof record.baselineTruncated === "boolean" ? record.baselineTruncated : false;

    const updatedAt = typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso();

    const resources = Array.isArray(record.resources)
        ? record.resources.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
        : [];

    return {
        version: 1,
        updatedAt,
        textHash: record.textHash,
        baselineFile,
        baselineLength,
        baselineTruncated,
        resources,
    };
}

async function loadTaskState(outputDir: string): Promise<{ state: TaskStateV1 | null; baselineText: string | null }> {
    const statePath = taskStatePath(outputDir);
    let state: TaskStateV1 | null = null;
    try {
        const raw = await fs.readFile(statePath, "utf8");
        state = normalizeTaskState(JSON.parse(raw));
    } catch {
        state = null;
    }

    if (!state) {
        return { state: null, baselineText: null };
    }

    const baselinePath = taskBaselinePath(outputDir, state.baselineFile);
    try {
        const baselineText = await fs.readFile(baselinePath, "utf8");
        return { state, baselineText };
    } catch {
        return { state, baselineText: null };
    }
}

async function saveTaskBaseline(outputDir: string, text: string): Promise<{ length: number; truncated: boolean }> {
    const length = text.length;
    const truncated = length > BASELINE_MAX_CHARS;
    const baselineText = truncated ? `${text.slice(0, BASELINE_MAX_CHARS)}\n\n[...truncated baseline...]\n` : text;
    const dir = taskStateDir(outputDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(taskBaselinePath(outputDir), baselineText, "utf8");
    return { length, truncated };
}

async function saveTaskStateJson(outputDir: string, state: TaskStateV1): Promise<void> {
    const dir = taskStateDir(outputDir);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(taskStatePath(outputDir), state);
}

async function saveTaskBaselineAndState(outputDir: string, input: { text: string; textHash: string; resources: string[] }): Promise<{
    baselineLength: number;
    baselineTruncated: boolean;
}> {
    const baseline = await saveTaskBaseline(outputDir, input.text);
    await saveTaskStateJson(outputDir, {
        version: 1,
        updatedAt: nowIso(),
        textHash: input.textHash,
        baselineFile: "baseline.txt",
        baselineLength: baseline.length,
        baselineTruncated: baseline.truncated,
        resources: input.resources,
    });
    return { baselineLength: baseline.length, baselineTruncated: baseline.truncated };
}

class PagePool {
    private idlePages: Page[] = [];
    private totalPages = 0;

    constructor(
        private readonly browser: Browser,
        private readonly size: number
    ) {}

    async acquire(): Promise<Page> {
        const existing = this.idlePages.pop();
        if (existing && !existing.isClosed()) {
            return existing;
        }

        if (this.totalPages >= this.size) {
            // Should not happen because the engine enforces concurrency before acquiring pages.
            throw new Error("Page pool exhausted");
        }

        const page = await this.browser.newPage();
        this.totalPages += 1;
        return page;
    }

    async release(page: Page): Promise<void> {
        if (page.isClosed()) {
            this.totalPages = Math.max(0, this.totalPages - 1);
            return;
        }
        this.idlePages.push(page);
    }

    async closeAll(): Promise<void> {
        const pages = this.idlePages.slice();
        this.idlePages.length = 0;
        this.totalPages = 0;
        await Promise.all(
            pages.map(async (page) => {
                try {
                    if (!page.isClosed()) {
                        await page.close();
                    }
                } catch {}
            })
        );
    }
}

async function runTask(page: Page, options: TaskOptions) {
    const timeout = (options.timeout ?? 15) * 1000;

    const response = await page.goto(options.url, {
        waitUntil: options.waitLoad ?? "load",
        timeout,
    });
    const responseStatus = response?.status() ?? null;

    if (options.waitSelector) {
        await page.waitForSelector(options.waitSelector, { timeout });
    }

    const waitTimeout = options.waitTimeout;
    if (typeof waitTimeout === "number" && waitTimeout > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTimeout * 1000));
    }

    const uiConfig = (options as TaskOptions & { __uiConfig?: UiDomNoiseConfig }).__uiConfig;

    await page.evaluate(injectDOMHelpers);
    if (options.preprocess) {
        if (uiConfig) {
            await page.evaluate(options.preprocess as any, uiConfig as any);
        } else {
            await page.evaluate(options.preprocess);
        }
    }

    const data = uiConfig
        ? ((await page.evaluate(options.extract as any, uiConfig as any)) ?? "")
        : ((await page.evaluate(options.extract)) ?? "");
    const textToCompare = options.textToCompare
        ? uiConfig
            ? ((await page.evaluate(options.textToCompare as any, uiConfig as any)) ?? "")
            : ((await page.evaluate(options.textToCompare)) ?? "")
        : data;
    const resourcesToCompare = options.resourcesToCompare ? await page.evaluate(options.resourcesToCompare) : [];
    const title = await page.title().catch(() => "");
    const finalUrl = page.url();
    return { data, textToCompare, resourcesToCompare, title, finalUrl, responseStatus };
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
    private configuredMaxConcurrency: number;
    private maxConcurrency: number;
    private uiTasks: UiTaskConfig[] = [];
    private legacyOptions: TaskOptions[] = [];
    private tasks = new Map<string, RuntimeTask>();
    private statuses = new Map<string, RuntimeTaskStatus>();
    private changes: ChangeRecord[] = [];
    private browser: Browser | null = null;
    private browserManaged = false;
    private pagePool: PagePool | null = null;
    private runQueue: string[] = [];
    private queuedIds = new Set<string>();
    private runningCount = 0;
    private running = false;
    private lastError: string | null = null;
    private onUpdate: (() => void) | null = null;

    constructor(options: RuntimeOptions) {
        this.runtimeOptions = {
            ...options,
            tasksFile: options.tasksFile ?? DEFAULT_TASKS_FILE,
        };
        this.configuredMaxConcurrency = normalizeMaxConcurrency(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
        this.maxConcurrency = options.mode === "attach" ? 1 : this.configuredMaxConcurrency;
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
            configuredMaxConcurrency: this.configuredMaxConcurrency,
            maxConcurrency: this.maxConcurrency,
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
        maxConcurrency?: number;
        userAgent?: string;
        acceptLanguage?: string;
    }): Promise<void> {
        const unchanged =
            this.runtimeOptions.mode === nextRuntime.mode &&
            this.runtimeOptions.browserUrl === nextRuntime.browserUrl &&
            this.runtimeOptions.includeLegacyTasks === nextRuntime.includeLegacyTasks &&
            this.runtimeOptions.launchHeadless === nextRuntime.launchHeadless &&
            this.runtimeOptions.maxConcurrency === nextRuntime.maxConcurrency &&
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
            maxConcurrency: nextRuntime.maxConcurrency,
            userAgent: nextRuntime.userAgent,
            acceptLanguage: nextRuntime.acceptLanguage,
        };
        this.configuredMaxConcurrency = normalizeMaxConcurrency(nextRuntime.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
        this.maxConcurrency = nextRuntime.mode === "attach" ? 1 : this.configuredMaxConcurrency;

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
        const uiConfig: UiDomNoiseConfig = {
            compareSelector: task.compareSelector,
            ignoreSelectors: task.ignoreSelectors,
            ignoreTextRegex: task.ignoreTextRegex,
        };

        return {
            __uiConfig: uiConfig,
            url: task.url,
            outputDir: task.outputDir,
            waitLoad: task.waitLoad ?? "load",
            waitSelector: task.waitSelector,
            waitTimeout: task.waitTimeoutSec,
            timeout: 20,
            textToCompare(config?: UiDomNoiseConfig) {
                const compareSelectorRaw = config?.compareSelector;
                const compareSelector = typeof compareSelectorRaw === "string" ? compareSelectorRaw.trim() : "";
                const ignoreSelectorsRaw = config?.ignoreSelectors;
                const ignoreSelectors = Array.isArray(ignoreSelectorsRaw) ? ignoreSelectorsRaw : [];
                const ignoreTextRegexRaw = config?.ignoreTextRegex;
                const ignoreTextRegex = typeof ignoreTextRegexRaw === "string" ? ignoreTextRegexRaw.trim() : "";

                const clone = (document.body ?? document.documentElement).cloneNode(true);
                if (!(clone instanceof Element)) {
                    return "";
                }

                clone.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
                clone.querySelectorAll("[hidden],[aria-hidden='true']").forEach((node) => node.remove());
                clone.querySelectorAll(
                    "#mount,[id^='immersive-translate'],[class*='immersive-translate'],.imt-fb-container"
                ).forEach((node) => node.remove());

                for (const selector of ignoreSelectors) {
                    try {
                        clone.querySelectorAll(selector).forEach((node) => node.remove());
                    } catch {}
                }

                const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
                const comments: Node[] = [];
                while (walker.nextNode()) {
                    comments.push(walker.currentNode);
                }
                comments.forEach((node) => node.parentNode?.removeChild(node));

                let text = "";
                if (compareSelector) {
                    try {
                        const target = clone.querySelector(compareSelector);
                        text = target?.textContent ?? "";
                    } catch {
                        text = "";
                    }
                } else {
                    text = clone.textContent ?? "";
                }

                if (ignoreTextRegex) {
                    try {
                        const re = new RegExp(ignoreTextRegex, "gu");
                        text = text.replace(re, "");
                    } catch {}
                }

                return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
            },
            extract(config?: UiDomNoiseConfig) {
                const compareSelectorRaw = config?.compareSelector;
                const compareSelector = typeof compareSelectorRaw === "string" ? compareSelectorRaw.trim() : "";
                const ignoreSelectorsRaw = config?.ignoreSelectors;
                const ignoreSelectors = Array.isArray(ignoreSelectorsRaw) ? ignoreSelectorsRaw : [];

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

                for (const selector of ignoreSelectors) {
                    try {
                        clone.querySelectorAll(selector).forEach((node) => node.remove());
                    } catch {}
                }

                if (compareSelector) {
                    try {
                        const target = clone.querySelector(compareSelector);
                        const body = clone.querySelector("body");
                        if (target instanceof Element && body) {
                            body.innerHTML = "";
                            body.appendChild(target.cloneNode(true));
                        }
                    } catch {}
                }

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
        } as TaskOptions;
    }

    private createDescriptorFromOptions(
        id: string,
        source: "ui" | "legacy",
        name: string,
        enabled: boolean,
        options: TaskOptions,
        requiredKeyword?: string
    ): RuntimeTask {
        const normalizedKeyword = normalizeRequiredKeyword(requiredKeyword);
        return {
            id,
            source,
            name,
            url: options.url,
            outputDir: options.outputDir,
            enabled,
            requiredKeyword: normalizedKeyword,
            requiredKeywordLower: normalizedKeyword ? normalizedKeyword.toLowerCase() : undefined,
            options,
            active: false,
            lastText: "",
            lastRenderedHtml: "",
            lastResources: [],
            stateLoaded: false,
            lastTextHash: "",
            baselineLength: 0,
            baselineTruncated: false,
            failureCount: 0,
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
                this.createUiTaskOptions(task),
                task.requiredKeyword
            );
            const previous = this.tasks.get(id);
            if (previous) {
                if (previous.outputDir === descriptor.outputDir) {
                    descriptor.lastText = previous.lastText;
                    descriptor.lastRenderedHtml = previous.lastRenderedHtml;
                    descriptor.lastResources = previous.lastResources;
                    descriptor.stateLoaded = previous.stateLoaded;
                    descriptor.lastTextHash = previous.lastTextHash;
                    descriptor.baselineLength = previous.baselineLength;
                    descriptor.baselineTruncated = previous.baselineTruncated;
                }
                descriptor.active = previous.active;
                descriptor.failureCount = previous.failureCount;
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
                    if (previous.outputDir === descriptor.outputDir) {
                        descriptor.lastText = previous.lastText;
                        descriptor.lastRenderedHtml = previous.lastRenderedHtml;
                        descriptor.lastResources = previous.lastResources;
                        descriptor.stateLoaded = previous.stateLoaded;
                        descriptor.lastTextHash = previous.lastTextHash;
                        descriptor.baselineLength = previous.baselineLength;
                        descriptor.baselineTruncated = previous.baselineTruncated;
                    }
                    descriptor.active = previous.active;
                    descriptor.failureCount = previous.failureCount;
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
            if (!nextTasks.has(id)) {
                this.removeFromQueue(id);
            }
        }

        this.tasks = nextTasks;
        this.syncStatusesWithTasks();
        for (const task of this.tasks.values()) {
            if (!task.enabled || task.blocked) {
                this.removeFromQueue(task.id);
            }
        }

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
                queued: task.enabled ? current?.queued ?? this.queuedIds.has(task.id) : false,
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
                status.queued = false;
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

        this.runQueue.length = 0;
        this.queuedIds.clear();
        this.runningCount = 0;

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
        this.runQueue.length = 0;
        this.queuedIds.clear();
        this.runningCount = 0;
        for (const task of this.tasks.values()) {
            if (task.timer) {
                clearTimeout(task.timer);
                task.timer = undefined;
            }
            task.active = false;
        }
        for (const status of this.statuses.values()) {
            status.running = false;
            status.queued = false;
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
        this.removeFromQueue(id);

        const status = this.statuses.get(id);
        if (status) {
            status.blocked = false;
            status.blockedReason = null;
            status.blockedAt = null;
            status.lastError = null;
            status.queued = false;
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

        this.removeFromQueue(id);

        const status = this.statuses.get(id);
        if (!task.enabled || task.blocked) {
            if (status) {
                status.queued = false;
                status.nextCheckAt = null;
            }
            return;
        }

        if (status) {
            status.queued = false;
            status.nextCheckAt = scheduleAtIso(delayMs);
        }

        task.timer = setTimeout(() => {
            task.timer = undefined;
            this.enqueueExecution(id);
        }, Math.max(0, delayMs));

        this.emitUpdate();
    }

    private removeFromQueue(id: string): void {
        this.queuedIds.delete(id);
        if (this.runQueue.length > 0) {
            this.runQueue = this.runQueue.filter((item) => item !== id);
        }
        const status = this.statuses.get(id);
        if (status) {
            status.queued = false;
        }
    }

    private enqueueExecution(id: string): void {
        if (!this.running) {
            return;
        }

        const task = this.tasks.get(id);
        if (!task || !task.enabled || task.blocked) {
            return;
        }

        if (task.active || this.queuedIds.has(id)) {
            return;
        }

        this.queuedIds.add(id);
        this.runQueue.push(id);

        const status = this.statuses.get(id);
        if (status) {
            status.queued = true;
            status.nextCheckAt = null;
        }

        this.emitUpdate();
        this.drainQueue();
    }

    private drainQueue(): void {
        if (!this.running) {
            return;
        }

        while (this.runningCount < this.maxConcurrency && this.runQueue.length > 0) {
            const id = this.runQueue.shift();
            if (!id) {
                break;
            }
            this.queuedIds.delete(id);

            const task = this.tasks.get(id);
            const status = this.statuses.get(id);

            if (!task || !task.enabled || task.blocked) {
                if (status) {
                    status.queued = false;
                }
                continue;
            }

            if (task.active) {
                if (status) {
                    status.queued = false;
                }
                continue;
            }

            this.runningCount += 1;
            if (status) {
                status.queued = false;
            }

            void this.executeTaskInternal(id).finally(() => {
                this.runningCount = Math.max(0, this.runningCount - 1);
                this.drainQueue();
            });
        }
    }

    private async executeTaskInternal(id: string): Promise<void> {
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
                status.queued = false;
                status.nextCheckAt = null;
            }
            return;
        }

        if (task.active) {
            return;
        }

        task.active = true;
        const status = this.statuses.get(id);
        if (status) {
            status.running = true;
            status.queued = false;
            status.lastError = null;
            status.nextCheckAt = null;
            this.emitUpdate();
        }

        let errorMessage: string | null = null;

        try {
            await this.checkTask(task);
            task.failureCount = 0;
            this.clearLastError();
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error);
            task.failureCount = Math.min(MAX_FAILURE_COUNT, task.failureCount + 1);
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
                    status.queued = false;
                    status.nextCheckAt = null;
                }
                return;
            }

            if (latest.blocked) {
                if (status) {
                    status.queued = false;
                    status.nextCheckAt = null;
                }
                return;
            }

            let intervalSec = FALLBACK_INTERVAL_SECONDS;
            try {
                intervalSec = resolveIntervalSeconds(latest.options.interval);
            } catch (error) {
                if (status && !errorMessage) {
                    status.lastError = error instanceof Error ? error.message : String(error);
                }
            }
            if (status) {
                status.intervalSec = intervalSec;
            }

            if (errorMessage) {
                const baseSec = Math.max(5, intervalSec);
                const delaySec = Math.min(3600, baseSec * 2 ** latest.failureCount);
                const jitterMax = Math.min(30, delaySec * 0.1);
                const jitter = Math.random() * jitterMax;
                const nextDelaySec = delaySec + jitter;
                if (status) {
                    status.lastError = `${errorMessage}. Next retry in ~${Math.round(nextDelaySec)}s.`;
                }
                this.scheduleTask(id, nextDelaySec * 1000);
                return;
            }

            this.scheduleTask(id, intervalSec * 1000);
        }
    }

    private async ensureTaskStateLoaded(task: RuntimeTask): Promise<void> {
        if (task.stateLoaded) {
            return;
        }
        task.stateLoaded = true;

        try {
            const { state, baselineText } = await loadTaskState(task.outputDir);
            if (!state) {
                return;
            }

            task.lastTextHash = state.textHash;
            task.baselineLength = state.baselineLength;
            task.baselineTruncated = state.baselineTruncated;
            task.lastResources = state.resources;
            if (typeof baselineText === "string") {
                task.lastText = baselineText;
            }
        } catch {}
    }

    private async checkTask(task: RuntimeTask): Promise<void> {
        await this.ensureTaskStateLoaded(task);

        const browser = await this.ensureBrowser();
        const pool = this.pagePool;
        if (!pool) {
            throw new Error("Browser page pool not initialized");
        }

        const page = await pool.acquire();
        let savedFile: string | null = null;
        let baselineUpdated = false;

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
            const { data, textToCompare, resourcesToCompare, title, finalUrl, responseStatus } = await runTask(page, task.options);
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
                    status.queued = false;
                    status.nextCheckAt = null;
                    status.lastError =
                        `${antiBotReason}. Monitoring paused for this task. ` +
                        "Recommended: switch to attach mode using your regular Chrome session, complete the verification once, then click Unblock.";
                }

                return;
            }
            if (typeof responseStatus === "number" && responseStatus >= 400) {
                throw new Error(`HTTP ${responseStatus} for "${task.url}"`);
            }

            const currentText = String(textToCompare ?? "");
            const currentHash = sha256(currentText);
            const currentResources = Array.isArray(resourcesToCompare)
                ? resourcesToCompare
                      .filter((item): item is string => typeof item === "string")
                      .map((item) => item.trim())
                      .filter(Boolean)
                : [];

            const hasBaseline = Boolean(task.lastTextHash);
            if (!hasBaseline) {
                const saved = await saveTaskBaselineAndState(task.outputDir, {
                    text: currentText,
                    textHash: currentHash,
                    resources: currentResources,
                });
                task.lastText = currentText;
                task.lastTextHash = currentHash;
                task.baselineLength = saved.baselineLength;
                task.baselineTruncated = saved.baselineTruncated;
                task.lastRenderedHtml = data;
                task.lastResources = currentResources;
                baselineUpdated = true;
                return;
            }

            const previousText = task.lastText;
            const previousRenderedHtml = task.lastRenderedHtml;

            const textChanged = currentHash !== task.lastTextHash;
            const keywordMatched =
                !task.requiredKeywordLower || currentText.toLowerCase().includes(task.requiredKeywordLower);
            const shouldSaveTextChange = textChanged && keywordMatched;
            const resourcesChanged =
                currentResources.length !== task.lastResources.length ||
                currentResources.some((item, idx) => item !== task.lastResources[idx]);

            if (shouldSaveTextChange) {
                await fs.mkdir(task.outputDir, { recursive: true });
                const screenshotDataUrl = await captureScreenshotDataUrl(page);
                const report = createDiffReport({
                    taskName: task.name,
                    url: task.url,
                    previousText,
                    currentText: currentText,
                    screenshotDataUrl,
                    previousRenderedHtml,
                    currentRenderedHtml: data,
                    createdAt: nowIso(),
                });

                const similarityStr = (report.similarity * 100).toFixed(2).padStart(5, "0");
                const reportPath = path.join(task.outputDir, `${time} ${similarityStr}.diff.html`);
                await fs.writeFile(reportPath, report.html);
                savedFile = reportPath;
                this.recordChange(task, savedFile);

                const saved = await saveTaskBaselineAndState(task.outputDir, {
                    text: currentText,
                    textHash: currentHash,
                    resources: currentResources,
                });
                task.baselineLength = saved.baselineLength;
                task.baselineTruncated = saved.baselineTruncated;
                task.lastText = currentText;
                task.lastTextHash = currentHash;
                baselineUpdated = true;
            }

            // Keep rendered HTML aligned with baseline snapshot.
            if (!textChanged || shouldSaveTextChange) {
                task.lastRenderedHtml = data;
            }

            if (currentResources.length >= task.lastResources.length) {
                const diff = currentResources.filter((resource) => !task.lastResources.includes(resource));
                const savedResources = await this.downloadChangedResources(page, task, diff, time);
                if (!savedFile && savedResources.length > 0) {
                    savedFile = savedResources[0];
                }
            }

            task.lastResources = currentResources;

            if (!baselineUpdated && resourcesChanged) {
                const baselineLength = task.baselineLength || task.lastText.length;
                const baselineTruncated = task.baselineTruncated || baselineLength > BASELINE_MAX_CHARS;
                task.baselineLength = baselineLength;
                task.baselineTruncated = baselineTruncated;
                await saveTaskStateJson(task.outputDir, {
                    version: 1,
                    updatedAt: nowIso(),
                    textHash: task.lastTextHash,
                    baselineFile: "baseline.txt",
                    baselineLength,
                    baselineTruncated,
                    resources: currentResources,
                });
            }
        } finally {
            try {
                await pool.release(page);
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
            if (!this.pagePool) {
                this.pagePool = new PagePool(this.browser, this.maxConcurrency);
            }
            return this.browser;
        }

        // Stale browser handle; reset.
        this.browser = null;
        this.browserManaged = false;
        this.pagePool = null;

        if (this.runtimeOptions.mode === "attach") {
            this.browser = await puppeteerCore.connect({
                browserURL: this.runtimeOptions.browserUrl,
                defaultViewport: null,
            });
            this.browserManaged = false;
            this.pagePool = new PagePool(this.browser, this.maxConcurrency);
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
        this.pagePool = new PagePool(this.browser, this.maxConcurrency);
        return this.browser;
    }

    private async teardownBrowser(): Promise<void> {
        const pool = this.pagePool;
        this.pagePool = null;
        try {
            await pool?.closeAll();
        } catch {}

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
