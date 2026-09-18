import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientVersionResolver } from '../src/garupa/clientVersion.js';
import { DEFAULT_CLIENT_VERSION } from '../src/garupa/config.js';

test('refreshes the client version after expiry and shares concurrent lookups', async () => {
    let time = 0, calls = 0;
    const resolve = createClientVersionResolver(async () => ++calls === 1 ? '10.1.4' : '10.1.5', () => time, {});
    assert.deepEqual(await Promise.all([resolve(), resolve()]), ['10.1.4', '10.1.4']);
    assert.equal(calls, 1);
    time = 299_999;
    assert.equal(await resolve(), '10.1.4');
    assert.equal(calls, 1);
    time = 300_000;
    assert.equal(await resolve(), '10.1.5');
    assert.equal(calls, 2);
});

test('failed refresh retains the successful version and backs off before retrying', async () => {
    let time = 0, calls = 0;
    const resolve = createClientVersionResolver(async () => {
        calls++;
        if (calls === 2) throw new Error('offline');
        return calls === 1 ? '10.1.5' : '10.1.6';
    }, () => time, { GARUPA_CLIENT_VERSION_DEFAULT: '10.1.0' });
    assert.equal(await resolve(), '10.1.5');
    time = 300_000;
    assert.equal(await resolve(), '10.1.5');
    time = 359_999;
    assert.equal(await resolve(), '10.1.5');
    assert.equal(calls, 2);
    time = 360_000;
    assert.equal(await resolve(), '10.1.6');
});

test('forced version skips lookup; initial failures use configured or built-in fallback', async () => {
    let calls = 0;
    const lookup = async () => { calls++; throw new Error('offline'); };
    const env = { GARUPA_CLIENT_VERSION_FORCE: '9.4.0', GARUPA_CLIENT_VERSION_DEFAULT: '10.1.3' };
    const resolve = createClientVersionResolver(lookup, () => 0, env);
    assert.equal(await resolve(), '9.4.0');
    assert.equal(calls, 0);
    delete env.GARUPA_CLIENT_VERSION_FORCE;
    assert.equal(await resolve(), '10.1.3');
    assert.equal(await createClientVersionResolver(lookup, () => 0, {})(), DEFAULT_CLIENT_VERSION);
});
