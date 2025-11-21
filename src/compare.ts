import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { stdout as output, stdin as input } from 'process'; // 导入标准输入/输出

// --- 配置常量 ---
const ASSET_DIR = "AssetBundleInfo";
const OUT_DIR = "compare";

// --- 类型定义 ---
type AssetMap = Map<string, string>; // { path: hash }
type VersionTuple = {
    baseVer: string;
    extraNum: number;
};
type VersionFile = {
    version: VersionTuple;
    fileName: string;
    versionKey: number[]; // 预计算的排序键
    formattedVersion: string; // 预计算的格式化版本字符串
};

// --- 工具函数 (保持不变) ---
// ... (extractVersionFromFilename, extractPathAndHash, readFileToAssetMap, versionKey, formatVersion 保持不变)

/**
 * 从文件名中提取版本号和递增号。
 * 例如：AssetBundleInfo_9.3.0.170.txt → { baseVer: '9.3.0.170', extraNum: 1 }
 * 例如：AssetBundleInfo_9.3.0.170.2.txt → { baseVer: '9.3.0.170', extraNum: 2 }
 */
function extractVersionFromFilename(name: string): VersionTuple | null {
    // 正则表达式：AssetBundleInfo_(\d+\.\d+\.\d+\.\d+)(?:\.(\d+))?
    const match = name.match(/AssetBundleInfo_(\d+\.\d+\.\d+\.\d+)(?:\.(\d+))?\.txt$/);
    if (match) {
        const baseVer = match[1];
        const extraNum = match[2] ? parseInt(match[2], 10) : 1;
        return { baseVer, extraNum };
    }
    return null;
}

/**
 * 从 AssetBundleInfo 的行中提取路径和哈希。
 * 格式示例：... [路径] @[64位哈希] ...
 */
function extractPathAndHash(line: string): { path: string, hashValue: string } | null {
    // 1. 查找 64 位哈希
    const hashMatch = line.match(/@([a-fA-F0-9]{64})/);
    if (!hashMatch) {
        return null;
    }

    const hashValue = hashMatch[1];
    const hashPos = hashMatch.index!;

    // 2. 只在 hash 前面找路径
    const validPart = line.substring(0, hashPos);

    // 3. 路径格式：字母开头，中间字母数字/_-.,，以字母或数字结尾
    // [A-Za-z][A-Za-z0-9_\-./]*[A-Za-z0-9]
    // 使用 g 标志和 matchAll 来获取所有匹配，并取最后一个（最接近哈希）
    const pathMatches = [...validPart.matchAll(/[A-Za-z][A-Za-z0-9_\-./]*[A-Za-z0-9]/g)];

    if (pathMatches.length === 0) {
        return null;
    }

    const pathValue = pathMatches[pathMatches.length - 1][0];

    return { path: pathValue, hashValue };
}

/**
 * 解析文件内容 → {path:hash} Map
 */
async function readFileToAssetMap(filePath: string): Promise<AssetMap> {
    const data: AssetMap = new Map();
    let fileHandle: fs.FileHandle | undefined;

    try {
        fileHandle = await fs.open(filePath, 'r');

        // 使用 readline 模块高效地逐行读取文件
        const rl = readline.createInterface({
            input: fileHandle.createReadStream({ encoding: 'utf-8' }),
            crlfDelay: Infinity // 允许处理 Windows/Unix 换行
        });

        for await (const line of rl) {
            const result = extractPathAndHash(line);
            if (result) {
                data.set(result.path, result.hashValue);
            }
        }
    } catch (e) {
        console.error(`读取文件失败: ${filePath}`, e);
        throw e;
    } finally {
        if (fileHandle) {
            await fileHandle.close();
        }
    }
    return data;
}

/**
 * 版本排序键：将版本号（例如 '9.3.0.170'）和递增号（例如 2）转换为可比较的数字数组
 */
function versionKey(v: VersionTuple): number[] {
    const parts = v.baseVer.split(".").map(p => parseInt(p, 10));
    return [...parts, v.extraNum];
}

/**
 * 格式化版本号，用于输出
 */
function formatVersion(v: VersionTuple): string {
    return v.extraNum > 1 ? `${v.baseVer}.${v.extraNum}` : v.baseVer;
}

// --- 主逻辑 ---

