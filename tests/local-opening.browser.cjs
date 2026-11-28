/* Synthetic fixtures, fresh IndexedDB and no outbound requests. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const out = process.env.RP_HUB_OPENING_OUTPUT || path.join(root, 'test-results/local-opening');
const origin = 'https://local-opening-test.invalid';
const vendors = {
    'https://unpkg.com/vue@3/dist/vue.global.prod.js': 'vue.js',
    'https://cdn.jsdelivr.net/npm/marked/marked.min.js': 'marked.js',
    'https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js': 'purify.js',
    'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js': 'sortable.js'
};
const types = {
    '.js':'application/javascript', '.css':'text/css', '.html':'text/html',
    '.webp':'image/webp', '.png':'image/png', '.jpg':'image/jpeg'
};
const mediaName = 'RPHubLocalOpening';
const mediaKey = '/';
const deadline = 12000;

function createFixture(tmp, name, seconds, color = 'teal') {
    const file = path.join(tmp, name + '.mp4');
    execFileSync(process.env.RP_HUB_FFMPEG || 'ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=180x240:r=30:d=${seconds}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-an',
        '-movflags', '+faststart', file
    ]);
    return fs.readFile(file);
}

async function inBrowser(mode, fn, record = false) {
    const browser = await chromium.launch({
        ...(process.env.RP_HUB_CHROMIUM ? { executablePath:process.env.RP_HUB_CHROMIUM } : {}),
        args:['--single-process','--no-zygote','--disable-crash-reporter']
    });
    try {
        const viewport = { width:390, height:844 };
        const context = await browser.newContext({
            viewport, serviceWorkers:'block', reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference',
            ...(record ? { recordVideo:{ dir:out, size:viewport } } : {})
        });
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (vendors[url.href]) {
                const body = await fs.readFile(path.join(process.env.RP_HUB_VENDOR_DIR, vendors[url.href]));
                return route.fulfill({ contentType:types['.js'], body });
            }
            if (url.origin === 'https://cdn.tailwindcss.com') {
                const body = await fs.readFile(process.env.RP_HUB_TAILWIND);
                return route.fulfill({ contentType:types['.js'], body });
            }
            if (url.origin !== origin) return route.fulfill({ status:204 });
            if (url.pathname === '/seed') return route.fulfill({ contentType:types['.html'], body:'<!doctype html><title>Synthetic QA</title>' });

            const file = path.resolve(root, '.' + url.pathname);
            assert.ok(file.startsWith(root + path.sep));
            try {
                const body = await fs.readFile(file);
                return route.fulfill({ contentType:types[path.extname(file)] || 'application/octet-stream', body });
            } catch (_) {
                return route.fulfill({ status:404 });
            }
        });
        const errors = [];
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ mode, mediaName }) => {
            window.qaOpening = { started:0, ended:0, fade:0, opened:0, startsInMs:[], quota:false };
            const storeOpen = indexedDB.open.bind(indexedDB);
            indexedDB.open = (name, ...args) => {
                if (name === mediaName) window.qaOpening.opened++;
                return storeOpen(name, ...args);
            };
            const nativePut = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (...args) {
                if (this.transaction.db.name === mediaName && window.qaOpening.quota) {
                    throw new DOMException('Synthetic write quota', 'QuotaExceededError');
                }
                return nativePut.apply(this, args);
            };
            const play = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function (...args) {
                if (this.closest('#local-opening')) {
                    window.qaOpening.started++;
                    if (mode === 'denied') return Promise.reject(new DOMException('Simulated autoplay failure', 'NotAllowedError'));
                }
                return play.apply(this, args);
            };
            if (mode === 'late' && HTMLVideoElement.prototype.requestVideoFrameCallback) {
                const request = HTMLVideoElement.prototype.requestVideoFrameCallback;
                HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
                    return request.call(this, (...args) => setTimeout(() => callback(...args), 550));
                };
            }
            document.addEventListener('ended', event => {
                if (event.target.closest('#local-opening')) window.qaOpening.ended++;
            }, true);
            const observer = new MutationObserver(rows => {
                for (const row of rows) {
                    const node = row.target;
                    if (node.id !== 'local-opening' || row.attributeName !== 'class') continue;
                    if (node.classList.contains('is-playing') && !node.classList.contains('is-fading')) {
                        window.qaOpening.startsInMs.push(performance.now() - Number(node.dataset.deadline) + 400);
                    }
                    if (node.classList.contains('is-fading')) window.qaOpening.fade++;
                }
            });
            observer.observe(document, {attributes:true, attributeFilter:['class'], subtree:true});
        }, { mode, mediaName });
        const result = await fn(page);
        assert.deepEqual(errors, []);
        await context.close();
        return result;
    } finally {
        await browser.close();
    }
}

async function seed(page, video, { corrupt = false, recovery = false } = {}) {
    await page.goto(origin + '/seed');
    await page.addScriptTag({ path:path.join(root, 'tests/fixtures/full-backup-fixture.js') });
    await page.evaluate(async ({ base64, mediaName, mediaKey, corrupt, recovery }) => {
        async function insert(name, table, fill) {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(name, 1);
                request.onupgradeneeded = () => request.result.createObjectStore(table);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            await new Promise((resolve, reject) => {
                const tx = db.transaction(table, 'readwrite');
                fill(tx.objectStore(table));
                tx.oncomplete = resolve;
                tx.onabort = () => reject(tx.error);
            });
            db.close();
        }
        const fixture = makeFullBackupFixture();
        const row = key => fixture.records.find(item => item.key === key).value;
        row('rp_hub_branches_char-a').activeBranchId = 'main';
        Object.assign(row('rp_hub_settings'), { imageGenKey:'', apiKey:'', apiProviderKeys:{} });
        row('rp_hub_characters').forEach(character => { character.avatar = ''; });
        for (const item of fixture.records.filter(record => record.key.startsWith('rp_hub_chat_') && Array.isArray(record.value))) {
            for (const message of item.value) {
                delete message.imageAttachments;
                delete message.reasoning;
                delete message.toolCalls;
            }
        }
        row('rp_hub_chat_char-a')[0].content = '今天想在海边多坐一会儿。';
        row('rp_hub_chat_char-a')[1].content = '好，等这一阵浪退下去。';
        await insert('RPHubDB', 'store', store => {
            for (const record of fixture.records) store.put(record.value, record.key);
        });
        localStorage.setItem('roleplay_hub_update_id', '10226');
        if (base64 || corrupt) {
            const bytes = corrupt ? new Uint8Array(12) : Uint8Array.from(atob(base64), char => char.charCodeAt(0));
            const blob = new Blob([bytes], { type:'video/mp4' });
            await insert(mediaName, 'media', store => store.put({ version:1, blob, duration:3.03 }, mediaKey));
        }
        if (recovery) localStorage.setItem('rp_hub_full_backup_pending_v1', 'synthetic-pending-marker');
    }, { base64:video?.toString('base64'), mediaName, mediaKey, corrupt, recovery });
}

async function chatReady(page) {
    await page.waitForFunction(() => {
        const app = document.querySelector('#app')?.__vue_app__?._container?._vnode?.component?.proxy;
        return app?.currentCharacter?.uuid === 'char-a' && app.chatHistory?.length === 2;
    }, null, { timeout:deadline });
}

async function openPage(page) {
    await page.goto(origin + '/index.html', { waitUntil:'domcontentloaded', timeout:deadline });
    await chatReady(page);
}

const traces = page => page.evaluate(() => window.qaOpening);
const opening = page => page.locator('#local-opening');
const hide = page => page.waitForFunction(() => document.querySelector('#local-opening').hidden
    && !document.querySelector('#local-opening video').hasAttribute('src'), null, { timeout:deadline });
const visibleVideo = page => page.waitForFunction(() => document.querySelector('#local-opening').classList.contains('is-playing'),
    null, { timeout:deadline });

async function settings(page) {
    await page.evaluate(() => {
        document.querySelector('#app').__vue_app__._container._vnode.component.proxy.currentView = 'settings';
    });
    await page.getByRole('button', { name:'设置本机开场视频' }).click({ timeout:deadline });
    return page.getByRole('dialog', { name:'本机开场视频' });
}

async function status(dialog, pattern) {
    await dialog.getByRole('status').filter({ hasText:pattern }).waitFor({timeout:deadline});
}

async function select(dialog, buffer, mimeType = 'video/mp4') {
    await dialog.locator('input[type=file]').setInputFiles({ name:'synthetic.mp4', mimeType, buffer });
}

async function testSettings(clips, pass) {
    await inBrowser('settings', async page => {
        await seed(page);
        await openPage(page);
        await hide(page);
        assert.equal(await page.locator('.entry-transition-book').count(), 0);
        assert.equal((await traces(page)).started, 0);
        assert.equal(await page.evaluate(async name => (await indexedDB.databases()).some(db => db.name === name), mediaName), false);
        pass.push('missing media skips animation and does not create a media database');

        let dialog = await settings(page);
        await status(dialog, '尚未设置');
        await select(dialog, clips.normal, 'application/octet-stream');
        await status(dialog, '已保存在本机');
        assert.equal(await dialog.getByRole('button', { name:'替换视频' }).isEnabled(), true);
        await page.screenshot({ path:path.join(out, 'settings-local-opening.png') });

        await select(dialog, Buffer.from('not mp4'));
        await status(dialog, '请选择 MP4');
        await select(dialog, Buffer.alloc(5 * 1024 * 1024 + 1));
        await status(dialog, '超过 5 MiB');
        await select(dialog, clips.long);
        await status(dialog, '5 秒以内');
        const truncated = clips.normal.subarray(0, 64);
        await select(dialog, truncated);
        await status(dialog, '无法解码');
        pass.push('rejects non-MP4, corrupt MP4, oversize and longer-than-five-second files before replacing');

        await dialog.getByRole('button', { name:'预览' }).click();
        await page.waitForFunction(() => {
            const video = document.querySelector('.local-opening-settings__preview');
            return !video.hidden && video.currentTime > 0.12 && video.muted && !video.loop;
        }, null, { timeout:deadline });
        assert.ok(Math.abs(await dialog.locator('video').evaluate(video => video.duration) - 3.03) < 0.06);
        await dialog.getByRole('button', { name:'关闭' }).click();
        await page.waitForFunction(() => !document.querySelector('.local-opening-settings__preview').hasAttribute('src'),
            null, { timeout:deadline });
        pass.push('settings import and silent preview work and the blob URL is released on close');

        dialog = await settings(page);
        await status(dialog, '已设置本机');
        await select(dialog, clips.exactLimits);
        await status(dialog, '已保存在本机');
        await page.evaluate(() => { window.qaOpening.quota = true; });
        await select(dialog, clips.normal);
        await status(dialog, '本机存储空间不足');
        await dialog.getByRole('button', { name:'预览' }).click();
        await page.waitForFunction(() => document.querySelector('.local-opening-settings__preview').duration === 5,
            null, { timeout:deadline });
        await page.evaluate(() => { window.qaOpening.quota = false; });
        pass.push('accepts exactly 5 MiB / 5 seconds and preserves the old clip when replacement fails on quota');

        await select(dialog, clips.replacement);
        await status(dialog, '已保存在本机');
        await dialog.getByRole('button', { name:'关闭' }).click();
        await page.reload({ waitUntil:'domcontentloaded', timeout:deadline });
        await visibleVideo(page);
        assert.equal(await opening(page).locator('video').evaluate(video => video.duration), 1);
        await hide(page);
        pass.push('successful replacement survives document reload');

        dialog = await settings(page);
        await status(dialog, '已设置本机');
        page.once('dialog', confirmation => confirmation.dismiss());
        await dialog.getByRole('button', { name:'移除' }).click();
        assert.equal(await dialog.getByRole('button', { name:'预览' }).isEnabled(), true);
        page.once('dialog', confirmation => confirmation.accept());
        await dialog.getByRole('button', { name:'移除' }).click();
        await status(dialog, '已移除');
        await dialog.getByRole('button', { name:'关闭' }).click();
        await page.reload({ waitUntil:'domcontentloaded', timeout:deadline });
        await chatReady(page);
        await hide(page);
        assert.equal((await traces(page)).started, 0);
        pass.push('cancelled removal preserves the clip; confirmed removal persists and disables the opening');
    });
}

async function testPlayback(clips, pass) {
    const normal = await inBrowser('normal', async page => {
        await seed(page, clips.normal);
        await openPage(page);
        await visibleVideo(page);
        const style = await opening(page).evaluate(root => {
            const layer = getComputedStyle(root);
            const video = root.querySelector('video');
            return { color:layer.backgroundColor, pointer:layer.pointerEvents, fit:getComputedStyle(video).objectFit,
                width:root.getBoundingClientRect().width, muted:video.muted, loop:video.loop, inline:video.playsInline };
        });
        assert.deepEqual(style, { color:'rgb(17, 44, 66)', pointer:'none', fit:'contain', width:390, muted:true, loop:false, inline:true });
        await hide(page);
        const trace = await traces(page);
        assert.equal(trace.started, 1);
        assert.equal(trace.ended, 1);
        assert.equal(trace.fade, 1);
        assert.equal(trace.startsInMs.length, 1);
        assert.ok(trace.startsInMs[0] <= 430);
        pass.push('first frame appears within the budget; the muted, proportionally contained video ends and fades once');

        const branches = await page.evaluate(async () => {
            const app = document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
            const start = app.activeStoryBranchId;
            await app.switchStoryBranch('side', { notify:false });
            const side = app.activeStoryBranchId;
            await app.switchStoryBranch('main', { notify:false });
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted:false }));
            document.dispatchEvent(new Event('visibilitychange'));
            return [start, side, app.activeStoryBranchId];
        });
        assert.deepEqual(branches, ['main','side','main']);
        assert.equal((await traces(page)).started, 1);
        pass.push('main/side/main switching and ordinary foreground events never replay the video');
        return trace;
    });
    for (const mode of ['denied', 'late', 'corrupt', 'reduced']) {
        await inBrowser(mode, async page => {
            await seed(page, clips.normal, { corrupt:mode === 'corrupt' });
            await openPage(page);
            await hide(page);
            const trace = await traces(page);
            assert.equal(trace.startsInMs.length, 0);
            assert.equal(trace.fade, 0);
            assert.equal(trace.started, mode === 'reduced' ? 0 : 1);
            if (mode === 'reduced') assert.equal(trace.opened, 0);
            pass.push('chat still mounts with no visible opening: ' + mode);
        });
    }

    await inBrowser('background', async page => {
        await seed(page, clips.normal);
        await openPage(page);
        await visibleVideo(page);
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { configurable:true, value:'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
            delete document.visibilityState;
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await hide(page);
        assert.equal((await traces(page)).started, 1);
        pass.push('backgrounding during the video cleans it up without replay on return');
    });

    await inBrowser('paused', async page => {
        await seed(page, clips.normal);
        await openPage(page);
        await visibleVideo(page);
        await opening(page).locator('video').evaluate(video => video.pause());
        await hide(page);
        assert.equal((await traces(page)).fade, 0);
        pass.push('an unexpected playback pause dismisses the opening immediately');
    });

    await inBrowser('recovery', async page => {
        await seed(page, clips.normal, { recovery:true });
        await page.goto(origin + '/index.html', { waitUntil:'commit', timeout:deadline }).catch(error => {
            if (!String(error).includes('ERR_ABORTED')) throw error;
        });
        await page.waitForURL('**/full-backup.html?recovery=1', { timeout:deadline });
        assert.equal(await page.evaluate(() => !!window.RPHubStorage), false);
        assert.equal((await traces(page)).started, 0);
        pass.push('pending restore still goes directly to the recovery gate');
    });
    return normal;
}

