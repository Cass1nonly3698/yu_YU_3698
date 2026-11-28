/* Isolated Chromium, synthetic chats, intercepted HTTP only. */
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { IDBFactory } = require('fake-indexeddb');
const Module = require('node:module');

const repo = path.resolve(__dirname, '..');
const out = process.env.RP_HUB_TIME_OUTPUT || path.join(repo, 'test-results/real-time');
const vendor = process.env.RP_HUB_VENDOR_DIR;
const origin = 'https://real-time-qa.invalid';
const vendors = {
    'https://unpkg.com/vue@3/dist/vue.global.prod.js': 'vue.js',
    'https://cdn.jsdelivr.net/npm/marked/marked.min.js': 'marked.js',
    'https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js': 'purify.js',
    'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js': 'sortable.js'
};
const mime = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp' };
const markerPattern = /<rphub_real_time_(?:user|system)>/g;
const placements = body => (JSON.stringify(body).match(markerPattern) || []).length;
const completion = (content, extra = {}) => ({ choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }] });

async function oldArchive() {
    const baseline = new Module('old-backup-for-synthetic-preview');
    baseline._compile(execFileSync('git', ['show', '9d06b27:assets/js/full-backup.js'], { cwd: repo, encoding: 'utf8' }), 'old-backup-for-synthetic-preview.cjs');
    const indexedDB = new IDBFactory();
    await new Promise((resolve, reject) => {
        const r = indexedDB.open('RPHubDB', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('store');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
            const tx = r.result.transaction('store', 'readwrite');
            tx.objectStore('store').put({ fontSize: 17 }, 'rp_hub_settings');
            tx.oncomplete = () => { r.result.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        };
    });
    return baseline.exports.create({ indexedDB, crypto: webcrypto, localStorage: { getItem: () => null },
        locks: { request: (_, __, run) => run({}) } }).backup('synthetic-old-preview-password');
}

async function main() {
    if (!vendor) throw new Error('Set RP_HUB_VENDOR_DIR to local Vue, Marked, DOMPurify and Sortable scripts');
    await fs.mkdir(out, { recursive: true });
    const browser = await chromium.launch({ ...(process.env.RP_HUB_CHROMIUM ? { executablePath: process.env.RP_HUB_CHROMIUM } : {}),
        args: ['--single-process', '--no-zygote', '--disable-crash-reporter'] });
    const sent = [], next = [], errors = [], cases = [], unexpected = [];
    let filteredStartupRequests = 0;
    try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York',
            locale: 'zh-CN', serviceWorkers: 'block' });
        const page = await context.newPage();
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (vendors[url.href]) return route.fulfill({ contentType: 'application/javascript', body: await fs.readFile(path.join(vendor, vendors[url.href])) });
            if (url.origin === 'https://cdn.tailwindcss.com') return route.fulfill({ contentType: 'application/javascript',
                body: process.env.RP_HUB_TAILWIND ? await fs.readFile(process.env.RP_HUB_TAILWIND) : 'window.tailwind={config:{}};' });
            if (url.origin !== origin) {
                const method = route.request().method();
                if (/\/chat\/completions|\/embeddings|\/generate\b/.test(url.pathname)
                    || (method === 'POST' && url.pathname !== '/api/api/getUser')) unexpected.push(url.pathname);
                filteredStartupRequests++;
                return route.fulfill({ status: 204 });
            }
            if (url.pathname === '/mock/v1/chat/completions') {
                sent.push(route.request().postDataJSON());
                const action = next.shift();
                if (!action) { unexpected.push('unstaged model call'); return route.fulfill({ status: 500 }); }
                if (typeof action === 'function') return action(route);
                return route.fulfill({ json: action });
            }
            if (url.pathname === '/mock/v1/models') return route.fulfill({ json: { data: [{ id: 'synthetic-role' }] } });
            if (url.pathname === '/seed') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic time QA</title>' });
            const file = path.resolve(repo, '.' + url.pathname);
            if (!file.startsWith(repo + path.sep)) return route.fulfill({ status: 404 });
            try { return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file) }); }
            catch (_) { return route.fulfill({ status: 404 }); }
        });
        page.on('pageerror', error => errors.push(error.message));
        await page.clock.install({ time: new Date('2026-11-28T15:50:00Z') });
        await page.goto(origin + '/seed');
        await page.addScriptTag({ path: path.join(repo, 'tests/fixtures/full-backup-fixture.js') });
        await page.evaluate(async () => {
            const data = makeFullBackupFixture();
            const row = key => data.records.find(item => item.key === key);
            Object.assign(row('rp_hub_settings').value, { apiProviderId: 'custom', apiUrl: location.origin + '/mock/v1',
                customApiUrl: location.origin + '/mock/v1', model: 'synthetic-role', qualityModel: 'synthetic-role', styleFilterEnabled: false });
            Object.assign(row('rp_hub_chat_preferences_v2').value, { model: 'synthetic-role', qualityModel: 'synthetic-role' });
            row('rp_hub_memory_settings').value.enabled = false;
            row('rp_hub_presets').value.push({ name: '时间戳', role: 'system', content: 'seed, updated by app', enabled: true });
            row('rp_hub_branches_char-a').value.activeBranchId = 'main';
            row('rp_hub_chat_char-a').value[1].content = '【2026年11月01日 星期日 18:00】\n合成旧回复，保留原样。';
            for (const item of data.records.filter(item => item.key.startsWith('rp_hub_chat_char-'))) {
                for (const message of item.value) { delete message.imageAttachments; delete message.reasoning; delete message.toolCalls; }
            }
            const open = indexedDB.open('RPHubDB', 1);
            await new Promise((resolve, reject) => { open.onupgradeneeded = () => open.result.createObjectStore('store'); open.onsuccess = resolve; open.onerror = reject; });
            await new Promise((resolve, reject) => {
                const tx = open.result.transaction('store', 'readwrite');
                data.records.forEach(record => tx.objectStore('store').put(record.value, record.key));
                tx.oncomplete = resolve; tx.onerror = reject;
            });
            open.result.close();
            localStorage.setItem('roleplay_hub_update_id', '10226');
        });
        await page.goto(origin + '/index.html');
        const ready = () => page.waitForFunction(() => {
            const app = document.querySelector('#app')?.__vue_app__?._container?._vnode?.component?.proxy;
            return app?.currentCharacter?.uuid === 'char-a' && app?.chatHistory?.length >= 2 && app?.settings?.apiUrl?.includes('/mock/v1');
        });
        await ready();
        await page.locator('.entry-transition').waitFor({ state: 'hidden' });
        const viaApp = async (action, input) => page.evaluate(({ fn, arg, text }) => {
            const app = document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
            if (fn === 'view') return (app.currentView = arg);
            if (fn === 'send') { app.userInput = text; return app.sendMessage(); }
            if (fn === 'branch') return app.switchStoryBranch(arg, { notify: false });
            if (fn === 'last') { const { id, content, realTimeDisplay } = app.chatHistory.at(-1); return { id, content, realTimeDisplay }; }
        }, { fn: action, arg: input, text: input });
        const checkDouble = body => {
            assert.equal(placements(body), 2);
            const directives = body.messages.filter(m => typeof m.content === 'string' && m.content.startsWith('<rphub_real_time_system>'));
            assert.equal(directives.length, 1);
            const reference = /^<rphub_real_time_system>(.+)<\/rphub_real_time_system>$/.exec(directives[0].content)[1];
            assert.ok(body.messages.filter(m => m.role === 'user').flatMap(m => Array.isArray(m.content)
                ? m.content.map(part => part.text) : [m.content]).some(content => content?.endsWith(`<rphub_real_time_user>${reference}</rphub_real_time_user>`)));
            assert.ok(body.messages.indexOf(directives[0]) > body.messages.findIndex(m => m.role === 'system' && m !== directives[0]));
        };
        await page.clock.setSystemTime(new Date('2026-11-28T15:58:10Z'));
        const story = '【第1日 07时】\n\n合成主线回复。';
        const sse = ['<cot>合成思考</cot>', story].map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('');
        next.push(route => route.fulfill({ contentType: 'text/event-stream', body: sse + 'data: [DONE]\n\n' }));
        await viaApp('send', '合成主线输入');
        assert.equal(sent.length, 1);
        checkDouble(sent[0]);
        assert.match(JSON.stringify(sent[0]), /Asia\/Shanghai/);
        assert.match(JSON.stringify(sent[0]), /当前剧情时间戳/);
        const mainAnswer = await viaApp('last');
        assert.equal(mainAnswer.content, '<cot>合成思考</cot>' + story);
        assert.equal(mainAnswer.realTimeDisplay.localMinute, '2026-11-28T23:58');
        assert.equal(await page.locator('[data-real-time-heading]').count(), 1);
        assert.match(await page.locator('[data-real-time-heading]').innerText(), /星期六 23:58/);
        assert.match(await page.locator('[data-chat-index="3"] .markdown-body').filter({ hasText: '合成主线回复。' }).innerText(), /【第1日 07时】/);
        assert.equal(await page.evaluate(() => document.querySelector('#app').__vue_app__._container._vnode.component.proxy.chatHistory[1].content), '【2026年11月01日 星期日 18:00】\n合成旧回复，保留原样。');
        await page.locator('[data-real-time-heading]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, 'real-time-chat-mobile.png') });
        cases.push('actual main streaming payload has two placements; one header stays separate from story timestamp and original history');

        await viaApp('view', 'settings');
        const select = page.locator('#real-time-mode');
        const button = page.getByRole('button', { name: '保存现实时间设置', exact: true });
        await select.selectOption('manual');
        await page.locator('#real-time-zone').fill('Invalid/Example');
        await button.click();
        await page.getByText('原设置仍在使用。', { exact: false }).waitFor();
        await page.locator('#real-time-zone').fill('Africa/Cairo');
        await button.click();
        await page.getByText('现实时间设置已保存。', { exact: true }).waitFor();
        await page.locator('section[aria-labelledby="real-time-settings-title"]').screenshot({ path: path.join(out, 'real-time-settings-mobile.png') });
        await page.reload(); await ready(); await viaApp('view', 'settings');
        assert.equal(await select.inputValue(), 'manual');
        assert.equal(await page.locator('#real-time-zone').inputValue(), 'Africa/Cairo');
        await viaApp('view', 'chat');
        assert.equal((await viaApp('last')).realTimeDisplay.zone, 'Asia/Shanghai');
        cases.push('settings reject an unsupported zone and persist Cairo; reload preserves an earlier Beijing heading');

        await viaApp('branch', 'side');
        await page.evaluate(() => document.querySelector('#app').__vue_app__._container._vnode.component.proxy.pendingChatImages.push({ dataUrl: 'data:image/png;base64,AA==' }));
        next.push(completion('合成支线图片回复。'));
        await viaApp('send', '合成支线图片输入');
        checkDouble(sent.at(-1));
        const imageParts = sent.at(-1).messages.find(m => Array.isArray(m.content)).content;
        assert.equal(imageParts.find(p => p.type === 'image_url').image_url.url, 'data:image/png;base64,AA==');
        assert.match(imageParts.at(-1).text, /Africa\/Cairo/);
        assert.equal((await viaApp('last')).realTimeDisplay.zone, 'Africa/Cairo');
        cases.push('actual side-branch multimodal request preserves the image and saves a Cairo heading');

        await page.evaluate(() => { const app = document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
            app.settings.model = 'gemini-synthetic'; app.settings.preventTruncation = true; });
        await page.clock.setSystemTime(new Date('2026-11-28T21:59:10Z'));
        next.push(async route => { await page.clock.setSystemTime(new Date('2026-11-28T22:00:10Z')); return route.fulfill({ json: completion('') }); });
        next.push(completion('合成空回重试成功。'));
        await viaApp('send', '合成重试输入');
        const retry = sent.slice(-2);
        retry.forEach(checkDouble);
        assert.match(JSON.stringify(retry[0]), /2026-11-28 星期六 23:59/);
        assert.match(JSON.stringify(retry[1]), /2026-11-29 星期日 00:00/);
        for (const { messages } of retry) {
            const i = messages.findIndex(m => m.tool_calls?.[0].function.name === 'read_user_input');
            assert.ok(i > 0);
            assert.match(messages[i - 1].content, /rphub_real_time_user/);
            assert.equal(messages[i + 1].tool_call_id, messages[i].tool_calls[0].id);
            assert.doesNotMatch(messages[i + 1].content, markerPattern);
        }
        assert.equal((await viaApp('last')).realTimeDisplay.localMinute, '2026-11-29T00:00');
        cases.push('Gemini retry crosses Cairo midnight, keeps the synthetic tool pair, and stamps the successful attempt');

        await viaApp('view', 'settings');
        await select.selectOption('device'); await button.click();
        await page.getByText('现实时间设置已保存。', { exact: true }).waitFor();
        await viaApp('view', 'chat');
        await page.evaluate(() => { const app = document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
            app.settings.model = 'synthetic-role'; app.activeTools.find(tool => tool.type === 'random_number').enabled = true; });
        next.push(completion(null, { tool_calls: [{ id: 'synthetic-roll', type: 'function', function: { name: 'tool_random', arguments: '{"min":7,"max":7}' } }] }));
        next.push(completion('合成续接只输出一次。'));
        await viaApp('send', '合成随机工具请求');
        sent.slice(-2).forEach(checkDouble);
        const toolMessages = sent.at(-1).messages;
        const toolIndex = toolMessages.findIndex(m => m.tool_calls?.[0].id === 'synthetic-roll');
        assert.ok(toolIndex > 0);
        assert.equal(toolMessages[toolIndex + 1].tool_call_id, 'synthetic-roll');
        assert.doesNotMatch(toolMessages[toolIndex + 1].content, markerPattern);
        const continued = await viaApp('last');
        assert.equal(continued.content, '合成续接只输出一次。');
        assert.equal(continued.realTimeDisplay.zone, 'America/New_York');
        cases.push('actual tool-only response followed by continuation uses device zone and one header without modifying the tool result');

        await viaApp('branch', 'main');
        next.push(completion('合成总结：双方谈过布置。'));
        await page.evaluate(async () => {
            const app = document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
            app.memorySettings.mode = 'classic';
            await app.retryClassicMemory(app.displayedClassicMemories.find(memory => memory.id === 'm-disabled'));
        });
        assert.equal(sent.at(-1).model, 'synthetic-summary');
        assert.equal(placements(sent.at(-1)), 0);
        assert.doesNotMatch(JSON.stringify(sent.at(-1)), /realTimeDisplay|localMinute/);
        const templates = await page.evaluate(() => {
            const app = document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
            Object.assign(app.settings, { uiTemplateEnabled: true, uiTemplateMainModelAnalysis: false, uiTemplateModel: 'synthetic-ui' });
            return app.activeUiTemplates.length;
        });
        assert.ok(templates > 0);
        next.push(...Array.from({ length: templates }, () => completion('合成变量分析，无需更新。')));
        await page.evaluate(() => document.querySelector('#app').__vue_app__._container._vnode.component.proxy.updateUiTemplatesFromChat());
        for (const body of sent.slice(-templates)) {
            assert.equal(body.model, 'synthetic-ui'); assert.equal(placements(body), 0);
            assert.doesNotMatch(JSON.stringify(body), /realTimeDisplay|localMinute/);
        }
        cases.push('the real classic-summary and UI-analysis paths send no time block or display metadata');

        next.push(completion('老婆，想留句晚安。'));
        const letter = await page.evaluate(async () => {
            const app = document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
            app.settings.uiTemplateEnabled = false;
            app.proactiveSettings.enabled = true;
            app.mailboxDevelopmentEnabled = true;
            const before = JSON.stringify(app.chatHistory);
            await app.requestMailboxDevelopmentTest();
            const same = before === JSON.stringify(app.chatHistory);
            return { same, text: app.mailboxMessages.find(message => message.content === '老婆，想留句晚安。')?.content };
        });
        assert.equal(placements(sent.at(-1)), 1);
        assert.match(JSON.stringify(sent.at(-1)), /America\/New_York/);
        assert.doesNotMatch(JSON.stringify(sent.at(-1)), /现实发送时间（北京时间）/);
        assert.equal(letter.same, true);
        assert.equal(letter.text, '老婆，想留句晚安。');
        await page.evaluate(() => { document.querySelector('#app').__vue_app__._container._vnode.component.proxy.showMailbox = false; });
        cases.push('mailbox generates a separate letter with just one system time and leaves main chat unchanged');

        await viaApp('view', 'settings');
        await page.getByLabel('由旧时间脚本提供（仅此浏览器）').check();
        await viaApp('view', 'chat');
        next.push(completion('合成旧脚本兼容回复。'));
        await viaApp('send', '合成仅旧脚本');
        assert.equal(placements(sent.at(-1)), 0);
        assert.equal((await viaApp('last')).realTimeDisplay, undefined);
        assert.equal(await page.evaluate(() => localStorage.getItem('rp_hub_real_time_external_v1')), '1');
        cases.push('external-script mode disables native wire slots and the new reply heading in this browser');

        const old = await oldArchive();
        await page.goto(origin + '/full-backup.html');
        await page.locator('#restore-tab').click();
        await page.locator('#backup-file').setInputFiles({ name: 'synthetic-old.rphub.json', mimeType: 'application/json', buffer: Buffer.from(old.text) });
        await page.locator('#restore-password').fill('synthetic-old-preview-password');
        await page.locator('#preflight').click();
        await page.getByText('这份备份未包含现实时间设置，将保留本机选择。', { exact: false }).waitFor();
        assert.equal(await page.locator('#restore-button').isDisabled(), true);
        const targetSettings = await page.evaluate(async () => {
            const before = await RPHubFullBackup.create().capture();
            return before.records.find(row => row.key === 'rp_hub_settings').value.realTimePreference;
        });
        assert.deepEqual(targetSettings, { version: 1, mode: 'device' });
        cases.push('old encrypted file preview explains preserved target time zone and remains unconfirmed');

        assert.deepEqual(unexpected, []);
        assert.deepEqual(errors, []);
        assert.deepEqual(next, []);
        const report = { browser: browser.version(), passed: cases.length, cases, syntheticModelCalls: sent.length,
            paidModelCalls: 0, realNetworkRequests: 0, filteredStartupRequests, placementCounts: sent.map(placements), javascriptErrors: errors };
        await fs.writeFile(path.join(out, 'real-time-browser.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report));
    } finally { await browser.close(); }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
