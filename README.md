# website-monitor

Local website change monitor with a built-in web console (localhost only).

It periodically opens pages in Chrome, extracts a comparable text snapshot, and when it detects changes it writes a visual `.diff.html` report into `outputs/`.

## Features

- Local web console: create/edit tasks, start/stop engine, tune runtime options, view recent changes
- Two runtime modes:
  - `launch`: managed Chrome (recommended default)
  - `attach`: connect to your existing Chrome (best for login / anti-bot challenges)
- UI task noise filtering:
  - `compareSelector` to focus on a DOM region
  - `ignoreSelectors` to remove noisy DOM nodes
  - `ignoreTextRegex` to strip noisy text (regex flags fixed to `gu`)
- Change reports: word-level diff, similarity score in filename, full-page screenshot, DOM snapshot
- Local outputs browser: `/outputs/...` is browsable in the console
- Binds to `127.0.0.1` only (not exposed to the LAN by default)
- Legacy (advanced) tasks: custom `preprocess/extract/resourcesToCompare/extractResource`

## Requirements

- Node.js v22 (see `.nvmrc`)
- npm
- Google Chrome / Chromium installed (this project uses `puppeteer-core` and does not download a browser)

## Quick Start (macOS)

1. Double-click `run.command` (launch mode).
2. It installs local deps (`npm ci`) if needed, then builds the project.
3. Your browser opens the console at `http://127.0.0.1:3210` (or the next available port).
4. Click `Create Task`, then `Start Monitoring`.

Attach mode: double-click `run-attach.command` (you must start Chrome with remote debugging first, see below).

## Quick Start (Terminal / any OS)

```bash
npm ci
npm run dev          # launch mode control panel
# or
npm run dev:attach   # attach mode control panel
```

## How It Works (UI Tasks)

- The monitor loads the page in Chrome and builds a sanitized clone for text comparison.
- It removes common noise (scripts, templates, hidden nodes, some translation-plugin artifacts, etc.).
- Optional noise controls:
  - `compareSelector`: only compare text inside a specific DOM region
  - `ignoreSelectors`: remove matching nodes before extracting text
  - `ignoreTextRegex`: remove matching text before hashing/comparing (flags fixed to `gu`)
- Baseline behavior:
  - First run writes the baseline and does not produce a diff report.
  - Subsequent runs compare the current snapshot to the baseline hash.
  - When changed, it writes a `.diff.html` report and updates the baseline.

## Launch vs Attach

### launch (recommended default)

- The monitor launches Chrome via Puppeteer.
- Default is headless (no visible window), lower interruption.
- Uses an isolated profile directory: `.chrome-profile`
- Supports concurrency (default `maxConcurrency=3`)

### attach (for login / anti-bot)

- The monitor connects to an already-running Chrome (remote debugging).
- Concurrency is forced to `1` to reduce focus-stealing.
- Better chance of passing Cloudflare/CAPTCHA when using your normal browser session.

Start Chrome with remote debugging (examples)

1. Quit all Chrome instances first.
2. macOS:

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222
```

3. Verify it is reachable: open `http://127.0.0.1:9222/json/version` in a browser; it should return JSON.

If you want an isolated profile (so you do not touch your main Chrome profile), add `--user-data-dir /some/path`, but you may need to log in again.

## Configuration

Main config file: `config/monitors.json`

Behavior notes:

- If missing, it is created with defaults.
- If invalid/corrupt JSON, the file is backed up as `config/monitors.json.corrupt-<timestamp>.json` and then reset to defaults.
- If the requested UI port is taken, the server picks the next available port nearby and writes it back to the config.

Example:

```json
{
  "version": 1,
  "ui": { "port": 3210 },
  "runtime": {
    "mode": "launch",
    "browserUrl": "http://127.0.0.1:9222",
    "includeLegacyTasks": false,
    "launchHeadless": true,
    "maxConcurrency": 3
  },
  "tasks": []
}
```

Notes:

- `runtime.maxConcurrency` limits parallel tasks. In `attach` mode concurrency is forced to `1` (your configured value is preserved but not used).
- `runtime.browserUrl` is only used for `attach`.

### UI Task Fields

Tasks are stored under `tasks` in `config/monitors.json` and are fully editable from the web console.

- `name`: display name
- `url`: page URL (must be `http://` or `https://`)
- `intervalSec`: check interval in seconds
- `waitLoad`: load strategy (`load | domcontentloaded | networkidle2 | networkidle0`)
- `waitSelector`: wait for a DOM element (CSS selector) after navigation
- `waitTimeoutSec`: extra fixed delay after load/selector (seconds; can be fractional)
- `compareSelector`: compare only this DOM region (CSS selector)
- `ignoreSelectors`: remove these selectors before extracting text (one per line in the UI)
- `ignoreTextRegex`: `text.replace(re, "")` before hashing/comparing (flags fixed to `gu`)
- `outputDir`: output directory path; recommended to keep it under `outputs/...` so the console can link to it
- `enabled`: enable/disable the task

Noise filtering tips:

- Start with `compareSelector` to narrow to the content you actually care about.
- Use `ignoreSelectors` for stable-but-noisy DOM blocks (ads, timestamps, popups).
- Use `ignoreTextRegex` last for unavoidable random strings (dates, counters, session ids).

## Outputs

Outputs live under `outputs/`, one folder per task:

```text
outputs/<task>/
  2026-02-08 12-34-56 098.12.diff.html
  .wm/
    baseline.txt
    state.json
```

