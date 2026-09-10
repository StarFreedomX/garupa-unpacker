#!/usr/bin/env npx tsx
/** 全量差异解包进程：读取探测服务写入的周期状态，逐 bundle 解开全部新增/变化内容。 */
import dotenv from "dotenv";
import axios from "axios";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";
import { compareAssetMaps, parseAssetBundleInfo } from "./compare.js";
import { buildAssetBundleUrl, findHashForDataVersion, loadStore } from "./garupa/assetBundleInfo.js";
import {
    changedFiles, downloadBundle, pipelineConcurrency, unpackBundleBestEffort, withStagedOutput, writeMemoryFiles,
    type MemoryFiles,
} from "./memoryAssets.js";
import { loadUnpackServerConfig } from "./unpackServer/config.js";
import { loadServerState, type CycleState } from "./unpackServer/state.js";
import {
    bundleIndexFile, bundleOutputDirectory, readBundleIndex, type UnpackedBundleIndex,
} from "./unpackServer/unpackedIndex.js";
import { predictedVersion } from "./unpackServer/version.js";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MANIFEST_DIR = path.join(PROJECT_ROOT, "AssetBundleInfo");
const STORE_FILE = path.join(PROJECT_ROOT, "AssetBundleInfoUrl.json");

function errorMessage(error: unknown): string {
    if (axios.isAxiosError(error) && error.response?.status) return `HTTP ${error.response.status}: ${error.message}`;
    return error instanceof Error ? error.message : String(error);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        const stop = () => done();
        function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", stop);
            resolve();
        }
        signal.addEventListener("abort", stop, { once: true });
    });
}

class FullUnpackWorker {
    private readonly config = loadUnpackServerConfig(PROJECT_ROOT, false);
    private readonly limit = pLimit(pipelineConcurrency(process.env.UNPACK_SERVER_CONCURRENCY));
    private inProgress = new Set<string>();

    private async baseUrl(version: string): Promise<string> {
        const store = await loadStore(STORE_FILE);
        const hash = this.config.cdnHash || findHashForDataVersion(store, version);
        if (!hash) throw new Error(`没有 ${version} 对应的 CDN hash`);
        return buildAssetBundleUrl(version, hash).replace(/AssetBundleInfo$/, "");
    }

    private async manifest(version: string): Promise<Buffer> {
        return fs.readFile(path.join(MANIFEST_DIR, `AssetBundleInfo_${version}.txt`));
    }

    private async unpackOne(cycle: CycleState, bundle: string, status: "new" | "change"): Promise<void> {
        const identity = `${cycle.targetVersion}|${bundle}`;
        if (this.inProgress.has(identity)
            || await readBundleIndex(this.config.outputRoot, cycle.targetVersion, bundle)) return;
        this.inProgress.add(identity);
        try {
            const targetBytes = await downloadBundle(await this.baseUrl(cycle.targetVersion), bundle);
            const currentResult = await unpackBundleBestEffort(targetBytes);
            const current = currentResult.files;
            let selected = current;
            let previous: MemoryFiles = new Map();
            if (status === "change") {
                const previousBytes = await downloadBundle(await this.baseUrl(cycle.baseVersion), bundle);
                previous = (await unpackBundleBestEffort(previousBytes)).files;
                selected = changedFiles(current, previous);
            }
            const output = bundleOutputDirectory(this.config.outputRoot, cycle.targetVersion, bundle);
            await withStagedOutput(output, stage => writeMemoryFiles(stage, selected));
            const index: UnpackedBundleIndex = {
                bundle,
                status,
                completedAt: new Date().toISOString(),
                files: [...selected.keys()].map(name => ({
                    name,
                    relative: path.join(output, ...name.split("/")),
                    new: !previous.has(name),
                })),
            };
            const indexFile = bundleIndexFile(this.config.outputRoot, cycle.targetVersion, bundle);
            await fs.mkdir(path.dirname(indexFile), { recursive: true });
            await fs.writeFile(indexFile, JSON.stringify(index, null, 2), "utf-8");
            console.log(`[全解完成] ${cycle.targetVersion} ${status}/${bundle}: 写出 ${selected.size} 个新增/修改文件`);
            if (currentResult.degraded) {
                console.warn(`[全解降级] ${cycle.targetVersion} ${bundle}: ${currentResult.errors.join(" | ")}`);
            }
        } catch (error) {
            console.warn(`[全解待重试] ${cycle.targetVersion} ${status}/${bundle}: ${errorMessage(error)}`);
        } finally {
            this.inProgress.delete(identity);
        }
    }

    async poll(): Promise<void> {
        const state = await loadServerState(this.config.stateFile);
        const store = await loadStore(STORE_FILE);
        const cycles = Object.values(state.cycles).filter(cycle => cycle.manifestReady && (
            cycle.confirmed || (state.application
                && cycle.baseVersion === state.application.dataVersion
                && cycle.targetVersion === predictedVersion(state.application.dataVersion, Object.keys(store.hashes)))
        ));
        for (const cycle of cycles) {
            try {
                const diff = compareAssetMaps(
                    parseAssetBundleInfo(await this.manifest(cycle.targetVersion)),
                    parseAssetBundleInfo(await this.manifest(cycle.baseVersion)),
                );
                const jobs = [
                    ...diff.new.map(bundle => ({ bundle, status: "new" as const })),
                    ...diff.change.map(bundle => ({ bundle, status: "change" as const })),
                ];
                await Promise.all(jobs.map(job => this.limit(() => this.unpackOne(cycle, job.bundle, job.status))));
            } catch (error) {
                console.warn(`[全解周期待重试] ${cycle.targetVersion}: ${errorMessage(error)}`);
            }
        }
    }

    async run(signal: AbortSignal): Promise<void> {
        console.log(`[unpack-worker] 全量差异解包已启动，输出 ${this.config.outputRoot}`);
        while (!signal.aborted) {
            const started = Date.now();
            await this.poll();
            await wait(Math.max(0, this.config.cdnPollMs - (Date.now() - started)), signal);
        }
    }
}

export async function main(): Promise<void> {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await new FullUnpackWorker().run(controller.signal);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[unpack-worker] ${errorMessage(error)}`);
        process.exitCode = 1;
    });
}
