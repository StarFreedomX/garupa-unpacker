import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import pLimit from 'p-limit';
import { mainVersion, buildAssetBundleUrl, loadStore } from "@/garupa/assetBundleInfo.js";
import { changedFiles, downloadBundle, pipelineConcurrency, unpackBundle, createMemoryWriter, type UnpackTimings } from "./memoryAssets.js";
import { integerSetting } from "./network.js";
import type { AssetDiff } from "./compare.js";

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);


const URL_JSON_NAME = "AssetBundleInfoUrl.json";
const DIFF_DIR_NAME = "compare";
const ASSETS_DIR_NAME = "assets";

export interface VersionTimings extends UnpackTimings {
    version: string;
    downloadMs: number;
    downloadBytes: number;
    unpackQueueMs: number;
}
export interface BundleTimings {
    name: string;
    category: 'new' | 'change';
    queueMs: number;
    totalMs: number;
    compareMs: number;
    writeMs: number;
    writtenFiles: number;
    versions: VersionTimings[];
    error?: string;
}

/**
 * 获取资源路径URL前缀
 * @param url
 */
function extractPrefix(url: string): string {
    const parts = url.split("/AssetBundleInfo");
    return parts[0] + "/";
}

/** 比较版本，用于排序 */
function compareVersion(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < pa.length; i++) {
        if (pa[i] !== pb[i]) return pb[i] - pa[i];
    }
    return 0;
}

/** 解析 diff 文件并返回最新版本差异文件路径 */
async function getLatestDiffByVersion(diffDir: string): Promise<string> {
    const globPattern = path.join(diffDir, "diff_*_to_*.json").replace(/\\/g, "/");
    const diffFiles = await glob(globPattern);
    if (!diffFiles.length) throw new Error(`未找到差异文件 (${DIFF_DIR_NAME}/diff_x_to_x.json)`);

    const parsed = diffFiles.map(f => {
        const name = path.basename(f);
        const match = name.match(/diff_(\d+\.\d+\.\d+\.\d+)_to_(\d+\.\d+\.\d+\.\d+)\.json$/);
        return match ? { file: f, newVer: match[2] } : null;
    }).filter(Boolean) as { file: string, newVer: string }[];

    //排序
    parsed.sort((a, b) => compareVersion(a.newVer, b.newVer));

    if (!parsed.length) throw new Error("没有有效版本号的差异文件");
    return parsed[0].file;
}

