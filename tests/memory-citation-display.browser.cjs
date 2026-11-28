/* Isolated synthetic UI regression; all requests are fulfilled locally. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const root = path.join(__dirname,'..');
const out = process.env.RP_HUB_MEMORY_OUTPUT || path.join(root,'test-results/memory-display');
const origin = 'https://memory-display.invalid';
const proxy = () => document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
const raw = [
    '我们一起看过海。',
    '记得那片**海**，也记得约定。[M3][M4][M999][M3]',
    '```html\n<div><p>卡片里的约定。[M3]</p><input id="card-note" value="原值"></div>\n```',
    '<!doctype html><html><head></head><body><p>完整卡片里的约定。[M4]</p></body></html>',
    '<section><p>行内 HTML 的约定。[M3]</p></section>',
    '没有引用的回复。'
];
async function run() {
    await fs.mkdir(out,{recursive:true});
    const browser=await chromium.launch({executablePath:process.env.RP_HUB_CHROMIUM,args:['--single-process','--no-zygote','--disable-crash-reporter'],timeout:15000});
    const pass=[], errors=[];
    try {
        const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'no-preference'});
        await context.route('**/*',async route=>{
            const url=new URL(route.request().url());
            const vendors={'https://unpkg.com/vue@3/dist/vue.global.prod.js':'vue.js','https://cdn.jsdelivr.net/npm/marked/marked.min.js':'marked.js','https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js':'purify.js','https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js':'sortable.js'};
            if(vendors[url.href])return route.fulfill({contentType:'application/javascript',body:await fs.readFile(path.join(process.env.RP_HUB_VENDOR_DIR,vendors[url.href]))});
            if(url.origin==='https://cdn.tailwindcss.com')return route.fulfill({contentType:'application/javascript',body:await fs.readFile(process.env.RP_HUB_TAILWIND)});
            if(url.origin!==origin)return route.fulfill({status:204});
            if(url.pathname==='/seed')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic memory display QA</title>'});
            const file=path.resolve(root,'.'+url.pathname);assert.ok(file.startsWith(root+path.sep));
            try{return route.fulfill({contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream',body:await fs.readFile(file)});}catch(_){return route.fulfill({status:404});}
        });
        const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
        await page.addInitScript(()=>{
            window.qaWrites=[];
            const put=IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put=function(value,key){window.qaWrites.push({db:this.transaction.db.name,key});return put.apply(this,arguments);};
        });
        await page.goto(origin+'/seed');
        await page.addScriptTag({path:path.join(root,'tests/fixtures/full-backup-fixture.js')});
        await page.evaluate(async raw=>{
            const data=makeFullBackupFixture();const row=key=>data.records.find(x=>x.key===key).value;
            row('rp_hub_branches_char-a').activeBranchId='main';
            row('rp_hub_chat_char-a__branch__side')[1].content='支线约定。[M1]';
            row('rp_hub_classic_memories_char-a__branch__side')[0].summary='支线专用记忆';
            row('rp_hub_characters').forEach(x=>x.avatar='');
            Object.assign(row('rp_hub_settings'),{apiKey:'',apiProviderKeys:{},imageGenKey:''});
            data.records.find(x=>x.key==='rp_hub_chat_char-a').value=raw.map((content,i)=>({id:i===0?'u-a':i===1?'a-a':'qa-'+i,role:i===0?'user':'assistant',isSelf:i===0,shouldAnimate:true,content}));
            const db=await new Promise(resolve=>{const r=indexedDB.open('RPHubDB',1);r.onupgradeneeded=()=>r.result.createObjectStore('store');r.onsuccess=()=>resolve(r.result);});
            await new Promise(resolve=>{const tx=db.transaction('store','readwrite');data.records.forEach(x=>tx.objectStore('store').put(x.value,x.key));tx.oncomplete=resolve;});db.close();
            localStorage.setItem('roleplay_hub_update_id','10226');
        },raw);
        async function ready(){await page.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?._container?._vnode?.component?.proxy?.startupChatReady);await page.waitForFunction(()=>[...document.querySelectorAll('iframe.executable-html-frame')].length===2 && [...document.querySelectorAll('iframe.executable-html-frame')].every(frame=>{const chip=frame.contentDocument?.querySelector('.memory-cite');return chip && chip.textContent!=='?';}));}
        async function setView(view){await page.evaluate(view=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.currentView=view,view);}
        async function toggle(value){await setView('settings');if(await page.getByRole('checkbox',{name:'显示正文记忆引用',exact:true}).isChecked()!==value) await page.getByText('显示正文记忆引用',{exact:true}).click();await page.waitForFunction(value=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.settings.showMemoryCitations===value,value);}
        async function state(){return page.evaluate(()=>{
            const root=document.querySelector('#app');
            const read=doc=>({chips:[...doc.querySelectorAll('.memory-cite')].map(x=>getComputedStyle(x).display),underlines:[...doc.querySelectorAll('.memory-cite-text')].map(x=>getComputedStyle(x).textDecorationLine)});
            return {main:read(document),frames:[...root.querySelectorAll('iframe.executable-html-frame')].map(x=>read(x.contentDocument))};
        });}
        async function stored(){return page.evaluate(async()=>{
            const db=await new Promise(resolve=>{const r=indexedDB.open('RPHubDB');r.onsuccess=()=>resolve(r.result);});
            const result=await new Promise(resolve=>{const tx=db.transaction('store');const s=tx.objectStore('store');const rows={};for(const k of ['rp_hub_chat_char-a','rp_hub_classic_memories_char-a','rp_hub_branches_char-a','rp_hub_chat_char-a__branch__side','rp_hub_classic_memories_char-a__branch__side','rp_hub_memory_settings']){const r=s.get(k);r.onsuccess=()=>rows[k]=r.result;}tx.oncomplete=()=>resolve(JSON.stringify(rows));});db.close();return result;
        });}
        await page.goto(origin+'/index.html');await ready();await page.waitForTimeout(700);
        const initial=await stored();
        assert.equal(await page.evaluate(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.settings.showMemoryCitations),false);
        let styles=await state();assert.ok(styles.main.chips.length>=2);assert.equal(styles.frames.length,2);
        for(const scope of [styles.main,...styles.frames]){assert.ok(scope.chips.length);assert.ok(scope.chips.every(x=>x==='none'),JSON.stringify(styles));assert.ok(scope.underlines.every(x=>x==='none'));}
        assert.equal(await page.locator('[data-chat-index="5"]').getByRole('button',{name:'记忆依据',exact:true}).count(),0);
        pass.push('default off hides Markdown, inline HTML and both iframe formats; unreferenced messages have no entry');
        const first=page.locator('[data-chat-index="1"]');
        await first.getByRole('button',{name:'记忆依据',exact:true}).click();
        await page.getByRole('heading',{name:'记忆依据',exact:true}).waitFor();
        assert.equal(await page.locator('.memory-cite-card').count(),3);
        assert.ok((await page.locator('.memory-cite-list').textContent()).includes('这条记忆已不存在'));
        assert.ok((await page.locator('.memory-cite-list').textContent()).includes('合成记忆'));
        await page.locator('.memory-cite-panel').getByRole('button',{name:'关闭',exact:true}).click();
        pass.push('message action retains deduplicated original, compressed-source and missing-source evidence');
        // Keep a card's live input and document identity across preference toggles.
        const card=page.frameLocator('iframe.executable-html-frame').first();await card.locator('#card-note').fill('卡片状态应保留');
        await card.locator('body').evaluate(body=>window.qaCardIdentity=body);
        await page.waitForTimeout(700);await page.evaluate(()=>window.qaWrites=[]);
        await toggle(true);await setView('chat');
        styles=await state();for(const scope of [styles.main,...styles.frames]){assert.ok(scope.chips.every(x=>x!=='none'));assert.ok(scope.underlines.every(x=>x==='underline'));}
        assert.equal(await card.locator('#card-note').inputValue(),'卡片状态应保留');assert.equal(await card.locator('body').evaluate(body=>window.qaCardIdentity===body),true);
        await first.locator('.memory-cite').first().click();await page.getByRole('heading',{name:'记忆依据',exact:true}).waitFor();
        await page.locator('.memory-cite-panel').getByRole('button',{name:'关闭',exact:true}).click();
        await card.locator('.memory-cite').first().click();await page.getByRole('heading',{name:'记忆依据',exact:true}).waitFor();
        await page.locator('.memory-cite-panel').getByRole('button',{name:'关闭',exact:true}).click();
        await toggle(false);await setView('chat');await page.waitForTimeout(700);
        const writes=await page.evaluate(()=>window.qaWrites);assert.ok(writes.length);assert.ok(writes.every(x=>x.db==='RPHubDB'&&x.key==='rp_hub_chat_preferences_v2'),JSON.stringify(writes));
        assert.equal(await stored(),initial);
        await first.locator('.memory-cite-text').first().click();assert.equal(await page.locator('.memory-cite-panel').count(),0);
        await page.screenshot({path:path.join(out,'default-hidden-mobile.png'),fullPage:true});
        pass.push('toggle restores original styles/clicks in all render paths without reloading cards or writing chat/memory');
        await toggle(true);await page.reload();await ready();assert.equal(await page.evaluate(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.settings.showMemoryCitations),true);
        await toggle(false);await page.reload();await ready();assert.equal(await page.evaluate(()=>document.querySelector('#app').__vue_app__._container._vnode.component.proxy.settings.showMemoryCitations),false);
        assert.equal(await stored(),initial);
        pass.push('true and false preferences survive reload; legacy preferences default off and raw historic stores stay intact');
        await page.evaluate(()=>{const app=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;app.chatHistory.push({id:'stream-qa',role:'assistant',content:'流式约定。[M',isSelf:false});app.isGenerating=true;app.isReceiving=true;});
        const last=page.locator('[data-chat-index="6"]');
        for(const content of ['流式约定。[M','流式约定。[M3','流式约定。[M3]']){
            await page.evaluate(content=>{document.querySelector('#app').__vue_app__._container._vnode.component.proxy.chatHistory.at(-1).content=content;},content);
            await last.locator('.markdown-body').waitFor();
            assert.doesNotMatch(await last.locator('.markdown-body').innerText(),/\[M/);
        }
        await page.evaluate(()=>{const app=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;app.isGenerating=false;app.isReceiving=false;});
        await last.getByRole('button',{name:'记忆依据',exact:true}).waitFor();
        pass.push('new streamed replies hide complete and incomplete markers while retaining a source entry after completion');
        await page.evaluate(()=>{const app=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;app.isGenerating=true;app.isReceiving=true;app.chatHistory.at(-1).content='```html\n<div><p>流式卡片。[M3';});
        await page.evaluate(()=>{document.querySelector('#app').__vue_app__._container._vnode.component.proxy.chatHistory.at(-1).content='```html\n<div><p>流式卡片。[M3]</p></div>\n```';});
        await page.waitForFunction(()=>{const frame=document.querySelector('[data-chat-index="6"] iframe');const cite=frame?.contentDocument?.querySelector('.memory-cite');return cite && getComputedStyle(cite).display==='none';});
        await page.evaluate(()=>{const app=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;app.isGenerating=false;app.isReceiving=false;});
        await last.getByRole('button',{name:'记忆依据',exact:true}).waitFor();
        pass.push('a streamed HTML card also hides its citation and retains the original source action');
        // Existing display regex remains effective; preference must not change render cache output or raw input.
        const rendered=await page.evaluate(()=>{const app=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;const text='**海边**。[M3]';const a=app.renderMarkdown(text);app.settings.showMemoryCitations=true;const b=app.renderMarkdown(text);return {a,b,text};});assert.equal(rendered.a,rendered.b);assert.equal(rendered.text,'**海边**。[M3]');
        await toggle(true);await page.screenshot({path:path.join(out,'settings-enabled-mobile.png'),fullPage:true});
        await setView('chat');await page.setViewportSize({width:1040,height:900});await last.hover();
        await page.screenshot({path:path.join(out,'enabled-desktop.png'),fullPage:true});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        pass.push('display toggle leaves renderer cache and original source untouched; mobile and desktop remain usable');
        await page.evaluate(async()=>{const app=document.querySelector('#app').__vue_app__._container._vnode.component.proxy;await app.switchStoryBranch('side',{notify:false});});
        const side=page.locator('[data-chat-index="1"]');await side.getByRole('button',{name:'记忆依据',exact:true}).click();
        await page.getByRole('heading',{name:'记忆依据',exact:true}).waitFor();
        assert.match(await page.locator('.memory-cite-list').textContent(),/支线专用记忆/);
        assert.doesNotMatch(await page.locator('.memory-cite-list').textContent(),/合成记忆/);
        pass.push('source lookup stays scoped to the active branch and includes that branch’s original memory');
        assert.deepEqual(errors,[]);
        const result={base:'d702214',passed:pass.length,cases:pass,javascriptErrors:errors,syntheticOnly:true,physicalIphone:false,preferenceWritesOnly:writes};
        await fs.writeFile(path.join(out,'memory-citation-display-regression.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
        await context.close();
    }finally{await browser.close();}
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;});
