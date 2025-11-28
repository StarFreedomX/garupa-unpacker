import path from "path";
import pLimit from "p-limit";
import fsp from "fs/promises";
import { createHash } from "crypto";
import { getDefaultPaths, getCategoryPaths } from "@/export.js";
import { fileURLToPath } from "url";
const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);


// Windows 对文件锁敏感，降低并发更稳定
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
 * 对比 change_old 和 change 的内容，如果 change 中与 change_old 内容(文件路径相同)一致，
 * 则删除 change 中的文件（带自动重试机制）
 */
export async function removeUnchangedFiles(change_old: string, change: string) {
    const oldFiles = await walkDir(change_old);
    const newFiles = await walkDir(change);

    console.log(`比对文件夹:`);
    console.log(`  old: ${change_old}`);
    console.log(`  new: ${change}`);

    const relativeMap = new Map<string, string>();
    for (const oldPath of oldFiles) {
        const rel = path.relative(change_old, oldPath);
        relativeMap.set(rel, oldPath);
    }

    const tasks = newFiles.map(newPath =>
        limit(async () => {
            const rel = path.relative(change, newPath);
            if (!relativeMap.has(rel)) return;

            const oldFilePath = relativeMap.get(rel)!;

            const [oldHash, newHash] = await Promise.all([
                hashFile(oldFilePath),
                hashFile(newPath)
            ]);

            if (oldHash === newHash) {
                console.log(`删除未变化 → ${rel}`);
                await safeDelete(newPath);
            }
        })
    );

    await Promise.all(tasks);

    // -----------------------
    // 🔥 新增：清理 change 目录中的空文件夹
    // -----------------------
    console.log("清理空文件夹...");
    await removeEmptyDirs(change);
    console.log(`✔ 空文件夹清理完成`);

    console.log(`✔ 完成：已删除未变化文件`);
}



// ----------------- 运行入口 -----------------
if (isMainProcess) {
    console.log("test");
    (async () => {
        const {input, output} = getDefaultPaths();
        const categoryFolders = getCategoryPaths(input);

        // 处理 change 与 change_old
        if (categoryFolders.includes("change") && categoryFolders.includes("change_old")) {
            await removeUnchangedFiles(
                path.join(output, "change_old"),
                path.join(output, "change")
            );
        } else {
            console.log("未找到 change/change_old 文件夹，跳过比较。");
        }
    })();
}
