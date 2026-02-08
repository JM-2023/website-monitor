import assert from "node:assert/strict";
import test from "node:test";

import { createDiffReportHtml } from "../.out/diff-report.js";

test("createDiffReportHtml includes red/green highlight spans", () => {
    const html = createDiffReportHtml({
        taskName: "Demo",
        url: "https://example.com",
        previousText: "Hello old world",
        currentText: "Hello new world",
        snapshotPath: "outputs/demo/1.html",
        createdAt: "2026-02-07T10:00:00.000Z",
    });

    assert.match(html, /diff-del/);
    assert.match(html, /diff-add/);
    assert.match(html, /Removed/);
    assert.match(html, /Added/);
});

test("createDiffReportHtml can embed rendered preview image", () => {
    const html = createDiffReportHtml({
        taskName: "Preview",
        url: "https://example.com",
        previousText: "before",
        currentText: "after",
        screenshotDataUrl: "data:image/jpeg;base64,ZmFrZS1pbWFnZS1kYXRh",
        createdAt: "2026-02-07T10:00:00.000Z",
    });

    assert.match(html, /Rendered Preview/);
    assert.match(html, /data:image\/jpeg;base64/);
});

test("createDiffReportHtml can embed rendered html iframe", () => {
    const html = createDiffReportHtml({
        taskName: "Rendered DOM",
        url: "https://example.com",
        previousText: "old",
        currentText: "new",
        previousRenderedHtml: "<!doctype html><html><body><h1>Old</h1></body></html>",
        currentRenderedHtml: "<!doctype html><html><body><h1>New</h1></body></html>",
        createdAt: "2026-02-07T10:00:00.000Z",
    });

    assert.match(html, /Rendered DOM Snapshot/);
    assert.match(html, /Blue = removed/);
    assert.match(html, /id="frame-merged"/);
    assert.match(html, /render-highlight/);
    assert.match(html, /srcdoc="&lt;!doctype html&gt;/);
});
