import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import axios from 'axios';
import { downloadAsset, integerSetting, networkGet, validateProxy } from '../src/network.js';

function env(t: TestContext, values: Record<string, string>) {
    const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    t.after(() => {
        for (const [key, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
}
const bytes = Buffer.alloc(7 * 1024 * 1024 + 123);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + Math.floor(i / 65536)) % 251;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('ranges finish out of order, preserve every byte, and share the global request limit across files', async t => {
    env(t, { DOWNLOAD_THREADS: '4', DOWNLOAD_CHUNK_SIZE_MB: '1', DOWNLOAD_CONCURRENCY: '3' });
    let active = 0, peak = 0, ranges = 0;
    const client = axios.create({ adapter: async config => {
        active++; peak = Math.max(peak, active);
        try {
            assert.equal(config.proxy, false);
            assert.ok(config.httpAgent); assert.ok(config.httpsAgent);
            const match = String(config.headers.Range).match(/^bytes=(\d+)-(\d+)$/)!;
            assert.ok(match);
            const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
            if (start) assert.equal(config.headers['If-Range'], '"stable"');
            ranges++;
            await delay(start % (2 * 1024 * 1024) ? 5 : 20);
            return { data: bytes.subarray(start, end + 1), status: 206, statusText: 'Partial Content',
                headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}`, etag: '"stable"' }, config };
        } finally { active--; }
    } });
    const results = await Promise.all(['a', 'b', 'c'].map(name => downloadAsset(`http://example.invalid/${name}`, client)));
    for (const result of results) assert.deepEqual(result, bytes);
    assert.equal(peak, 3); assert.equal(active, 0); assert.equal(ranges, 24);
});

test('unsupported ranges and single-thread mode each download the complete file once', async t => {
    env(t, { DOWNLOAD_THREADS: '4' });
    const seen: unknown[] = [];
    const client = axios.create({ adapter: async config => {
        seen.push(config.headers.Range);
        return { data: bytes, status: 200, statusText: 'OK', headers: {}, config };
    } });
    assert.deepEqual(await downloadAsset('http://example.invalid/a', client), bytes);
    process.env.DOWNLOAD_THREADS = '1';
    assert.deepEqual(await downloadAsset('http://example.invalid/b', client), bytes);
    assert.equal(seen.length, 2); assert.ok(seen[0]); assert.equal(seen[1], undefined);
});

test('range corruption, resource changes and absent validators fall back without publishing mixed bytes', async t => {
    env(t, { DOWNLOAD_THREADS: '3', DOWNLOAD_CHUNK_SIZE_MB: '1' });
    for (const mode of ['wrong offset', 'truncated', 'changed etag', 'ignored if-range', 'no validator', 'wrong total']) {
        let active = 0, full = 0;
        const client = axios.create({ adapter: async config => {
            if (!config.headers.Range) {
                assert.equal(active, 0, 'siblings must finish before fallback');
                full++;
                return { data: bytes, status: 200, statusText: 'OK', headers: {}, config };
            }
            active++;
            try {
                const match = String(config.headers.Range).match(/(\d+)-(\d+)/)!;
                const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
                await delay(start ? 10 : 1);
                return { data: bytes.subarray(start, end + (start && mode === 'truncated' ? 0 : 1)),
                    status: start && mode === 'ignored if-range' ? 200 : 206, statusText: 'Partial Content', config,
                    headers: {
                        'content-range': `bytes ${start && mode === 'wrong offset' ? start + 1 : start}-${end}/${bytes.length + (start && mode === 'wrong total' ? 1 : 0)}`,
                        ...(mode === 'no validator' ? {} : { etag: start && mode === 'changed etag' ? '"changed"' : '"stable"' }),
                    } };
            } finally { active--; }
        } });
        assert.deepEqual(await downloadAsset('http://example.invalid/a', client), bytes, mode);
        assert.equal(full, 1, mode);
    }
});

test('small partial response needs no further download; Last-Modified also protects ranges', async t => {
    env(t, { DOWNLOAD_THREADS: '2', DOWNLOAD_CHUNK_SIZE_MB: '1' });
    for (const data of [Buffer.from('small'), bytes]) {
        const modified = 'Mon, 07 Sep 2026 00:00:00 GMT';
        const client = axios.create({ adapter: async config => {
            const match = String(config.headers.Range).match(/(\d+)-(\d+)/)!;
            const start = Number(match[1]), end = Math.min(Number(match[2]), data.length - 1);
            if (start) assert.equal(config.headers['If-Range'], modified);
            return { data: data.subarray(start, end + 1), status: 206, statusText: 'Partial Content', config,
                headers: { 'content-range': `bytes ${start}-${end}/${data.length}`, 'last-modified': modified } };
        } });
        assert.deepEqual(await downloadAsset('http://example.invalid/a', client), data);
    }
});

test('invalid configuration rejects without exposing proxy credentials', async t => {
    assert.equal(validateProxy('direct'), '');
    for (const scheme of ['http', 'https', 'socks5', 'socks5h']) {
        assert.equal(validateProxy(`${scheme}://localhost:8080`), `${scheme}://localhost:8080`);
    }
    assert.throws(() => validateProxy('ftp://user:secret@localhost'), error => !String(error).includes('secret'));
    env(t, { DOWNLOAD_CONCURRENCY: '0' });
    assert.throws(() => integerSetting('DOWNLOAD_CONCURRENCY', 8));
});

async function listen(t: TestContext, server: net.Server) {
    const sockets = new Set<net.Socket>();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    return (server.address() as net.AddressInfo).port;
}

test('real HTTP proxy forwards bytes, credentials, environment proxy and NO_PROXY/direct settings', async t => {
    env(t, { GARUPA_PROXY_URL: '', http_proxy: '', HTTP_PROXY: '', no_proxy: '', NO_PROXY: '', ALL_PROXY: '', all_proxy: '',
        DOWNLOAD_THREADS: '4', DOWNLOAD_CHUNK_SIZE_MB: '1' });
    let forwarded = 0;
    const origin = http.createServer((req, res) => {
        if (req.url !== '/bundle') { res.end('origin bytes'); return; }
        const match = req.headers.range?.match(/bytes=(\d+)-(\d+)/);
        if (!match) { res.end(bytes); return; }
        const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, ETag: '"stable"' });
        res.end(bytes.subarray(start, end + 1));
    });
    const originPort = await listen(t, origin);
    const proxy = http.createServer((req, res) => {
        forwarded++;
        if (forwarded === 1) assert.equal(req.headers['proxy-authorization'], `Basic ${Buffer.from('user:pass').toString('base64')}`);
        const headers = { ...req.headers };
        delete headers['proxy-authorization'];
        const upstream = http.get(req.url!, { headers }, response => { res.writeHead(response.statusCode!, response.headers); response.pipe(res); });
        upstream.on('error', error => res.destroy(error));
    });
    const proxyPort = await listen(t, proxy);
    const url = `http://127.0.0.1:${originPort}/resource`;
    process.env.GARUPA_PROXY_URL = `http://user:pass@127.0.0.1:${proxyPort}`;
    assert.equal(Buffer.from((await networkGet(url)).data).toString(), 'origin bytes');
    process.env.GARUPA_PROXY_URL = '';
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    await networkGet(url);
    process.env.NO_PROXY = '127.0.0.1';
    await networkGet(url);
    process.env.NO_PROXY = '';
    process.env.GARUPA_PROXY_URL = 'direct';
    await networkGet(url);
    assert.equal(forwarded, 2);
    process.env.GARUPA_PROXY_URL = `http://127.0.0.1:${proxyPort}`;
    assert.deepEqual(await downloadAsset(`http://127.0.0.1:${originPort}/bundle`), bytes);
    assert.equal(forwarded, 10);
});

test('real SOCKS5h proxy resolves the destination through the proxy and forwards bytes', async t => {
    env(t, { GARUPA_PROXY_URL: '' });
    const origin = http.createServer((_req, res) => res.end('socks bytes'));
    const originPort = await listen(t, origin);
    let destination = '';
    const proxy = net.createServer(socket => {
        let phase = 0;
        let pending = Buffer.alloc(0);
        const receive = (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            if (phase === 0) {
                if (pending.length < 2 || pending.length < 2 + pending[1]) return;
                assert.equal(pending[0], 5);
                pending = pending.subarray(2 + pending[1]);
                socket.write(Buffer.from([5, 0]));
                phase = 1;
            }
            if (phase === 1) {
                if (pending.length < 5 || pending.length < 7 + pending[4]) return;
                assert.equal(pending[3], 3, 'socks5h must send the hostname to the proxy');
                destination = pending.subarray(5, 5 + pending[4]).toString();
                assert.equal(pending.readUInt16BE(5 + pending[4]), originPort);
                const remainder = pending.subarray(7 + pending[4]);
                phase = 2;
                socket.removeListener('data', receive);
                const upstream = net.connect(originPort, '127.0.0.1', () => {
                    socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                    if (remainder.length) upstream.write(remainder);
                    socket.pipe(upstream); upstream.pipe(socket);
                });
                socket.on('close', () => upstream.destroy());
                upstream.on('error', () => socket.destroy());
            }
        };
        socket.on('data', receive);
    });
    const proxyPort = await listen(t, proxy);
    process.env.GARUPA_PROXY_URL = `socks5h://127.0.0.1:${proxyPort}`;
    const result = await networkGet(`http://proxy-resolved.invalid:${originPort}/`);
    assert.equal(Buffer.from(result.data).toString(), 'socks bytes');
    assert.equal(destination, 'proxy-resolved.invalid');
});
