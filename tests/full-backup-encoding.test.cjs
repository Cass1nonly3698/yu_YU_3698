const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const backup = require('../assets/js/full-backup.js');
const fixture = require('./fixtures/full-backup-fixture.js');
const PASSWORD = 'synthetic-encoding-password';
const options = () => ({ indexedDB: new IDBFactory(), crypto: webcrypto, localStorage: { getItem: () => null }, locks: { request: (_, o, fn) => fn({}) } });
async function sealed(packed) {
    const salt = webcrypto.getRandomValues(new Uint8Array(16)), iv = webcrypto.getRandomValues(new Uint8Array(12));
    const e = { format: 'RP-Hub encrypted backup', version: 1, kind: 'backup', iterations: 600000, salt: Buffer.from(salt).toString('base64'), iv: Buffer.from(iv).toString('base64') };
    const material = await webcrypto.subtle.importKey('raw', Buffer.from(PASSWORD), 'PBKDF2', false, ['deriveKey']);
    const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: e.iterations, salt }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const additionalData = Buffer.from(JSON.stringify([e.format, e.version, e.kind, e.iterations, e.salt, e.iv]));
    const cipher = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, Buffer.from(JSON.stringify(packed)));
    return JSON.stringify({ ...e, cipher: Buffer.from(cipher).toString('base64') });
}
test('linear Base64 decoder preserves all byte values, short lengths and padding forms', () => {
    for (let length = 0; length <= 1024; length++) {
        const data = Buffer.from(Array.from({ length }, (_, i) => i % 256));
        assert.deepEqual(Buffer.from(backup.unpack(['buffer', data.toString('base64')])), data);
    }
});
test('invalid alphabet, Unicode, whitespace, embedded or excess padding and incomplete quartets are rejected', () => {
    for (const value of ['=', 'A', 'AAA', '====', 'AA=A', 'A===', 'AAA=AAAA', 'AAAA\n', 'AA\rA', 'AA A', 'AA-A', 'AA_A', 'AAéA', 'AA😀', null, 3])
        assert.throws(() => backup.unpack(['buffer', value]), error => error.code === 'FORMAT' && error.message.includes('BUFFER_BYTES'));
    assert.deepEqual(Buffer.from(backup.unpack(['buffer', 'AB=='])), Buffer.from('AB==', 'base64')); // Legacy accepted form remains readable.
});
test('20 MiB of valid Base64 bytes decode without a long-string RegExp or atob intermediary', () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024, 219);
    assert.deepEqual(Buffer.from(backup.unpack(['buffer', bytes.toString('base64')])), bytes);
});
test('outer salt, IV and cipher report different fixed stage labels without private values', async () => {
    const api = backup.create(options()), file = await api.backup(PASSWORD);
    for (const [field, stage] of [['salt', 'OUTER_SALT'], ['iv', 'OUTER_IV'], ['cipher', 'OUTER_CIPHER']]) {
        const e = JSON.parse(file.text); e[field] = 'SYNTHETIC-PRIVATE-CANARY!';
        await assert.rejects(api.decrypt(JSON.stringify(e), PASSWORD), error => error.code === 'FORMAT' && error.message.includes(stage) && !error.message.includes('CANARY'));
    }
});
test('authenticated plaintext vector and typed-byte errors retain their own stage', async () => {
    const data = fixture(), api = backup.create(options());
    data.records.find(r => r.key === 'rp_hub_classic_memories_char-a').value[0].embeddingQ = '!!!!';
    const archive = { formatVersion: 1, snapshotId: 'synthetic', createdAt: 1, sourceVersion: 'ab7500d', data, digest: 'unused-before-validation' };
    await assert.rejects(api.decrypt(await sealed(backup.pack(archive)), PASSWORD), error => error.code === 'FORMAT' && error.message.includes('MEMORY_VECTOR'));
    const packed = backup.pack({ ...archive, data: fixture() });
    function corrupt(node) { if (!Array.isArray(node)) return false; if (node[0] === 'typed') { node[2] = '!!!!'; return true; } return node.some(corrupt); }
    assert.equal(corrupt(packed), true);
    await assert.rejects(api.decrypt(await sealed(packed), PASSWORD), error => error.code === 'FORMAT' && error.message.includes('TYPED_BYTES'));
});
test('valid Base64 tampering still fails GCM authentication; authenticated wrong digest still fails integrity', async () => {
    const api = backup.create(options()), file = await api.backup(PASSWORD), e = JSON.parse(file.text);
    e.cipher = (e.cipher[0] === 'A' ? 'B' : 'A') + e.cipher.slice(1);
    await assert.rejects(api.decrypt(JSON.stringify(e), PASSWORD), error => error.code === 'DECRYPT' && error.message.includes('GCM_AUTH'));
    const archive = await api.decrypt(file.text, PASSWORD); archive.digest = 'synthetic-wrong-digest';
    await assert.rejects(api.decrypt(await sealed(backup.pack(archive)), PASSWORD), error => error.code === 'INTEGRITY' && error.message.includes('CONTENT_DIGEST'));
});
test('newly exported version-1 bytes remain readable by the unchanged ab7500d reader', async () => {
    const legacy = new Module('synthetic-legacy-reader');
    legacy._compile(execFileSync('git', ['show', 'ab7500d:assets/js/full-backup.js'], { cwd: __dirname, encoding: 'utf8' }), 'synthetic-legacy-reader.cjs');
    const current = backup.create(options()), exported = await current.backup(PASSWORD);
    const old = await legacy.exports.create(options()).decrypt(exported.text, PASSWORD);
    assert.equal(old.digest, (await current.decrypt(exported.text, PASSWORD)).digest);
});
