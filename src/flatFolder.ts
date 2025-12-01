import fs from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDefaultPaths } from "@/export.js";

const __filename = fileURLToPath(import.meta.url);
const isMainProcess = process.argv[1] === __filename;

/**
 * 递归地把「只有单个子文件夹」的层级全部“压平”，把子文件夹的名字累加到父文件夹上
 * @param rootDir 要处理的文件夹绝对路径
 */
export async function flatFolder(rootDir: string): Promise<void> {
    // 确保传入的是目录
    const stat = await fs.stat(rootDir);
    if (!stat.isDirectory()) {
        throw new Error(`"${rootDir}" 不是一个文件夹`);
    }

    while (true) {
        const entries = await fs.readdir(rootDir, { withFileTypes: true });

        // 统计文件和文件夹数量
        const files = entries.filter(e => e.isFile());
        const dirs  = entries.filter(e => e.isDirectory());

        // 只有文件 → 结束递归
        if (dirs.length === 0) {
            return;
        }

        // 只有一个子文件夹且没有文件 → 扁平化
        if (dirs.length === 1 && files.length === 0) {
            const childDir = dirs[0]!;
            const childPath = path.join(rootDir, childDir.name);

            // Step 0: 检查子文件夹下是否存在与自己同名的文件夹
            const childEntries = await fs.readdir(childPath, { withFileTypes: true });

            // Step 1: 把子文件夹内容搬到当前文件夹
            const tmpDir = path.join(rootDir, '_tmp_flat');

            // 1. 创建临时目录
            await fs.mkdir(tmpDir, { recursive: true });

            // 2. 先把子文件夹内容搬到临时目录
            for (const entry of childEntries) {
                const src = path.join(childPath, entry.name);
                const dest = path.join(tmpDir, entry.name);
                await fs.rename(src, dest);
            }

            await fs.rmdir(childPath);

            // 3. 再把临时目录内容搬回父目录
            const tmpEntries = await fs.readdir(tmpDir, { withFileTypes: true });
            for (const entry of tmpEntries) {
                const src = path.join(tmpDir, entry.name);
                const dest = path.join(rootDir, entry.name);
                await fs.rename(src, dest);
            }

            // 4. 删除临时目录
            await fs.rmdir(tmpDir);

            // Step 3: 安全重命名当前文件夹（保持原逻辑）
            const parentDir = path.dirname(rootDir);
            const oldName = path.basename(rootDir);
            const newFolderName = oldName + '.' + childDir.name;
            let newRootDir = path.join(parentDir, newFolderName);

            // 避免重名
            let counter = 1;
            while (await exists(newRootDir)) {
                newRootDir = path.join(parentDir, `${newFolderName}_${counter++}`);
            }

            // 先创建新目录 → 移动所有内容 → 删除旧目录
            await fs.mkdir(newRootDir, { recursive: true });

            const currentEntries = await fs.readdir(rootDir, { withFileTypes: true });
            for (const entry of currentEntries) {
                const src = path.join(rootDir, entry.name);
                const dest = path.join(newRootDir, entry.name);
                await fs.rename(src, dest);
            }

            // 删除旧目录
            await fs.rmdir(rootDir);

            console.log(`扁平化目录: ${rootDir} -> ${newRootDir}`);

            rootDir = newRootDir;
            continue;
        }

        // 有文件 + 有文件夹或多个文件夹 → 子目录递归
        for (const dir of dirs) {
            const subPath = path.join(rootDir, dir.name);
            await flatFolder(subPath);
        }

        return;
    }
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

// CLI
if (isMainProcess) {
    (async () => {
        let arg = process.argv.filter(a => !a.startsWith('--'))[2];
        if (!arg) {
            const { output } = getDefaultPaths();
            arg = output;
        }
        try {
            await flatFolder(arg);
        } catch (err) {
            console.error('简化失败:', err instanceof Error ? err.message : err);
            process.exit(1);
        }
    })();
}
