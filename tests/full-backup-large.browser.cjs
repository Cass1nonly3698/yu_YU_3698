const { chromium, webkit } = require('playwright');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname,'..'), out = process.env.RP_HUB_QA_OUTPUT || path.join(root,'test-results');
async function main() {
    const offline = process.env.RP_HUB_QA_OFFLINE === '1';
    const address = offline ? 'http://127.0.0.1:41777/tests/full-backup-large.html'
        : process.env.RP_HUB_QA_URL || (await fs.readFile(path.join(out, 'local-qa-url.txt'), 'utf8')).trim();
    const legacy = offline ? execFileSync('git', ['show', 'ab7500d:assets/js/full-backup.js'], { cwd: root }) : null;
    await fs.mkdir(out, { recursive: true });
    const engine = process.env.QA_ENGINE === 'webkit' ? webkit : chromium;
    const all = [];
    for (const mib of [20, 30, 50]) {
        const browser = await engine.launch(engine === chromium ? { ...(process.env.RP_HUB_CHROMIUM ? {executablePath:process.env.RP_HUB_CHROMIUM} : {}), args: ['--single-process','--no-zygote','--disable-crash-reporter'] } : {});
        try {
            const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage(), blocked = [];
            await context.route('**/*', async route => {
                const url = new URL(route.request().url());
                if (url.origin !== new URL(address).origin) { blocked.push('unexpected-outbound'); return route.abort(); }
                if (!offline) return route.continue();
                if (['/qa-progress', '/qa-result'].includes(url.pathname) && route.request().method() === 'POST') return route.fulfill({ status: 204 });
                if (url.pathname === '/ab7500d-full-backup.js') return route.fulfill({ contentType: 'application/javascript', body: legacy });
                const file = path.resolve(root, '.' + url.pathname);
                if (!file.startsWith(root + path.sep)) return route.fulfill({ status: 404 });
                const type = file.endsWith('.html') ? 'text/html' : 'application/javascript';
                try { return route.fulfill({ contentType: type, body: await fs.readFile(file) }); }
                catch (_) { return route.fulfill({ status: 404 }); }
            });
            await page.goto(address + '?mib=' + mib);
            await page.locator('#run').click();
            await page.waitForFunction(() => document.getElementById('result').textContent.length > 0, null, { timeout: 180000 });
            const result = JSON.parse(await page.locator('#result').textContent());
            assert.equal(result.pass, true, JSON.stringify(result)); assert.deepEqual(blocked, []);
            const pending = page.waitForEvent('download'); await page.locator('#download').click(); const download = await pending;
            const bytes = await fs.readFile(await download.path());
            assert.equal(bytes.length, result.legacyFileBytes);
            assert.equal(createHash('sha256').update(bytes).digest('hex'), result.legacySha256);
            all.push({ ...result, browserVersion: browser.version(), actualDownload: { suggestedFilename: download.suggestedFilename(), bytes: bytes.length, sha256Matches: true } });
            console.log(engine.name(), mib, 'MiB passed, file bytes:', bytes.length);
        } finally { await browser.close(); }
    }
    await fs.writeFile(path.join(out, engine.name() + '-large-summary.json'), JSON.stringify(all, null, 2));
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
