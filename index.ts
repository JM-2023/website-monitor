import path from "path";
import sourceMapSupport from "source-map-support";
import { ConfigStore } from "./config-store.js";
import { MonitorEngine } from "./engine.js";
import type { RuntimeMode } from "./types.js";

function parseBool(value: string | undefined, fallback: boolean): boolean {
    if (!value) {
        return fallback;
    }
    const normalized = value.toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes") {
        return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no") {
        return false;
    }
    return fallback;
}

function normalizeOptionalString(input: string | undefined): string | undefined {
    const trimmed = input?.trim();
    return trimmed ? trimmed : undefined;
}

try {
    sourceMapSupport.install();
} catch (error) {
    console.warn("failed to install source-map-support:", error);
}

(async function main() {
    const configPath = path.resolve(process.env.WM_CONFIG_FILE || "config/monitors.json");
    const store = new ConfigStore(configPath);
    const config = await store.load();

    const mode = ((process.env.WM_MODE as RuntimeMode | undefined) || config.runtime.mode) as RuntimeMode;
    const browserUrl = process.env.WM_BROWSER_URL || config.runtime.browserUrl;
    const includeLegacyTasks = parseBool(process.env.WM_INCLUDE_LEGACY_TASKS, config.runtime.includeLegacyTasks);
    const launchHeadless = parseBool(process.env.WM_LAUNCH_HEADLESS, config.runtime.launchHeadless);
    const maxConcurrency = config.runtime.maxConcurrency;
    const userAgent = normalizeOptionalString(process.env.WM_USER_AGENT) ?? config.runtime.userAgent;
    const acceptLanguage = normalizeOptionalString(process.env.WM_ACCEPT_LANGUAGE) ?? config.runtime.acceptLanguage;

    const engine = new MonitorEngine({
        mode,
        browserUrl,
        includeLegacyTasks,
        launchHeadless,
        tasksFile: process.env.WM_TASKS_FILE,
        chromeExecutable: process.env.WM_CHROME_EXECUTABLE,
        maxConcurrency,
        userAgent,
        acceptLanguage,
    });

    await engine.refreshLegacyTasks();
    engine.setUiTasks(store.getTasks());

    const snapshot = engine.getSnapshot();
    console.log("Website monitor (CLI mode)");
    console.log(`mode=${snapshot.mode} includeLegacy=${snapshot.includeLegacyTasks}`);
    console.log(`uiTasks=${snapshot.uiTaskCount} legacyTasks=${snapshot.legacyTaskCount}`);

    await engine.start();
    console.log("monitor started");

    const shutdown = async (signal: NodeJS.Signals) => {
        console.log(`shutting down (${signal})...`);
        await engine.stop();
        process.exit(0);
    };

    process.once("SIGINT", () => {
        void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
        void shutdown("SIGTERM");
    });
})().catch((error) => {
    console.error("fatal error:", error);
    process.exit(1);
});
