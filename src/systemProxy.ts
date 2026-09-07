import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BlockList, isIP } from 'node:net';

export interface SystemProxySettings {
    values: Record<string, string>;
    exceptions: string[];
}

/** Only read the effective top-level configuration, not inactive per-interface scopes. */
export function parseMacProxy(text: string): SystemProxySettings {
    const values = Object.fromEntries([...text.matchAll(/^  (\w+) : ([^\n{}]+)$/gm)]
        .map(match => [match[1], match[2].trim()]));
    const list = text.match(/^  ExceptionsList : <array> \{\n([\s\S]*?)^  \}/m)?.[1] ?? '';
    const exceptions = [...list.matchAll(/^    \d+ : (.+)$/gm)].map(match => match[1].trim());
    return { values, exceptions };
}

/** Standard NO_PROXY matching, including domain suffixes, ports and bracketed IPv6. */
export function matchesNoProxy(url: string, value: string): boolean {
    const target = new URL(url);
    const host = target.hostname.toLowerCase();
    const port = target.port || (target.protocol === 'https:' ? '443' : '80');
    return value.toLowerCase().split(/[,\s]+/).filter(Boolean).some(entry => {
        if (entry === '*') return true;
        const match = entry.match(/^(.+):(\d+)$/);
        if (match) {
            if (String(Number(match[2])) !== port) return false;
            entry = match[1];
        }
        if (entry.startsWith('*')) return host.endsWith(entry.slice(1));
        if (entry.startsWith('.')) return host.endsWith(entry);
        return host === entry;
    });
}

function bypassSystemProxy(host: string, settings: SystemProxySettings): boolean {
    host = host.replace(/^\[|\]$/g, '').toLowerCase();
    const simple = !host.includes('.') && !host.includes(':');
    if (settings.values.ExcludeSimpleHostnames === '1' && simple) return true;
    return settings.exceptions.some(value => {
        value = value.toLowerCase();
        if (value === '<local>') return simple;
        if (value.includes('/')) {
            const [address, prefix] = value.split('/');
            const family = isIP(address);
            if (!family || isIP(host) !== family || !/^\d+$/.test(prefix ?? '')) return false;
            try {
                const list = new BlockList();
                const type = family === 4 ? 'ipv4' : 'ipv6';
                list.addSubnet(address, Number(prefix), type);
                return list.check(host, type);
            } catch { return false; }
        }
        const pattern = value.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        return new RegExp(`^${pattern}$`).test(host);
    });
}

export function proxyFromSystemSettings(url: string, settings: SystemProxySettings): string {
    const target = new URL(url);
    if (bypassSystemProxy(target.hostname, settings)) return '';
    const values = settings.values;
    if (values.ProxyAutoConfigEnable === '1' && values.ProxyAutoConfigURLString) {
        const pac = new URL(values.ProxyAutoConfigURLString);
        if (['http:', 'https:', 'file:'].includes(pac.protocol)) return `pac+${pac.href}`;
        throw new Error('系统 PAC 地址协议不受支持');
    }
    const key = target.protocol === 'https:' ? 'HTTPS' : 'HTTP';
    for (const kind of [key, 'SOCKS']) {
        if (values[`${kind}Enable`] !== '1') continue;
        const host = values[`${kind}Proxy`];
        const port = Number(values[`${kind}Port`]);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('系统代理的地址或端口无效');
        }
        // macOS "Secure Web Proxy (HTTPS)" is an HTTP CONNECT proxy, not a TLS proxy endpoint.
        const scheme = kind === 'SOCKS' ? 'socks5h' : 'http';
        const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
        return new URL(`${scheme}://${hostname}:${port}`).href;
    }
    return '';
}

const execute = promisify(execFile);
export function createSystemProxyReader(
    read = async () => (await execute('/usr/sbin/scutil', ['--proxy'], { timeout: 3000, maxBuffer: 256 * 1024 })).stdout,
    platform = process.platform,
    now = Date.now,
) {
    let cached: Promise<SystemProxySettings> | undefined;
    let expires = 0;
    return () => {
        if (platform !== 'darwin') return Promise.resolve({ values: {}, exceptions: [] });
        if (!cached || now() >= expires) {
            expires = now() + 30_000;
            cached = read().then(parseMacProxy).catch(() => {
                console.warn('[系统代理] 无法读取 macOS 代理设置，本次按直连处理');
                return { values: {}, exceptions: [] };
            });
        }
        return cached;
    };
}

const readSystemProxy = createSystemProxyReader();
export async function systemProxyForUrl(url: string): Promise<string> {
    return proxyFromSystemSettings(url, await readSystemProxy());
}
