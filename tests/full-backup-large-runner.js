/* Only served from a fresh localhost test origin. No user files, credentials or external requests. */
(function () {
    'use strict';
    if (!['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Synthetic runner requires localhost');
    const mib = Number(new URL(location.href).searchParams.get('mib') || 20);
    if (![20, 30, 50].includes(mib)) throw new Error('Unsupported synthetic size');
    const $ = id => document.getElementById(id), password = 'synthetic-large-backup-password';
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const result = { payloadMiB: mib, userAgent: navigator.userAgent, secureContext: isSecureContext, syntheticOnly: true, paidApiRequests: 0, stages: [] };
    async function log(stage) { result.stages.push(stage); $('progress').textContent = result.stages.join('\n'); await fetch('/qa-progress', { method: 'POST', body: JSON.stringify({ ...result, stage }) }); }
    async function open(name, store = 'store') {
        const r = indexedDB.open(name, 1); return new Promise((resolve, reject) => { r.onupgradeneeded = () => r.result.createObjectStore(store); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    }
    async function eraseMain() {
        await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('RPHubDB'); r.onsuccess = resolve; r.onerror = reject; r.onblocked = () => reject(new Error('Synthetic database blocked')); });
        for (const key of ['rphub-appearance', 'rp_hub_visual_cottage_v1', 'rp_hub_proactive_config_v1']) localStorage.removeItem(key);
    }
    $('cleanup').onclick = async () => {
        await eraseMain();
        for (const name of ['RPHubFullBackupJournal', 'HaishenPushTestV3']) await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = resolve; r.onerror = reject; });
        localStorage.removeItem('rp_hub_full_backup_pending_v1');
        $('progress').textContent = '仅本次 localhost 测试来源的合成数据已清理';
    };
    $('run').onclick = async () => {
        $('run').disabled = true; const start = performance.now();
        try {
            await eraseMain();
            await log('开始：' + mib + ' MiB 合成正文');
            let fixture = makeFullBackupFixture();
            fixture.records.find(r => r.key === 'rp_hub_chat_char-a').value[1].content = 'SYNTHETIC-LARGE-BODY|'.repeat(Math.ceil(mib * 1048576 / 21)).slice(0, mib * 1048576);
            const db = await open('RPHubDB');
            await new Promise((resolve, reject) => { const tx = db.transaction('store', 'readwrite'); fixture.records.forEach(r => tx.objectStore('store').put(r.value, r.key)); tx.oncomplete = resolve; tx.onerror = reject; }); db.close();
            fixture.local.forEach(r => localStorage.setItem(r.key, r.value)); fixture = null;
            const pushDb = await open('HaishenPushTestV3', 'kv');
            await new Promise(resolve => { const tx = pushDb.transaction('kv', 'readwrite'); tx.objectStore('kv').put('SYNTHETIC-PROTECTED-DEVICE', 'device'); tx.oncomplete = resolve; }); pushDb.close();
            await log('旧版原样导出');
            let legacy = await LegacyFullBackup.create().backup(password);
            result.legacyFileBytes = new Blob([legacy.text]).size;
            result.legacySha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacy.text))), b => b.toString(16).padStart(2, '0')).join('');
            result.cipherCharacters = JSON.parse(legacy.text).cipher.length;
            const legacyBlob = new Blob([legacy.text], { type: 'application/json' });
            $('download').href = URL.createObjectURL(legacyBlob); $('download').download = 'synthetic-legacy-' + mib + '.rphub'; $('download').hidden = false;
            try { await LegacyFullBackup.create().decrypt(legacy.text, password); result.legacyReader = 'unexpected-success'; }
            catch (error) { result.legacyReader = { name: error.name, code: error.code || null, message: error.message.slice(0, 120) }; }
            await log('新版本解密旧格式，模拟 .rphub.json 及改名');
            const api = RPHubFullBackup.create();
            let archive;
            for (const name of ['renamed-backup.rphub.json', 'original-download.rphub']) {
                const file = new File([legacyBlob], name, { type: name.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
                archive = await api.decrypt(await file.text(), password);
                assert(archive.digest === await api.fingerprint(await api.capture()), 'Source digest differs after filename/MIME roundtrip');
            }
            legacy = null;
            await eraseMain();
            await log('空目标预检、保存加密日志、恢复和完整性核对');
            let plan = await api.preflight(archive);
            const restored = await api.restore(plan, password, { planDigest: plan.planDigest, replaceConflicts: true });
            assert(restored.status === 'verified' && await api.fingerprint(await api.capture()) === archive.digest, 'Restored data mismatch');
            result.counts = restored.counts;
            plan = await api.preflight(archive);
            assert((await api.restore(plan, password, { planDigest: plan.planDigest, replaceConflicts: true })).status === 'unchanged', 'Repeated restore not deduplicated');
            await log('新版本再次导出并解密、认证失败不写入');
            const exported = await api.backup(password);
            assert((await api.decrypt(exported.text, password)).digest === archive.digest, 'New export mismatch');
            const bad = JSON.parse(exported.text); bad.cipher = (bad.cipher[0] === 'A' ? 'B' : 'A') + bad.cipher.slice(1);
            try { await api.decrypt(JSON.stringify(bad), password); throw new Error('Tampered ciphertext accepted'); }
            catch (error) { assert(error.code === 'DECRYPT' && error.message.includes('GCM_AUTH'), 'Tamper rejected at wrong stage'); }
            try { await api.decrypt(exported.text, 'synthetic-wrong-password'); throw new Error('Wrong password accepted'); }
            catch (error) { assert(error.code === 'DECRYPT', 'Wrong password rejected at wrong stage'); }
            assert(await api.fingerprint(await api.capture()) === archive.digest && !api.pending(), 'Verification mutated restored data');
            const push = await open('HaishenPushTestV3', 'kv');
            const device = await new Promise(resolve => { const r = push.transaction('kv').objectStore('kv').get('device'); r.onsuccess = () => resolve(r.result); }); push.close();
            assert(device === 'SYNTHETIC-PROTECTED-DEVICE', 'Push identity changed');
            result.pass = true; result.elapsedMs = Math.round(performance.now() - start);
        } catch (error) { result.pass = false; result.error = { name: error.name, message: error.message.slice(0, 300) }; }
        $('result').textContent = JSON.stringify(result, null, 2);
        await fetch('/qa-result', { method: 'POST', body: JSON.stringify(result) });
    };
})();
