/* Fresh, non-persistent browser contexts; all requests fulfilled from local files or blocked. */
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const out = process.env.RP_HUB_BACKUP_OUTPUT || path.join(root, 'test-results');
const origin = 'https://rphub-backup-test.invalid';
const cases = [], unexpected = [], blockedAssets = [], errors = [];
async function launch(mainApp = false) {
    const browser = await chromium.launch({ ...(process.env.RP_HUB_CHROMIUM ? { executablePath: process.env.RP_HUB_CHROMIUM } : {}), args: ['--single-process', '--no-zygote', '--disable-crash-reporter'] });
    const context = await browser.newContext({ viewport: { width: 1040, height: 1050 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN', acceptDownloads: true });
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
            if (mainApp) {
                const vendors = { 'https://unpkg.com/vue@3/dist/vue.global.prod.js': 'vue.js', 'https://cdn.jsdelivr.net/npm/marked/marked.min.js': 'marked.js', 'https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js': 'purify.js', 'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js': 'sortable.js' };
                if (vendors[url.href]) return route.fulfill({ contentType: 'application/javascript', body: await fs.readFile(path.join(process.env.RP_HUB_VENDOR_DIR, vendors[url.href])) });
                if (url.origin === 'https://cdn.tailwindcss.com') return route.fulfill({ contentType: 'application/javascript', body: 'window.tailwind={config:{}};' });
                if (/chat\/completions|embeddings|\/generate\b/.test(url.pathname)) unexpected.push(url.pathname);
                return route.fulfill({ contentType: 'application/json', body: '{}' });
            }
            if (['https://cdn.tailwindcss.com', 'https://unpkg.com', 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(url.origin) && route.request().method() === 'GET') blockedAssets.push(url.origin);
            else unexpected.push(url.origin);
            return route.fulfill({ status: 204 });
        }
        if (url.pathname === '/seed') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>SYNTHETIC ONLY</title>' });
        if (url.pathname === '/gate-test') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/assets/js/full-backup-gate.js"></script><body><script>RPHubBackupGate.start(()=>document.body.dataset.mounted="yes")</script></body>' });
        try {
            const filename = path.resolve(root, '.' + url.pathname);
            if (!filename.startsWith(root + path.sep)) throw new Error('invalid path');
            const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(filename)] || 'application/octet-stream';
            await route.fulfill({ contentType: type, body: await fs.readFile(filename) });
        } catch (_) { await route.fulfill({ status: 404, body: 'Not found' }); }
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    return { browser, context, page };
}
async function seed(page, conflict = false) {
    await page.goto(origin + '/seed');
    await page.addScriptTag({ path: path.join(__dirname, 'fixtures/full-backup-fixture.js') });
    await page.evaluate(async conflict => {
        const data = makeFullBackupFixture();
        if (conflict) { data.records.find(x => x.key === 'rp_hub_chat_char-a').value[0].content = '合成目标旧原文'; data.records.find(x => x.key === 'rp_hub_settings').value.apiKey = 'SYNTHETIC-OLD-KEY'; }
        const request = indexedDB.open('RPHubDB', 1);
        await new Promise((resolve, reject) => { request.onupgradeneeded = () => request.result.createObjectStore('store'); request.onsuccess = resolve; request.onerror = reject; });
        const db = request.result;
        await new Promise((resolve, reject) => { const tx = db.transaction('store', 'readwrite'); data.records.forEach(x => tx.objectStore('store').put(x.value, x.key)); tx.oncomplete = resolve; tx.onerror = reject; }); db.close();
        data.local.forEach(x => localStorage.setItem(x.key, x.value));
        const r = indexedDB.open('HaishenPushTestV3', 1);
        await new Promise(resolve => { r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('notices', { keyPath: 'id' }); }; r.onsuccess = resolve; });
        await new Promise(resolve => { const tx = r.result.transaction(['kv', 'notices'], 'readwrite'); tx.objectStore('kv').put({ deviceId: 'SYNTHETIC-PWA-DEVICE', token: 'SYNTHETIC-PWA-TOKEN', backend: 'https://push.offline.invalid' }, 'device'); tx.objectStore('kv').put('https://push.offline.invalid', 'backend'); tx.objectStore('notices').put({ id: 'synthetic-notice', body: '合成旧通知' }); tx.oncomplete = resolve; }); r.result.close();
    }, conflict);
}
const digest = page => page.evaluate(async () => { const a = RPHubFullBackup.create(); return a.fingerprint(await a.capture()); });
async function pushState(page) {
    return page.evaluate(async () => {
        const r = indexedDB.open('HaishenPushTestV3'); await new Promise(resolve => { r.onsuccess = resolve; });
        const db = r.result, result = {};
        for (const name of ['kv', 'notices']) result[name] = await new Promise(resolve => { const tx = db.transaction(name, 'readonly'), q = tx.objectStore(name).getAll(); tx.oncomplete = () => resolve(q.result); });
        db.close(); return { data: result, permission: Notification.permission, registrations: (await navigator.serviceWorker.getRegistrations()).length };
    });
}
async function fileSelect(page, buffer) { await page.locator('#backup-file').setInputFiles({ name: 'synthetic.rphub', mimeType: 'application/json', buffer }); }
async function preflightUI(page, buffer, password = 'synthetic-backup-password') {
    await page.locator('#restore-tab').click(); await fileSelect(page, buffer); await page.locator('#restore-password').fill(password); await page.locator('#preflight').click();
}
async function run() {
    await fs.mkdir(out, { recursive: true });
    let env = await launch(), buffer, sourceDigest;
    try {
        await seed(env.page); await env.page.goto(origin + '/full-backup.html'); await env.page.locator('#export-button').waitFor();
        sourceDigest = await digest(env.page);
        await env.page.screenshot({ path: path.join(out, '01-full-backup-export.png'), fullPage: true });
        await env.page.locator('#export-password').fill('synthetic-backup-password'); await env.page.locator('#export-confirm').fill('synthetic-backup-password');
        const downloadPromise = env.page.waitForEvent('download'); await env.page.locator('#export-button').click(); const download = await downloadPromise;
        buffer = await fs.readFile(await download.path()); assert.equal(buffer.includes(Buffer.from('SYNTHETIC-PRIVATE-CANARY')), false);
        await env.page.locator('#status').filter({ hasText: '加密文件已生成' }).waitFor(); assert.equal(await env.page.locator('#export-password').inputValue(), '');
        cases.push('真实浏览器生成单一加密文件，包含全部合成数据且清除密码输入');
    } finally { await env.browser.close(); }
    env = await launch(); const page = env.page;
    try {
        await seed(page, true); await page.goto(origin + '/full-backup.html'); const before = await digest(page), protectedBefore = await pushState(page);
        await preflightUI(page, buffer, 'synthetic-wrong-password'); await page.locator('#status').filter({ hasText: '密码错误或文件已损坏' }).waitFor(); assert.equal(await digest(page), before);
        cases.push('错误密码只显示安全错误，目标数据不变');
        await preflightUI(page, buffer.subarray(0, buffer.length - 10)); await page.locator('#status').filter({ hasText: '文件损坏' }).waitFor(); assert.equal(await digest(page), before);
        cases.push('文件损坏不能进入恢复确认');
        await preflightUI(page, buffer); await page.locator('#preview').waitFor(); assert.equal(await digest(page), before);
        assert.ok((await page.locator('#change-summary').textContent()).includes('2 项')); assert.equal(await page.locator('#restore-button').isDisabled(), true);
        await page.screenshot({ path: path.join(out, '02-full-backup-preflight.png'), fullPage: true });
        cases.push('预检展示数量与冲突，确认前不写资料');
        await page.locator('#confirm-restore').check(); await page.locator('#restore-button').click(); await page.locator('#status').filter({ hasText: '完整性验证通过' }).waitFor();
        assert.equal(await digest(page), sourceDigest); assert.deepEqual(await pushState(page), protectedBefore);
        cases.push('确认后全部数据、来源及向量一致，推送库和权限/注册状态不变');
        await preflightUI(page, buffer); await page.locator('#preview').waitFor(); assert.ok((await page.locator('#change-summary').textContent()).startsWith('0 项'));
        await page.locator('#confirm-restore').check(); await page.locator('#restore-button').click(); await page.locator('#status').filter({ hasText: '资料已一致' }).waitFor();
        cases.push('重复导入显示一致且不重复写入');
        await page.setViewportSize({ width: 390, height: 844 }); await preflightUI(page, buffer); await page.locator('#preview').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(out, '03-full-backup-mobile.png'), fullPage: true });
        cases.push('手机宽度无横向溢出，数量/确认可见');
        // Run the real storage engine with an injected crash, then test the production UI/gate after navigation.
        await page.evaluate(async text => {
            const api = RPHubFullBackup.create({ failpoint(name) { if (name === 'after-main') throw Object.assign(new Error('synthetic interruption'), { code: 'SIMULATED_CRASH' }); } });
            const r = indexedDB.open('RPHubDB'); await new Promise(resolve => { r.onsuccess = resolve; });
            await new Promise(resolve => { const tx = r.result.transaction('store', 'readwrite'); tx.objectStore('store').put({ apiKey: 'SYNTHETIC-BEFORE-RECOVERY' }, 'rp_hub_settings'); tx.oncomplete = resolve; }); r.result.close();
            const archive = await api.decrypt(text, 'synthetic-backup-password'), plan = await api.preflight(archive);
            try { await api.restore(plan, 'synthetic-backup-password', { planDigest: plan.planDigest, replaceConflicts: true }); } catch (e) { if (e.code !== 'SIMULATED_CRASH') throw e; }
        }, buffer.toString());
        await page.goto(origin + '/index.html'); await page.waitForURL('**/full-backup.html?recovery=1'); await page.locator('#recovery').waitFor();
        assert.equal(await page.evaluate(() => !!window.RPHubStorage), false);
        await page.screenshot({ path: path.join(out, '04-full-backup-recovery.png'), fullPage: true });
        await page.locator('#recovery-password').fill('synthetic-wrong-password'); await page.locator('#resume').click(); await page.locator('#status').filter({ hasText: '密码错误或文件已损坏' }).waitFor();
        assert.equal(await page.locator('#recovery').isVisible(), true);
        cases.push('中断恢复输入错误密码仍保留加密记录和恢复入口');
        await page.locator('#recovery-password').fill('synthetic-backup-password'); await page.locator('#resume').click(); await page.locator('#status').filter({ hasText: '恢复与逐项核对已完成' }).waitFor();
        assert.equal(await digest(page), sourceDigest); assert.deepEqual(await pushState(page), protectedBefore);
        cases.push('中断后主线初始化被阻止，原密码可继续恢复并验证');
        const other = await env.context.newPage(); await other.goto(origin + '/gate-test'); await other.waitForFunction(() => document.body.dataset.mounted === 'yes');
        await preflightUI(page, buffer); await page.locator('#status').filter({ hasText: '关闭其他新家窗口' }).waitFor(); await other.close();
        cases.push('实际 Web Locks 阻止另一新家窗口打开时恢复');
        assert.deepEqual(await pushState(page), protectedBefore);
        const beforeRollback = await page.evaluate(async text => {
            const r = indexedDB.open('RPHubDB'); await new Promise(resolve => { r.onsuccess = resolve; });
            await new Promise(resolve => { const tx = r.result.transaction('store', 'readwrite'); tx.objectStore('store').put({ apiKey: 'SYNTHETIC-ROLLBACK-TARGET' }, 'rp_hub_settings'); tx.oncomplete = resolve; }); r.result.close();
            const api = RPHubFullBackup.create({ failpoint(name) { if (name === 'after-local') throw Object.assign(new Error('synthetic crash'), { code: 'SIMULATED_CRASH' }); } });
            const before = await api.fingerprint(await api.capture()), a = await api.decrypt(text, 'synthetic-backup-password'), p = await api.preflight(a);
            try { await api.restore(p, 'synthetic-backup-password', { planDigest: p.planDigest, replaceConflicts: true }); } catch (e) { if (e.code !== 'SIMULATED_CRASH') throw e; }
            return before;
        }, buffer.toString());
        await page.reload(); await page.locator('#recovery').waitFor(); await page.locator('#recovery-password').fill('synthetic-backup-password'); await page.locator('#rollback').click();
        await page.locator('#status').filter({ hasText: '已回退并核对恢复前资料' }).waitFor(); assert.equal(await digest(page), beforeRollback);
        assert.deepEqual(await pushState(page), protectedBefore); cases.push('浏览器恢复中断后可从界面回退，资料与推送身份均核对一致');
    } finally { await env.browser.close(); }
    if (process.env.RP_HUB_VENDOR_DIR) {
        env = await launch(true);
        try {
            await seed(env.page); await env.page.goto(origin + '/index.html');
            await env.page.waitForFunction(() => {
                const app = document.querySelector('#app')?.__vue_app__?._container?._vnode?.component?.proxy;
                return app?.currentCharacter?.uuid === 'char-a' && app.chatHistory?.length === 2
                    && app.switchingCharacterIndex === -1 && app.memoryStats?.activeTotal > 0;
            });
            await env.page.evaluate(() => { document.querySelector('#app').__vue_app__._container._vnode.component.proxy.currentView = 'settings'; });
            const entry = env.page.getByRole('button', { name: '完整备份与恢复 · 本地加密', exact: true }); await entry.waitFor();
            await env.page.evaluate(() => {
                const db = RPHubStorage.getMainDb(), transaction = db.transaction;
                db.transaction = function (...args) {
                    if (args[1] === 'readonly') { delete db.transaction; throw new Error('synthetic verification failure'); }
                    return transaction.apply(this, args);
                };
            });
            await entry.click();
            await env.page.getByText('保存核对失败，已取消进入完整备份，请保留当前页面并重试', { exact: true }).waitFor();
            assert.equal(new URL(env.page.url()).pathname, '/index.html');
            cases.push('设置入口保存核对失败时保留当前页面，不带着未核对资料跳转');
            await entry.click();
            await env.page.waitForURL('**/full-backup.html'); await env.page.locator('#export-button').waitFor();
            const stats = await env.page.evaluate(async () => { const api = RPHubFullBackup.create(); return RPHubFullBackup.counts(await api.capture()); });
            assert.equal(stats.characters, 2); assert.equal(stats.messages, 4); assert.equal(stats.vectors, 4);
            const download = env.page.waitForEvent('download'); await env.page.locator('#export-password').fill('synthetic-backup-password'); await env.page.locator('#export-confirm').fill('synthetic-backup-password'); await env.page.locator('#export-button').click(); await download;
            cases.push('实际新家设置入口可保存合成数据、进入工具并释放主线锁，完整导出成功');
        } finally { await env.browser.close(); }
    }
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    const result = { syntheticOnly: true, realUserDataAccessed: false, realNetworkRequests: 0, blockedSpeculativeAssetRequests: blockedAssets.length, paidModelOrVectorRequests: 0, passed: cases.length, cases, browser: 'Chromium / isolated non-persistent context', mobile: '390×844 emulation, not iPhone hardware' };
    await fs.writeFile(path.join(out, 'browser-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; });
