import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, createWriteStream } from 'fs';

// --- 配置常量 ---
const ANALYSING_DIR_NAME = "analysing";
const SEGMENT_PATTERN = /^(.+?)(?:-(\d+))?(\.[^.]+)\.bytes$/;

// --- 工具函数 ---
function versionSortKey(v: string): number[] {
    return v.split('.').map(p => parseInt(p, 10)).filter(n => !isNaN(n));
}

async function getLatestVersion(analysingDir: string): Promise<string> {
    const entries = await fs.readdir(analysingDir, { withFileTypes: true });
    const versions = entries
        .filter(dirent => dirent.isDirectory() && /^\d+\.\d+\.\d+\.\d+/.test(dirent.name))
        .map(dirent => dirent.name);

    if (!versions.length) throw new Error(`assets/ 下没有可用版本文件夹`);

    versions.sort((a, b) => {
        const keyA = versionSortKey(a);
        const keyB = versionSortKey(b);
        for (let i = 0; i < keyA.length || i < keyB.length; i++) {
            const numA = keyA[i] || 0;
            const numB = keyB[i] || 0;
            if (numA !== numB) return numB - numA;
        }
        return 0;
    });

    return versions[0];
}

// 递归获取目录下所有 .bytes 文件
async function getAllBytesFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let files: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(await getAllBytesFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".bytes")) {
            files.push(fullPath);
        }
    }
    return files;
}

async function mergeBytesFiles(files: string[], outputDir: string, deleteSource = false): Promise<void> {
    const baseMap = new Map<string, Array<{ index: number, filepath: string }>>();

    for (const filepath of files) {
        const filename = path.basename(filepath);
        const match = filename.match(SEGMENT_PATTERN);
        if (!match) continue;

        const baseName = match[1];
        const index = match[2] ? parseInt(match[2], 10) : 0;
        const ext = match[3];
        const mapKey = `${baseName}${ext}`;

        if (!baseMap.has(mapKey)) baseMap.set(mapKey, []);
        baseMap.get(mapKey)!.push({ index, filepath });
    }

    await fs.mkdir(outputDir, { recursive: true });

    for (const [mapKey, parts] of baseMap.entries()) {
        parts.sort((a, b) => a.index - b.index);
        const outputPath = path.join(outputDir, mapKey);
        if (parts.length > 1 || parts[0].index !== 0) {
            const writer = createWriteStream(outputPath);
            await new Promise<void>((resolve, reject) => {
                let i = 0;
                const pipeNext = () => {
                    if (i >= parts.length) {
                        writer.end();
                        return;
                    }
                    const reader = createReadStream(parts[i].filepath);
                    reader.on('error', reject);
                    reader.pipe(writer, { end: false });
                    reader.on('end', () => {
                        i++;
                        pipeNext();
                    });
                };
                writer.on('finish', resolve);
                writer.on('error', reject);
                pipeNext();
            });
            console.log(`[合并] ${mapKey} (${parts.length} 分段)`);
        } else {
            await fs.copyFile(parts[0].filepath, outputPath);
            console.log(`[复制] ${mapKey}`);
        }

        if (deleteSource) {
            for (const part of parts) {
                await fs.unlink(part.filepath);
            }
        }
    }
}

// --- 主函数 ---
async function main(deleteSource = false, version?: string): Promise<void> {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const PROJECT_ROOT = path.resolve(__dirname, '..');
    const FULL_ANALYSING_DIR = path.join(PROJECT_ROOT, ANALYSING_DIR_NAME);

    let latestVersion: string;
    try {
        latestVersion = await getLatestVersion(FULL_ANALYSING_DIR);
    } catch (e) {
        console.error((e as Error).message);
        return;
    }
    console.log(`检测到最新版本: ${latestVersion}`);

    const assetsDir = path.join(FULL_ANALYSING_DIR, version || latestVersion, "assets");
    try {
        await fs.access(assetsDir);
    } catch {
        console.error(`错误: assets 目录不存在: ${assetsDir}`);
        return;
    }
    const allBytesFiles = await getAllBytesFiles(assetsDir);
    if (!allBytesFiles.length) {
        console.error(`未找到任何 .bytes 文件`);
        return;
    }

    const outputDir = path.join(PROJECT_ROOT, 'merged_assets');
    await mergeBytesFiles(allBytesFiles, outputDir, deleteSource);

    console.log("\n处理完成。");
}

// 调用主函数，可传 true 删除源文件
main(false, "9.3.0.180").catch(err => {
    console.error("程序执行错误:", err instanceof Error ? err.message : err);
    process.exit(1);
});
