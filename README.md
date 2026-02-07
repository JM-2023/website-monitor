# website-monitor

Local website monitor with a built-in web console.

## Quick Start (macOS)

1. Double-click `run.command`.
2. The script installs local dependencies (`npm ci`) if needed.
3. Your browser opens the local console (default `http://127.0.0.1:3210`).
4. Add tasks and click **Start Monitoring**.

No global dependency installation is required.  
All dependencies are installed in local `node_modules`.

## Launch Modes

- `run.command`: default launch mode (managed Chrome, no required `9222`).
- `run-attach.command`: attach mode (connects to existing Chrome at `http://127.0.0.1:9222`).

## Local Residue Policy

- Local npm cache: `.cache/npm`
- Local Chrome profile (launch mode): `.chrome-profile`
- Build output: `.out`
- Dependencies: `node_modules`

Cleanup command (keeps monitoring outputs):

```bash
npm run clean
```

Or double-click `clean.command`.

To stop leftover monitor processes quickly, double-click `stop.command`.

## Scripts

```bash
npm run dev          # launch mode control panel
npm run dev:attach   # attach mode control panel
npm run start        # CLI-compatible monitor runner (no web console)
npm run build
npm run test
npm run clean
```

## Control API (localhost only)

Server binds to `127.0.0.1` only.

- `GET /api/state`
- `GET /api/tasks`
- `POST /api/tasks`
- `PUT /api/tasks/:id`
- `DELETE /api/tasks/:id`
- `POST /api/engine/start`
- `POST /api/engine/stop`
- `GET /api/changes?limit=N`

## Configuration File

File: `config/monitors.json`

```json
{
  "version": 1,
  "ui": { "port": 3210 },
  "runtime": {
    "mode": "launch",
    "browserUrl": "http://127.0.0.1:9222",
    "includeLegacyTasks": false
  },
  "tasks": []
}
```

## Legacy Task Compatibility

- UI tasks are stored in `config/monitors.json`.
- Legacy advanced tasks can still be loaded from `TASKS_FILE` (default `.out/tasks.js`).
- Legacy tasks are read-only in the web console.

## Environment Variables

- `WM_MODE=launch|attach`
- `WM_BROWSER_URL=http://127.0.0.1:9222`
- `WM_UI_PORT=3210`
- `WM_TASKS_FILE=/absolute/path/to/tasks.js`
- `WM_INCLUDE_LEGACY_TASKS=true|false`
- `WM_CHROME_EXECUTABLE=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
