interface DiffChunk {
    type: "equal" | "add" | "del";
    value: string;
}

interface DiffReportOptions {
    taskName: string;
    url: string;
    previousText: string;
    currentText: string;
    snapshotPath?: string;
    screenshotDataUrl?: string;
    previousRenderedHtml?: string;
    currentRenderedHtml?: string;
    createdAt: string;
}

interface TruncatedText {
    text: string;
    truncated: boolean;
}

const MAX_COMPARE_CHARS = 120_000;
const MAX_RENDER_CHARS = 90_000;
const MAX_HIGHLIGHT_TERMS = 120;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

const EN_STOP_WORDS = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "you",
    "your",
    "are",
    "was",
    "were",
    "have",
    "has",
    "had",
    "will",
    "can",
    "not",
    "but",
    "all",
    "new",
    "more",
    "read",
    "home",
    "news",
]);

function escapeHtml(input: string): string {
    return input
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function truncateText(input: string, maxChars: number): TruncatedText {
    if (input.length <= maxChars) {
        return { text: input, truncated: false };
    }
    return {
        text: `${input.slice(0, maxChars)}\n\n[...truncated for diff performance...]`,
        truncated: true,
    };
}

function tokenizeByWord(input: string): string[] {
    const tokens = input.match(/\s+|\S+/g);
    return tokens ?? [];
}

function mergeChunks(chunks: DiffChunk[]): DiffChunk[] {
    if (!chunks.length) {
        return chunks;
    }

    const merged: DiffChunk[] = [];
    for (const chunk of chunks) {
        const previous = merged[merged.length - 1];
        if (previous && previous.type === chunk.type) {
            previous.value += chunk.value;
        } else {
            merged.push({ ...chunk });
        }
    }

    return merged;
}

function myersWordDiff(beforeTokens: string[], afterTokens: string[]): DiffChunk[] {
    const n = beforeTokens.length;
    const m = afterTokens.length;
    const max = n + m;

    const trace: Map<number, number>[] = [];
    let frontier = new Map<number, number>();
    frontier.set(1, 0);

    let finalDistance = 0;
    outer: for (let d = 0; d <= max; d++) {
        const nextFrontier = new Map<number, number>();

        for (let k = -d; k <= d; k += 2) {
            const left = frontier.get(k - 1) ?? Number.NEGATIVE_INFINITY;
            const right = frontier.get(k + 1) ?? Number.NEGATIVE_INFINITY;

            let x: number;
            if (k === -d || (k !== d && left < right)) {
                x = frontier.get(k + 1) ?? 0;
            } else {
                x = (frontier.get(k - 1) ?? 0) + 1;
            }

            let y = x - k;
            while (x < n && y < m && beforeTokens[x] === afterTokens[y]) {
                x++;
                y++;
            }

            nextFrontier.set(k, x);

            if (x >= n && y >= m) {
                trace.push(nextFrontier);
                finalDistance = d;
                break outer;
            }
        }

        trace.push(nextFrontier);
        frontier = nextFrontier;
    }

    let x = n;
    let y = m;
    const reversed: DiffChunk[] = [];

    for (let d = finalDistance; d > 0; d--) {
        const previousFrontier = trace[d - 1];
        const k = x - y;
        const left = previousFrontier.get(k - 1) ?? Number.NEGATIVE_INFINITY;
        const right = previousFrontier.get(k + 1) ?? Number.NEGATIVE_INFINITY;

        const prevK = k === -d || (k !== d && left < right) ? k + 1 : k - 1;
        const prevX = previousFrontier.get(prevK) ?? 0;
        const prevY = prevX - prevK;

        while (x > prevX && y > prevY) {
            reversed.push({ type: "equal", value: beforeTokens[x - 1] });
            x--;
            y--;
        }

        if (x === prevX) {
            reversed.push({ type: "add", value: afterTokens[prevY] ?? "" });
            y--;
        } else {
            reversed.push({ type: "del", value: beforeTokens[prevX] ?? "" });
            x--;
        }
    }

    while (x > 0 && y > 0) {
        reversed.push({ type: "equal", value: beforeTokens[x - 1] });
        x--;
        y--;
    }

    while (x > 0) {
        reversed.push({ type: "del", value: beforeTokens[x - 1] });
        x--;
    }

    while (y > 0) {
        reversed.push({ type: "add", value: afterTokens[y - 1] });
        y--;
    }

    return mergeChunks(reversed.reverse());
}

function renderChunksToHtml(chunks: DiffChunk[]): { html: string; truncated: boolean; addedChars: number; removedChars: number } {
    let addedChars = 0;
    let removedChars = 0;

    const htmlParts: string[] = [];
    let renderedChars = 0;
    let truncated = false;

    for (const chunk of chunks) {
        if (chunk.type === "add") {
            addedChars += chunk.value.length;
        }
        if (chunk.type === "del") {
            removedChars += chunk.value.length;
        }

        if (renderedChars >= MAX_RENDER_CHARS) {
            truncated = true;
            break;
        }

        const remaining = MAX_RENDER_CHARS - renderedChars;
        const text = chunk.value.length > remaining ? chunk.value.slice(0, remaining) : chunk.value;
        renderedChars += text.length;

        const escaped = escapeHtml(text);
        if (chunk.type === "add") {
            htmlParts.push(`<span class="diff-add">${escaped}</span>`);
        } else if (chunk.type === "del") {
            htmlParts.push(`<span class="diff-del">${escaped}</span>`);
        } else {
            htmlParts.push(`<span>${escaped}</span>`);
        }

        if (text.length < chunk.value.length) {
            truncated = true;
            break;
        }
    }

    return {
        html: htmlParts.join(""),
        truncated,
        addedChars,
        removedChars,
    };
}

function extractHighlightTerms(chunks: DiffChunk[], type: "add" | "del"): string[] {
    const terms = new Set<string>();

    for (const chunk of chunks) {
        if (chunk.type !== type) {
            continue;
        }
        const tokens = chunk.value.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9][A-Za-z0-9_-]{2,}/gu) ?? [];
        for (const token of tokens) {
            const normalized = token.trim();
            if (!normalized) {
                continue;
            }
            if (normalized.length > 80) {
                continue;
            }
            if (/^[A-Za-z]+$/.test(normalized) && EN_STOP_WORDS.has(normalized.toLowerCase())) {
                continue;
            }
            terms.add(normalized);
        }
    }

    return Array.from(terms)
        .sort((a, b) => b.length - a.length)
        .slice(0, MAX_HIGHLIGHT_TERMS);
}

