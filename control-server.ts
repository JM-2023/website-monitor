import fs from "fs/promises";
import type { Dirent, Stats } from "fs";
import http from "http";
import path from "path";
import { spawn } from "child_process";
import { pathToFileURL } from "url";
import type { IncomingMessage, ServerResponse } from "http";
import { ConfigStore } from "./config-store.js";
import type { RuntimeUpdateInput, UiTaskInput, UiTaskUpdateInput } from "./config-store.js";
import { MonitorEngine } from "./engine.js";
import type { RuntimeMode } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3210;

interface ControlServerOptions {
    baseDir?: string;
    host?: string;
    preferredPort?: number;
    openBrowser?: boolean;
    mode?: RuntimeMode;
    launchHeadless?: boolean;
    browserUrl?: string;
    includeLegacyTasks?: boolean;
    tasksFile?: string;
    configPath?: string;
    uiDir?: string;
}

interface ControlServerHandle {
    host: string;
    port: number;
    url: string;
    close: () => Promise<void>;
}

type FocusRisk = "low" | "medium" | "high";

function parseBool(input: string | undefined, fallback: boolean): boolean {
    if (!input) {
        return fallback;
    }
    const value = input.toLowerCase();
    if (value === "1" || value === "true" || value === "yes") {
        return true;
    }
    if (value === "0" || value === "false" || value === "no") {
        return false;
    }
    return fallback;
}

function normalizeOptionalString(input: string | undefined): string | undefined {
    const trimmed = input?.trim();
    return trimmed ? trimmed : undefined;
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
            try {
                const body = Buffer.concat(chunks).toString("utf8");
                resolve((body ? JSON.parse(body) : {}) as T);
            } catch (error) {
                reject(new Error("Invalid JSON body"));
            }
        });
        req.on("error", (error) => reject(error));
    });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
    });
    res.end(body);
}

function escapeHtml(input: string): string {
    return input
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function contentTypeByFile(filePath: string): string {
    if (filePath.endsWith(".html")) {
        return "text/html; charset=utf-8";
    }
    if (filePath.endsWith(".js")) {
        return "application/javascript; charset=utf-8";
    }
    if (filePath.endsWith(".css")) {
        return "text/css; charset=utf-8";
    }
    if (filePath.endsWith(".json")) {
        return "application/json; charset=utf-8";
    }
    if (filePath.endsWith(".png")) {
        return "image/png";
    }
    if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) {
        return "image/jpeg";
    }
    if (filePath.endsWith(".gif")) {
        return "image/gif";
    }
    if (filePath.endsWith(".webp")) {
        return "image/webp";
    }
    if (filePath.endsWith(".svg")) {
        return "image/svg+xml; charset=utf-8";
    }
    return "text/plain; charset=utf-8";
}

async function serveStatic(res: ServerResponse, uiDir: string, pathname: string): Promise<void> {
    const normalized = pathname === "/" ? "/index.html" : pathname;
    const absolute = path.resolve(uiDir, `.${normalized}`);
    if (!absolute.startsWith(path.resolve(uiDir))) {
        sendJson(res, 400, { error: "Invalid file path" });
        return;
    }

    try {
        const content = await fs.readFile(absolute);
        res.writeHead(200, {
            "Content-Type": contentTypeByFile(absolute),
            "Cache-Control": "no-store",
        });
        res.end(content);
    } catch {
        sendJson(res, 404, { error: "File not found" });
    }
}

function hasDotPathSegment(pathname: string): boolean {
    const segments = pathname.split("/").filter(Boolean);
    return segments.some((segment) => segment.startsWith("."));
}

function encodePathForHref(pathname: string): string {
    const segments = pathname.split("/").filter(Boolean).map((segment) => encodeURIComponent(segment));
    return `/${segments.join("/")}`;
}

