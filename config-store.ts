import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import type { MonitorConfig, RuntimeMode, UiTaskConfig, WaitLoadStrategy } from "./types.js";

export interface UiTaskInput {
    name: string;
    url: string;
    intervalSec: number;
    waitLoad?: WaitLoadStrategy;
    waitSelector?: string;
    waitTimeoutSec?: number;
    outputDir?: string;
    enabled?: boolean;
}

export interface UiTaskUpdateInput {
    name?: string;
    url?: string;
    intervalSec?: number;
    waitLoad?: WaitLoadStrategy;
    waitSelector?: string;
    waitTimeoutSec?: number;
    outputDir?: string;
    enabled?: boolean;
}

export interface RuntimeUpdateInput {
    mode?: RuntimeMode;
    browserUrl?: string;
    includeLegacyTasks?: boolean;
    launchHeadless?: boolean;
    userAgent?: string;
    acceptLanguage?: string;
}

const DEFAULT_BROWSER_URL = "http://127.0.0.1:9222";
const DEFAULT_PORT = 3210;
const DEFAULT_LAUNCH_HEADLESS = true;
const WAIT_LOAD_VALUES: WaitLoadStrategy[] = ["load", "domcontentloaded", "networkidle0", "networkidle2"];

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function normalizePort(value: unknown, fallback: number): number {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return fallback;
    }
    return port;
}

function isValidWaitLoad(value: unknown): value is WaitLoadStrategy {
    return typeof value === "string" && WAIT_LOAD_VALUES.includes(value as WaitLoadStrategy);
}

export function isHttpUrl(url: string): boolean {
    try {
        const target = new URL(url);
        return target.protocol === "http:" || target.protocol === "https:";
    } catch {
        return false;
    }
}

function normalizeInterval(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.max(1, Math.floor(parsed));
}

function normalizeWaitTimeoutSec(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return undefined;
    }
    if (parsed === 0) {
        return undefined;
    }
    return parsed;
}

function parseWaitTimeoutSecInput(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("waitTimeoutSec must be a number greater than or equal to 0");
    }
    if (parsed === 0) {
        return undefined;
    }
    return parsed;
}

function normalizeWaitSelector(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}

function normalizeOutputDir(value: unknown, fallback: string): string {
    if (typeof value !== "string") {
        return fallback;
    }
    const trimmed = value.trim();
    return trimmed || fallback;
}

function normalizeName(value: unknown, fallback: string): string {
    if (typeof value !== "string") {
        return fallback;
    }
    const trimmed = value.trim();
    return trimmed || fallback;
}

export function slugify(input: string): string {
    return input
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

export function defaultOutputDirForName(name: string): string {
    const slug = slugify(name) || "task";
    return path.join("outputs", slug);
}

export function createDefaultConfig(): MonitorConfig {
    return {
        version: 1,
        ui: {
            port: DEFAULT_PORT,
        },
        runtime: {
            mode: "launch",
            browserUrl: DEFAULT_BROWSER_URL,
            includeLegacyTasks: false,
            launchHeadless: DEFAULT_LAUNCH_HEADLESS,
        },
        tasks: [],
    };
}

function normalizeMode(mode: unknown, fallback: RuntimeMode): RuntimeMode {
    return mode === "attach" ? "attach" : mode === "launch" ? "launch" : fallback;
}

function normalizeOptionalString(input: unknown): string | undefined {
    if (typeof input !== "string") {
        return undefined;
    }
    const trimmed = input.trim();
    return trimmed ? trimmed : undefined;
}

function normalizeTask(raw: unknown): UiTaskConfig | null {
    if (!isObject(raw)) {
        return null;
    }

    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : randomUUID();
    const name = normalizeName(raw.name, "Untitled task");
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!isHttpUrl(url)) {
        return null;
    }

    const intervalSec = normalizeInterval(raw.intervalSec, 60);
    const waitLoad = isValidWaitLoad(raw.waitLoad) ? raw.waitLoad : undefined;
    const waitSelector = normalizeWaitSelector(raw.waitSelector);
    const waitTimeoutSec = normalizeWaitTimeoutSec(raw.waitTimeoutSec);
    const outputDir = normalizeOutputDir(raw.outputDir, defaultOutputDirForName(name));
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
    const now = new Date().toISOString();
    const createdAt = typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : now;
    const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : now;

    return {
        id,
        name,
        url,
        intervalSec,
        waitLoad,
        waitSelector,
        waitTimeoutSec,
        outputDir,
        enabled,
        createdAt,
        updatedAt,
    };
}

export function normalizeConfig(raw: unknown): MonitorConfig {
    const fallback = createDefaultConfig();
    if (!isObject(raw)) {
        return fallback;
    }

    const ui = isObject(raw.ui) ? raw.ui : {};
    const runtime = isObject(raw.runtime) ? raw.runtime : {};
    const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : [];

    return {
        version: 1,
        ui: {
            port: normalizePort(ui.port, fallback.ui.port),
        },
        runtime: {
            mode: normalizeMode(runtime.mode, fallback.runtime.mode),
            browserUrl:
                typeof runtime.browserUrl === "string" && runtime.browserUrl.trim()
                    ? runtime.browserUrl.trim()
                    : fallback.runtime.browserUrl,
            includeLegacyTasks:
                typeof runtime.includeLegacyTasks === "boolean" ? runtime.includeLegacyTasks : fallback.runtime.includeLegacyTasks,
            launchHeadless:
                typeof runtime.launchHeadless === "boolean" ? runtime.launchHeadless : fallback.runtime.launchHeadless,
            userAgent: normalizeOptionalString(runtime.userAgent),
            acceptLanguage: normalizeOptionalString(runtime.acceptLanguage),
        },
        tasks: tasksRaw.map(normalizeTask).filter((task): task is UiTaskConfig => Boolean(task)),
    };
}

