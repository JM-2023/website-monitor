// @ts-ignore
import sourceMapSupport from "source-map-support";
import fs from "fs/promises";
import path from "path";
import puppetter from "puppeteer-core";
import { formatISO9075 } from "date-fns";
import { calculateSimilarity, injectDOMHelpers } from "./helpers.js";
import { TASKS } from "./tasks.js";

export interface ExtractedResource {
    filename?: string;
    encodedBuf: string;
}

export interface TaskOptions {
    url: string;
    outputDir: string;

    waitLoad?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
    waitTimeout?: number;
    waitSelector?: string;
    timeout?: number;

    preprocess?: (this: never) => void | Promise<void>;
    textToCompare?: (this: never) => string | undefined | Promise<string>;
    resourcesToCompare?: (this: never) => string[] | Promise<string[]>;
    extract: (this: never) => string | undefined | Promise<string>;
    extractResource?: (this: never, id: string) => Promise<ExtractedResource | Required<ExtractedResource[]>>;

    interval: number | (() => number);
}

try {
    sourceMapSupport.install();
} catch (ignore) {}

(async function () {
    const browser = await puppetter.connect({
        browserURL: "http://localhost:9222",
        defaultViewport: null,
    });

    const page = await browser.newPage();
    let working = false;

    function handleExit() {
        console.log("exiting...");
        try {
            page.close();
        } catch (ignore) {
        } finally {
            process.exit(0);
        }
    }

    process.on("SIGINT", handleExit);
    process.on("beforeExit", handleExit);

    async function run(options: TaskOptions) {
        const timeout = (options.timeout ?? 15) * 1000;

        await page.goto(options.url, {
            waitUntil: options.waitLoad ?? "load",
            timeout,
        });
        options.waitSelector && (await page.waitForSelector(options.waitSelector, { timeout }));
        options.waitTimeout && (await page.waitForTimeout(options.waitTimeout * 1000));

        await page.evaluate(injectDOMHelpers);

        options.preprocess && (await page.evaluate(options.preprocess));
        const data = (await page.evaluate(options.extract)) ?? "";
        const textToCompare = !options.textToCompare ? data : (await page.evaluate(options.textToCompare)) ?? "";
        const resourcesToCompare = !options.resourcesToCompare ? [] : await page.evaluate(options.resourcesToCompare);

        return { data, textToCompare, resourcesToCompare };
    }

    let globalNext: number = +Infinity;

    function updateMessage() {
        if (!working) {
            try {
                page.evaluate((globalNext: number) => {
                    document.title = "Website Monitor";
                    document.body.innerHTML = `<h2>Next check after ${globalNext} secs</h4>`;
                }, globalNext);
            } catch (e) {}
        }
    }

    setInterval(() => {
        globalNext > 0 && globalNext--;
        updateMessage();
    }, 1000);

    for (const task of TASKS) {
        let last: string = "";
        let lastResources: string[] = [];

        async function doTask() {
            while (working) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            working = true;

            const nextTime = typeof task.interval === "function" ? task.interval() : task.interval;
            console.log(`checking "${task.url}" (next check after ${nextTime}s)`);

            try {
                const time = formatISO9075(new Date()).replaceAll(":", "-");
                const { data, textToCompare, resourcesToCompare } = await run(task);

                const similarity = calculateSimilarity(last, textToCompare);
                if (similarity !== 1) {
                    const similarityStr = (similarity * 100).toFixed(2).padStart(5, "0");

                    const file = path.join(task.outputDir, `${time} ${similarityStr}.html`);
                    await fs.mkdir(task.outputDir, { recursive: true });
                    await fs.writeFile(file, data);
                    console.log(`change detected, saved to "${file}"`);

                    last = textToCompare;
                }

                if (resourcesToCompare.length >= lastResources.length) {
                    const diff = resourcesToCompare.filter((r) => !lastResources.includes(r));
                    if (diff.length) {
                        if (task.extractResource) {
                            let count = 0;
                            for (const id of diff) {
                                const resources = await page.evaluate(task.extractResource, id);
                                const dir = path.join(task.outputDir, time);
                                await fs.mkdir(dir, { recursive: true });
                                for (const res of Array.isArray(resources) ? resources : [resources]) {
                                    const { filename, encodedBuf } = res;
                                    await fs.writeFile(
                                        path.join(dir, filename ?? path.basename(id)),
                                        Buffer.from(encodedBuf, "base64")
                                    );
                                    count++;
                                }
                            }

                            console.log(`${count} resource(s) downloaded`);
                        } else {
                            await fs.writeFile(path.join(task.outputDir, `${time}.resources.txt`), diff.join("\n"));
                        }
                    }
                }

                lastResources = resourcesToCompare;
            } catch (e) {
                // console.warn(e.toString());
                console.warn(e);
            } finally {
                await page.goto("about:blank", { waitUntil: "domcontentloaded" });
            }

            working = false;
            globalNext = globalNext <= 0 ? nextTime : Math.min(globalNext, nextTime);
            updateMessage();
            setTimeout(doTask, nextTime * 1000);
        }

        await doTask();
    }
})();
