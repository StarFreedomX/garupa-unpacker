import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MemoryFiles } from "../memoryAssets.js";

export interface UnpackedFileEntry {
    name: string;
    relative: string;
    /** true = 旧 bundle 中不存在；false = 同路径内容发生修改。 */
    new: boolean;
}

export interface UnpackedBundleIndex {
    bundle: string;
    status: "new" | "change";
    completedAt: string;
    files: UnpackedFileEntry[];
}

function bundleKey(bundle: string): string {
    return Buffer.from(bundle).toString("base64url");
}

export function bundleOutputDirectory(outputRoot: string, version: string, bundle: string): string {
    return path.join(outputRoot, version, "unpacked", ...bundle.split("/"));
}

export function bundleIndexFile(outputRoot: string, version: string, bundle: string): string {
    return path.join(outputRoot, version, ".indexes", `${bundleKey(bundle)}.json`);
}

export async function readBundleIndex(
    outputRoot: string,
    version: string,
    bundle: string,
): Promise<UnpackedBundleIndex | null> {
    try {
        return JSON.parse(await fs.readFile(bundleIndexFile(outputRoot, version, bundle), "utf-8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export async function indexFilesToMemory(index: UnpackedBundleIndex, additionsOnly: boolean): Promise<MemoryFiles> {
    const files: MemoryFiles = new Map();
    for (const entry of index.files) {
        if (additionsOnly && !entry.new) continue;
        files.set(entry.name, await fs.readFile(entry.relative));
    }
    return files;
}