async function recordLocal(file) {
    const video = await fs.readFile(file);
    await inBrowser('normal', async page => {
        await seed(page);
        await openPage(page);
        const dialog = await settings(page);
        await status(dialog, '尚未设置');
        await select(dialog, video);
        await status(dialog, '已保存在本机');
        await dialog.getByRole('button', { name:'关闭' }).click();
        await page.reload({ waitUntil:'domcontentloaded', timeout:deadline });
        await visibleVideo(page);
        await chatReady(page);
        const choice = await opening(page).locator('video').evaluate(player => ({
            duration:player.duration, width:player.videoWidth, height:player.videoHeight
        }));
        assert.ok(choice.width > 0 && choice.height > 0 && choice.duration <= 5);
        await page.screenshot({ path:path.join(out, 'komodo-local-opening.png') });
        await hide(page);
        const trace = await traces(page);
        assert.equal(trace.ended, 1);
        assert.equal(trace.fade, 1);
        await page.waitForTimeout(450);
        const recording = page.video();
        await page.close();
        await recording.saveAs(path.join(out, 'komodo-local-opening.webm'));
        await fs.writeFile(path.join(out, 'local-sample-verification.json'),
            JSON.stringify({ media:choice, started:trace.started, ended:trace.ended, faded:trace.fade, outboundRequests:0 }, null, 2) + '\n');
    }, true);
}

async function run() {
    await fs.mkdir(out, { recursive:true });
    if (process.env.RP_HUB_OPENING_LOCAL_SAMPLE) {
        await recordLocal(process.env.RP_HUB_OPENING_LOCAL_SAMPLE);
        return;
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rphub-opening-test-'));
    try {
        const [normal, exact, long, replacement] = await Promise.all([
            createFixture(tmp, 'normal', 3.03), createFixture(tmp, 'exact', 5),
            createFixture(tmp, 'long', 5.3), createFixture(tmp, 'replacement', 1, 'blue')
        ]);
        const padding = Buffer.alloc(5 * 1024 * 1024 - exact.length);
        padding.writeUInt32BE(padding.length, 0);
        padding.write('free', 4, 'ascii');
        const clips = { normal, long, replacement, exactLimits:Buffer.concat([exact, padding]) };
        const pass = [];
        await testSettings(clips, pass);
        const trace = await testPlayback(clips, pass);
        const result = { passed:pass.length, cases:pass, normal:trace, networkRequests:0, syntheticOnly:true };
        await fs.writeFile(path.join(out, 'local-opening-regression.json'), JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await fs.rm(tmp, { recursive:true, force:true });
    }
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
