import { Acb } from 'acb';
import HCA from 'hca-decoder';
import fs from 'node:fs/promises';
import path from 'path';
import { getDefaultPaths, getCategoryPaths } from '@/export.js';
import { fileURLToPath } from 'url';

const HCADecoder = HCA.HCADecoder;
const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);
const DEFAULT_KEY = 0x22CE;

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
async function decodeSingleAcb(
    acbPath: string,
    deleteHca = true,
    deleteAcb = true,
    key = DEFAULT_KEY
): Promise<string> {
    //处理后的acb路径
    const resolved = path.resolve(acbPath);
    const dir = path.dirname(resolved);
    const name = path.basename(resolved, '.acb');
    const outDir = path.join(dir, name);

    await fs.mkdir(outDir, { recursive: true });

    // 提取
    try {
        await new Acb(resolved).extract(outDir);
    } catch (err) {
        console.error(`提取失败 ${path.basename(acbPath)}:`, (err as Error).message);
        throw err;
    }
    if (deleteAcb) await fs.unlink(acbPath).catch((reason) => console.error(reason));

    // 解码 HCA
    const hcaFiles = (await fs.readdir(outDir))
        .filter(f => f.toLowerCase().endsWith('.hca'))
        .map(f => path.join(outDir, f));

    if (hcaFiles.length > 0) {
        const decoder = new HCADecoder(key, 0x0000);
        // Promise 异步执行
        await Promise.all(
            hcaFiles.map(hcaPath =>
                new Promise<void>((resolve, reject) => {
                    decoder.decodeToWaveFile(hcaPath, async (err: any) => {
                        if (err) {
                            console.error(`解码失败 ${path.basename(hcaPath)}: ${err.message || err}`);
                            reject(err);
                        } else {
                            if (deleteHca) await fs.unlink(hcaPath).catch((reason) => console.error(reason));
                            resolve();
                        }
                    });
                })
            )
        );
    }

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
    const { output } = getDefaultPaths();
    const categories = getCategoryPaths(output);

    let newDir: string | null = null;
    let changeDir: string | null = null;
    let changeOldDir: string | null = null;

    if (version) {
        const base = path.join(output, version);
        newDir = categories.includes('new') ? path.join(base, 'new') : null;
        changeDir = categories.includes('change') ? path.join(base, 'change') : null;
        changeOldDir = categories.includes('change_old') ? path.join(base, 'change_old') : null;
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

export async function decodeLatestAssets(): Promise<void> {
    await decodeAssets();
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