function cloneConfig(config: MonitorConfig): MonitorConfig {
    return JSON.parse(JSON.stringify(config)) as MonitorConfig;
}

export class ConfigStore {
    private config: MonitorConfig = createDefaultConfig();

    constructor(private readonly filePath: string) {}

    async load(): Promise<MonitorConfig> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        try {
            const raw = await fs.readFile(this.filePath, "utf8");
            this.config = normalizeConfig(JSON.parse(raw));
        } catch (error) {
            this.config = createDefaultConfig();
            await this.save();
        }
        return this.get();
    }

    get(): MonitorConfig {
        return cloneConfig(this.config);
    }

    async save(): Promise<void> {
        const tempPath = `${this.filePath}.tmp`;
        await fs.writeFile(tempPath, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
        await fs.rename(tempPath, this.filePath);
    }

    async setUiPort(port: number): Promise<void> {
        this.config.ui.port = normalizePort(port, this.config.ui.port);
        await this.save();
    }

    async updateRuntime(input: RuntimeUpdateInput): Promise<MonitorConfig["runtime"]> {
        if (input.mode !== undefined) {
            this.config.runtime.mode = normalizeMode(input.mode, this.config.runtime.mode);
        }
        if (input.browserUrl !== undefined) {
            const normalized = typeof input.browserUrl === "string" ? input.browserUrl.trim() : "";
            this.config.runtime.browserUrl = normalized || this.config.runtime.browserUrl;
        }
        if (typeof input.includeLegacyTasks === "boolean") {
            this.config.runtime.includeLegacyTasks = input.includeLegacyTasks;
        }
        if (typeof input.launchHeadless === "boolean") {
            this.config.runtime.launchHeadless = input.launchHeadless;
        }
        if (input.userAgent !== undefined) {
            this.config.runtime.userAgent = normalizeOptionalString(input.userAgent);
        }
        if (input.acceptLanguage !== undefined) {
            this.config.runtime.acceptLanguage = normalizeOptionalString(input.acceptLanguage);
        }
        await this.save();
        return { ...this.config.runtime };
    }

    getTasks(): UiTaskConfig[] {
        return this.config.tasks.map((task) => ({ ...task }));
    }

    async addTask(input: UiTaskInput): Promise<UiTaskConfig> {
        if (!isHttpUrl(input.url)) {
            throw new Error("URL must start with http:// or https://");
        }
        if (input.waitLoad !== undefined && !isValidWaitLoad(input.waitLoad)) {
            throw new Error(`waitLoad must be one of: ${WAIT_LOAD_VALUES.join(", ")}`);
        }
        if (input.waitTimeoutSec !== undefined) {
            parseWaitTimeoutSecInput(input.waitTimeoutSec);
        }

        const now = new Date().toISOString();
        const name = normalizeName(input.name, "Untitled task");
        const task: UiTaskConfig = {
            id: randomUUID(),
            name,
            url: input.url.trim(),
            intervalSec: normalizeInterval(input.intervalSec, 60),
            waitLoad: input.waitLoad,
            waitSelector: normalizeWaitSelector(input.waitSelector),
            waitTimeoutSec: parseWaitTimeoutSecInput(input.waitTimeoutSec),
            outputDir: normalizeOutputDir(input.outputDir, defaultOutputDirForName(name)),
            enabled: input.enabled ?? true,
            createdAt: now,
            updatedAt: now,
        };
        this.config.tasks.push(task);
        await this.save();
        return { ...task };
    }

    async updateTask(id: string, input: UiTaskUpdateInput): Promise<UiTaskConfig> {
        const task = this.config.tasks.find((item) => item.id === id);
        if (!task) {
            throw new Error(`Task "${id}" not found`);
        }

        if (typeof input.name === "string") {
            task.name = normalizeName(input.name, task.name);
        }
        if (typeof input.url === "string") {
            const nextUrl = input.url.trim();
            if (!isHttpUrl(nextUrl)) {
                throw new Error("URL must start with http:// or https://");
            }
            task.url = nextUrl;
        }
        if (input.intervalSec !== undefined) {
            task.intervalSec = normalizeInterval(input.intervalSec, task.intervalSec);
        }
        if (input.waitLoad !== undefined) {
            if (!isValidWaitLoad(input.waitLoad)) {
                throw new Error(`waitLoad must be one of: ${WAIT_LOAD_VALUES.join(", ")}`);
            }
            task.waitLoad = input.waitLoad;
        }
        if (input.waitSelector !== undefined) {
            task.waitSelector = normalizeWaitSelector(input.waitSelector);
        }
        if (input.waitTimeoutSec !== undefined) {
            task.waitTimeoutSec = parseWaitTimeoutSecInput(input.waitTimeoutSec);
        }
        if (input.outputDir !== undefined) {
            task.outputDir = normalizeOutputDir(input.outputDir, task.outputDir);
        }
        if (typeof input.enabled === "boolean") {
            task.enabled = input.enabled;
        }
        task.updatedAt = new Date().toISOString();

        await this.save();
        return { ...task };
    }

    async deleteTask(id: string): Promise<void> {
        const before = this.config.tasks.length;
        this.config.tasks = this.config.tasks.filter((task) => task.id !== id);
        if (this.config.tasks.length === before) {
            throw new Error(`Task "${id}" not found`);
        }
        await this.save();
    }
}
