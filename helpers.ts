import levenshtein from "js-levenshtein";
import type { ExtractedResource } from "./types.js";

export function range(min: number, max: number): () => number {
    return () => Math.floor(Math.random() * (max - min + 1) + min);
}

export const fetchResource: Window["fetchResource"] = (id: string) => window.fetchResource(id);

export function calculateSimilarity(from: string, to: string): number {
    if (from === to) return 1;
    if (!from || !to) return 0;
    const distance = levenshtein(from, to);
    return 1 - distance / Math.max(from.length, to.length);
}

const WINDOWS_RESERVED_NAMES = new Set([
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
]);

export function sanitizeFilename(rawName: string, fallback: string = "resource.bin"): string {
    const baseName = rawName.split(/[\\/]/).pop() ?? "";
    const cleaned = baseName
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\.+$/, "")
        .slice(0, 255);

    const safeName = cleaned || fallback;
    const lowerSafeName = safeName.toLowerCase();
    return WINDOWS_RESERVED_NAMES.has(lowerSafeName) ? `_${safeName}` : safeName;
}

type ToArray<T> = T extends ArrayLike<infer E> ? E[] : T extends Iterable<infer E> ? E[] : never;

declare global {
    interface Window {
        base64: (buf: ArrayBufferLike | Uint8Array) => string;
        selectFirst: Document["querySelector"];
        selectAll: (
            ...args: Parameters<Document["querySelectorAll"]>
        ) => ToArray<ReturnType<Document["querySelectorAll"]>>;

        selectTags<K extends keyof HTMLElementTagNameMap>(qualifiedName: K): HTMLElementTagNameMap[K][];
        selectTags<K extends keyof SVGElementTagNameMap>(qualifiedName: K): SVGElementTagNameMap[K][];
        selectTags(qualifiedName: string): Element[];

        quickFetch: (url: string) => Promise<Response>;
        fetchResource: (id: string) => Promise<ExtractedResource & { url: string }>;
        removeElements: <E extends { remove(): void }>(elements: Iterable<E>) => void;
        filterContent: <E extends { textContent?: string | null }>(elements: Iterable<E>, pattern: RegExp) => E[];
    }

    interface Array<T> {
        removeAll<E extends { remove(): void }>(this: Array<E>): void;
        filterContent<E extends { textContent?: string | null }>(this: Array<E>, pattern: RegExp): Array<E>;
    }
}

export const injectDOMHelpers = () => {
    window.base64 = (buf) =>
        window.btoa(
            (buf instanceof Uint8Array ? buf : new Uint8Array(buf)).reduce((d, b) => d + String.fromCharCode(b), "")
        );

    window.selectFirst = document.querySelector.bind(document);
    window.selectAll = (selectors) => Array.from(document.querySelectorAll(selectors));
    window.selectTags = (name: string) => Array.from(document.getElementsByTagName(name));

    window.quickFetch = async function quickFetch(url: string) {
        const res = await window.fetch(url, {
            credentials: "same-origin",
            cache: "force-cache",
            referrer: window.location.href,
            referrerPolicy: "origin-when-cross-origin",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for "${url}"`);
        return res;
    };

    window.fetchResource = async function fetchResource(id: string) {
        const res = await window.quickFetch(id);
        const encodedBuf = window.base64(await res.arrayBuffer());
        return { encodedBuf, url: res.url };
    };

    window.removeElements = function removeElements(elements) {
        for (const element of elements) {
            element.remove();
        }
    };

    window.filterContent = function filterContent(elements, pattern) {
        return Array.from(elements).filter((element) => {
            const text = element.textContent;
            return typeof text === "string" && pattern.test(text);
        });
    };

    const arrayProto = Array.prototype as {
        removeAll?: () => void;
        filterContent?: (pattern: RegExp) => unknown[];
    };

    // Backward compatibility for legacy TASKS scripts that use chained array helpers.
    if (typeof arrayProto.removeAll !== "function") {
        Object.defineProperty(Array.prototype, "removeAll", {
            configurable: true,
            writable: true,
            value: function removeAll(this: Array<{ remove(): void }>) {
                window.removeElements(this);
            },
        });
    }

    if (typeof arrayProto.filterContent !== "function") {
        Object.defineProperty(Array.prototype, "filterContent", {
            configurable: true,
            writable: true,
            value: function filterContent<E extends { textContent?: string | null }>(
                this: Array<E>,
                pattern: RegExp
            ): E[] {
                return window.filterContent(this, pattern);
            },
        });
    }
};
