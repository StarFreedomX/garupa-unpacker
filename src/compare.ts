import * as fs from 'node:fs/promises';
import * as path from 'path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from "url";
const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);

const ASSET_DIR = "AssetBundleInfo";
const OUT_DIR = "compare";

type AssetMap = Map<string, string>;
type VersionTuple = { baseVer: string; extraNum: number };
type VersionFile = {
    version: VersionTuple;
    fileName: string;
    versionKey: number[];
    formattedVersion: string;
};


function extractVersionFromFilename(name: string): VersionTuple | null {
    const match = name.match(/^AssetBundleInfo_(\d+\.\d+\.\d+\.\d+)\.txt$/);
    return match ? { baseVer: match[1], extraNum: 1 } : null;
}


function extractPathAndHash(line: string) {
    const hashMatch = line.match(/@([a-fA-F0-9]{64})/);
    if (!hashMatch) return null;
    const hashValue = hashMatch[1];
    const hashPos = hashMatch.index!;
    const validPart = line.substring(0, hashPos);
    const matches = [...validPart.matchAll(/[A-Za-z][A-Za-z0-9_\-./]*[A-Za-z0-9]/g)];
    if (!matches.length) return null;

    return { path: matches[matches.length - 1][0], hashValue };
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

function versionKey(v: VersionTuple): number[] {
    return v.baseVer.split(".").map(n => Number(n));
}


function formatVersion(v: VersionTuple): string {
    return v.extraNum > 1 ? `${v.baseVer}.${v.extraNum}` : v.baseVer;
}

export async function compareVersions(targetVersion?: string) {

    const filesInDir = await fs.readdir(ASSET_DIR);

    const versionFiles: VersionFile[] = filesInDir
        .filter(f => f.endsWith(".txt"))
        .map(fileName => {
            const version = extractVersionFromFilename(fileName);
            return version ? {
                version,
                fileName,
                versionKey: versionKey(version),
                formattedVersion: formatVersion(version)
            } : null;
        })
        .filter(Boolean) as VersionFile[];

    if (versionFiles.length < 2) throw new Error("需要至少两个版本文件才能比较！");

    versionFiles.sort((a, b) => {
        for (let i = 0; i < a.versionKey.length; i++)
            if (a.versionKey[i] !== b.versionKey[i]) return a.versionKey[i] - b.versionKey[i];
        return 0;
    });

    let newestFile: VersionFile;
    let olderFile: VersionFile;

    if (!targetVersion) {
        newestFile = versionFiles.at(-1)!;
        olderFile = versionFiles.at(-2)!;
    } else {
        const idx = versionFiles.findIndex(v => v.formattedVersion === targetVersion);
        if (idx === -1) throw new Error(`未找到版本 ${targetVersion}`);
        if (idx === 0) throw new Error(`版本 ${targetVersion} 没有更旧版本可比较`);
        newestFile = versionFiles[idx];
        olderFile = versionFiles[idx - 1];
    }

    const verOld = olderFile.formattedVersion;
    const verNew = newestFile.formattedVersion;

    const oldMap = await readFileToAssetMap(path.join(ASSET_DIR, olderFile.fileName));
    const newMap = await readFileToAssetMap(path.join(ASSET_DIR, newestFile.fileName));

    const added = [...newMap.keys()].filter(p => !oldMap.has(p)).sort();
    const changed = [...newMap.keys()].filter(p => oldMap.has(p) && newMap.get(p) !== oldMap.get(p)).sort();

    await fs.mkdir(OUT_DIR, { recursive: true });
    const outFile = path.join(OUT_DIR, `diff_${verOld}_to_${verNew}.json`);

    const result = { new: added, change: changed };
    await fs.writeFile(outFile, JSON.stringify(result, null, 2), "utf-8");

    return { outFile, summary: { added: added.length, changed: changed.length }, versions: { verOld, verNew } };
}


async function main() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const target = (await rl.question("输入版本号 (留空默认最新): ")).trim();
    rl.close();

    try {
        const { outFile, summary, versions } = await compareVersions(target || undefined);

        console.log(`\n✔ 对比完成: ${versions.verOld} → ${versions.verNew}`);
        console.log(`新增: ${summary.added}, 修改: ${summary.changed}`);
        console.log(`结果已保存到: ${outFile}`);
    } catch (err) {
        console.error("出错:", err instanceof Error ? err.message : err);
    }
}
if (isMainProcess)
    main();
