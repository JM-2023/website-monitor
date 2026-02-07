export interface ExtractedResource {
    filename?: string;
    encodedBuf: string;
}

export type WaitLoadStrategy = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

export interface TaskOptions {
    url: string;
    outputDir: string;

    waitLoad?: WaitLoadStrategy;
    waitTimeout?: number;
    waitSelector?: string;
    timeout?: number;

    preprocess?: (this: Window) => void | Promise<void>;
    textToCompare?: (this: Window) => string | undefined | Promise<string | undefined>;
    resourcesToCompare?: (this: Window) => string[] | Promise<string[]>;
    extract: (this: Window) => string | undefined | Promise<string | undefined>;
    extractResource?: (this: Window, id: string) => Promise<ExtractedResource | ExtractedResource[]>;

    interval: number | (() => number);
}

export type RuntimeMode = "launch" | "attach";

export interface UiTaskConfig {
    id: string;
    name: string;
    url: string;
    intervalSec: number;
    waitLoad?: WaitLoadStrategy;
    waitSelector?: string;
    waitTimeoutSec?: number;
    outputDir: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface MonitorConfig {
    version: 1;
    ui: {
        port: number;
    };
    runtime: {
        mode: RuntimeMode;
        browserUrl: string;
        includeLegacyTasks: boolean;
        launchHeadless: boolean;
    };
    tasks: UiTaskConfig[];
}

export interface RuntimeTaskStatus {
    id: string;
    source: "ui" | "legacy";
    name: string;
    url: string;
    enabled: boolean;
    intervalSec: number;
    outputDir: string;
    running: boolean;
    nextCheckAt: string | null;
    lastCheckAt: string | null;
    lastChangeAt: string | null;
    lastError: string | null;
    lastSavedFile: string | null;
}

export interface ChangeRecord {
    id: string;
    taskId: string;
    taskName: string;
    source: "ui" | "legacy";
    savedPath: string;
    timestamp: string;
}

export interface RuntimeOptions {
    mode: RuntimeMode;
    browserUrl: string;
    includeLegacyTasks: boolean;
    launchHeadless: boolean;
    tasksFile?: string;
    chromeExecutable?: string;
}
