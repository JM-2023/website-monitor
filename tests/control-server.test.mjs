import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startControlServer } from "../.out/control-server.js";

function listen(server, port, host) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
    });
}

function closeServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}

test("Control server falls back from occupied port and validates task URL", async (t) => {
    const originalUserAgent = process.env.WM_USER_AGENT;
    const originalAcceptLanguage = process.env.WM_ACCEPT_LANGUAGE;
    delete process.env.WM_USER_AGENT;
    delete process.env.WM_ACCEPT_LANGUAGE;

    const host = "127.0.0.1";
    const blocker = http.createServer((req, res) => {
        res.statusCode = 200;
        res.end("occupied");
    });
    try {
        await listen(blocker, 0, host);
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
            t.skip("Socket listen is not permitted in this runtime.");
            return;
        }
        throw error;
    }
    const blockerPort = blocker.address().port;

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wm-control-test-"));
    const configPath = path.join(tempRoot, "config", "monitors.json");
    const outputsDir = path.join(tempRoot, "outputs");
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.writeFile(path.join(outputsDir, "hello.txt"), "hello outputs", "utf8");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
        configPath,
        JSON.stringify(
            {
                version: 1,
                ui: { port: blockerPort },
                runtime: {
                    mode: "launch",
                    browserUrl: "http://127.0.0.1:9222",
                    includeLegacyTasks: false,
                    launchHeadless: true,
                },
                tasks: [],
            },
            null,
            2
        ),
        "utf8"
    );

    let handle = null;
    try {
        handle = await startControlServer({
            baseDir: tempRoot,
            host,
            preferredPort: blockerPort,
            openBrowser: false,
            includeLegacyTasks: false,
            mode: "launch",
            configPath,
            uiDir: path.resolve("ui"),
        });

        assert.notEqual(handle.port, blockerPort);

        const stateResponse = await fetch(`${handle.url}/api/state`);
        assert.equal(stateResponse.ok, true);
        const stateBody = await stateResponse.json();
        assert.equal(stateBody.running, false);
        assert.equal(stateBody.launchHeadless, true);
        assert.equal(stateBody.focusRisk, "low");
        assert.equal(stateBody.userAgent, undefined);
        assert.equal(stateBody.acceptLanguage, undefined);

        const outputsFile = await fetch(`${handle.url}/outputs/hello.txt`);
        assert.equal(outputsFile.ok, true);
        assert.equal(await outputsFile.text(), "hello outputs");

        const outputsIndex = await fetch(`${handle.url}/outputs/`);
        assert.equal(outputsIndex.ok, true);
        const outputsIndexBody = await outputsIndex.text();
        assert.match(outputsIndexBody, /hello\.txt/);

        const outputsDot = await fetch(`${handle.url}/outputs/.wm/state.json`);
        assert.equal(outputsDot.status, 400);

        const badResponse = await fetch(`${handle.url}/api/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "Bad URL",
                url: "ftp://example.com",
                intervalSec: 10,
                outputDir: "outputs/bad",
                enabled: true,
            }),
        });
        assert.equal(badResponse.status, 400);

        const badWaitLoad = await fetch(`${handle.url}/api/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "Bad Wait Load",
                url: "https://example.com",
                intervalSec: 10,
                waitLoad: "invalid-load",
                outputDir: "outputs/bad-wait-load",
                enabled: true,
            }),
        });
        assert.equal(badWaitLoad.status, 400);

        const badWaitTimeout = await fetch(`${handle.url}/api/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "Bad Wait Timeout",
                url: "https://example.com",
                intervalSec: 10,
                waitTimeoutSec: -1,
                outputDir: "outputs/bad-wait-timeout",
                enabled: true,
            }),
        });
        assert.equal(badWaitTimeout.status, 400);

        const badRegex = await fetch(`${handle.url}/api/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "Bad Regex",
                url: "https://example.com",
                intervalSec: 10,
                ignoreTextRegex: "[",
                outputDir: "outputs/bad-regex",
                enabled: true,
            }),
        });
        assert.equal(badRegex.status, 400);

        const goodResponse = await fetch(`${handle.url}/api/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "Good URL",
                url: "https://example.com",
                intervalSec: 10,
                waitLoad: "networkidle2",
                waitSelector: "#app",
                waitTimeoutSec: 1.2,
                compareSelector: "#main",
                ignoreSelectors: ".ad\n.timestamp",
                ignoreTextRegex: "\\b\\d{4}-\\d{2}-\\d{2}\\b",
                outputDir: "outputs/good",
                enabled: true,
            }),
        });
        assert.equal(goodResponse.status, 201);

        const tasksResponse = await fetch(`${handle.url}/api/tasks`);
        assert.equal(tasksResponse.ok, true);
        const tasksBody = await tasksResponse.json();
        assert.equal(tasksBody.uiTasks.length, 1);
        assert.equal(tasksBody.uiTasks[0].name, "Good URL");
        assert.equal(tasksBody.uiTasks[0].waitLoad, "networkidle2");
        assert.equal(tasksBody.uiTasks[0].waitSelector, "#app");
        assert.equal(tasksBody.uiTasks[0].waitTimeoutSec, 1.2);
        assert.equal(tasksBody.uiTasks[0].compareSelector, "#main");
        assert.equal(Array.isArray(tasksBody.uiTasks[0].ignoreSelectors), true);
        assert.equal(tasksBody.uiTasks[0].ignoreSelectors[0], ".ad");
        assert.equal(tasksBody.uiTasks[0].ignoreTextRegex, "\\b\\d{4}-\\d{2}-\\d{2}\\b");

        const unblockResponse = await fetch(`${handle.url}/api/tasks/${encodeURIComponent(tasksBody.uiTasks[0].id)}/unblock`, {
            method: "POST",
        });
        assert.equal(unblockResponse.ok, true);
        const unblockBody = await unblockResponse.json();
        assert.equal(unblockBody.ok, true);

        const runtimeResponse = await fetch(`${handle.url}/api/runtime`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                launchHeadless: false,
                userAgent: "Mozilla/5.0 (Test UA)",
                acceptLanguage: "en-US,en;q=0.9",
            }),
        });
        assert.equal(runtimeResponse.status, 200);
        const runtimeBody = await runtimeResponse.json();
        assert.equal(runtimeBody.runtime.launchHeadless, false);
        assert.equal(runtimeBody.runtime.userAgent, "Mozilla/5.0 (Test UA)");
        assert.equal(runtimeBody.runtime.acceptLanguage, "en-US,en;q=0.9");
        assert.equal(runtimeBody.state.launchHeadless, false);
        assert.equal(runtimeBody.state.userAgent, "Mozilla/5.0 (Test UA)");
        assert.equal(runtimeBody.state.acceptLanguage, "en-US,en;q=0.9");
        assert.equal(runtimeBody.state.focusRisk, "medium");

        const stateAfterResponse = await fetch(`${handle.url}/api/state`);
        const stateAfterBody = await stateAfterResponse.json();
        assert.equal(stateAfterBody.launchHeadless, false);
        assert.equal(stateAfterBody.focusRisk, "medium");
        assert.equal(stateAfterBody.userAgent, "Mozilla/5.0 (Test UA)");
        assert.equal(stateAfterBody.acceptLanguage, "en-US,en;q=0.9");
    } finally {
        if (handle) {
            await handle.close();
        }
        await closeServer(blocker);

        if (originalUserAgent === undefined) {
            delete process.env.WM_USER_AGENT;
        } else {
            process.env.WM_USER_AGENT = originalUserAgent;
        }
        if (originalAcceptLanguage === undefined) {
            delete process.env.WM_ACCEPT_LANGUAGE;
        } else {
            process.env.WM_ACCEPT_LANGUAGE = originalAcceptLanguage;
        }
    }
});
