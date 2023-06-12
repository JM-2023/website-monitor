import levenshtein from "js-levenshtein";
import type { ExtractedResource } from "./index.js";

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
    }

    interface Array<T> {
        removeAll<E extends { remove(): void }>(this: Array<E>): void;
        filterContent<E extends { textContent?: string }>(this: Array<E>, pattern: RegExp): Array<E>;
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

    Array.prototype.removeAll = function removeAll() {
        return this.forEach((e) => e.remove());
    };

    Array.prototype.filterContent = function filterContent(pattern) {
        return this.filter((e) => e.textContent && pattern.test(e.textContent));
    };
};
