import { Acb } from 'acb';
import { assetPath, decodeAcbBuffer, DEFAULT_HCA_KEY } from './memoryAssets.js';
import fs from 'node:fs/promises';
import path from 'path';
import { getDefaultPaths, getCategoryPaths } from '@/export.js';
import { fileURLToPath } from 'url';

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);
const DEFAULT_KEY = DEFAULT_HCA_KEY;

// 分段acb文件格式
const SEGMENTED_ACB_PATTERN = /-(\d{3,})\.acb$/i;

/** 递归查找非分段完整 .acb */
async function findValidAcbFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await findValidAcbFiles(fullPath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.acb')) {
            if (!SEGMENTED_ACB_PATTERN.test(entry.name)) files.push(fullPath);
        }
    }
    return files;
}

/** 解单个 ACB 并返回输出目录路径 */
export async function decodeSingleAcb(
    acbPath: string,
    deleteHca = true,
    deleteAcb = true,
    key = DEFAULT_KEY
): Promise<string> {
    const resolved = path.resolve(acbPath);
    const outDir = path.join(path.dirname(resolved), path.basename(resolved).replace(/\.acb$/i, ''));
    const buffer = await fs.readFile(resolved);
    const awbPath = resolved.replace(/\.acb$/i, '.awb');
    const awb = await fs.readFile(awbPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    });
    const files = await decodeAcbBuffer(buffer, awb, key);
    if (!deleteHca) {
        for (const entry of new Acb(buffer, awb).getFileList()) {
            files.set(assetPath(entry.name), entry.buffer);
        }
    }
    for (const [name, data] of files) {
        const destination = path.join(outDir, assetPath(name));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, data);
    }
    // Retain the input on any decoding or writing error.
    if (deleteAcb) await fs.unlink(resolved);
    console.log(`解码完成 → ${path.relative(process.cwd(), outDir)}`);
    return outDir;
}

/** 去重：删除 changeOutDir 中与 oldOutDir 内容完全相同的 wav */
async function dedupeWavPair(changeOutDir: string, oldOutDir: string): Promise<void> {
    if (!(await fs.stat(oldOutDir).catch(() => null))) return;

    const wavFiles = (await fs.readdir(changeOutDir)).filter(f => f.toLowerCase().endsWith('.wav'));
    let deleted = 0;

    for (const wav of wavFiles) {
        const changeWav = path.join(changeOutDir, wav);
        const oldWav = path.join(oldOutDir, wav);

        try {
            const [bufNew, bufOld] = await Promise.all([
                fs.readFile(changeWav),
                fs.readFile(oldWav)
            ]);
            if (bufNew.equals(bufOld)) {
                await fs.unlink(changeWav);
                deleted++;
            }
        } catch {
            // oldWav 不存在或读取失败 → 保留新的
        }
    }

    if (deleted > 0) {
        console.log(`去重删除 ${deleted} 个未变化的 wav ← ${path.basename(changeOutDir)}`);
    }
}

/** 主函数 */
export async function decodeAssets(version?: string): Promise<void> {
    const { output } = getDefaultPaths(version);
    const categories = getCategoryPaths(output);

    let newDir: string | null = null;
    let changeDir: string | null = null;
    let changeOldDir: string | null = null;

    if (version) {
        newDir = categories.includes('new') ? path.join(output, 'new') : null;
        changeDir = categories.includes('change') ? path.join(output, 'change') : null;
        changeOldDir = categories.includes('change_old') ? path.join(output, 'change_old') : null;
        console.log(`开始解析指定版本: ${version}\n`);
    } else {
        newDir = categories.includes('new') ? path.join(output, 'new') : null;
        changeDir = categories.includes('change') ? path.join(output, 'change') : null;
        changeOldDir = categories.includes('change_old') ? path.join(output, 'change_old') : null;
        console.log('开始解析最新版本...\n');
    }

    // 解 new 目录
    if (newDir && (await fs.stat(newDir).catch(() => null))) {
        const files = await findValidAcbFiles(newDir);
        console.log(`new 目录发现 ${files.length} 个完整 ACB`);
        for (const f of files) {
            await decodeSingleAcb(f);
        }
        console.log();
    }

    // 解 change 目录 -- 每解一个就同步解 change_old 同名文件并立即去重
    if (changeDir && (await fs.stat(changeDir).catch(() => null))) {
        const changeFiles = await findValidAcbFiles(changeDir);
        console.log(`change 目录发现 ${changeFiles.length} 个完整 ACB\n`);

        for (const changeAcb of changeFiles) {
            // 计算相对于 change 目录的相对路径
            const relativePath = path.relative(changeDir, changeAcb);
            // 在 change_old 中构造完全相同的路径
            const oldAcb = changeOldDir ? path.join(changeOldDir, relativePath) : null;

            // 解 change 的这个 acb
            const changeOutDir = await decodeSingleAcb(changeAcb);

            // 如果 change_old 中存在完全同路径的 acb → 也解它，然后立刻去重
            if (oldAcb && (await fs.stat(oldAcb).catch(() => null))) {
                //console.log(`解码变化前文件: ${path.relative(process.cwd(), oldAcb)}`);
                const oldOutDir = await decodeSingleAcb(oldAcb);
                await dedupeWavPair(changeOutDir, oldOutDir);
            } else {
                console.log(`旧版无此文件，跳过去重: ${relativePath}`);
            }

            console.log('─'.repeat(5));
        }
    }

    console.log('\ncomplete.');
}

export async function decodeLatestAssets(version?: string): Promise<void> {
    await decodeAssets(version);
}

if (isMainProcess) {
    (async () => {
        try {
            const ver = process.argv[2];
            if (ver && /^\d+\.\d+\.\d+\.\d+$/.test(ver)) {
                await decodeAssets(ver);
            } else {
                await decodeLatestAssets();
            }
        } catch (err) {
            console.error('解析失败:', err instanceof Error ? err.message : err);
            process.exit(1);
        }
    })();
}