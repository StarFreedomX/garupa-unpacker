import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { ProxyAgent } from 'proxy-agent';
import pLimit from 'p-limit';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { matchesNoProxy, systemProxyForUrl } from './systemProxy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
dotenv.config({ path: [path.join(root, '.env'), path.join(root, '.env.example')], quiet: true });

export function integerSetting(name: string, fallback: number, max = 32): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) {
        throw new Error(`${name} 必须是 1–${max} 的整数`);
    }
    return value;
}

/** Explicit project proxy overrides environment proxies; "direct" forces direct connections. */
export function validateProxy(value: string): string {
    if (!value || value === 'direct') return '';
    try {
        const url = new URL(value);
        if (!['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol)
            || !url.hostname) throw new Error();
        return value;
    } catch {
        // Do not include a URL here: it may contain proxy credentials.
        throw new Error('代理地址无效：请使用 http://、https:// 或 socks5:// 等代理 URL');
    }
}

// Keep direct connections reusable. Forward HTTP proxies must rebuild the absolute request
// target on each request; proxy-agent's async delegation currently breaks that on reused sockets.
const agent = new ProxyAgent({
    keepAlive: false,
    httpAgent: new HttpAgent({ keepAlive: true }),
    httpsAgent: new HttpsAgent({ keepAlive: true }),
});
const environmentProxy = agent.getProxyForUrl;
export function createProxyResolver(
    fromEnvironment: ProxyAgent['getProxyForUrl'],
    fromSystem = systemProxyForUrl,
    env: NodeJS.ProcessEnv = process.env,
): ProxyAgent['getProxyForUrl'] {
    return async (url, request) => {
        const explicit = env.GARUPA_PROXY_URL?.trim();
        if (explicit) return validateProxy(explicit);
        const inherited = await fromEnvironment(url, request);
        if (inherited) return validateProxy(inherited);
        // An empty environment result may mean NO_PROXY matched, not that none was configured.
        if (matchesNoProxy(url, env.no_proxy || env.NO_PROXY || '')) return '';
        return fromSystem(url);
    };
}
agent.getProxyForUrl = createProxyResolver(environmentProxy);
const requests = pLimit(8);

/** One shared socket-request budget for bundles, manifests, API calls and image downloads. */
export function networkGet<T = ArrayBuffer>(url: string, config: AxiosRequestConfig = {}, client: AxiosInstance = axios): Promise<AxiosResponse<T>> {
    requests.concurrency = integerSetting('DOWNLOAD_CONCURRENCY', 8, 64);
    validateProxy(process.env.GARUPA_PROXY_URL?.trim() ?? '');
    return requests(() => client.get<T>(url, {
        timeout: 30_000, responseType: 'arraybuffer', ...config,
        httpAgent: agent, httpsAgent: agent, proxy: false,
    }));
}

const MAX_BYTES = 512 * 1024 * 1024;
class RangeFallback extends Error {}

function contentRange(response: AxiosResponse, start: number, end: number, total?: number): number {
    const match = String(response.headers['content-range'] ?? '').match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
    const size = Number(match?.[3]);
    const encoding = response.headers['content-encoding'];
    if (response.status !== 206 || !match || !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES
        || Number(match[1]) !== start || Number(match[2]) !== Math.min(end, size - 1)
        || response.data.length !== Number(match[2]) - start + 1 || (total !== undefined && size !== total)
        || (encoding && encoding !== 'identity')) {
        throw new RangeFallback('服务器返回的分段范围或长度不一致');
    }
    return size;
}

/** Complete bundle bytes stay in memory; ranges are assembled before the Unity parser runs. */
export async function downloadAsset(url: string, client: AxiosInstance = axios): Promise<Buffer> {
    const threads = integerSetting('DOWNLOAD_THREADS', 4, 16);
    const chunkSize = integerSetting('DOWNLOAD_CHUNK_SIZE_MB', 4, 64) * 1024 * 1024;
    const get = async (start?: number, end?: number, validator?: string, signal?: AbortSignal) => {
        for (let attempt = 1; ; attempt++) {
            try {
                return await networkGet<Buffer>(url, {
                    // Ranges refer to bytes of the identity representation.
                    decompress: false, signal,
                    maxContentLength: validator ? end! - start! + 1 : MAX_BYTES,
                    headers: {
                        'User-Agent': 'garupa-getAssets/1.0.0', 'Accept-Encoding': 'identity',
                        ...(start === undefined ? {} : { Range: `bytes=${start}-${end}` }),
                        ...(validator ? { 'If-Range': validator } : {}),
                    },
                }, client);
            } catch (error) {
                if (signal?.aborted) throw error;
                const status = axios.isAxiosError(error) ? error.response?.status : undefined;
                if (start !== undefined && (status === 416 || (axios.isAxiosError(error)
                    && error.code === 'ERR_BAD_RESPONSE' && error.message.startsWith('maxContentLength')))) {
                    throw new RangeFallback('服务器不再提供有效分段');
                }
                if (attempt >= 3 || (status && status < 500 && status !== 408 && status !== 429)) throw error;
                console.warn(`[下载重试 ${attempt}/3] ${new URL(url).pathname}: ${axios.isAxiosError(error) ? error.code : '网络错误'}`);
                await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
                if (signal?.aborted) throw error;
            }
        }
    };
    const whole = async () => {
        const response = await get();
        if (response.status !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            throw new Error('整包下载返回了不完整或压缩的响应');
        }
        return Buffer.from(response.data);
    };
    if (threads === 1) return whole();
    try {
        const first = await get(0, chunkSize - 1);
        if (first.status === 200) {
            if (first.headers['content-encoding'] && first.headers['content-encoding'] !== 'identity') {
                throw new Error('服务器忽略了 Accept-Encoding: identity');
            }
            return Buffer.from(first.data); // Range unsupported: this is already the full file.
        }
        const total = contentRange(first, 0, chunkSize - 1);
        if (first.data.length === total) return Buffer.from(first.data);
        const etag = first.headers.etag;
        const modified = first.headers['last-modified'];
        const validator = typeof etag === 'string' && /^".*"$/.test(etag) ? etag
            : typeof modified === 'string' && Number.isFinite(Date.parse(modified)) ? modified : undefined;
        if (!validator) throw new RangeFallback('服务器未提供可用于校验分段版本的 ETag/Last-Modified');

        const output = Buffer.allocUnsafe(total);
        Buffer.from(first.data).copy(output);
        const controller = new AbortController();
        let next = first.data.length;
        let failure: unknown;
        const worker = async () => {
            try {
                while (next < total && !controller.signal.aborted) {
                    const start = next;
                    const end = Math.min(start + chunkSize, total) - 1;
                    next = end + 1;
                    const part = await get(start, end, validator, controller.signal);
                    contentRange(part, start, end, total);
                    const returnedValidator = validator === etag ? part.headers.etag : part.headers['last-modified'];
                    if (returnedValidator !== validator) throw new RangeFallback('分段下载期间资源版本发生变化');
                    Buffer.from(part.data).copy(output, start);
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    failure = error;
                    controller.abort();
                }
            }
        };
        // Drain aborted siblings before releasing memory or starting the full-download fallback.
        await Promise.all(Array.from({ length: Math.min(threads, Math.ceil((total - next) / chunkSize)) }, worker));
        if (failure) throw failure;
        return output;
    } catch (error) {
        if (!(error instanceof RangeFallback)) throw error;
        console.warn(`[分段回退] ${new URL(url).pathname}: ${error.message}`);
        return whole();
    }
}
