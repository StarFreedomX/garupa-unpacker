/**
 * 从 apks/ 目录的 APK 文件提取版本（AndroidManifest.xml 的 versionName，二进制 AXML）
 * 与 CDN hash（global-metadata.dat 中 content.garupa.jp/Release/ 之后的 64 位 hex）。
 *
 * 关键实证（真实文件 apks/ガルパ_10.1.4.apks）：
 * - 外层 .apks 是 zip，内含 base.apk + split_config.arm64_v8a.apk（split 无 metadata 可跳过）
 * - base.apk 内含 AndroidManifest.xml（二进制 AXML）与
 *   assets/bin/Data/Managed/Metadata/global-metadata.dat（IL2CPP 元数据，含 hash 明文）
 * - metadata 里 hash 前的 \x80\x80 是 IL2CPP 字符串长度前缀，正则应跳过（定位后 200 字节内搜 64hex）
 * - APK 里只有 clientVersion（versionName），没有 dataVersion；归属判断由调用方通过
 *   /application 服务器确认（本模块只返回全部候选，不做版本匹配）
 *
 * 不依赖任何 zip 库（项目无 zip 依赖），自行解析 zip 中央目录（stored / deflate 两种压缩）。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";

/** zip 条目描述（来自中央目录） */
export interface ZipEntry {
    name: string;
    method: number;
    compSize: number;
    uncompSize: number;
    localHeaderOffset: number;
}

/** apks 目录路径（约定在项目根下） */
export function getApksDir(projectRoot: string): string {
    return path.join(projectRoot, "apks");
}

/**
 * 在 Buffer 尾部搜索 EOCD（签名 PK\x05\x06 = 0x06054b50），返回其偏移；找不到返回 -1。
 * EOCD 是 zip 最后一个结构（后面仅跟注释），从文件末尾往前扫最后 65557 字节即可。
 */
function findEocd(data: Buffer): number {
    if (data.length < 22) return -1;
    const minPos = Math.max(0, data.length - 65557); // 22 字节 EOCD + 最大 65535 字节注释
    for (let p = data.length - 22; p >= minPos; p--) {
        if (data.readUInt32LE(p) === 0x06054b50) {
            // 校验注释长度恰好到文件尾，避免在注释内容里误命中签名
            if (p + 22 + data.readUInt16LE(p + 20) === data.length) return p;
        }
    }
    return -1;
}

/** 列出 zip 中央目录中的全部条目 */
export function listZipEntries(data: Buffer): ZipEntry[] {
    const eocd = findEocd(data);
    if (eocd === -1) return [];
    const entryCount = data.readUInt16LE(eocd + 10);
    const cdOffset = data.readUInt32LE(eocd + 16);
    const entries: ZipEntry[] = [];
    let p = cdOffset;
    for (let i = 0; i < entryCount; i++) {
        // 每条目：签名 PK\x01\x02，名称/额外/注释长度与 local header 偏移固定布局
        if (p + 46 > data.length || data.readUInt32LE(p) !== 0x02014b50) break;
        const nameLen = data.readUInt16LE(p + 28);
        const extraLen = data.readUInt16LE(p + 30);
        const commentLen = data.readUInt16LE(p + 32);
        const total = 46 + nameLen + extraLen + commentLen;
        if (p + total > data.length) break;
        entries.push({
            name: data.toString("utf8", p + 46, p + 46 + nameLen),
            method: data.readUInt16LE(p + 10),
            compSize: data.readUInt32LE(p + 20),
            uncompSize: data.readUInt32LE(p + 24),
            localHeaderOffset: data.readUInt32LE(p + 42),
        });
        p += total;
    }
    return entries;
}

/**
 * 按中央目录描述提取条目数据：
 * - 跳到 local header 读 method（0=stored, 8=deflate），数据在 local header 后 nameLen+extraLen 处
 * - stored 直接切片；deflate 用 node:zlib 的 inflateRawSync
 */
function extractZipEntry(data: Buffer, entry: ZipEntry): Buffer | null {
    const lh = entry.localHeaderOffset;
    if (lh + 30 > data.length || data.readUInt32LE(lh) !== 0x04034b50) return null;
    const nameLen = data.readUInt16LE(lh + 26);
    const extraLen = data.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compSize;
    if (dataEnd > data.length) return null;
    const comp = data.subarray(dataStart, dataEnd);
    if (entry.method === 0) return Buffer.from(comp); // stored
    if (entry.method === 8) return inflateRawSync(comp); // deflate
    return null; // 其他压缩方式不支持
}

