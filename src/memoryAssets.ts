import { Acb } from 'acb';
import { AssetTypes, readAssets, type AssetInput, type AssetType, type ExportAssetsDefaultConfig } from 'node-asset-studio-mod-js';
import path from 'node:path';
import fs from 'node:fs/promises';
import axios, { type AxiosInstance } from 'axios';
import { downloadAsset } from './network.js';
import { createHash } from 'node:crypto';


export type MemoryFiles = Map<string, Buffer>;
export interface UnpackTimings {
    exportMs: number;
    finalizeMs: number;
    fileCount: number;
    outputBytes: number;
}
export const DEFAULT_HCA_KEY = 0x22CE;
const SEGMENT_PATTERN = /^(.*)-(\d{3,})\.(acb|awb)$/i;

/** Both Unity container names and ACB cue names are untrusted relative paths. */
export function assetPath(name: string): string {
    const normalized = name.replace(/\\/g, '/');
    if (!normalized || normalized.includes('\0') || /^[A-Za-z]:/.test(normalized)
        || normalized.startsWith('/') || normalized.split('/').some(p => p === '..' || p === '.' || !p)) {
        throw new Error(`非法资源路径: ${name}`);
    }
    return normalized;
}

function addFile(files: MemoryFiles, name: string, data: Buffer): void {
    name = assetPath(name);
    const previous = files.get(name);
    if (previous && !previous.equals(data)) throw new Error(`资源输出重名: ${name}`);
    files.set(name, data);
}

/** Merge before comparing: an unchanged fragment is still needed to decode a changed ACB. */
export function mergeAudioSegments(input: MemoryFiles): MemoryFiles {
    const files: MemoryFiles = new Map();
    const groups = new Map<string, Array<{ index: number; data: Buffer }>>();
    for (const [name, data] of input) {
        const match = assetPath(name).match(SEGMENT_PATTERN);
        if (!match) { addFile(files, name, data); continue; }
        const target = `${match[1]}.${match[3].toLowerCase()}`;
        const parts = groups.get(target) ?? [];
        parts.push({ index: Number(match[2]), data });
        groups.set(target, parts);
    }
    for (const [name, parts] of groups) {
        parts.sort((a, b) => a.index - b.index);
        if (parts[0].index > 1 || parts.some((part, i) => i > 0 && part.index !== parts[i - 1].index + 1)) {
            throw new Error(`音频分片缺失或重复: ${name}`);
        }
        addFile(files, name, Buffer.concat(parts.map(p => p.data)));
    }
    return files;
}

export async function decodeHcaBuffer(data: Buffer, key = DEFAULT_HCA_KEY): Promise<Buffer> {
    // Load the native decoder only for audio; images/charts do not require it.
    const { default: HCA } = await import('hca-decoder');
    const decoder = new HCA.HCADecoder(key, 0x0000);
    // hca-decoder 1.6 reads only .buffer and ignores a Buffer's byteOffset/length.
    // ACB entries are slices of their archive: pass an exact, unpooled ArrayBuffer.
    const input = Uint8Array.from(data).buffer;
    return new Promise((resolve, reject) => {
        decoder.decodeToMemory(input, (error, wav) => {
            if (error) reject(error);
            else if (!wav) reject(new Error('HCA 解码没有返回 WAV'));
            else resolve(wav);
        });
    });
}

/** Decode cue buffers directly; unsupported non-HCA codecs retain their original extension. */
export async function decodeAcbBuffer(data: Buffer, awb?: Buffer, key = DEFAULT_HCA_KEY): Promise<MemoryFiles> {
    const acb = new Acb(data, awb);
    // getFileList silently omits missing waveforms, so validate them explicitly.
    for (const track of acb.trackList.tracks) {
        if (!(track.wavId in acb.awbFile.files)) throw new Error(`ACB 缺少音轨 ${track.wavId}`);
    }
    const files: MemoryFiles = new Map();
    for (const entry of acb.getFileList()) {
        const name = assetPath(entry.name);
        if (/\.hca$/i.test(name)) {
            addFile(files, name.replace(/\.hca$/i, '.wav'), await decodeHcaBuffer(entry.buffer, key));
        } else {
            addFile(files, name, entry.buffer);
        }
    }
    return files;
}

export async function finalizeAssets(input: MemoryFiles): Promise<MemoryFiles> {
    const files = mergeAudioSegments(input);
    const result: MemoryFiles = new Map();
    const companions = new Set<string>();
    for (const [name, data] of files) {
        if (!/\.acb$/i.test(name)) continue;
        const prefix = name.replace(/\.acb$/i, '');
        const awbName = [...files.keys()].find(p => p.toLowerCase() === `${prefix}.awb`.toLowerCase());
        const decoded = await decodeAcbBuffer(data, awbName ? files.get(awbName) : undefined);
        for (const [cue, buffer] of decoded) addFile(result, `${prefix}/${cue}`, buffer);
        if (awbName) companions.add(awbName);
    }
    for (const [name, data] of files) {
        if (/\.acb$/i.test(name) || companions.has(name)) continue;
        if (/\.hca$/i.test(name)) addFile(result, name.replace(/\.hca$/i, '.wav'), await decodeHcaBuffer(data));
        else addFile(result, name, data);
    }
    return result;
}

