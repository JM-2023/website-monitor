import assert from "node:assert/strict";
import test from "node:test";

import { injectDOMHelpers, sanitizeFilename } from "./.out/helpers.js";

test("sanitizeFilename strips traversal and invalid characters", () => {
    assert.equal(sanitizeFilename("../a:b?.png"), "a_b_.png");
    assert.equal(sanitizeFilename("..\\..\\evil.txt"), "evil.txt");
    assert.equal(sanitizeFilename(""), "resource.bin");
});

test("sanitizeFilename protects reserved windows names", () => {
    assert.equal(sanitizeFilename("con"), "_con");
    assert.equal(sanitizeFilename("LPT1"), "_LPT1");
});

test("injectDOMHelpers keeps legacy array helper chain working", () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousRemoveAll = Array.prototype.removeAll;
    const previousFilterContent = Array.prototype.filterContent;

    try {
        globalThis.document = {
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementsByTagName: () => [],
        };
        globalThis.window = {
            btoa(input) {
                return Buffer.from(input, "binary").toString("base64");
            },
            fetch: async () => {
                throw new Error("not implemented");
            },
            location: { href: "https://example.com/" },
        };

        injectDOMHelpers();

        assert.equal(typeof [].filterContent, "function");
        assert.equal(typeof [].removeAll, "function");

        const elements = [
            { textContent: "keep", removed: false, remove() { this.removed = true; } },
            { textContent: "drop", removed: false, remove() { this.removed = true; } },
            { textContent: null, removed: false, remove() { this.removed = true; } },
        ];

        const matched = elements.filterContent(/^drop$/);
        matched.removeAll();

        assert.equal(elements[0].removed, false);
        assert.equal(elements[1].removed, true);
        assert.equal(elements[2].removed, false);
    } finally {
        if (previousWindow === undefined) {
            Reflect.deleteProperty(globalThis, "window");
        } else {
            globalThis.window = previousWindow;
        }
        if (previousDocument === undefined) {
            Reflect.deleteProperty(globalThis, "document");
        } else {
            globalThis.document = previousDocument;
        }

        if (previousRemoveAll === undefined) {
            Reflect.deleteProperty(Array.prototype, "removeAll");
        } else {
            Array.prototype.removeAll = previousRemoveAll;
        }
        if (previousFilterContent === undefined) {
            Reflect.deleteProperty(Array.prototype, "filterContent");
        } else {
            Array.prototype.filterContent = previousFilterContent;
        }
    }
});