/** 按名称读取 zip 条目数据（未找到返回 null） */
export function readZipEntry(data: Buffer, name: string): Buffer | null {
    const entry = listZipEntries(data).find(e => e.name === name);
    return entry ? extractZipEntry(data, entry) : null;
}

/**
 * 解析二进制 AXML（AndroidManifest.xml），提取 versionName 字符串。
 *
 * 结构：
 * - 文件头 chunk（type 0x0003, headerSize 8, size）
 * - 随后 string pool chunk（type 0x0001）：
 *   strCount(off+8)、flags(off+16, 第 8 位 0x100 = UTF-8)、stringsStart(off+20)，
 *   之后 strCount 个 4 字节偏移表（从 chunk off+28 开始）
 * - 字符串解码：
 *   UTF-16LE：先 2 字节长度（`<H`，高位置位时为 4 字节扩展长度），再 len*2 字节内容
 *   UTF-8：先 1 字节长度（高位置位时 ((b&0x7f)<<8)|next），再 len 字节
 * - 遍历后续 chunk（0x0102 = start element）找 <manifest>：
 *   name 字符串引用在 off+20；attrStart 在 off+24（相对元素块 p+16 的偏移）、
 *   attrSize 在 off+26、attrCount 在 off+28。每个属性 20 字节：ns(4) name(4) rawValue(4) typedValue(8)。
 *   属性名（name 引用）== "versionName" 时，rawValue 即字符串池索引。
 */
export function parseAxmlVersionName(buf: Buffer): string | null {
    // 文件头校验 + 第一个 chunk 必须是 string pool
    if (buf.length < 36 || buf.readUInt16LE(0) !== 0x0003) return null;
    if (buf.readUInt16LE(8) !== 0x0001) return null;

    const strCount = buf.readUInt32LE(16);
    const flags = buf.readUInt32LE(24);
    const stringsStart = buf.readUInt32LE(28);
    const isUtf8 = (flags & 0x100) !== 0;
    const offsetsBase = 8 + 28; // string pool chunk 起点 8 + 28 字节头部
    const stringDataBase = 8 + stringsStart;

    /** 按字符串池索引取字符串 */
    const getString = (index: number): string | null => {
        if (index < 0 || index >= strCount) return null;
        const strOff = buf.readUInt32LE(offsetsBase + index * 4);
        let sp = stringDataBase + strOff;
        if (isUtf8) {
            if (sp + 2 > buf.length) return null;
            let len = buf[sp];
            if (len & 0x80) {
                len = ((len & 0x7f) << 8) | buf[sp + 1];
                sp += 2;
            } else {
                sp += 1;
            }
            const end = sp + len;
            if (end > buf.length) return null;
            return buf.toString("utf8", sp, end);
        }
        if (sp + 4 > buf.length) return null;
        let len = buf.readUInt16LE(sp);
        if (len & 0x8000) {
            len = ((len & 0x7fff) << 16) | buf.readUInt16LE(sp + 2);
            sp += 4;
        } else {
            sp += 2;
        }
        const end = sp + len * 2;
        if (end > buf.length) return null;
        return buf.toString("utf16le", sp, end);
    };

    // 跳到 string pool chunk 结束，遍历后续 chunk 找 <manifest> 的 start element
    let p = 8 + buf.readUInt32LE(12);
    while (p + 8 <= buf.length) {
        const ctype = buf.readUInt16LE(p);
        const csize = buf.readUInt32LE(p + 4);
        if (csize < 8 || p + csize > buf.length) break;
        if (ctype === 0x0102) {
            const nameIndex = buf.readUInt32LE(p + 20);
            if (getString(nameIndex) === "manifest") {
                const attrStart = buf.readUInt16LE(p + 24);
                const attrSize = buf.readUInt16LE(p + 26);
                const attrCount = buf.readUInt16LE(p + 28);
                const step = attrSize >= 20 ? attrSize : 20;
                const attrsBase = p + 16 + attrStart;
                for (let i = 0; i < attrCount; i++) {
                    const a = attrsBase + i * step;
                    if (a + 20 > buf.length) break;
                    if (getString(buf.readUInt32LE(a + 4)) !== "versionName") continue;
                    // rawValue 为 versionName 字符串池索引；缺失时回退 typedValue.data（dataType 0x03 = TYPE_STRING）
                    let strIndex = buf.readUInt32LE(a + 8);
                    if (strIndex === 0xffffffff || strIndex >= strCount) {
                        if (buf.readUInt8(a + 15) === 0x03) strIndex = buf.readUInt32LE(a + 16);
                        else continue;
                    }
                    return getString(strIndex);
                }
            }
        }
        p += csize;
    }
    return null;
}

