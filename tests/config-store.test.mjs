import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigStore } from "../.out/config-store.js";

test("ConfigStore creates default config and persists task CRUD", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wm-config-test-"));
    const configPath = path.join(tempRoot, "config", "monitors.json");
    const store = new ConfigStore(configPath);

    const loaded = await store.load();
    assert.equal(loaded.version, 1);
    assert.equal(Array.isArray(loaded.tasks), true);
    assert.equal(loaded.ui.port, 3210);
    assert.equal(loaded.runtime.includeLegacyTasks, false);
    assert.equal(loaded.runtime.launchHeadless, true);
    assert.equal(loaded.runtime.userAgent, undefined);
    assert.equal(loaded.runtime.acceptLanguage, undefined);

    const created = await store.addTask({
        name: "Example",
        url: "https://example.com",
        intervalSec: 45,
        waitLoad: "networkidle2",
        waitSelector: "#main",
        waitTimeoutSec: 1.5,
    });
    assert.equal(created.name, "Example");
    assert.equal(created.outputDir, "outputs/example");
    assert.equal(created.waitLoad, "networkidle2");
    assert.equal(created.waitSelector, "#main");
    assert.equal(created.waitTimeoutSec, 1.5);

    const updated = await store.updateTask(created.id, {
        intervalSec: 90,
        waitLoad: "domcontentloaded",
        waitSelector: "",
        waitTimeoutSec: 0,
        enabled: false,
    });
    assert.equal(updated.intervalSec, 90);
    assert.equal(updated.enabled, false);
    assert.equal(updated.waitLoad, "domcontentloaded");
    assert.equal(updated.waitSelector, undefined);
    assert.equal(updated.waitTimeoutSec, undefined);

    const runtime = await store.updateRuntime({
        launchHeadless: false,
        includeLegacyTasks: false,
        userAgent: "Mozilla/5.0 (Test UA)",
        acceptLanguage: "en-US,en;q=0.9",
    });
    assert.equal(runtime.launchHeadless, false);
    assert.equal(runtime.includeLegacyTasks, false);
    assert.equal(runtime.userAgent, "Mozilla/5.0 (Test UA)");
    assert.equal(runtime.acceptLanguage, "en-US,en;q=0.9");

    const reloadedStore = new ConfigStore(configPath);
    const reloaded = await reloadedStore.load();
    assert.equal(reloaded.tasks.length, 1);
    assert.equal(reloaded.tasks[0].intervalSec, 90);
    assert.equal(reloaded.tasks[0].waitLoad, "domcontentloaded");
    assert.equal(reloaded.runtime.launchHeadless, false);
    assert.equal(reloaded.runtime.includeLegacyTasks, false);
    assert.equal(reloaded.runtime.userAgent, "Mozilla/5.0 (Test UA)");
    assert.equal(reloaded.runtime.acceptLanguage, "en-US,en;q=0.9");

    const cleared = await reloadedStore.updateRuntime({
        userAgent: "",
        acceptLanguage: "",
    });
    assert.equal(cleared.userAgent, undefined);
    assert.equal(cleared.acceptLanguage, undefined);

    const afterClearStore = new ConfigStore(configPath);
    const afterClear = await afterClearStore.load();
    assert.equal(afterClear.runtime.userAgent, undefined);
    assert.equal(afterClear.runtime.acceptLanguage, undefined);

    await reloadedStore.deleteTask(created.id);
    const afterDelete = reloadedStore.get();
    assert.equal(afterDelete.tasks.length, 0);
});

test("ConfigStore normalizes legacy runtime config without launchHeadless", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wm-config-legacy-test-"));
    const configPath = path.join(tempRoot, "config", "monitors.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
        configPath,
        JSON.stringify(
            {
                version: 1,
                ui: { port: 3210 },
                runtime: {
                    mode: "launch",
                    browserUrl: "http://127.0.0.1:9222",
                    includeLegacyTasks: true,
                },
                tasks: [],
            },
            null,
            2
        ),
        "utf8"
    );

    const store = new ConfigStore(configPath);
    const loaded = await store.load();
    assert.equal(loaded.runtime.launchHeadless, true);
});
