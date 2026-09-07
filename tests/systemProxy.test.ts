import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClientRequest } from 'node:http';
import { createProxyResolver } from '../src/network.js';
import { createSystemProxyReader, matchesNoProxy, parseMacProxy, proxyFromSystemSettings } from '../src/systemProxy.js';

const configuration = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : localhost
    3 : *.local
    4 : <local>
    5 : fd00::/8
  }
  HTTPEnable : 1
  HTTPPort : 7896
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7898
  SOCKSProxy : 127.0.0.1
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPSPort : 9999
    }
  }
}`;

test('macOS effective HTTP/HTTPS settings, exceptions, CIDR and SOCKS fallback', () => {
    const settings = parseMacProxy(configuration);
    assert.equal(proxyFromSystemSettings('http://example.com/', settings), 'http://127.0.0.1:7896/');
    assert.equal(proxyFromSystemSettings('https://example.com/', settings), 'http://127.0.0.1:7897/');
    for (const host of ['127.0.0.1', 'localhost', '192.168.3.5', 'printer.local', 'printer', '[fd00::1]']) {
        assert.equal(proxyFromSystemSettings(`https://${host}/`, settings), '', host);
    }
    assert.ok(proxyFromSystemSettings('https://192.169.3.5/', settings));
    settings.values.HTTPSEnable = '0';
    assert.equal(proxyFromSystemSettings('https://example.com/', settings), 'socks5h://127.0.0.1:7898');
    settings.values.SOCKSEnable = '0';
    assert.equal(proxyFromSystemSettings('https://example.com/', settings), '');
    assert.equal(proxyFromSystemSettings('https://example.com/', parseMacProxy('<dictionary> {\n}')), '');
});

test('system PAC and IPv6 proxy endpoints are supported; invalid enabled ports reject', () => {
    const settings = parseMacProxy(configuration);
    settings.values.HTTPSProxy = '::1';
    assert.equal(proxyFromSystemSettings('https://example.com/', settings), 'http://[::1]:7897/');
    settings.values.HTTPSPort = '0';
    assert.throws(() => proxyFromSystemSettings('https://example.com/', settings), /端口无效/);
    settings.values.ProxyAutoConfigEnable = '1';
    settings.values.ProxyAutoConfigURLString = 'http://127.0.0.1/proxy.pac';
    assert.equal(proxyFromSystemSettings('https://example.com/', settings), 'pac+http://127.0.0.1/proxy.pac');
    assert.equal(proxyFromSystemSettings('http://localhost/', settings), '');
});

test('NO_PROXY matches ports, suffixes and IPv6 without bypassing unrelated hosts', () => {
    for (const [url, rule] of [
        ['https://example.com', '*'], ['https://example.com', 'example.com:443'],
        ['https://api.example.com', '.example.com'], ['http://[::1]:8080', '[::1]:8080'],
    ]) assert.equal(matchesNoProxy(url, rule), true);
    assert.equal(matchesNoProxy('https://example.com', 'example.com:80'), false);
    assert.equal(matchesNoProxy('https://notexample.com', '.example.com'), false);
});

test('proxy priority: explicit/direct, environment, NO_PROXY, then system', async () => {
    const env: NodeJS.ProcessEnv = { GARUPA_PROXY_URL: 'http://127.0.0.1:8000' };
    let environmentReads = 0, systemReads = 0, inherited = 'http://127.0.0.1:8001';
    const resolve = createProxyResolver(() => { environmentReads++; return inherited; },
        async () => { systemReads++; return 'http://127.0.0.1:7897'; }, env);
    const get = () => resolve('https://example.com', {} as ClientRequest);
    assert.equal(await get(), 'http://127.0.0.1:8000');
    env.GARUPA_PROXY_URL = 'direct';
    assert.equal(await get(), '');
    assert.equal(environmentReads, 0); assert.equal(systemReads, 0);
    env.GARUPA_PROXY_URL = '  ';
    assert.equal(await get(), inherited); assert.equal(systemReads, 0);
    inherited = '';
    env.NO_PROXY = 'example.com';
    assert.equal(await get(), ''); assert.equal(systemReads, 0);
    env.NO_PROXY = '';
    assert.equal(await get(), 'http://127.0.0.1:7897'); assert.equal(systemReads, 1);
});

test('system lookup coalesces concurrent reads, caches for 30 seconds, and refreshes', async () => {
    let calls = 0, now = 0;
    const read = createSystemProxyReader(async () => { calls++; return configuration; }, 'darwin', () => now);
    const values = await Promise.all([read(), read(), read()]);
    assert.equal(calls, 1); assert.deepEqual(values[0], values[1]);
    now = 29_999; await read(); assert.equal(calls, 1);
    now = 30_000; await read(); assert.equal(calls, 2);
    const unsupported = createSystemProxyReader(async () => { throw new Error('must not execute'); }, 'linux');
    assert.deepEqual(await unsupported(), { values: {}, exceptions: [] });
});
