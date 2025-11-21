import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, createWriteStream } from 'fs'; // 用于流操作

// --- 配置常量 ---
const ANALYSING_DIR_NAME = "analysing";
const SEGMENT_PATTERN = /^(.+?)(?:-(\d+))?(\.[^.]+)\.bytes$/;

// --- 工具函数 ---

/**
 * 确保版本号格式统一为数字数组进行比较排序。
 */
function versionSortKey(v: string): number[] {
    return v.split('.').map(p => parseInt(p, 10)).filter(n => !isNaN(n));
}

/**
 * 查找 analysing 目录下最新版本号的目录名 (例如: '9.3.0.180')
 * @param analysingDir analysing 目录的绝对路径
 */
async function getLatestVersion(analysingDir: string): Promise<string> {
    try {
        // 读取 analysing 目录下的所有文件和文件夹
        const entries = await fs.readdir(analysingDir, { withFileTypes: true });

        // 过滤出符合版本号格式 (\d+.\d+.\d+.\d+) 的目录名
        const versions = entries
            .filter(dirent => dirent.isDirectory() && /^\d+\.\d+\.\d+\.\d+/.test(dirent.name))
            .map(dirent => dirent.name);

        if (versions.length === 0) {
            throw new Error(`错误: 在 ${analysingDir} 中没有找到版本目录。`);
        }

        // 按版本号排序（降序）
        versions.sort((a, b) => {
            const keyA = versionSortKey(a);
            const keyB = versionSortKey(b);

            for (let i = 0; i < keyA.length || i < keyB.length; i++) {
                const numA = keyA[i] || 0;
                const numB = keyB[i] || 0;
                if (numA !== numB) {
                    return numB - numA; // 降序排列
                }
            }
            return 0;
        });

        return versions[0];

    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`错误: analysing 目录不存在: ${analysingDir}`);
        }
        throw error;
    }
}

/**
 * 合并分段的 .bytes 文件或复制单个文件。
 * @param inputDir 包含 .bytes 文件的输入目录
 * @param outputDir 合并后的文件输出目录
 */
async function mergeBytesFiles(inputDir: string, outputDir: string): Promise<void> {
    await fs.mkdir(outputDir, { recursive: true });

    const files = (await fs.readdir(inputDir))
        .filter(f => f.endsWith(".bytes"));

    // 结构: Map<[baseName, ext], Array<{ index: number, filename: string }>>
    const baseMap = new Map<string, Array<{ index: number, filename: string }>>();

    for (const filename of files) {
        const match = filename.match(SEGMENT_PATTERN);
        if (!match) {
            continue;
        }

        const baseName = match[1];
        const indexStr = match[2];
        const ext = match[3]; // 例如 .json

        // 索引: 如果没有分段数字 (-d+)，则视为索引 0
        const index = indexStr ? parseInt(indexStr, 10) : 0;
        const mapKey = `${baseName}${ext}`;

        if (!baseMap.has(mapKey)) {
            baseMap.set(mapKey, []);
        }
        baseMap.get(mapKey)!.push({ index, filename });
    }

    for (const [mapKey, parts] of baseMap.entries()) {
        // 按索引排序: 从 0 开始
        parts.sort((a, b) => a.index - b.index);

        const outputFilename = mapKey; // baseName + ext
        const outputPath = path.join(outputDir, outputFilename);

        const isSegmented = parts.length > 1 || parts[0].index !== 0;

        if (isSegmented) {
            // 写入流（覆盖模式）
            const writer = createWriteStream(outputPath);

            await new Promise<void>((resolve, reject) => {
                let currentPartIndex = 0;

                function pipeNextPart() {
                    if (currentPartIndex >= parts.length) {
                        writer.close();
                        return;
                    }

                    const part = parts[currentPartIndex];
                    const srcPath = path.join(inputDir, part.filename);
                    const reader = createReadStream(srcPath);

                    reader.on('error', (err) => {
                        writer.end();
                        reject(err);
                    });

                    // 管道连接到写入流
                    reader.pipe(writer, { end: false }); // 关键: 禁用 end 选项，防止 reader.end() 触发 writer.end()

                    reader.on('end', () => {
                        currentPartIndex++;
                        pipeNextPart(); // 递归调用下一个分段
                    });
                }

                writer.on('finish', resolve);
                writer.on('error', reject);

                pipeNextPart(); // 开始合并
            });

            console.log(`[合并] ${outputFilename} (${parts.length} 分段)`);
        } else {
            // 单个文件，直接复制 (使用 fs.copyFile 更高效)
            const srcPath = path.join(inputDir, parts[0].filename);
            await fs.copyFile(srcPath, outputPath);
            console.log(`[复制] ${outputFilename}`);
        }
    }
}

// --- 主函数 ---

async function main() {
    // 1. 确定项目根目录 (Project Root)
    // 假设脚本位于 src/mergeAssets.ts，项目根目录在上一级
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

    const textAssetDir = path.join(FULL_ANALYSING_DIR, latestVersion, "TextAsset");
    const outputDir = path.join(textAssetDir, "trans");

    try {
        await fs.access(textAssetDir); // 检查目录是否存在
    } catch {
        console.error(`错误: TextAsset 目录不存在: ${textAssetDir}`);
        return;
    }

    console.log(`开始处理 ${textAssetDir} 中的 .bytes 文件...`);
    await mergeBytesFiles(textAssetDir, outputDir);

    console.log("\n处理完成。");
}

main().catch(err => {
    console.error("程序执行错误:", err instanceof Error ? err.message : err);
    process.exit(1);
});