async function serveOutputs(res: ServerResponse, baseDir: string, pathname: string): Promise<void> {
    if (hasDotPathSegment(pathname)) {
        sendJson(res, 400, { error: "Invalid file path" });
        return;
    }

    const outputsRoot = path.resolve(baseDir, "outputs");
    const absolute = path.resolve(baseDir, `.${pathname}`);
    if (!absolute.startsWith(outputsRoot)) {
        sendJson(res, 400, { error: "Invalid file path" });
        return;
    }

    let stat: Stats | null = null;
    try {
        stat = await fs.stat(absolute);
    } catch {
        stat = null;
    }

    if (!stat) {
        sendJson(res, 404, { error: "File not found" });
        return;
    }

    if (stat.isDirectory()) {
        let entries: Dirent[];
        try {
            entries = (await fs.readdir(absolute, { withFileTypes: true })) as Dirent[];
        } catch {
            sendJson(res, 404, { error: "File not found" });
            return;
        }

        const normalized = pathname.endsWith("/") ? pathname : `${pathname}/`;
        const items = entries
            .filter((entry) => !entry.name.startsWith("."))
            .map((entry) => ({
                name: entry.name,
                isDir: entry.isDirectory(),
            }))
            .sort((a, b) => {
                if (a.isDir !== b.isDir) {
                    return a.isDir ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });

        const parentHref = normalized !== "/outputs/" ? (() => {
            const parts = normalized.split("/").filter(Boolean);
            parts.pop();
            const parent = `/${parts.join("/")}/`;
            return encodePathForHref(parent);
        })() : null;

        const links = items
            .map((item) => {
                const href = encodePathForHref(`${normalized}${item.name}${item.isDir ? "/" : ""}`);
                const label = escapeHtml(item.name + (item.isDir ? "/" : ""));
                return `<li><a href="${href}">${label}</a></li>`;
            })
            .join("\n");

        const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Outputs - ${escapeHtml(normalized)}</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; padding: 18px; color: #162d3f; }
      a { color: #0b607f; text-decoration: none; }
      a:hover { text-decoration: underline; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      ul { padding-left: 18px; }
    </style>
  </head>
  <body>
    <h1>outputs</h1>
    <p>Path: <code>${escapeHtml(normalized)}</code></p>
    ${parentHref ? `<p><a href="${parentHref}">..</a></p>` : ""}
    <ul>
      ${links || "<li><em>(empty)</em></li>"}
    </ul>
  </body>
</html>`;

        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
        });
        res.end(body);
        return;
    }

    try {
        const content = await fs.readFile(absolute);
        res.writeHead(200, {
            "Content-Type": contentTypeByFile(absolute),
            "Cache-Control": "no-store",
        });
        res.end(content);
    } catch {
        sendJson(res, 404, { error: "File not found" });
    }
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
    return await new Promise((resolve) => {
        const tester = http
            .createServer()
            .once("error", () => resolve(false))
            .once("listening", () => {
                tester.close(() => resolve(true));
            })
            .listen(port, host);
    });
}

async function findAvailablePort(host: string, startPort: number, maxOffset: number = 100): Promise<number> {
    const base = Math.max(1, Math.min(65535, startPort));
    for (let offset = 0; offset <= maxOffset; offset++) {
        const candidate = base + offset;
        if (candidate > 65535) {
            break;
        }
        if (await isPortAvailable(host, candidate)) {
            return candidate;
        }
    }
    throw new Error(`Cannot find a free port near ${startPort}`);
}

function openInBrowser(url: string): void {
    try {
        const child = spawn("open", [url], {
            detached: true,
            stdio: "ignore",
        });
        child.unref();
    } catch (error) {}
}

function getFocusRisk(mode: RuntimeMode, launchHeadless: boolean): FocusRisk {
    if (mode === "attach") {
        return "high";
    }
    return launchHeadless ? "low" : "medium";
}

export async function startControlServer(options: ControlServerOptions = {}): Promise<ControlServerHandle> {
    const baseDir = options.baseDir ? path.resolve(options.baseDir) : process.cwd();
    const host = options.host ?? DEFAULT_HOST;
    const uiDir = options.uiDir ? path.resolve(options.uiDir) : path.resolve(baseDir, "ui");
    const configPath = options.configPath
        ? path.resolve(options.configPath)
        : path.resolve(baseDir, "config/monitors.json");

    const store = new ConfigStore(configPath);
    const config = await store.load();
    const configLoad = store.getLoadError();

    const requestedMode = options.mode ?? ((process.env.WM_MODE as RuntimeMode | undefined) || config.runtime.mode);
    const mode: RuntimeMode = requestedMode === "attach" ? "attach" : "launch";
    const browserUrl = options.browserUrl ?? process.env.WM_BROWSER_URL ?? config.runtime.browserUrl;
    const includeLegacyTasks =
        options.includeLegacyTasks ?? parseBool(process.env.WM_INCLUDE_LEGACY_TASKS, config.runtime.includeLegacyTasks);
    const launchHeadless =
        options.launchHeadless ?? parseBool(process.env.WM_LAUNCH_HEADLESS, config.runtime.launchHeadless);
    const maxConcurrency = config.runtime.maxConcurrency;
    const tasksFile = options.tasksFile ?? process.env.WM_TASKS_FILE;
    const envUserAgent = normalizeOptionalString(process.env.WM_USER_AGENT);
    const envAcceptLanguage = normalizeOptionalString(process.env.WM_ACCEPT_LANGUAGE);

    const runtime = await store.updateRuntime({
        mode,
        browserUrl,
        includeLegacyTasks,
        launchHeadless,
        maxConcurrency,
    });

    const engine = new MonitorEngine({
        mode: runtime.mode,
        browserUrl: runtime.browserUrl,
        includeLegacyTasks: runtime.includeLegacyTasks,
        launchHeadless: runtime.launchHeadless,
        tasksFile,
        chromeExecutable: process.env.WM_CHROME_EXECUTABLE,
        maxConcurrency: runtime.maxConcurrency,
        userAgent: envUserAgent ?? runtime.userAgent,
        acceptLanguage: envAcceptLanguage ?? runtime.acceptLanguage,
    });
    await engine.refreshLegacyTasks();
    engine.setUiTasks(store.getTasks());

    const envPort = process.env.WM_UI_PORT ? Number(process.env.WM_UI_PORT) : Number.NaN;
    const requestedPort = options.preferredPort ?? (Number.isFinite(envPort) ? envPort : config.ui.port || DEFAULT_PORT);
    const port = await findAvailablePort(host, requestedPort);
    if (port !== config.ui.port) {
        await store.setUiPort(port);
    }

    const server = http.createServer(async (req, res) => {
        if (!req.url) {
            sendJson(res, 400, { error: "Missing request URL" });
            return;
        }

        const requestUrl = new URL(req.url, `http://${host}:${port}`);
        const pathname = requestUrl.pathname;
        const method = req.method || "GET";

        try {
            if (pathname === "/api/state" && method === "GET") {
                const snapshot = engine.getSnapshot();
                sendJson(res, 200, {
                    ...snapshot,
                    focusRisk: getFocusRisk(snapshot.mode, snapshot.launchHeadless),
                    host,
                    port,
                    controlUrl: `http://${host}:${port}`,
                    configLoadError: configLoad.error,
                    configBackupPath: configLoad.backupPath,
                });
                return;
            }

            if (pathname === "/api/tasks" && method === "GET") {
                const statuses = engine.getTaskStatuses();
                sendJson(res, 200, {
                    uiTasks: store.getTasks(),
                    legacyTasks: statuses.filter((status) => status.source === "legacy"),
                    statuses,
                });
                return;
            }

            if (pathname === "/api/tasks" && method === "POST") {
                const body = await readJsonBody<Record<string, unknown>>(req);
                const ignoreSelectors =
                    typeof body.ignoreSelectors === "string"
                        ? body.ignoreSelectors
                              .split(/\r?\n/)
                              .map((line) => line.trim())
                              .filter(Boolean)
                        : Array.isArray(body.ignoreSelectors)
                          ? body.ignoreSelectors.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
                          : undefined;
                const task = await store.addTask({
                    name: String(body.name ?? ""),
                    url: String(body.url ?? ""),
                    intervalSec: Number(body.intervalSec),
                    waitLoad: body.waitLoad as any,
                    waitSelector: typeof body.waitSelector === "string" ? body.waitSelector : undefined,
                    waitTimeoutSec: body.waitTimeoutSec as any,
                    compareSelector: typeof body.compareSelector === "string" ? body.compareSelector : undefined,
                    requiredKeyword:
                        body.requiredKeyword === undefined
                            ? undefined
                            : typeof body.requiredKeyword === "string"
                              ? body.requiredKeyword
                              : "",
                    ignoreSelectors,
                    ignoreTextRegex: typeof body.ignoreTextRegex === "string" ? body.ignoreTextRegex : undefined,
                    outputDir: typeof body.outputDir === "string" ? body.outputDir : undefined,
                    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
                } as UiTaskInput);
                engine.setUiTasks(store.getTasks());
                sendJson(res, 201, { task });
                return;
            }

            if (pathname.startsWith("/api/tasks/") && pathname.endsWith("/unblock") && method === "POST") {
                const suffix = "/unblock";
                const rawId = pathname.slice("/api/tasks/".length, -suffix.length);
                const id = decodeURIComponent(rawId);
                if (!id) {
                    sendJson(res, 400, { error: "Missing task id" });
                    return;
                }

                const ok = engine.unblockTask(`ui-${id}`);
                if (!ok) {
                    sendJson(res, 404, { error: `Task "${id}" not found` });
                    return;
                }

                sendJson(res, 200, { ok: true });
                return;
            }

            if (pathname.startsWith("/api/tasks/") && method === "PUT") {
                const id = decodeURIComponent(pathname.slice("/api/tasks/".length));
                const body = await readJsonBody<Record<string, unknown>>(req);
                const ignoreSelectors =
                    body.ignoreSelectors === undefined
                        ? undefined
                        : typeof body.ignoreSelectors === "string"
                          ? body.ignoreSelectors
                                .split(/\r?\n/)
                                .map((line) => line.trim())
                                .filter(Boolean)
                          : Array.isArray(body.ignoreSelectors)
                            ? body.ignoreSelectors.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
                            : [];

                const update: UiTaskUpdateInput = {};
                if (body.name !== undefined) update.name = typeof body.name === "string" ? body.name : String(body.name);
                if (body.url !== undefined) update.url = typeof body.url === "string" ? body.url : String(body.url);
                if (body.intervalSec !== undefined) update.intervalSec = Number(body.intervalSec);
                if (body.waitLoad !== undefined) update.waitLoad = body.waitLoad as any;
                if (body.waitSelector !== undefined) update.waitSelector = typeof body.waitSelector === "string" ? body.waitSelector : "";
                if (body.waitTimeoutSec !== undefined) update.waitTimeoutSec = body.waitTimeoutSec as any;
                if (body.compareSelector !== undefined)
                    update.compareSelector = typeof body.compareSelector === "string" ? body.compareSelector : String(body.compareSelector);
                if (body.requiredKeyword !== undefined)
                    update.requiredKeyword = typeof body.requiredKeyword === "string" ? body.requiredKeyword : "";
                if (body.ignoreSelectors !== undefined) update.ignoreSelectors = ignoreSelectors;
                if (body.ignoreTextRegex !== undefined)
                    update.ignoreTextRegex = typeof body.ignoreTextRegex === "string" ? body.ignoreTextRegex : String(body.ignoreTextRegex);
                if (body.outputDir !== undefined) update.outputDir = typeof body.outputDir === "string" ? body.outputDir : String(body.outputDir);
                if (typeof body.enabled === "boolean") update.enabled = body.enabled;

                const task = await store.updateTask(id, update);
                engine.setUiTasks(store.getTasks());
                sendJson(res, 200, { task });
                return;
            }

            if (pathname.startsWith("/api/tasks/") && method === "DELETE") {
                const id = decodeURIComponent(pathname.slice("/api/tasks/".length));
                await store.deleteTask(id);
                engine.setUiTasks(store.getTasks());
                sendJson(res, 200, { ok: true });
                return;
            }

            if (pathname === "/api/runtime" && method === "PUT") {
                const body = await readJsonBody<RuntimeUpdateInput>(req);
                if (body.mode !== undefined && body.mode !== "launch" && body.mode !== "attach") {
                    throw new Error('mode must be "launch" or "attach"');
                }
                if (body.browserUrl !== undefined && typeof body.browserUrl !== "string") {
                    throw new Error("browserUrl must be a string");
                }
                if (body.includeLegacyTasks !== undefined && typeof body.includeLegacyTasks !== "boolean") {
                    throw new Error("includeLegacyTasks must be a boolean");
                }
                if (body.launchHeadless !== undefined && typeof body.launchHeadless !== "boolean") {
                    throw new Error("launchHeadless must be a boolean");
                }
                if (body.maxConcurrency !== undefined && typeof body.maxConcurrency !== "number") {
                    throw new Error("maxConcurrency must be a number");
                }
                if (body.userAgent !== undefined && typeof body.userAgent !== "string") {
                    throw new Error("userAgent must be a string");
                }
                if (body.acceptLanguage !== undefined && typeof body.acceptLanguage !== "string") {
                    throw new Error("acceptLanguage must be a string");
                }

                const nextRuntime = await store.updateRuntime(body);
                await engine.applyRuntimeOptions({
                    mode: nextRuntime.mode,
                    browserUrl: nextRuntime.browserUrl,
                    includeLegacyTasks: nextRuntime.includeLegacyTasks,
                    launchHeadless: nextRuntime.launchHeadless,
                    maxConcurrency: nextRuntime.maxConcurrency,
                    userAgent: envUserAgent ?? nextRuntime.userAgent,
                    acceptLanguage: envAcceptLanguage ?? nextRuntime.acceptLanguage,
                });
                engine.setUiTasks(store.getTasks());

                const snapshot = engine.getSnapshot();
                sendJson(res, 200, {
                    runtime: nextRuntime,
                    state: {
                        ...snapshot,
                        focusRisk: getFocusRisk(snapshot.mode, snapshot.launchHeadless),
                        host,
                        port,
                        controlUrl: `http://${host}:${port}`,
                        configLoadError: configLoad.error,
                        configBackupPath: configLoad.backupPath,
                    },
                });
                return;
            }

            if (pathname === "/api/engine/start" && method === "POST") {
                await engine.refreshLegacyTasks();
                engine.setUiTasks(store.getTasks());
                await engine.start();
                const snapshot = engine.getSnapshot();
                sendJson(res, 200, {
                    ...snapshot,
                    focusRisk: getFocusRisk(snapshot.mode, snapshot.launchHeadless),
                });
                return;
            }

            if (pathname === "/api/engine/stop" && method === "POST") {
                await engine.stop();
                const snapshot = engine.getSnapshot();
                sendJson(res, 200, {
                    ...snapshot,
                    focusRisk: getFocusRisk(snapshot.mode, snapshot.launchHeadless),
                });
                return;
            }

            if (pathname === "/api/changes" && method === "GET") {
                const limit = Number(requestUrl.searchParams.get("limit") ?? "50");
                sendJson(res, 200, { changes: engine.getChanges(limit) });
                return;
            }

            if (pathname.startsWith("/api/")) {
                sendJson(res, 404, { error: "API endpoint not found" });
                return;
            }

            if (pathname === "/outputs" || pathname.startsWith("/outputs/")) {
                await serveOutputs(res, baseDir, pathname === "/outputs" ? "/outputs/" : pathname);
                return;
            }

            await serveStatic(res, uiDir, pathname);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 400, { error: message });
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
    });

    const url = `http://${host}:${port}`;
    const shouldOpen = options.openBrowser ?? parseBool(process.env.WM_OPEN_UI, true);
    if (shouldOpen) {
        openInBrowser(url);
    }

    let closed = false;
    const close = async () => {
        if (closed) {
            return;
        }
        closed = true;
        await engine.stop();
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    };

    return { host, port, url, close };
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
    (async () => {
        const handle = await startControlServer();
        console.log(`Control server running at ${handle.url}`);

        const shutdown = async () => {
            await handle.close();
            process.exit(0);
        };

        process.once("SIGINT", () => {
            void shutdown();
        });
        process.once("SIGTERM", () => {
            void shutdown();
        });
    })().catch((error) => {
        console.error("Failed to start control server:", error);
        process.exit(1);
    });
}