/**
 * 从 global-metadata.dat 提取 CDN hash：
 * 定位 content.garupa.jp/Release/ 后，在之后 200 字节内搜 [0-9a-fA-F]{64}。
 * 哈希前的 \x80\x80 是 IL2CPP 字符串长度前缀，定位法天然跳过它。
 * 注意：metadata 里该前缀可能出现多次（实测存在 Unity 文档 URL 模板误命中，
 * 如 content.garupa.jp/Release/https://docs.unity3d.com/...），故遍历所有出现位置，
 * 返回第一个 200 字节窗口内含 64hex 的位置。
 */
export function parseMetadataHash(buf: Buffer): string | null {
    const marker = Buffer.from("content.garupa.jp/Release/", "ascii");
    const hexRe = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
    let idx = buf.indexOf(marker);
    while (idx !== -1) {
        const win = buf.subarray(idx + marker.length, idx + marker.length + 200);
        const m = win.toString("latin1").match(hexRe);
        if (m) {
            const hash = m[0].toLowerCase();
            if (hash.length === 64) return hash;
        }
        idx = buf.indexOf(marker, idx + 1);
    }
    return null;
}

/**
 * 读取单个 apk/apks/xapk 文件，返回 versionName 与 hash。
 * - .apks/.xapk 是外层 zip：先列出内部 .apk 条目逐个尝试
 * - .apk 直接作为 zip 处理
 * 返回第一个同时解析出 versionName 与 hash 的内层 APK。
 */
async function readApkVersionAndHash(apkPath: string): Promise<{ versionName: string; hash: string } | null> {
    const data = await fs.readFile(apkPath);
    const ext = path.extname(apkPath).toLowerCase();
    const isBundle = ext === ".apks" || ext === ".xapk";

    const apkBuffers: Buffer[] = [];
    if (isBundle) {
        for (const entry of listZipEntries(data)) {
            if (!entry.name.toLowerCase().endsWith(".apk")) continue;
            const inner = extractZipEntry(data, entry);
            if (inner) apkBuffers.push(inner);
        }
    } else {
        apkBuffers.push(data);
    }

    for (const apkData of apkBuffers) {
        const entries = listZipEntries(apkData);
        const findEntry = (name: string): Buffer | null => {
            const e = entries.find(x => x.name === name);
            return e ? extractZipEntry(apkData, e) : null;
        };
        // global-metadata.dat 缺失（如 split APK）→ 跳过该 APK
        const metadata = findEntry("assets/bin/Data/Managed/Metadata/global-metadata.dat");
        if (!metadata) continue;
        const manifest = findEntry("AndroidManifest.xml");
        if (!manifest) continue;
        const versionName = parseAxmlVersionName(manifest);
        if (!versionName) continue;
        const hash = parseMetadataHash(metadata);
        if (!hash) continue;
        return { versionName, hash };
    }
    return null;
}

/**
 * 扫描 apksDir 下 .apk/.apks/.xapk 文件，返回全部解析成功的候选
 * （apkName + clientVersion + hash）。单文件解析失败忽略继续。
 * 不做任何版本匹配——APK 里只有 clientVersion 没有 dataVersion，
 * 归属判断由调用方通过 /application 服务器确认。
 */
export async function extractApkCandidates(apksDir: string): Promise<Array<{ apkName: string; clientVersion: string; hash: string }>> {
    let names: string[];
    try {
        names = await fs.readdir(apksDir);
    } catch {
        return []; // 目录不存在或不可读
    }

    const results: Array<{ apkName: string; clientVersion: string; hash: string }> = [];
    for (const name of names) {
        if (!/\.(apk|apks|xapk)$/i.test(name)) continue;
        try {
            const r = await readApkVersionAndHash(path.join(apksDir, name));
            if (r) results.push({ apkName: name, clientVersion: r.versionName, hash: r.hash });
        } catch {
            // 忽略单文件解析错误
        }
    }
    return results;
}
