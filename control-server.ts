import fs from "fs/promises";
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

    const requestedMode = options.mode ?? ((process.env.WM_MODE as RuntimeMode | undefined) || config.runtime.mode);
    const mode: RuntimeMode = requestedMode === "attach" ? "attach" : "launch";
    const browserUrl = options.browserUrl ?? process.env.WM_BROWSER_URL ?? config.runtime.browserUrl;
    const includeLegacyTasks =
        options.includeLegacyTasks ?? parseBool(process.env.WM_INCLUDE_LEGACY_TASKS, config.runtime.includeLegacyTasks);
    const launchHeadless =
        options.launchHeadless ?? parseBool(process.env.WM_LAUNCH_HEADLESS, config.runtime.launchHeadless);
    const tasksFile = options.tasksFile ?? process.env.WM_TASKS_FILE;

    const runtime = await store.updateRuntime({
        mode,
        browserUrl,
        includeLegacyTasks,
        launchHeadless,
    });

    const engine = new MonitorEngine({
        mode: runtime.mode,
        browserUrl: runtime.browserUrl,
        includeLegacyTasks: runtime.includeLegacyTasks,
        launchHeadless: runtime.launchHeadless,
        tasksFile,
        chromeExecutable: process.env.WM_CHROME_EXECUTABLE,
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
                const body = await readJsonBody<UiTaskInput>(req);
                const task = await store.addTask(body);
                engine.setUiTasks(store.getTasks());
                sendJson(res, 201, { task });
                return;
            }

            if (pathname.startsWith("/api/tasks/") && method === "PUT") {
                const id = decodeURIComponent(pathname.slice("/api/tasks/".length));
                const body = await readJsonBody<UiTaskUpdateInput>(req);
                const task = await store.updateTask(id, body);
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

                const nextRuntime = await store.updateRuntime(body);
                await engine.applyRuntimeOptions({
                    mode: nextRuntime.mode,
                    browserUrl: nextRuntime.browserUrl,
                    includeLegacyTasks: nextRuntime.includeLegacyTasks,
                    launchHeadless: nextRuntime.launchHeadless,
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
