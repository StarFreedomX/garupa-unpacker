import path from "path";
import pLimit from "p-limit";
import fsp from "fs/promises";
import { createHash } from "crypto";
import { getDefaultPaths, getCategoryPaths } from "@/export.js";
import { fileURLToPath } from "url";
const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);

const limit = pLimit(5);

function wait(ms: number) {
    return new Promise(res => setTimeout(res, ms));
}

// 读取文件内容（带自动重试）
async function safeRead(filePath: string, retry = 5): Promise<Buffer> {
    while (retry > 0) {
        try {
            return await fsp.readFile(filePath);
        } catch (err: any) {
            if (err.code === "EBUSY" || err.code === "EPERM") {
                await wait(100);
                retry--;
                continue;
            }
            throw err;
        }
    }
    throw new Error(`文件一直被占用，无法读取: ${filePath}`);
}

async function hashFile(filePath: string): Promise<string> {
    const buffer = await safeRead(filePath);
    return createHash("md5").update(buffer).digest("hex");
}

// 安全删除文件（带重试）
async function safeDelete(filePath: string, retry = 5) {
    while (retry > 0) {
        try {
            await fsp.unlink(filePath);
            return;
        } catch (err: any) {
            if (err.code === "EBUSY" || err.code === "EPERM") {
                await wait(100);
                retry--;
                continue;
            }
            throw err;
        }
    }
    console.warn(`无法删除（可能仍被占用）: ${filePath}`);
}

async function walkDir(dir: string): Promise<string[]> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await walkDir(fullPath)));
        } else {
            files.push(fullPath);
        }
    }

    return files;
}

export async function removeEmptyDirs(dir: string): Promise<boolean> {
    try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });

        if (entries.length === 0) {
            await fsp.rmdir(dir).catch(() => {});
            return true;
        }

        let allEmpty = true;
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const subEmpty = await removeEmptyDirs(full);
                if (!subEmpty) allEmpty = false;
            } else {
                allEmpty = false;
            }
        }

        if (allEmpty) {
            await fsp.rmdir(dir).catch(() => {});
            return true;
        }

        return false;
    } catch (err: any) {
        if (err && err.code === "ENOENT") return true;
        throw err;
    }
}

/**
 * 对比 change_old 和 change 目录
 * - 删除 change 中内容完全相同的文件（带重试）
 * - 清理空文件夹
 * - 返回：内容真正发生变化的文件绝对路径列表（new 目录中的路径）
 */
export async function removeUnchangedFiles(
    change_old: string,
    change: string,
    removeOld=true
): Promise<string[]> {
    const oldFiles = await walkDir(change_old);
    const newFiles = await walkDir(change);

    console.log(`比对文件夹:`);
    console.log(`  old: ${change_old}`);
    console.log(`  new: ${change}`);

    // 构建 old 的相对路径 → 绝对路径映射
    const relativeMap = new Map<string, string>();
    for (const oldPath of oldFiles) {
        const rel = path.relative(change_old, oldPath);
        relativeMap.set(rel, oldPath);
    }

    // 用来收集真正被修改的文件（new 目录中的路径）
    const changedFiles: string[] = [];

    const tasks = newFiles.map(newPath =>
        limit(async () => {
            const rel = path.relative(change, newPath);
            const oldPath = relativeMap.get(rel);

            // 旧目录没有这个文件 → 新增文件，也算“修改”
            if (!oldPath) return;


            // 旧目录有，但内容可能相同
            const [oldHash, newHash] = await Promise.all([
                hashFile(oldPath),
                hashFile(newPath)
            ]);

            if (oldHash === newHash) {
                console.log(`删除未变化 → ${rel}`);
                await safeDelete(newPath);
            } else {
                console.log(`内容已变 → ${rel}`);
                changedFiles.push(newPath);
            }
        })
    );

    await Promise.all(tasks);

    // 清理空文件夹
    console.log("清理空文件夹...");
    await removeEmptyDirs(change);
    console.log(`✔ 空文件夹清理完成`);

    console.log(`✔ 完成：共保留/新增 ${changedFiles.length} 个修改文件`);
    return changedFiles;  // 返回修改的文件列表
}



// 运行入口
if (isMainProcess) {
    // console.log("test");
    (async () => {
        const {input, output} = getDefaultPaths();
        const categoryFolders = getCategoryPaths(input);

        // 处理 change 与 change_old
        if (categoryFolders.includes("change") && categoryFolders.includes("change_old")) {
            const editedLists = await removeUnchangedFiles(
                path.join(output, "change_old"),
                path.join(output, "change")
            );
            // console.log(editedLists)
        } else {
            console.log("未找到 change/change_old 文件夹，跳过比较。");
        }
    })();
}
