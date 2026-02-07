import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanTargets } from "../scripts/clean.mjs";

async function exists(target) {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

test("cleanTargets removes dependency/cache/build folders and keeps outputs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wm-clean-test-"));
    const paths = {
        nodeModules: path.join(tempRoot, "node_modules"),
        out: path.join(tempRoot, ".out"),
        cache: path.join(tempRoot, ".cache"),
        chromeProfile: path.join(tempRoot, ".chrome-profile"),
        outputs: path.join(tempRoot, "outputs"),
    };

    await fs.mkdir(paths.nodeModules, { recursive: true });
    await fs.mkdir(paths.out, { recursive: true });
    await fs.mkdir(paths.cache, { recursive: true });
    await fs.mkdir(paths.chromeProfile, { recursive: true });
    await fs.mkdir(paths.outputs, { recursive: true });
    await fs.writeFile(path.join(paths.outputs, "keep.txt"), "keep");

    await cleanTargets(tempRoot);

    assert.equal(await exists(paths.nodeModules), false);
    assert.equal(await exists(paths.out), false);
    assert.equal(await exists(paths.cache), false);
    assert.equal(await exists(paths.chromeProfile), false);
    assert.equal(await exists(paths.outputs), true);
    assert.equal(await exists(path.join(paths.outputs, "keep.txt")), true);
});
