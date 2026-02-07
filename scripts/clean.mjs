#!/usr/bin/env node
import fs from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const TARGETS = ["node_modules", ".out", ".cache", ".chrome-profile"];
const RETRYABLE_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"]);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTarget(baseDir, target) {
    const absolutePath = path.join(baseDir, target);
    try {
        await fs.rm(absolutePath, {
            recursive: true,
            force: true,
            maxRetries: 8,
            retryDelay: 150,
        });
        console.log(`removed ${target}`);
        return;
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (!RETRYABLE_CODES.has(code)) {
            throw error;
        }
    }

    const fallbackPath = `${absolutePath}.cleanup-${Date.now()}`;
    try {
        await fs.rename(absolutePath, fallbackPath);
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code === "ENOENT") {
            console.log(`removed ${target}`);
            return;
        }
        throw error;
    }

    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await fs.rm(fallbackPath, {
                recursive: true,
                force: true,
                maxRetries: 8,
                retryDelay: 150,
            });
            console.log(`removed ${target}`);
            return;
        } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
            if (!RETRYABLE_CODES.has(code) || attempt === 5) {
                throw error;
            }
            await sleep(attempt * 120);
        }
    }
}

export async function cleanTargets(baseDir = rootDir, targets = TARGETS) {
    for (const target of targets) {
        await removeTarget(baseDir, target);
    }
}

async function main() {
    for (const target of TARGETS) {
        await removeTarget(rootDir, target);
    }
    console.log("clean complete. Monitoring outputs are kept.");
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
    main().catch((error) => {
        console.error("clean failed:", error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