- `.wm/baseline.txt`: current baseline text (kept to ~200k chars max; large baselines are truncated and marked)
- `.wm/state.json`: baseline metadata and hash (and legacy resource ids)
- `*.diff.html`: change report. The filename includes a similarity percentage (higher means smaller change).

The control server also serves a basic directory listing and file viewer under `/outputs/...` (only inside `outputs/`).

## Control API (localhost only)

The server binds to `127.0.0.1` only.

- `GET /api/state`
- `GET /api/tasks`
- `POST /api/tasks`
- `PUT /api/tasks/:id`
- `DELETE /api/tasks/:id`
- `POST /api/tasks/:id/unblock`
- `PUT /api/runtime`
- `POST /api/engine/start`
- `POST /api/engine/stop`
- `GET /api/changes?limit=N`

## Legacy Tasks (Advanced: custom extraction / resource downloads)

UI tasks cover most "page text changed" workflows. Use legacy tasks when you need:

- custom `preprocess()` logic beyond selectors
- custom comparison (e.g. parse JSON, filter nodes, normalize content)
- resource monitoring and downloading (images, attachments, etc.)

Default legacy tasks file is `.out/tasks.js` (compiled from `tasks.ts`).

How to use:

1. Edit `tasks.ts` and export `TASKS: TaskOptions[]`.
2. Enable legacy tasks in the console (`Include Legacy Tasks`), or set `WM_INCLUDE_LEGACY_TASKS=true`.
3. Legacy tasks are displayed read-only in the console.

To load from another file, set `WM_TASKS_FILE=/absolute/path/to/tasks.js` (must be ESM and export `TASKS`).

Minimal ESM example:

```js
export const TASKS = [
  {
    url: "https://example.com",
    outputDir: "outputs/example",
    waitLoad: "networkidle2",
    textToCompare() {
      return document.querySelector("main")?.textContent ?? "";
    },
    extract() {
      return document.documentElement.outerHTML;
    },
    interval: 60,
  },
];
```

Helpers injected into the page `window` (available to legacy tasks):

- `selectFirst(selector)`
- `selectAll(selector)`
- `selectTags(tagName)`
- `removeElements(iterable)`
- `filterContent(iterable, regex)`
- `quickFetch(url)`
- `fetchResource(url)` (returns `{ encodedBuf, url }`, base64-encoded)

Resource monitoring (legacy):

- `resourcesToCompare()` returns an array of string ids (often URLs).
- When it detects newly-added ids, the monitor calls `extractResource(id)` to download and save them.

## Environment Variables

- `WM_MODE=launch|attach`
- `WM_BROWSER_URL=http://127.0.0.1:9222` (attach target)
- `WM_UI_PORT=3210`
- `WM_OPEN_UI=1|0` (auto-open the console in a browser)
- `WM_TASKS_FILE=/absolute/path/to/tasks.js`
- `WM_INCLUDE_LEGACY_TASKS=true|false`
- `WM_LAUNCH_HEADLESS=true|false` (launch mode)
- `WM_CHROME_EXECUTABLE=/path/to/chrome`
- `WM_USER_AGENT=...` (optional)
- `WM_ACCEPT_LANGUAGE=...` (optional, e.g. `en-US,en;q=0.9`)
- `WM_CONFIG_FILE=/path/to/config.json` (CLI mode only: `npm start`)

Notes:

- User-Agent / Accept-Language are compatibility knobs; they do not guarantee fewer bot challenges.
- In `launch` + headless, if `WM_USER_AGENT` is not set, the monitor normalizes the UA by replacing `HeadlessChrome` with `Chrome` (without hard-coding a UA).

## CLI Mode (No Web Console)

```bash
npm start
```

- Loads tasks from `config/monitors.json` (or `WM_CONFIG_FILE`)
- Runs the monitor engine without the web UI

## Troubleshooting

- Task is `Blocked`: usually Cloudflare/CAPTCHA. Switch to `attach`, complete verification in your normal Chrome session, then click `Unblock`.
- Chrome not found: set `WM_CHROME_EXECUTABLE` to the Chrome executable path.
- Attach connect fails: verify `http://127.0.0.1:9222/json/version` is reachable.
- Diff too noisy: use `compareSelector` first, then `ignoreSelectors`, then `ignoreTextRegex`.
- UI port conflict: the server will auto-pick a nearby free port and write it back to `config/monitors.json`.

## Security Notes

- The control server binds to `127.0.0.1`, but outputs are written to disk under `outputs/` and may include screenshots and HTML snapshots. Treat `outputs/` as sensitive.
- Legacy tasks are executable code (dynamic `import` in Node). Only load scripts you trust.
- Attach mode uses your existing Chrome session (cookies/login state). Only enable it for sites you trust.

## Scripts

```bash
npm run dev          # launch mode control panel
npm run dev:attach   # attach mode control panel
npm run start        # CLI engine (no web console)
npm run build
npm run test
npm run clean
```

## Cleanup

Local residue:

- Local npm cache: `.cache/npm`
- Chrome profile (launch mode): `.chrome-profile`
- Build output: `.out`
- Dependencies: `node_modules`
- Monitoring outputs: `outputs` (kept by default)

Clean everything except `outputs/`:

```bash
npm run clean
```

Or double-click `clean.command`.

To stop leftover monitor processes quickly, double-click `stop.command`.

## License

ISC

