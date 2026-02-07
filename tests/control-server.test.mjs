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

        const runtimeResponse = await fetch(`${handle.url}/api/runtime`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                launchHeadless: false,
            }),
        });
        assert.equal(runtimeResponse.status, 200);
        const runtimeBody = await runtimeResponse.json();
        assert.equal(runtimeBody.runtime.launchHeadless, false);
        assert.equal(runtimeBody.state.launchHeadless, false);
        assert.equal(runtimeBody.state.focusRisk, "medium");

        const stateAfterResponse = await fetch(`${handle.url}/api/state`);
        const stateAfterBody = await stateAfterResponse.json();
        assert.equal(stateAfterBody.launchHeadless, false);
        assert.equal(stateAfterBody.focusRisk, "medium");
    } finally {
        if (handle) {
            await handle.close();
        }
        await closeServer(blocker);
    }
});
