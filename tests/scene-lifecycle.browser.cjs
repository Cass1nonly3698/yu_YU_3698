const { chromium } = require('playwright');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const repo = path.join(__dirname, '..'), out = process.env.RP_HUB_SCENE_OUTPUT || path.join(repo, 'test-results/scenes');
const vendor = process.env.RP_HUB_VENDOR_DIR;
if (!vendor) throw new Error('Set RP_HUB_VENDOR_DIR to local vue.js/marked.js/purify.js/sortable.js');
const original = process.env.QA_BASELINE === '1';
const origin = 'https://scene-lifecycle.invalid';
const proxy = () => document.querySelector('#app')?.__vue_app__?._container?._vnode?.component?.proxy;
async function main() {
    await fs.mkdir(out,{recursive:true});
    const browser = await chromium.launch({ ...(process.env.RP_HUB_CHROMIUM ? {executablePath:process.env.RP_HUB_CHROMIUM} : {}), args: ['--single-process','--no-zygote','--disable-crash-reporter'] });
    const blocked = [], errors = [], cases = [];
    try {
        const context = await browser.newContext({ viewport: { width: 1040, height: 1050 }, timezoneId: 'Asia/Shanghai' });
        await context.route('**/*', async route => {
            const target = new URL(route.request().url());
            const vendors = { 'https://unpkg.com/vue@3/dist/vue.global.prod.js':'vue.js','https://cdn.jsdelivr.net/npm/marked/marked.min.js':'marked.js','https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js':'purify.js','https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js':'sortable.js' };
            if (vendors[target.href]) return route.fulfill({ contentType:'application/javascript', body:await fs.readFile(path.join(vendor,vendors[target.href])) });
            if (target.origin === 'https://cdn.tailwindcss.com') return route.fulfill({ contentType:'application/javascript',body:process.env.RP_HUB_TAILWIND ? await fs.readFile(process.env.RP_HUB_TAILWIND) : 'window.tailwind={config:{}};' });
            if (target.origin !== origin) { blocked.push({ path: target.pathname, method: route.request().method() }); return route.fulfill({ status:204 }); }
            if (target.pathname === '/seed') return route.fulfill({ contentType:'text/html',body:'<!doctype html><title>Synthetic scene QA</title>' });
            const name = target.pathname.slice(1) || 'index.html';
            try {
                const body = original ? execFileSync('git',['show','ab7500d:'+name],{cwd:repo}) : await fs.readFile(path.join(repo,name));
                return route.fulfill({ contentType: name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'application/octet-stream',body });
            } catch (_) { return route.fulfill({ status:404 }); }
        });
        const page = await context.newPage(); page.on('pageerror', e=>errors.push(e.message));
        await page.clock.install({ time:new Date('2026-11-28T18:59:50+08:00') });
        await page.goto(origin+'/seed'); await page.addScriptTag({path:path.join(repo,'tests/fixtures/full-backup-fixture.js')});
        await page.evaluate(async()=>{
            const fixture=makeFullBackupFixture(); fixture.records.find(r=>r.key==='rp_hub_branches_char-a').value.activeBranchId='main';
            fixture.records.find(r=>r.key==='rp_hub_characters').value.forEach(c=>{c.avatar='';});
            fixture.records.filter(r=>r.key.startsWith('rp_hub_chat_')&&Array.isArray(r.value)).forEach(r=>r.value.forEach(m=>{delete m.imageAttachments;delete m.reasoning;delete m.toolCalls;}));
            const r=indexedDB.open('RPHubDB',1);await new Promise(resolve=>{r.onupgradeneeded=()=>r.result.createObjectStore('store');r.onsuccess=resolve;});
            await new Promise(resolve=>{const tx=r.result.transaction('store','readwrite');fixture.records.forEach(v=>tx.objectStore('store').put(v.value,v.key));tx.oncomplete=resolve;});r.result.close();
            localStorage.setItem('rp_hub_visual_cottage_v1',JSON.stringify({version:1,scene:'studio',mode:'auto'}));
            localStorage.setItem('roleplay_hub_update_id','10226');
        });
        await page.addInitScript(()=>{ const native=navigator.locks.request.bind(navigator.locks);navigator.locks.request=(name,opts,fn)=> opts.mode==='shared'?new Promise((resolve,reject)=>{window.__releaseQaGate=()=>{native(name,opts,fn).then(resolve,reject);};}):native(name,opts,fn); });
        await page.goto(origin+'/index.html'); await page.waitForFunction(()=>!!window.__releaseQaGate);
        const before = await page.locator('.cottage-room').getAttribute('data-cottage-mounted');
        await page.evaluate(()=>{window.__releaseQaGate();});
        await page.waitForFunction(()=>{const a=document.querySelector('#app')?.__vue_app__?._container?._vnode?.component?.proxy;return a?.currentCharacter?.uuid==='char-a'&&a.chatHistory?.length===2&&a.memoryStats?.activeTotal>0;});
        await page.clock.runFor(1000);
        const root=page.locator('.cottage-room');
        await root.locator('.cottage-controls summary').click(); await root.locator('[data-cottage-mode="day"]').click();
        const manualWorks=await root.getAttribute('data-cottage-phase')==='day';
        await root.locator('[data-cottage-mode="auto"]').click();
        await page.clock.runFor(45000);
        const boundaryWorks=await root.getAttribute('data-cottage-phase')==='night';
        await page.evaluate(async()=>{const a=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;await a.switchStoryBranch('side',{notify:false});});
        const branchActive=await root.getAttribute('data-cottage-active')==='true';
        const repro={baseline:original,beforeVueMounted:before,manualWorks,boundaryWorks,branchActive,errors};
        if(original){ await fs.writeFile(path.join(out,'scene-baseline-reproduction.json'),JSON.stringify(repro,null,2)); console.log(JSON.stringify(repro));return; }
        assert.equal(before,null,'Background must not mount into Vue template before Vue owns it');
        assert.equal(manualWorks,true);assert.equal(boundaryWorks,true);assert.equal(branchActive,true); cases.push('delayed Web Lock mount: manual selection, 19:00 boundary and side branch remain live');
        for(const branch of ['main','side','main']){
            await page.evaluate(async id=>{const a=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;await a.switchStoryBranch(id,{notify:false});},branch);
            for(const scene of ['cottage','studio'])for(const mode of ['day','dusk','night','auto']){
                const details=root.locator('.cottage-controls');if(!await details.evaluate(el=>el.open))await root.locator('.cottage-controls > summary').click();
                await root.locator('[data-cottage-scene="'+scene+'"]').click();await root.locator('[data-cottage-mode="'+mode+'"]').click();
                assert.equal(await root.getAttribute('data-cottage-scene'),scene);assert.equal(await root.getAttribute('data-cottage-mode'),mode);
            }
        } cases.push('both scenes and all modes work across repeated main/side switches');
        // A real second document changes global localStorage; the chat must receive storage synchronization.
        const other=await context.newPage();await other.goto(origin+'/seed');await other.evaluate(()=>localStorage.setItem('rp_hub_visual_cottage_v1',JSON.stringify({version:1,scene:'studio',mode:'night'})));await other.close();
        await page.waitForFunction(()=>document.querySelector('.cottage-room')?.dataset.cottageMode==='night');cases.push('cross-window localStorage preference event updates the selected global mode');
        await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:false}));});
        assert.equal(await root.getAttribute('data-cottage-mode'),'night'); cases.push('visibility and pageshow refresh preserve the saved manual preference');
        if(!await root.locator('.cottage-controls').evaluate(el=>el.open))await root.locator('.cottage-controls > summary').click();await root.locator('[data-cottage-mode="auto"]').click();
        await page.clock.setSystemTime(new Date('2026-11-29T06:00:01+08:00'));await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        assert.equal(await root.getAttribute('data-cottage-phase'),'day');cases.push('resume after suspended wall time recalculates Beijing phase');
        await page.clock.setSystemTime(new Date('2026-11-29T17:00:01+08:00'));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
        assert.equal(await root.getAttribute('data-cottage-phase'),'dusk');cases.push('focus refresh recalculates the 17:00 boundary');
        await page.screenshot({path:path.join(out,'scene-side-controls.png'),fullPage:false});
        const saved=await page.evaluate(()=>localStorage.getItem('rp_hub_visual_cottage_v1'));
        await page.reload();await page.waitForFunction(()=>!!window.__releaseQaGate);await page.evaluate(()=>{window.__releaseQaGate();});
        await page.waitForSelector('.cottage-room[data-cottage-mounted="true"]');
        await page.clock.runFor(1000);
        assert.equal(await root.getAttribute('data-cottage-scene'),'studio');assert.equal(await root.getAttribute('data-cottage-mode'),'auto');
        assert.equal(await page.evaluate(()=>localStorage.getItem('rp_hub_visual_cottage_v1')),saved);cases.push('reload preserves the exact stored global scene and mode');
        const stable=await page.evaluate(()=>{const root=document.querySelector('.cottage-room'),a=RPHubCottage.mount(root),b=RPHubCottage.mount(root);return a===b&&root.querySelectorAll('.cottage-toolbar').length===1;});
        assert.equal(stable,true);cases.push('repeated initialization reuses one controller and one toolbar');
        const repaired=await page.evaluate(()=>{const root=document.createElement('div');if(RPHubCottage.mount(root)!==null||root.dataset.cottageMounted)return false;root.dataset.cottageMounted='true';root.innerHTML='<div data-cottage-host></div>';const c=RPHubCottage.mount(root);const ok=!!c&&root.querySelectorAll('.cottage-toolbar').length===1;c.destroy();return ok&&!root.dataset.cottageMounted;});
        assert.equal(repaired,true);cases.push('missing host can retry and stale DOM marker cannot suppress initialization');
        await page.setViewportSize({width:390,height:844});await root.locator('.cottage-controls > summary').click();
        const box=await root.locator('.cottage-popover').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=391);
        await root.locator('[data-cottage-scene="cottage"]').click();await root.locator('[data-cottage-mode="day"]').click();
        assert.equal(await root.getAttribute('data-cottage-phase'),'day');
        await root.locator('[data-cottage-scene="studio"]').click();await root.locator('[data-cottage-mode="auto"]').click();
        await page.screenshot({path:path.join(out,'scene-mobile-controls.png'),fullPage:false});cases.push('390px scene/time controls are clickable and stay inside the viewport');
        const cleaned=await page.evaluate(()=>{const root=document.querySelector('.cottage-room'),stored=localStorage.getItem('rp_hub_visual_cottage_v1');document.querySelector('#app').__vue_app__.unmount();return !root.dataset.cottageMounted&&root.querySelector('[data-cottage-host]').childElementCount===0&&localStorage.getItem('rp_hub_visual_cottage_v1')===stored;});
        assert.equal(cleaned,true);cases.push('Vue unmount destroys the background controller without resetting stored preferences');
        assert.deepEqual(errors,[]);assert.equal(blocked.some(r=>/chat\/completions|embeddings|\/generate\b/.test(r.path)),false);
        const result={...repro,passed:cases.length,cases,paidApiRequests:0,syntheticOnly:true};await fs.writeFile(path.join(out,'scene-regression.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
    }finally{await browser.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