/** One readAssets call owns one Worker and closes it even on error. */
export async function unpackBundle(input: AssetInput, config: ExportAssetsDefaultConfig = {}, timings?: UnpackTimings): Promise<MemoryFiles> {
    const started = performance.now();
    const restoreNames = config.filenameFormat === undefined && config.mode !== 'extract' && config.mode !== 'live2d';
    const options: ExportAssetsDefaultConfig = {
        unityVersion: process.env.UNITY_VERSION,
        assetType: ['all'], group: 'container', imageFormat: 'png', audioFormat: 'wav',
        filenameFormat: 'assetName_pathID', maxExportTasks: 1, log: false, ...config,
    };
    const requested = Array.isArray(options.assetType) ? options.assetType : [options.assetType];
    let selected: AssetType[] = requested.includes('all') ? AssetTypes.filter(type => type !== 'all') : requested;
    const rawTypes: AssetType[] = [];
    const unsupported: Record<string, AssetType> = {
        Texture2DArray: 'tex2dArray', MovieTexture: 'movietexture', Animator: 'animator',
    };
    let result: Awaited<ReturnType<typeof readAssets>>;
    for (;;) {
        try {
            result = await readAssets(input, { ...options, assetType: selected });
            break;
        } catch (error) {
            const type = error instanceof Error ? unsupported[error.message.match(/^Conversion of (\w+) is not supported;/)?.[1] ?? ''] : undefined;
            if ((options.mode && options.mode !== 'export') || !type || !selected.includes(type)
                || (error as { code?: string }).code !== 'UNSUPPORTED_OPERATION') throw error;
            console.warn(`[原始导出] ${type} 暂不支持转换，将保留 .bin 原始对象`);
            rawTypes.push(type);
            selected = selected.filter(value => value !== type);
            if (!selected.length) {
                result = await readAssets(input, { ...options, mode: 'exportRaw', assetType: rawTypes });
                rawTypes.length = 0;
                break;
            }
        }
    }
    if (rawTypes.length) {
        const raw = await readAssets(input, { ...options, mode: 'exportRaw', assetType: rawTypes });
        result.files.push(...raw.files);
    }
    const exported = performance.now();
    // Unity bundles can contain same-name objects (e.g. multiple _empty_ MonoBehaviours).
    // Export uniquely first, then restore ordinary names so image picks and ACB fragments still match.
    const plainNames = result.files.map(file => restoreNames
        ? file.path.replace(/ @-?\d+(?=\.[^/.]+$)/, '') : file.path);
    const counts = new Map<string, number>();
    for (const name of plainNames) counts.set(name, (counts.get(name) ?? 0) + 1);
    const files: MemoryFiles = new Map();
    for (const [index, file] of result.files.entries()) {
        const name = counts.get(plainNames[index]) === 1 ? plainNames[index] : file.path;
        addFile(files, name, Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength));
    }
    const finalized = await finalizeAssets(files);
    if (timings) {
        timings.exportMs = exported - started;
        timings.finalizeMs = performance.now() - exported;
        timings.fileCount = finalized.size;
        timings.outputBytes = [...finalized.values()].reduce((size, data) => size + data.length, 0);
    }
    return finalized;
}

export function changedFiles(current: MemoryFiles, previous: MemoryFiles): MemoryFiles {
    return new Map([...current].filter(([name, data]) => !previous.get(name)?.equals(data)));
}

/** The concurrency limit applies to the whole download/unpack/decode/write task. */
export function pipelineConcurrency(value = process.env.ASSET_PIPELINE_CONCURRENCY): number {
    const count = Number(value ?? 4);
    if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('资源流水线并发数必须是 1–32 的整数');
    return count;
}

export async function downloadBundle(baseUrl: string, name: string, client: AxiosInstance = axios): Promise<Buffer> {
    const clean = assetPath(name.replace(/^\//, ''));
    const url = `${baseUrl.replace(/\/?$/, '/')}${clean}`;
    return downloadAsset(url, client);
}

/** Deduplicate shared output paths using in-memory hashes; serialize identical concurrent writes. */
export function createMemoryWriter(root: string) {
    const written = new Map<string, { digest: string; done: Promise<void> }>();
    return async (files: MemoryFiles, prefix = ''): Promise<void> => {
        for (const [name, data] of files) {
            const relative = assetPath(prefix ? `${assetPath(prefix)}/${assetPath(name)}` : name);
            const digest = createHash('sha256').update(data).digest('hex');
            const previous = written.get(relative);
            if (previous) {
                if (previous.digest !== digest) throw new Error(`资源输出重名: ${relative}`);
                await previous.done;
                continue;
            }
            const destination = path.join(root, relative);
            const done = (async () => {
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, data, { flag: 'wx' });
            })();
            written.set(relative, { digest, done });
            await done;
        }
    };
}

export async function writeMemoryFiles(root: string, files: MemoryFiles): Promise<void> {
    await createMemoryWriter(root)(files);
}

/** Only final bytes are staged. A failed run leaves the last successful output intact. */
export async function withStagedOutput<T>(output: string, action: (stage: string) => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(output), { recursive: true });
    const stage = await fs.mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}-`));
    const backup = `${stage}-previous`;
    let backedUp = false;
    try {
        const result = await action(stage);
        try {
            await fs.rename(output, backup);
            backedUp = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        try {
            await fs.rename(stage, output);
        } catch (error) {
            if (backedUp) await fs.rename(backup, output);
            throw error;
        }
        if (backedUp) await fs.rm(backup, { recursive: true, force: true });
        return result;
    } finally {
        await fs.rm(stage, { recursive: true, force: true });
    }
}
