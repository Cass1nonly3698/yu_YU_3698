const { chromium, webkit } = require('playwright');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const root = path.join(__dirname,'..'), out = process.env.RP_HUB_QA_OUTPUT || path.join(root,'test-results');
async function main() {
    const address = process.env.RP_HUB_QA_URL || (await fs.readFile(path.join(out, 'local-qa-url.txt'), 'utf8')).trim();
    const engine = process.env.QA_ENGINE === 'webkit' ? webkit : chromium;
    const all = [];
    for (const mib of [20, 30, 50]) {
        const browser = await engine.launch(engine === chromium ? { ...(process.env.RP_HUB_CHROMIUM ? {executablePath:process.env.RP_HUB_CHROMIUM} : {}), args: ['--single-process','--no-zygote','--disable-crash-reporter'] } : {});
        try {
            const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage(), blocked = [];
            await context.route('**/*', route => new URL(route.request().url()).origin === new URL(address).origin ? route.continue() : (blocked.push('unexpected-outbound'), route.abort()));
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
