const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { IDBFactory, IDBObjectStore } = require('fake-indexeddb');
const backup = require('../assets/js/full-backup.js');
const fixture = require('./fixtures/full-backup-fixture.js');
const PASSWORD = 'synthetic-backup-password';
const pendingKey = backup.constants.PENDING;
function environment() {
    const idb = new IDBFactory(), entries = new Map(), state = { busy: false, failpoint: null, quota: 1e10, lsFail: null }, opened = [];
    const originalOpen = idb.open.bind(idb); idb.open = (...args) => { opened.push(args[0]); return originalOpen(...args); };
    const storage = { getItem: k => entries.has(k) ? entries.get(k) : null,
        setItem(k, v) { if (state.lsFail?.(k)) throw new DOMException('synthetic quota', 'QuotaExceededError'); entries.set(k, String(v)); },
        removeItem(k) { entries.delete(k); } };
    const options = { indexedDB: idb, localStorage: storage, crypto: webcrypto,
        locks: { request: async (_, options, fn) => { if (state.busy) return fn(null); state.busy = true; try { return await fn({}); } finally { state.busy = false; } } },
        estimate: async () => ({ quota: state.quota, usage: 0 }), failpoint: async name => state.failpoint?.(name) };
    return { idb, storage, entries, state, opened, options, api: backup.create(options) };
}
async function seed(env, data = fixture(), name = 'RPHubDB') {
    await new Promise((resolve, reject) => {
        const r = env.idb.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('store');
        r.onsuccess = () => { const db = r.result, tx = db.transaction('store', 'readwrite'); data.records.forEach(x => tx.objectStore('store').put(x.value, x.key)); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; r.onerror = () => reject(r.error);
    });
    data.local.forEach(x => env.storage.setItem(x.key, x.value));
}
async function write(env, key, value) {
    const db = await new Promise(resolve => { const r = env.idb.open('RPHubDB'); r.onsuccess = () => resolve(r.result); });
    await new Promise((resolve, reject) => { const tx = db.transaction('store', 'readwrite'); tx.objectStore('store').put(value, key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
}
const code = expected => e => e.code === expected;
let source, file, archive;
test('fixture contains every declared category; encrypted file round-trips every value and vector byte', async () => {
    source = environment(); await seed(source); const before = await source.api.capture();
    file = await source.api.backup(PASSWORD); archive = await source.api.decrypt(file.text, PASSWORD);
    assert.equal(await source.api.fingerprint(before), await source.api.fingerprint(archive.data));
    assert.equal(file.text.includes('SYNTHETIC-PRIVATE-CANARY'), false); assert.equal(file.text.includes('合成原文'), false);
    assert.deepEqual(backup.pack(before), backup.pack(archive.data));
    const stats = backup.counts(archive.data); assert.equal(stats.characters, 2); assert.equal(stats.messages, 4); assert.equal(stats.vectors, 4); assert.equal(stats.letters, 1);
    assert.equal(before.records.find(r => r.key === 'rp_hub_classic_memories_char-a').value[0].enabled, false);
});
test('independent exports use different random salts and nonces; password is never stored', async () => {
    const next = await source.api.backup(PASSWORD); assert.notEqual(file.text, next.text); assert.equal(next.text.includes(PASSWORD), false);
    assert.equal(source.entries.has(pendingKey), false);
});
test('wrong password causes no writes', async () => {
    const env = environment(), before = await env.api.fingerprint(await env.api.capture());
    await assert.rejects(env.api.decrypt(file.text, 'another-wrong-password'), code('DECRYPT'));
    assert.equal(await env.api.fingerprint(await env.api.capture()), before);
});
test('ciphertext corruption, truncation, unknown parameters and invalid encoding are rejected', async () => {
    const e = JSON.parse(file.text); e.cipher = (e.cipher[0] === 'A' ? 'B' : 'A') + e.cipher.slice(1);
    await assert.rejects(source.api.decrypt(JSON.stringify(e), PASSWORD), code('DECRYPT'));
    await assert.rejects(source.api.decrypt(file.text.slice(0, -30), PASSWORD), code('FORMAT'));
    e.version = 99; await assert.rejects(source.api.decrypt(JSON.stringify(e), PASSWORD), code('FORMAT'));
    e.version = 1; e.cipher = '!!'; await assert.rejects(source.api.decrypt(JSON.stringify(e), PASSWORD), code('FORMAT'));
});
test('unknown or protected keys and dangling memory references fail closed', async () => {
    const value = fixture(); value.records.push({ key: 'rp_hub_push_device', value: 'synthetic' });
    assert.throws(() => backup.validate(value), code('FORMAT'));
    const broken = fixture(); broken.records.find(x => x.key === 'rp_hub_classic_memories_char-a').value[0].sourceUserIds = ['missing-id'];
    assert.throws(() => backup.validate(broken), code('FORMAT'));
});
test('restore to empty application preserves all IDs, raw text, summaries, settings, UI state and vectors', async () => {
    const env = environment(), plan = await env.api.preflight(archive);
    const result = await env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest }); assert.equal(result.status, 'verified');
    assert.equal(await env.api.fingerprint(await env.api.capture()), archive.digest); assert.equal(env.api.pending(), null);
});
const settingsRow = data => data.records.find(row => row.key === 'rp_hub_settings').value;
const timePreference = { version: 1, mode: 'manual', ianaZone: 'Africa/Cairo' };
test('v1 round-trips three time modes and assistant display metadata without changing raw chat or exporting legacy-script mode', async () => {
    const modes = [{ version: 1, mode: 'beijing' }, { version: 1, mode: 'device' }, timePreference];
    for (const preference of modes) {
        const from = environment(), target = environment(), data = fixture();
        settingsRow(data).realTimePreference = preference;
        const messages = data.records.find(r => r.key === 'rp_hub_chat_char-a__branch__side').value;
        messages[1].realTimeDisplay = { version: 1, instant: Date.parse('2026-11-28T17:00:00Z'),
            zone: 'Africa/Cairo', offsetMinutes: 120, localMinute: '2026-11-28T19:00' };
        await seed(from, data);
        from.storage.setItem('rp_hub_real_time_external_v1', '1');
        target.storage.setItem('rp_hub_real_time_external_v1', 'target-local-only');
        const encrypted = await from.api.backup(PASSWORD);
        assert.equal(JSON.parse(encrypted.text).version, 1);
        const incoming = await target.api.decrypt(encrypted.text, PASSWORD);
        const plan = await target.api.preflight(incoming);
        assert.equal(plan.keepsTimePreference, false);
        await target.api.restore(plan, PASSWORD, { planDigest: plan.planDigest });
        assert.equal(await target.api.fingerprint(await target.api.capture()), await from.api.fingerprint(await from.api.capture()));
        assert.equal(target.storage.getItem('rp_hub_real_time_external_v1'), 'target-local-only');
    }
});

test('an encrypted old backup missing the preference preserves the target zone while restoring other settings', async () => {
    const target = environment(), data = fixture();
    settingsRow(data).realTimePreference = timePreference;
    settingsRow(data).fontSize = 12;
    target.storage.setItem('rp_hub_real_time_external_v1', '1');
    await seed(target, data);
    const plan = await target.api.preflight(archive);
    assert.equal(plan.keepsTimePreference, true);
    assert.ok(plan.changes.some(change => change.key === 'rp_hub_settings' && change.conflict));
    assert.equal(await target.api.fingerprint(await target.api.capture()), plan.targetDigest);
    await target.api.restore(plan, PASSWORD, { planDigest: plan.planDigest, replaceConflicts: true });
    const result = await target.api.capture();
    assert.deepEqual(settingsRow(result), { ...settingsRow(archive.data), realTimePreference: timePreference });
    assert.equal(await target.api.fingerprint(result), plan.afterDigest);
    assert.equal((await target.api.preflight(archive)).changes.length, 0);
    assert.equal(target.storage.getItem('rp_hub_real_time_external_v1'), '1');
});

test('an explicit new preference is a normal settings conflict and interrupted restore rolls it back', async () => {
    const from = environment(), target = environment(), sourceData = fixture(), targetData = fixture();
    settingsRow(sourceData).realTimePreference = { version: 1, mode: 'device' };
    settingsRow(targetData).realTimePreference = timePreference;
    await seed(from, sourceData);
    await seed(target, targetData);
    const plan = await target.api.preflight(await target.api.decrypt((await from.api.backup(PASSWORD)).text, PASSWORD));
    assert.equal(plan.keepsTimePreference, false);
    assert.ok(plan.changes.some(change => change.key === 'rp_hub_settings' && change.conflict));
    await assert.rejects(target.api.restore(plan, PASSWORD, { planDigest: plan.planDigest }), code('CONFIRM'));
    target.state.failpoint = stage => { if (stage === 'after-main') throw Object.assign(new Error('synthetic crash'), { code: 'SIMULATED_CRASH' }); };
    await assert.rejects(target.api.restore(plan, PASSWORD, { planDigest: plan.planDigest, replaceConflicts: true }), code('SIMULATED_CRASH'));
    assert.deepEqual(settingsRow(await target.api.capture()).realTimePreference, { version: 1, mode: 'device' });
    target.state.failpoint = null;
    assert.equal((await backup.create(target.options).recover(PASSWORD, 'rollback')).status, 'rolled-back');
    const data = await target.api.capture();
    assert.deepEqual(settingsRow(data).realTimePreference, timePreference);
    assert.equal(await target.api.fingerprint(data), plan.targetDigest);
});

test('a display-only chat difference in an older archive never clears existing summaries', async () => {
    const from = environment(), target = environment(), sourceData = fixture(), targetData = fixture();
    const chatKey = 'rp_hub_chat_char-a', memoryKey = 'rp_hub_classic_memories_char-a';
    sourceData.records = sourceData.records.filter(row => row.key !== memoryKey);
    targetData.records.find(row => row.key === chatKey).value[1].realTimeDisplay = {
        version: 1, instant: Date.parse('2026-11-28T12:00:00Z'), zone: 'Asia/Shanghai',
        offsetMinutes: 480, localMinute: '2026-11-28T20:00'
    };
    await seed(from, sourceData);
    await seed(target, targetData);
    const plan = await target.api.preflight(await target.api.decrypt((await from.api.backup(PASSWORD)).text, PASSWORD));
    assert.ok(plan.changes.some(change => change.key === chatKey && change.conflict));
    assert.equal(plan.changes.some(change => change.key === memoryKey), false);
    await target.api.restore(plan, PASSWORD, { planDigest: plan.planDigest, replaceConflicts: true });
    const restored = await target.api.capture();
    assert.deepEqual(restored.records.find(row => row.key === memoryKey).value, targetData.records.find(row => row.key === memoryKey).value);
});

test('same character card with newer backed-up chat is compared per record, not skipped', async () => {
    const env = environment(), target = fixture(); target.records.find(x => x.key === 'rp_hub_chat_char-a').value[0].content = '合成旧原文'; await seed(env, target);
    const plan = await env.api.preflight(archive); assert.ok(plan.changes.some(x => x.key === 'rp_hub_chat_char-a' && x.conflict));
    await assert.rejects(env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest }), code('CONFIRM'));
    await env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest, replaceConflicts: true });
    assert.equal(await env.api.fingerprint(await env.api.capture()), archive.digest);
});
test('repeated restore is a no-op and does not duplicate presets, memories or letters', async () => {
    const env = environment(); await seed(env); const plan = await env.api.preflight(archive); assert.equal(plan.changes.length, 0);
    assert.equal((await env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest })).status, 'unchanged');
    assert.equal(env.api.pending(), null); assert.equal(env.opened.includes('RPHubFullBackupJournal'), false);
});
test('stale preflight cannot overwrite edits made after preview', async () => {
    const env = environment(); await seed(env); const plan = await env.api.preflight(archive);
    await write(env, 'rp_hub_settings', { apiKey: 'SYNTHETIC-NEW-TARGET-KEY' });
    await assert.rejects(env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest, replaceConflicts: true }), code('STALE'));
});
test('capacity precheck fails before creating journal or changing data', async () => {
    const env = environment(), plan = await env.api.preflight(archive); env.state.quota = 1;
    await assert.rejects(env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest }), code('QUOTA'));
    assert.equal(env.api.pending(), null); assert.equal((await env.api.capture()).records.length, 0);
    await assert.rejects(env.api.preflight(archive), code('QUOTA'));
});
test('edited preview plan and unknown payload partitions cannot be confirmed', async () => {
    const env = environment(), plan = await env.api.preflight(archive); plan.changes = [];
    await assert.rejects(env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest, replaceConflicts: true }), code('INTEGRITY'));
    const data = fixture(); data.unknownPartition = []; assert.throws(() => backup.validate(data), code('FORMAT'));
});
test('a backed-up chat with no summaries explicitly clears stale dependent target summaries in preview', async () => {
    const source2 = environment(), data = fixture(); data.records = data.records.filter(r => r.key !== 'rp_hub_classic_memories_char-a');
    data.records.find(r => r.key === 'rp_hub_chat_char-a').value[0].id = 'new-user-id'; await seed(source2, data);
    const saved = await source2.api.backup(PASSWORD), a = await source2.api.decrypt(saved.text, PASSWORD);
    const env = environment(); await seed(env); const plan = await env.api.preflight(a);
    assert.ok(plan.changes.some(r => r.key === 'rp_hub_classic_memories_char-a' && r.conflict));
    await env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest, replaceConflicts: true });
    assert.deepEqual((await env.api.capture()).records.find(r => r.key === 'rp_hub_classic_memories_char-a').value, []);
});
test('mid-transaction quota failure aborts partial IDB writes and rolls back', async () => {
    const env = environment(), plan = await env.api.preflight(archive), original = IDBObjectStore.prototype.put; let writes = 0;
    IDBObjectStore.prototype.put = function (...args) { if (this.transaction.db.name === 'RPHubDB' && ++writes === 3) throw new DOMException('synthetic quota', 'QuotaExceededError'); return original.apply(this, args); };
    try { await assert.rejects(env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest }), code('ROLLED_BACK')); }
    finally { IDBObjectStore.prototype.put = original; }
    assert.equal((await env.api.capture()).records.length, 0); assert.equal(env.api.pending(), null);
});
test('localStorage failure after IDB commit rolls back both storage phases', async () => {
    const env = environment(), plan = await env.api.preflight(archive); let hit = false;
    env.state.lsFail = key => key === 'rp_hub_visual_cottage_v1' && !hit && (hit = true);
    await assert.rejects(env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest }), code('ROLLED_BACK'));
    assert.equal(await env.api.fingerprint(await env.api.capture()), plan.targetDigest); assert.equal(env.api.pending(), null);
});
async function interrupted(point = 'after-main') {
    const env = environment(), plan = await env.api.preflight(archive);
    env.state.failpoint = name => { if (name === point) throw Object.assign(new Error('synthetic crash'), { code: 'SIMULATED_CRASH' }); };
    await assert.rejects(env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest }), code('SIMULATED_CRASH'));
    env.state.failpoint = null; assert.ok(env.api.pending()); return { env, plan };
}
test('interruption after IDB commit persists encrypted recovery journal and resumes after fresh client creation', async () => {
    const { env } = await interrupted();
    const db = await new Promise(resolve => { const r = env.idb.open('RPHubFullBackupJournal'); r.onsuccess = () => resolve(r.result); });
    const rows = await new Promise(resolve => { const tx = db.transaction('jobs', 'readonly'), r = tx.objectStore('jobs').getAll(); tx.oncomplete = () => resolve(r.result); }); db.close();
    assert.equal(JSON.stringify(rows).includes('SYNTHETIC-PRIVATE-CANARY'), false);
    const rebooted = backup.create(env.options); assert.equal((await rebooted.recover(PASSWORD)).status, 'verified');
    assert.equal(await rebooted.fingerprint(await rebooted.capture()), archive.digest);
});
test('wrong recovery password leaves pending data and encrypted rollback intact', async () => {
    const { env } = await interrupted(); const before = await env.api.fingerprint(await env.api.capture());
    await assert.rejects(env.api.recover('wrong-recovery-password'), code('DECRYPT')); assert.ok(env.api.pending());
    assert.equal(await env.api.fingerprint(await env.api.capture()), before);
    await env.api.recover(PASSWORD, 'rollback');
});
test('interrupted restore supports verified rollback to exact prior application data', async () => {
    const { env, plan } = await interrupted('after-local');
    assert.equal((await env.api.recover(PASSWORD, 'rollback')).status, 'rolled-back');
    assert.equal(await env.api.fingerprint(await env.api.capture()), plan.targetDigest);
});
test('interruption after verification resumes idempotently without duplicate writes', async () => {
    const { env } = await interrupted('after-verify'); await env.api.recover(PASSWORD);
    assert.equal(await env.api.fingerprint(await env.api.capture()), archive.digest);
});
test('unexpected mutation during interruption blocks both resume and rollback', async () => {
    const { env } = await interrupted(); await write(env, 'rp_hub_settings', { apiKey: 'SYNTHETIC-CONCURRENT-CHANGE' });
    await assert.rejects(env.api.recover(PASSWORD), code('CHANGED')); await assert.rejects(env.api.recover(PASSWORD, 'rollback'), code('CHANGED')); assert.ok(env.api.pending());
});
test('unrelated target characters, branches and mailbox messages are retained', async () => {
    const env = environment(), target = fixture(); target.records.find(r => r.key === 'rp_hub_characters').value.push({ uuid: 'char-c', name: '目标独有合成角色' });
    target.records.find(r => r.key === 'rp_hub_mailbox_v2_char-a').value.push({ id: 'letter-target', content: '合成目标留言' }); await seed(env, target);
    const plan = await env.api.preflight(archive); await env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest, replaceConflicts: true });
    const data = await env.api.capture(); assert.equal(data.records.find(r => r.key === 'rp_hub_characters').value.length, 3); assert.equal(data.records.find(r => r.key === 'rp_hub_mailbox_v2_char-a').value.length, 2);
});
test('legacy fallback is read-only, primary wins, false/empty settings are preserved', async () => {
    const env = environment(), old = fixture(); old.records = old.records.map(r => ({ ...r, key: 'silly_tavern_' + r.key.slice(7) })); await seed(env, old, 'SillyTavernDB');
    const data = await env.api.capture(); assert.equal(data.records.find(r => r.key === 'rp_hub_settings').value.styleFilterEnabled, false);
    assert.equal((await env.idb.databases()).some(d => d.name === 'RPHubDB'), false);
    await env.api.backup(PASSWORD); assert.equal((await env.idb.databases()).some(d => d.name === 'RPHubDB'), false);
    const primary = fixture(); primary.records.find(r => r.key === 'rp_hub_settings').value.apiKey = 'SYNTHETIC-PRIMARY-WINS'; await seed(env, primary);
    assert.equal((await env.api.capture()).records.find(r => r.key === 'rp_hub_settings').value.apiKey, 'SYNTHETIC-PRIMARY-WINS');
});
test('push database and device authorization are never opened or written by the tool', async () => {
    const env = environment();
    await seed(env, { records: [{ key: 'device', value: { deviceId: 'SYNTHETIC-DEVICE', token: 'SYNTHETIC-PUSH-TOKEN', backend: 'https://push.offline.invalid' } }], local: [] }, 'HaishenPushTestV3');
    env.opened.length = 0; const plan = await env.api.preflight(archive); await env.api.restore(plan, PASSWORD, { planDigest: plan.planDigest });
    assert.equal(env.opened.includes('HaishenPushTestV3'), false);
    const export2 = await env.api.backup(PASSWORD); assert.equal(export2.text.includes('SYNTHETIC-PUSH-TOKEN'), false);
});
test('exclusive operation refuses another active application window', async () => {
    const env = environment(); env.state.busy = true;
    await assert.rejects(env.api.backup(PASSWORD), code('BUSY'));
});
test('tagged codec preserves typed bytes, undefined and literal prototype-like object keys', () => {
    const value = { bytes: new Uint8Array([0, 255, 123]), vector: new Float32Array([1, 0.25]), absent: undefined, nested: JSON.parse('{"__proto__":{"x":1},"constructor":"literal"}') };
    const decoded = backup.unpack(backup.pack(value)); assert.deepEqual(decoded, value); assert.equal({}.x, undefined);
    assert.throws(() => backup.unpack(['typed', '__proto__', 'AA==']), code('FORMAT'));
});