export function createDiffReport(options: DiffReportOptions): {
    html: string;
    similarity: number;
    addedChars: number;
    removedChars: number;
} {
    const previous = truncateText(options.previousText, MAX_COMPARE_CHARS);
    const current = truncateText(options.currentText, MAX_COMPARE_CHARS);

    const chunks = myersWordDiff(tokenizeByWord(previous.text), tokenizeByWord(current.text));
    const rendered = renderChunksToHtml(chunks);
    const den = previous.text.length + current.text.length;
    const similarity = den === 0 ? 1 : clamp(1 - (rendered.addedChars + rendered.removedChars) / den, 0, 1);

    const notes: string[] = [];
    if (previous.truncated || current.truncated) {
        notes.push("Input text was truncated before diff generation to keep performance stable.");
    }
    if (rendered.truncated) {
        notes.push("Rendered diff was truncated due to size.");
    }

    const noteHtml =
        notes.length > 0
            ? `<p class="note"><strong>Note:</strong> ${escapeHtml(notes.join(" "))}</p>`
            : "";

    const addTerms = extractHighlightTerms(chunks, "add");
    const delTerms = extractHighlightTerms(chunks, "del");

    const snapshotMeta = options.snapshotPath
        ? `<div class="meta">Snapshot: <code>${escapeHtml(options.snapshotPath)}</code></div>`
        : "";
    const screenshotSection = options.screenshotDataUrl
        ? `<section class="preview-wrap">
          <h2>Rendered Preview</h2>
          <img class="preview-image" src="${options.screenshotDataUrl}" alt="Rendered page preview" />
        </section>`
        : "";
    const renderedHtmlSection = options.currentRenderedHtml
        ? `<section class="preview-wrap">
          <h2>Rendered DOM Snapshot</h2>
          <p class="render-hint">Blue = removed from previous snapshot, Green = newly added in current snapshot.</p>
          <iframe id="frame-merged" class="rendered-frame" sandbox="allow-forms allow-pointer-lock allow-popups allow-scripts allow-same-origin" srcdoc="${escapeHtml(
              options.currentRenderedHtml
          )}"></iframe>
        </section>`
        : "";

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Diff - ${escapeHtml(options.taskName)}</title>
    <style>
      :root {
        color-scheme: light;
      }

      body {
        margin: 0;
        padding: 24px;
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
        background: #f4f7fa;
        color: #112433;
      }

      .card {
        max-width: 1200px;
        margin: 0 auto;
        background: #fff;
        border-radius: 14px;
        border: 1px solid #d7e3ea;
        box-shadow: 0 14px 34px rgba(16, 38, 53, 0.14);
        overflow: hidden;
      }

      header {
        padding: 18px 20px;
        background: linear-gradient(135deg, #e5f2f3 0%, #fff 50%, #f6eadf 100%);
        border-bottom: 1px solid #d7e3ea;
      }

      h1 {
        margin: 0;
        font-size: 1.15rem;
      }

      .meta {
        margin-top: 8px;
        color: #4f6574;
        font-size: 0.9rem;
      }

      .meta code {
        font-family: "SF Mono", Menlo, Consolas, monospace;
      }

      .summary {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 8px;
      }

      .pill {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        border-radius: 999px;
        padding: 3px 10px;
        font-size: 0.8rem;
        font-weight: 700;
      }

      .pill-add {
        background: #d9f2dd;
        color: #1f6d2d;
      }

      .pill-del {
        background: #f8dada;
        color: #922727;
      }

      .pill-sim {
        background: #ddebf5;
        color: #1d4f73;
      }

      .diff {
        margin: 0;
        padding: 16px 20px 20px;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.42;
        font-family: "SF Mono", Menlo, Consolas, monospace;
        font-size: 0.84rem;
      }

      .diff-del {
        background: #ffdede;
        color: #8e2020;
        text-decoration: line-through;
      }

      .diff-add {
        background: #dbf5df;
        color: #1e6f2e;
      }

      .note {
        margin: 0;
        padding: 0 20px 18px;
        color: #5b6f7e;
        font-size: 0.85rem;
      }

      .preview-wrap {
        margin: 0 20px 18px;
        padding: 14px;
        border: 1px solid #d7e3ea;
        border-radius: 12px;
        background: #fbfdff;
      }

      .preview-wrap h2 {
        margin: 0 0 10px;
        font-size: 0.95rem;
        color: #1b425c;
      }

      .preview-image {
        width: 100%;
        height: auto;
        border-radius: 8px;
        border: 1px solid #ccdbe4;
        display: block;
        background: #fff;
      }

      .render-hint {
        margin: 0 0 10px;
        font-size: 0.86rem;
        color: #416175;
      }

      .rendered-frame {
        width: 100%;
        min-height: 680px;
        border-radius: 8px;
        border: 1px solid #ccdbe4;
        background: #fff;
      }
    </style>
  </head>
  <body>
    <article class="card">
      <header>
        <h1>${escapeHtml(options.taskName)}</h1>
        <div class="meta">URL: ${escapeHtml(options.url)}</div>
        <div class="meta">Created: ${escapeHtml(options.createdAt)}</div>
        ${snapshotMeta}
        <div class="summary">
          <span class="pill pill-sim">Similarity ${(similarity * 100).toFixed(2)}%</span>
          <span class="pill pill-add">Added ${rendered.addedChars} chars</span>
          <span class="pill pill-del">Removed ${rendered.removedChars} chars</span>
        </div>
      </header>
      ${screenshotSection}
      ${renderedHtmlSection}
      <pre class="diff">${rendered.html}</pre>
      ${noteHtml}
    </article>
    <script>
      const addTerms = ${JSON.stringify(addTerms)};
      const delTerms = ${JSON.stringify(delTerms)};

      function escapeRegExp(input) {
        return input.replace(/[.*+?^$()|[\]{}\\]/g, "\\\\$&");
      }

      function buildRegex(terms) {
        if (!Array.isArray(terms) || terms.length === 0) {
          return null;
        }
        const escaped = terms.map((term) => escapeRegExp(term)).filter(Boolean);
        if (escaped.length === 0) {
          return null;
        }
        return new RegExp("(" + escaped.join("|") + ")", "gu");
      }

      function injectHighlightStyle(doc) {
        const style = doc.createElement("style");
        style.textContent = [
          "mark.render-highlight { padding: 0 1px; border-radius: 2px; }",
          "mark.render-highlight.add { background: rgba(95, 215, 128, 0.35); color: inherit; }",
          "mark.render-highlight.del { background: rgba(110, 170, 255, 0.32); color: inherit; }"
        ].join("\\n");
        doc.head.appendChild(style);
      }

      function highlightDocumentText(doc, terms, className) {
        const regex = buildRegex(terms);
        if (!regex) {
          return;
        }

        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const text = node.nodeValue || "";
            if (!text.trim()) {
              return NodeFilter.FILTER_REJECT;
            }
            const parent = node.parentElement;
            if (!parent) {
              return NodeFilter.FILTER_REJECT;
            }
            if (parent.closest("mark.render-highlight")) {
              return NodeFilter.FILTER_REJECT;
            }
            const tag = parent.tagName;
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        });

        const nodes = [];
        while (walker.nextNode()) {
          nodes.push(walker.currentNode);
        }

        for (const textNode of nodes) {
          const value = textNode.nodeValue || "";
          regex.lastIndex = 0;
          if (!regex.test(value)) {
            continue;
          }

          const fragment = doc.createDocumentFragment();
          let lastIndex = 0;
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(value)) !== null) {
            const index = match.index;
            if (index > lastIndex) {
              fragment.appendChild(doc.createTextNode(value.slice(lastIndex, index)));
            }

            const mark = doc.createElement("mark");
            mark.className = "render-highlight " + className;
            mark.textContent = match[0];
            fragment.appendChild(mark);
            lastIndex = index + match[0].length;

            if (match.index === regex.lastIndex) {
              regex.lastIndex += 1;
            }
          }

          if (lastIndex < value.length) {
            fragment.appendChild(doc.createTextNode(value.slice(lastIndex)));
          }

          textNode.parentNode.replaceChild(fragment, textNode);
        }
      }

      function highlightMergedFrame(frameId) {
        const iframe = document.getElementById(frameId);
        if (!iframe) {
          return;
        }

        const apply = () => {
          const doc = iframe.contentDocument;
          if (!doc || !doc.body) {
            return;
          }

          injectHighlightStyle(doc);
          highlightDocumentText(doc, addTerms, "add");

          const addSet = new Set(addTerms);
          const delTermsFiltered = delTerms.filter((term) => !addSet.has(term));
          highlightDocumentText(doc, delTermsFiltered, "del");
        };

        iframe.addEventListener("load", apply, { once: true });
        if (iframe.contentDocument?.readyState === "complete") {
          apply();
        }
      }

      highlightMergedFrame("frame-merged");
    </script>
  </body>
</html>`;

    return {
        html,
        similarity,
        addedChars: rendered.addedChars,
        removedChars: rendered.removedChars,
    };
}

export function createDiffReportHtml(options: DiffReportOptions): string {
    return createDiffReport(options).html;
}
