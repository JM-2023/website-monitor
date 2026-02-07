#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function readArg(name, fallback = undefined) {
    const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    if (direct) {
        return direct.slice(name.length + 3);
    }
    const idx = process.argv.indexOf(`--${name}`);
    if (idx >= 0 && process.argv[idx + 1]) {
        return process.argv[idx + 1];
    }
    return fallback;
}

function runCommand(command, args, env = process.env) {
    const result = spawnSync(command, args, {
        cwd: rootDir,
        stdio: "inherit",
        env,
    });
    if (result.error) {
        throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
        throw new Error(`Command failed: ${command} ${args.join(" ")}`);
    }
}

function checkNodeVersion() {
    const nvmrcPath = path.join(rootDir, ".nvmrc");
    if (!fs.existsSync(nvmrcPath)) {
        return;
    }

    const expectedRaw = fs.readFileSync(nvmrcPath, "utf8").trim();
    if (!expectedRaw) {
        return;
    }

    const expectedMajor = expectedRaw.replace(/^v/i, "").split(".")[0];
    const currentMajor = process.versions.node.split(".")[0];
    if (expectedMajor !== currentMajor) {
        console.warn(
            `[warn] Node major version mismatch. expected=${expectedMajor} current=${currentMajor}. ` +
                "You can continue, but behavior may differ."
        );
    }
}

function ensureLocalDependencies() {
    const nodeModules = path.join(rootDir, "node_modules");
    const hasTsc = fs.existsSync(path.join(rootDir, "node_modules", ".bin", "tsc"));
    if (fs.existsSync(nodeModules) && hasTsc) {
        return;
    }
    console.log("Installing local dependencies (npm ci)...");
    runCommand("npm", ["ci"]);
}

function main() {
    const mode = readArg("mode", "launch");
    const browserUrl = readArg("browser-url", "http://127.0.0.1:9222");
    const tasksFile = readArg("tasks-file", process.env.WM_TASKS_FILE);
    const includeLegacyTasks = readArg("include-legacy", process.env.WM_INCLUDE_LEGACY_TASKS);
    const launchHeadless = readArg("launch-headless", process.env.WM_LAUNCH_HEADLESS);
    const uiPort = readArg("ui-port", process.env.WM_UI_PORT);

    checkNodeVersion();
    ensureLocalDependencies();

    console.log("Building project...");
    runCommand("npm", ["run", "build"]);

    const env = {
        ...process.env,
        WM_MODE: mode,
        WM_BROWSER_URL: browserUrl,
        WM_OPEN_UI: "1",
    };
    if (includeLegacyTasks) {
        env.WM_INCLUDE_LEGACY_TASKS = includeLegacyTasks;
    }
    if (tasksFile) {
        env.WM_TASKS_FILE = tasksFile;
    }
    if (uiPort) {
        env.WM_UI_PORT = uiPort;
    }
    if (launchHeadless) {
        env.WM_LAUNCH_HEADLESS = launchHeadless;
    }

    console.log(`Starting control server (mode=${mode})...`);
    const child = spawnSync("node", [".out/control-server.js"], {
        cwd: rootDir,
        stdio: "inherit",
        env,
    });
    process.exit(child.status ?? 1);
}

try {
    main();
} catch (error) {
    console.error("[error]", error instanceof Error ? error.message : String(error));
    process.exit(1);
}