export async function downloadDiffAssets(PROJECT_ROOT: string, diffFile?: string, diff?: AssetDiff): Promise<{ total: number; failed: number; output: string; timings: { totalMs: number; bundles: BundleTimings[] } }> {
    const pipelineStarted = performance.now();
    const bundles: BundleTimings[] = [];

    // AssetBundleInfo下载地址的json文件路径
    const FULL_URL_JSON_PATH = path.join(PROJECT_ROOT, URL_JSON_NAME);
    // diff文件的位置
    const FULL_DIFF_DIR = path.join(PROJECT_ROOT, DIFF_DIR_NAME);
    // 导出的assets路径
    const FULL_ASSETS_DIR = path.join(PROJECT_ROOT, ASSETS_DIR_NAME);

    const store = await loadStore(FULL_URL_JSON_PATH);

    // 优先使用本次传入的 diff，未传时回退到最新的 diff
    const resolvedDiffFile = diffFile ?? await getLatestDiffByVersion(FULL_DIFF_DIR);
    console.log(`使用差异文件：${path.basename(resolvedDiffFile)}`);

    // 正则匹配
    const match = resolvedDiffFile.match(/diff_(\d+\.\d+\.\d+\.\d+)_to_(\d+\.\d+\.\d+\.\d+)\.json$/);
    if (!match) throw new Error("diff 文件格式错误!");

    const oldVersion = match[1];
    const newVersion = match[2];

    console.log(`旧版本: ${oldVersion}`);
    console.log(`新版本: ${newVersion}`);

    const diffJson: AssetDiff = diff ?? JSON.parse(await fs.readFile(resolvedDiffFile, "utf8"));

    const hashNew = store.hashes[mainVersion(newVersion)];
    const hashOld = store.hashes[mainVersion(oldVersion)];
    if (!hashNew) throw new Error(`hashes 缺少主版本 ${mainVersion(newVersion)} 的 hash，请先运行 downloadAssetBundleInfo 粘贴一次该主版本 URL`);
    if (diffJson.change.length && !hashOld) throw new Error(`hashes 缺少主版本 ${mainVersion(oldVersion)} 的 hash，请先运行 downloadAssetBundleInfo 粘贴一次该主版本 URL`);

    const baseUrlNew = extractPrefix(buildAssetBundleUrl(newVersion, hashNew));
    const baseUrlOld = hashOld ? extractPrefix(buildAssetBundleUrl(oldVersion, hashOld)) : "";

    const output = path.join(FULL_ASSETS_DIR, newVersion);
    const total = diffJson.new.length + diffJson.change.length;
    const failures: Error[] = [];
    console.log(`开始内存流水线 NEW(${diffJson.new.length}) + CHANGE(${diffJson.change.length} 对) ...`);
    console.log(`并发设置：流水线 ${pipelineConcurrency()}，网络请求 ${integerSetting('DOWNLOAD_CONCURRENCY', 8, 64)}，单包分段 ${integerSetting('DOWNLOAD_THREADS', 4, 16)}，解包 ${integerSetting('UNPACK_CONCURRENCY', 4)}`);
    await fs.mkdir(output, { recursive: true });
    const writeFiles = createMemoryWriter(output);
    const limit = pLimit(pipelineConcurrency());
    const unpack = pLimit(integerSetting('UNPACK_CONCURRENCY', 4));
    const run = (name: string, category: 'new' | 'change') => limit(async () => {
        const started = performance.now();
        const timing: BundleTimings = {
            name, category, queueMs: started - pipelineStarted, totalMs: 0,
            compareMs: 0, writeMs: 0, writtenFiles: 0, versions: [],
        };
        bundles.push(timing);
        const load = async (baseUrl: string, version: string) => {
            const item: VersionTimings = { version, downloadMs: 0, downloadBytes: 0, unpackQueueMs: 0, exportMs: 0, finalizeMs: 0, fileCount: 0, outputBytes: 0 };
            timing.versions.push(item);
            const begin = performance.now();
            const bytes = await downloadBundle(baseUrl, name);
            item.downloadMs = performance.now() - begin;
            item.downloadBytes = bytes.length;
            console.log(`[下载] ${version}/${name}: ${(item.downloadMs / 1000).toFixed(2)}s，${(bytes.length / 1048576).toFixed(2)}MiB`);
            const queued = performance.now();
            const files = await unpack(() => {
                item.unpackQueueMs = performance.now() - queued;
                return unpackBundle(bytes, {}, item);
            });
            console.log(`[解包] ${version}/${name}: ${(item.exportMs / 1000).toFixed(2)}s，后处理 ${(item.finalizeMs / 1000).toFixed(2)}s，${files.size} 个文件`);
            return files;
        };
        try {
            // Keep a bounded number of pairs in flight, but download both versions concurrently.
            // Drain both sides even on failure before releasing the pair's pipeline slot.
            const results = await Promise.allSettled([
                category === 'change' ? load(baseUrlOld, oldVersion) : Promise.resolve(new Map<string, Buffer>()),
                load(baseUrlNew, newVersion),
            ]);
            const rejected = results.find(result => result.status === 'rejected');
            if (rejected?.status === 'rejected') throw rejected.reason;
            const [previous, current] = results.map(result => (result as PromiseFulfilledResult<Map<string, Buffer>>).value);
            const compareStarted = performance.now();
            const files = changedFiles(current, previous);
            timing.compareMs = performance.now() - compareStarted;
            const writeStarted = performance.now();
            await writeFiles(files);
            timing.writeMs = performance.now() - writeStarted;
            timing.writtenFiles = files.size;
            console.log(`[完成] ${category}/${name}: 写出 ${files.size}，未变化 ${current.size - files.size}`);
        } catch (error) {
            const failure = new Error(`${category}/${name}: ${error instanceof Error ? error.message : error}`);
            failures.push(failure);
            timing.error = failure.message;
            console.error(`[失败] ${failure.message}`);
        } finally {
            timing.totalMs = performance.now() - started;
        }
    });
    await Promise.all([
        ...diffJson.new.map(name => run(name, 'new')),
        ...diffJson.change.map(name => run(name, 'change')),
    ]);
    console.log(`处理完成（成功 ${total - failures.length}/${total} 个 bundle）；结果已保留：${output}`);
    return { total, failed: failures.length, output, timings: { totalMs: performance.now() - pipelineStarted, bundles } };
}



async function main() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const PROJECT_ROOT = path.resolve(__dirname, '..');

    const result = await downloadDiffAssets(PROJECT_ROOT);
    if (result.failed) process.exitCode = 1;
}
if (isMainProcess){
    main().catch(err => {
        console.error("程序错误:", err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