async function main() {
    let filesInDir: string[];
    try {
        filesInDir = await fs.readdir(ASSET_DIR);
    } catch (e) {
        console.error(`错误：无法访问目录 ${ASSET_DIR}。请确保目录存在并包含 AssetBundleInfo_*.txt 文件。`);
        return;
    }

    // 存储所有解析出的版本文件信息
    const versionFiles: VersionFile[] = [];

    for (const fileName of filesInDir) {
        if (fileName.endsWith('.txt')) {
            const version = extractVersionFromFilename(fileName);
            if (version) {
                versionFiles.push({
                    version,
                    fileName,
                    versionKey: versionKey(version), // 预计算键
                    formattedVersion: formatVersion(version) // 预计算格式化字符串
                });
            }
        }
    }

    if (versionFiles.length < 2) {
        console.error(`错误：目录 ${ASSET_DIR} 内必须至少有两个版本文件 (${versionFiles.length} 找到)。`);
        return;
    }

    // 排序：基于版本号和递增号 (升序)
    versionFiles.sort((a, b) => {
        const keyA = a.versionKey;
        const keyB = b.versionKey;
        for (let i = 0; i < keyA.length; i++) {
            if (keyA[i] !== keyB[i]) {
                return keyA[i] - keyB[i]; // 升序
            }
        }
        return 0;
    });

    // -----------------------------------------------------
    // 1. 用户输入处理和文件选择
    // -----------------------------------------------------

    // 导入 readline 模块用于获取用户输入
    const readline = await import('readline/promises');
    const process = await import('process');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    // 构造可用版本列表供用户参考
    const availableVersions = versionFiles.map(v => v.formattedVersion);
    console.log("可用版本:", availableVersions.join(' | '));

    let targetVersionInput = await rl.question(`请输入要比较的最新版本 (留空默认比较最新两个版本):\n> `);
    rl.close();
    targetVersionInput = targetVersionInput.trim();

    let newestFile: VersionFile;
    let olderFile: VersionFile;

    if (!targetVersionInput) {
        // A. 默认模式：比较最新的两个
        newestFile = versionFiles[versionFiles.length - 1];
        olderFile = versionFiles[versionFiles.length - 2];
    } else {
        // B. 指定版本模式：比较指定版本和紧邻前一个版本

        // 查找目标版本文件
        const newestIndex = versionFiles.findIndex(v => v.formattedVersion === targetVersionInput);

        if (newestIndex === -1) {
            console.error(`错误：未找到指定的版本文件 ${targetVersionInput}。`);
            return;
        }

        if (newestIndex === 0) {
            console.error(`错误：指定的版本 ${targetVersionInput} 是最老的版本，无法找到其上一个版本进行比较。`);
            return;
        }

        newestFile = versionFiles[newestIndex];
        olderFile = versionFiles[newestIndex - 1]; // 紧邻前一个版本
    }

    // -----------------------------------------------------
    // 2. 比较逻辑
    // -----------------------------------------------------

    const verOld = olderFile.formattedVersion;
    const verNew = newestFile.formattedVersion;

    console.log(`\n开始比较版本: ${verOld} → ${verNew}`);

    // 读取内容
    const oldData = await readFileToAssetMap(path.join(ASSET_DIR, olderFile.fileName));
    const newData = await readFileToAssetMap(path.join(ASSET_DIR, newestFile.fileName));

    const oldPaths = new Set(oldData.keys());
    const newPaths = new Set(newData.keys());

    // 1. 新增路径 (在 New 中有，在 Old 中没有)
    const added: string[] = [];
    for (const p of newPaths) {
        if (!oldPaths.has(p)) {
            added.push(p);
        }
    }
    added.sort();

    // 2. 哈希变化路径 (都在，但哈希不同)
    const modified: string[] = [];
    for (const p of newPaths) {
        if (oldPaths.has(p)) {
            if (newData.get(p) !== oldData.get(p)) {
                modified.push(p);
            }
        }
    }
    modified.sort();

    console.log(`\n统计结果:`);
    console.log(`新增文件数量: ${added.length}`);
    console.log(`修改文件数量: ${modified.length}`);


    // -----------------------------------------------------
    // 3. 写入输出文件
    // -----------------------------------------------------
    // 创建输出目录
    await fs.mkdir(OUT_DIR, { recursive: true });

    const outfile = path.join(OUT_DIR, `assetsList_from_${verOld}_to_${verNew}.txt`);

    // 构建内容：先是新增，然后是修改
    const content = [
        `# 新增文件 (${added.length} 个)`,
        ...added,
        "",
        `# 修改文件 (${modified.length} 个)`,
        ...modified
    ].join('\n');

    await fs.writeFile(outfile, content + '\n', 'utf-8');

    console.log(`\n✅ 已将比较结果写入文件: ${outfile}`);
}

main().catch(err => {
    // 确保关闭 readline 接口，防止程序挂起
    // 由于 rl 局部于 main，这里无法直接关闭，但程序退出时会清理。
    console.error("程序执行错误:", err);
    process.exit(1);
});