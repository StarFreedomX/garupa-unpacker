import * as fs from 'node:fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, createWriteStream } from 'node:fs';
import { getCategoryPaths, getDefaultPaths } from "@/export.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);

// 正则：匹配 chorus342-001.acb、live123-456.acb
const ACB_SEGMENT_PATTERN = /^(.+?)-(\d{3,})\.acb$/i;

/**
 * 递归获取目录下所有 .acb 文件
 * @param dir 输入目录
 * @return 返回acb文件的绝对路径
 */
async function getAllAcbFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await getAllAcbFiles(fullPath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.acb')) {
            files.push(fullPath);
        }
    }
    return files;
}

/**
 * 按文件名中的数字排序（001 < 002 < 010）
 */
function numericSort(a: string, b: string): number {
    return parseInt(a, 10) - parseInt(b, 10);
}

/**
 * 合并同一组分段 ACB 文件
 */
async function mergeSegmentedAcb(
    segments: Array<{ index: string; filepath: string }>,
    outputPath: string
): Promise<void> {
    // 按数字顺序排序
    segments.sort((a, b) => numericSort(a.index, b.index));

    const writer = createWriteStream(outputPath);

    await new Promise<void>((resolve, reject) => {
        let i = 0;

        function pipeNext() {
            if (i >= segments.length) {
                writer.end();
                return;
            }

            const reader = createReadStream(segments[i].filepath);
            reader.on('error', reject);
            reader.pipe(writer, { end: false });
            reader.on('end', () => {
                console.log(`  ${i===segments.length-1?'└─':'├─'} 合并分片: ${path.basename(segments[i].filepath)}`);
                i++;
                pipeNext();
            });
        }

        writer.on('finish', resolve);
        writer.on('error', reject);
        pipeNext();
    });

    console.log(`Success: 合并完成 → ${path.basename(outputPath)} (${segments.length} 片)`);
}

/**
 * 查找目录下所有acb
 * @param rootDir
 * @param deleteSource
 * @param outputToSameDir
 */
async function mergeAllSegmentedAcbFiles(
    rootDir: string,
    deleteSource = false,
    outputToSameDir = true // 是否在原目录生成合并后的完整 acb
): Promise<void> {
    console.log('Start: 开始递归查找并合并分段 ACB 文件...\n');

    const allAcbFiles = await getAllAcbFiles(rootDir);
    if (allAcbFiles.length === 0) {
        console.log('Warning: 未找到任何 .acb 文件');
        return;
    }

    // 按所在目录分组
    const groups = new Map<string, string[]>();

    for (const file of allAcbFiles) {
        const dir = path.dirname(file);
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir)!.push(file);
    }

    let mergedCount = 0;

    for (const [dir, files] of groups) {
        // 构建映射：baseName → 分段列表
        const segmentMap = new Map<string, Array<{ index: string; filepath: string }>>();

        for (const file of files) {
            const filename = path.basename(file);
            const match = filename.match(ACB_SEGMENT_PATTERN);

            if (match) {
                const baseName = match[1]; // chorus342
                const index = match[2];    // 001
                const key = baseName;      // 同一组用 baseName 聚合

                if (!segmentMap.has(key)) segmentMap.set(key, []);
                segmentMap.get(key)!.push({ index, filepath: file });
            }
        }

        // 处理每一组需要合并的文件
        for (const [baseName, parts] of segmentMap) {
            if (parts.length <= 1) continue; // 只有一个分片，不需要合并

            const finalAcbName = `${baseName}.acb`;
            const outputPath = outputToSameDir
                ? path.join(dir, finalAcbName)
                : path.join(rootDir, 'merged_acb', finalAcbName);

            // 创建输出目录（如果不是原目录）
            if (!outputToSameDir) {
                await fs.mkdir(path.dirname(outputPath), { recursive: true });
            }

            console.log(`\nFound: 发现分段文件组: ${baseName}.acb（共 ${parts.length} 片）`);
            await mergeSegmentedAcb(parts, outputPath);
            mergedCount++;

            // 可选：删除源分片文件
            if (deleteSource) {
                await Promise.all(
                    parts.map(p => fs.unlink(p.filepath).catch(() => {}))
                );
                console.log(`Deleted: 已删除 ${parts.length} 个源分片文件`);
            }
        }
    }

    console.log(`\nFinish: 合并完成！共处理 ${mergedCount} 组分段 ACB 文件`);
}




if (isMainProcess) {
    (async () => {
        try {
            const { output } = getDefaultPaths();
            await mergeAllSegmentedAcbFiles(output,false,true)
        } catch (err) {
            console.error('Error: 合并过程出错：', err instanceof Error ? err.message : err);
            process.exit(1);
        }
    })();
}

export { mergeAllSegmentedAcbFiles };