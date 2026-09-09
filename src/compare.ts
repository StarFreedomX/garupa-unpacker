import * as fs from 'node:fs/promises';
import * as path from 'path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from "url";
const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);

const ASSET_DIR = "AssetBundleInfo";
const OUT_DIR = "compare";

export interface AssetDiff { new: string[]; change: string[] }

type AssetMap = Map<string, string>;


export function extractPathAndHash(line: string) {
    const hashMatch = line.match(/@([a-fA-F0-9]{64})/);
    if (!hashMatch) return null;
    const hashValue = hashMatch[1];
    const hashPos = hashMatch.index!;
    const validPart = line.substring(0, hashPos);
    const matches = [...validPart.matchAll(/[A-Za-z][A-Za-z0-9_\-./]*[A-Za-z0-9]/g)];
    if (!matches.length) return null;

    return { path: matches[matches.length - 1][0], hashValue };
}

/** 直接解析内存中的 AssetBundleInfo；常驻服务用它探测 CDN，不需要先落盘。 */
export function parseAssetBundleInfo(input: Buffer | string): AssetMap {
    const data: AssetMap = new Map();
    const text = typeof input === "string" ? input : input.toString("utf-8");
    for (const line of text.split(/\r?\n/)) {
        const parsed = extractPathAndHash(line);
        if (parsed) data.set(parsed.path, parsed.hashValue);
    }
    return data;
}

/** 比较两个已解析的清单，方向为 previous → current。 */
export function compareAssetMaps(current: AssetMap, previous: AssetMap): AssetDiff {
    return {
        new: [...current.keys()].filter(p => !previous.has(p)).sort(),
        change: [...current.keys()].filter(p => previous.has(p) && current.get(p) !== previous.get(p)).sort(),
    };
}

async function readFileToAssetMap(filePath: string): Promise<AssetMap> {
    const data: AssetMap = new Map();
    let fileHandle: fs.FileHandle | undefined;

    try {
        fileHandle = await fs.open(filePath, 'r');
        const rl = readline.createInterface({
            input: fileHandle.createReadStream({ encoding: 'utf-8' }),
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            const parsed = extractPathAndHash(line);
            if (parsed) data.set(parsed.path, parsed.hashValue);
        }
    } finally {
        if (fileHandle) await fileHandle.close();
    }
    return data;
}

/** 点分版本号数字比较（升序：负数表示 a < b） */
function compareVersionNumbers(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na - nb;
    }
    return 0;
}

/** 列出 AssetBundleInfo/ 目录下已下载的版本号（升序排序） */
export async function listDownloadedVersions(): Promise<string[]> {
    const files = await fs.readdir(ASSET_DIR);
    const versions = files
        .map(f => f.match(/^AssetBundleInfo_(\d+\.\d+\.\d+\.\d+)\.txt$/)?.[1])
        .filter((v): v is string => !!v);
    versions.sort(compareVersionNumbers);
    return versions;
}

/**
 * 对比两个已下载版本的 AssetBundleInfo（old → new 方向）。
 * @param verNew 新版本（4 段 dataVersion，如 10.1.0.230）
 * @param verOld 旧版本（4 段 dataVersion）
 * 两版本文件必须已下载（缺失抛错）。返回 { outFile, summary: {added, changed}, versions: { verOld, verNew } }。
 */
export async function compareVersions(verNew: string, verOld: string) {
    const newFile = path.join(ASSET_DIR, `AssetBundleInfo_${verNew}.txt`);
    const oldFile = path.join(ASSET_DIR, `AssetBundleInfo_${verOld}.txt`);
    for (const [ver, file] of [[verNew, newFile], [verOld, oldFile]] as const) {
        try {
            await fs.access(file);
        } catch {
            throw new Error(`未找到版本 ${ver} 的 AssetBundleInfo 文件，请先下载`);
        }
    }

    const oldMap = await readFileToAssetMap(oldFile);
    const newMap = await readFileToAssetMap(newFile);

    const compared = compareAssetMaps(newMap, oldMap);
    const added = compared.new;
    const changed = compared.change;

    await fs.mkdir(OUT_DIR, { recursive: true });
    const outFile = path.join(OUT_DIR, `diff_${verOld}_to_${verNew}.json`);

    const result = { new: added, change: changed };
    await fs.writeFile(outFile, JSON.stringify(result, null, 2), "utf-8");

    return { outFile, diff: result, summary: { added: added.length, changed: changed.length }, versions: { verOld, verNew } };
}


async function main() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const versions = await listDownloadedVersions();
    const inputNew = (await rl.question("请输入新版本（留空用本地已下载的最新）：\n> ")).trim();
    const inputOld = (await rl.question("请输入旧版本（留空用本地已下载的最新之前一个）：\n> ")).trim();
    rl.close();

    try {
        // 默认：新版本取最新（at(-1)），旧版本取相邻前一个（at(-2)）；有输入则用输入值
        const verNew = inputNew || (versions.at(-1) ?? "");
        const verOld = inputOld || (versions.at(-2) ?? "");
        if (!verNew) throw new Error("AssetBundleInfo/ 目录下没有已下载的版本，请输入新版本");
        if (!verOld) throw new Error("AssetBundleInfo/ 目录下至少需要两个已下载版本，请输入旧版本");

        const { outFile, summary, versions: v } = await compareVersions(verNew, verOld);

        console.log(`\n✔ 对比完成: ${v.verOld} → ${v.verNew}`);
        console.log(`新增: ${summary.added}, 修改: ${summary.changed}`);
        console.log(`结果已保存到: ${outFile}`);
    } catch (err) {
        console.error("出错:", err instanceof Error ? err.message : err);
    }
}
if (isMainProcess)
    main();
