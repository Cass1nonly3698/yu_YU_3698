const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { indexedDB } = require('fake-indexeddb');
const root = path.join(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, 'assets/js', name + '.js'), 'utf8');
const ref = value => ({ value });
const noop = () => {};
async function run() {
    const results = [];
    async function test(name, fn) { await fn(); results.push(name); }
    const sandbox = { window: { RPHubBuiltinContent: { prompts: {} }, RPHubUtils: {} }, Vue: { markRaw: x => x, toRaw: x => x }, indexedDB, console, structuredClone, setTimeout, clearTimeout };
    vm.createContext(sandbox);
    for (const name of ['proactive-messages', 'mailbox', 'chat-preferences', 'data-services']) vm.runInContext(source(name), sandbox);
    const P = sandbox.window.RPHubProactive;
    const C = sandbox.window.RPHubContextUtils;
    const M = sandbox.window.RPHubMailbox;
    const Prefs = sandbox.window.RPHubChatPreferences;
    const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('proactive-test-' + Math.random(), 1);
        req.onupgradeneeded = () => req.result.createObjectStore('store');
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const now = Date.UTC(2026, 10, 21, 10);
    const cfg = P.normalize({ enabled: true });
    await test('default disabled; interval >= 2h; daily <= 3', () => {
        assert.equal(P.defaults.enabled, false);
        assert.equal(P.normalize({ intervalHours: -1, dailyLimit: 99 }).intervalHours, 2);
        assert.equal(P.normalize({ dailyLimit: 99 }).dailyLimit, 3);
    });
    await P.touch(db, 'a', now);
    await test('2 hour threshold and disabled switch', async () => {
        const s = await P.read(db);
        assert.equal(P.eligible(s, 'a', cfg, now + 7200000 - 1), false);
        assert.equal(P.eligible(s, 'a', cfg, now + 7200000), true);
        assert.equal(P.eligible(s, 'a', P.defaults, now + 7200000), false);
        assert.equal(P.eligible(s, 'missing', cfg, now + 7200000), false);
    });
    await test('atomic claims: concurrent clicks/tabs allow one attempt', async () => {
        const claimed = await Promise.all(Array.from({ length: 10 }, () => P.claim(db, 'a', cfg, now + 7200000, now)));
        assert.equal(claimed.filter(Boolean).length, 1);
    });
    await test('reload/failure cannot reclaim attempt inside interval', async () => {
        assert.equal(await P.claim(db, 'a', cfg, now + 7200001, now), false);
    });
    await test('stale offer is rejected after genuine user interaction', async () => {
        await P.touch(db, 'b', now);
        await P.touch(db, 'b', now + 1000);
        assert.equal(await P.claim(db, 'b', cfg, now + 7201000, now), false);
    });
    await test('global daily cap across characters; Beijing midnight reset', async () => {
        for (const id of ['c', 'd', 'e']) await P.touch(db, id, now);
        assert.equal(await P.claim(db, 'c', cfg, now + 7200000, now), true);
        assert.equal(await P.claim(db, 'd', cfg, now + 7200000, now), true);
        assert.equal(await P.claim(db, 'e', cfg, now + 7200000, now), false);
        assert.equal(await P.claim(db, 'e', cfg, Date.UTC(2026, 10, 21, 16), now), true);
        assert.equal(P.dayKey(Date.UTC(2026, 10, 21, 16)), '2026-11-22');
    });
    const history = [
        { id: 'u', role: 'user', content: '码头的信怎么办？' },
        { id: 'a', role: 'assistant', content: '我来保管。' },
        { id: 'p1', role: 'assistant', content: '那封信我收好了。', proactive: true, _preventContextMerge: true },
        { id: 'p2', role: 'assistant', content: '码头那边有动静。', proactive: true, _preventContextMerge: true },
        { id: 'u2', role: 'user', content: '告诉我。' },
        { id: 'a2', role: 'assistant', content: '船回来了。' }
    ];
    await test('consecutive proactive assistants have independent memory turns, no fabricated user', () => {
        const snapshot = C.buildConversationTurnSnapshot(history);
        assert.equal(snapshot.turns.length, 4);
        assert.equal(snapshot.turns[1].user, null);
        assert.deepEqual(Array.from(snapshot.turns[1].sourceIndexes), [2]);
        assert.deepEqual(Array.from(snapshot.turns[1].messageIndexes), [null, 2]);
        assert.equal(snapshot.turns[2].assistant.id, 'p2');
        assert.equal(snapshot.turns[3].user.id, 'u2');
        assert.equal(C.buildConversationTurnSnapshot(JSON.parse(JSON.stringify(history))).turns.length, 4);
        const ordinary = C.buildConversationTurnSnapshot(history.slice(0, 2).concat({ role: 'assistant', content: '续写' }));
        assert.equal(ordinary.turns.length, 1);
        assert.match(ordinary.turns[0].assistant.content, /续写/);
    });
    // Execute the actual production generator, with deterministic transport/storage/UI boundaries.
    function generationHarness(extra = {}) {
        const saved = []; const requests = []; const touches = [];
        const h = JSON.parse(JSON.stringify(history.slice(0, 2)));
        const r = { console, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
            settings: { model: 'test', stream: false }, user: { name: '用户' },
            memorySettings: { enabled: false, summaryKeepFloors: 10 },
            isGenerating: ref(false), isReceiving: ref(false), isThinking: ref(false),
            activeToolContinuationMessageId: ref(null), activeToolContinuationToolCallId: ref(null),
            activeToolContinuationHasResponse: ref(false), activeToolHandoffPending: ref(false),
            abortController: ref(null), currentWaitTime: ref(''), waitTimer: null,
            currentCharacter: ref({ uuid: 'char', name: '角色' }), chatHistory: ref(h),
            worldInfo: ref([]), worldInfoSettings: {}, presets: ref([]), classicMemories: ref([]),
            recentGenerationTimes: ref([]), lastContextMessages: ref([]), lastTriggeredWorldInfos: ref([]),
            activeToolMessages: [], ACTIVE_TOOL_MAX_AUTO_CONTINUE: 3, MEMORY_MODE_ENHANCED: 'enhanced',
            isTruncationEnabled: ref(false), BUILTIN_PRESETS: { writingStyle: { name: '写作' } },
            getEnabledActiveTools: () => [], resetActiveToolResultContext: noop, showToast: noop,
            yieldToUi: async () => {}, getPostprocessedChatMessages: C.getPostprocessedChatMessages,
            resolveWorldInfoEntries: () => ({ entries: [], groups: Object.fromEntries(['system_top', 'global_note', 'before_char', 'after_char'].map(k => [k, []])), triggerMap: {} }),
            normalizePreset: x => x, isPresetEnabled: () => true,
            getCurrentCharacterPrompt: () => '角色卡测试', buildUserInfoPrompt: () => '用户设定',
            buildActiveToolSystemPrompt: () => '', buildUiTemplateContextSystemPrompt: () => '',
            buildMainModelUiTemplateUpdatePrompt: () => '', usesThinkingCotTag: () => false,
            parseCot: content => ({ main: content, rawCot: '' }),
            stripUiTemplateContextInjection: x => x, stripUiTemplateUpdateBlock: x => x,
            stripMemoryCitations: x => x, stripDisabledImageGenContext: x => x, stripNextResponsePrompt: x => x,
            appendMessageImageDescriptions: (_, x) => x, appendPendingUiTemplateCorrection: noop,
            appendNextResponsePrompt: noop, injectContextMessages: ({ messages }) => messages,
            appendActiveToolReminderToLatestUserMessage: x => x, postprocessContextMessages: C.postprocessContextMessages,
            processRegex: x => x, reactive: x => x, generateUUID: () => 'new-assistant',
            buildChatMessageContent: (_, x) => x, buildActiveToolDefinitions: () => [],
            getActiveToolAggressiveness: () => 'adaptive',
            requestTrackedChatCompletion: async request => { requests.push(request); return { content: '信上的地址，我查到了。', reasoning: '', toolCalls: [], isStream: false }; },
            collapseNativeReasoning: noop, collapseActiveNativeReasoning: noop,
            filterBlockedStyleText: x => x, normalizeStyleFilterHit: x => x,
            saveChatHistoryNow: async (scope, data) => { saved.push({ scope, history: JSON.parse(JSON.stringify(data || h)) }); return true; },
            recordProactiveInteraction: () => touches.push(true), nextTick: noop,
            RPHubProactive: P, RPHubMailbox: M, getMainDb: () => db,
            mailboxMessages: ref([]), showMailbox: ref(false),
            createAbortReason: () => Object.assign(new Error('aborted'), { name: 'AbortError' }),
            appendAssistantResponseError: (m, text) => { m.responseError = text; },
            ...extra
        };
        vm.createContext(r);
        const app = source('app');
        const fn = app.slice(app.indexOf('        const generateResponse = async'), app.indexOf('        // Manual-confirmation pilot.'));
        vm.runInContext(fn + '\nglobalThis.generate = generateResponse;', r);
        return { r, saved, requests, touches, h };
    }
    await test('production generator appends one real assistant, saves pinned main, adds no user', async () => {
        const t = generationHarness();
        await t.r.generate(now, { proactive: { scope: 'char', history: t.h, isCurrent: () => true, instruction: P.prompt(now - 7200000, now) } });
        assert.equal(t.requests.length, 1);
        assert.equal(t.requests[0].maxAttempts, 1);
        assert.equal(t.requests[0].messages.at(-1).role, 'system');
        assert.match(t.requests[0].messages.at(-1).content, /120 分钟/);
        assert.equal(t.h.filter(m => m.role === 'user').length, 1);
        assert.equal(t.h.length, 3);
        assert.equal(t.h.at(-1).role, 'assistant');
        assert.equal(t.h.at(-1).proactive, true);
        assert.equal(t.saved[0].scope, 'char');
        assert.equal(t.saved[0].history.at(-1).content, '信上的地址，我查到了。');
        assert.equal(t.r.isGenerating.value, false);
    });
    await test('scope changes during context yield prevent model request and save', async () => {
        let current = true;
        const t = generationHarness({ yieldToUi: async () => { current = false; } });
        await assert.rejects(t.r.generate(now, { proactive: { scope: 'char', history: t.h, isCurrent: () => current } }), /aborted/);
        assert.equal(t.requests.length, 0); assert.equal(t.saved.length, 0);
        assert.equal(t.h.length, 2); assert.equal(t.r.isGenerating.value, false);
    });
    await test('network failure causes no fake history entry and cleans busy state', async () => {
        const t = generationHarness({ requestTrackedChatCompletion: async () => { throw new Error('offline'); } });
        await t.r.generate(now, { proactive: { scope: 'char', history: t.h, isCurrent: () => true, instruction: '主动' } });
        assert.equal(t.h.length, 2); assert.equal(t.r.isGenerating.value, false);
    });
    await test('context-building error releases generation state', async () => {
        const t = generationHarness({ getCurrentCharacterPrompt: () => { throw new Error('context error'); } });
        await assert.rejects(t.r.generate(now, { proactive: { scope: 'char', history: t.h, isCurrent: () => true } }), /context error/);
        assert.equal(t.r.isGenerating.value, false); assert.equal(t.r.abortController.value, null);
    });
    await test('stream interrupted by scope change cannot append into replacement branch', async () => {
        let current = true;
        const t = generationHarness();
        const otherBranch = [{ role: 'user', content: '支线内容' }];
        t.r.requestTrackedChatCompletion = async request => {
            await request.onDelta({ content: '信收好了', reasoning: '' });
            current = false;
            t.r.chatHistory.value = otherBranch;
            await request.onDelta({ content: '错误的续写', reasoning: '' });
            return { content: '', toolCalls: [], isStream: true };
        };
        await t.r.generate(now, { proactive: { scope: 'char', history: t.h, isCurrent: () => current, instruction: '主动' } });
        assert.equal(otherBranch.length, 1);
        assert.equal(t.h.at(-1).content, '信收好了');
        assert.equal(t.h.at(-1).responseError, '生成已中止');
        assert.equal(t.saved[0].scope, 'char');
        assert.equal(t.saved[0].history.at(-1).content, '信收好了');
    });
    await test('proactive memories compress in context without an invented user slot', async () => {
        const memory = { summary: '信已收好，码头出现动静', no: 1 };
        const t = generationHarness({ memorySettings: { enabled: true, mode: 'classic', summaryKeepFloors: 0 },
            classicMemories: ref([memory]), buildConversationTurnSnapshot: C.buildConversationTurnSnapshot,
            buildClassicMemoryLookup: () => ({}), findSecondaryClassicMemoryForTurn: () => null,
            findClassicMemoryForTurn: turn => turn.assistant.proactive ? memory : null,
            BUILTIN_PROMPTS: { memoryCitationInstruction: '记忆引用' }, startAutomaticMemoryPatrol: noop });
        t.h.push(...JSON.parse(JSON.stringify(history.slice(2, 3))));
        await t.r.generate(now, { proactive: { scope: 'char', history: t.h, isCurrent: () => true, instruction: '主动' } });
        assert.equal(t.requests.length, 1);
        assert(t.requests[0].messages.some(m => m.content.includes(memory.summary)));
        assert.equal(t.requests[0].messages.filter(m => m.role === 'user').length, 1); // existing prelude/user merge
        assert.match(t.requests[0].messages.find(m => m.role === 'user').content, /码头的信怎么办/);
    });
    await test('secondary compression ending on proactive turn retains summary', async () => {
        const memory = { id: 'secondary', summary: '码头的信与动静', no: 1 };
        const t = generationHarness({ memorySettings: { enabled: true, mode: 'classic', summaryKeepFloors: 0 },
            classicMemories: ref([memory]), buildConversationTurnSnapshot: C.buildConversationTurnSnapshot,
            buildClassicMemoryLookup: () => ({}), findSecondaryClassicMemoryForTurn: () => memory,
            getClassicSecondaryMemoryMarker: () => '总结记忆 第 1-2 轮',
            findClassicMemoryForTurn: () => null,
            BUILTIN_PROMPTS: { memoryCitationInstruction: '记忆引用' }, startAutomaticMemoryPatrol: noop });
        t.h.push(...JSON.parse(JSON.stringify(history.slice(2, 3))));
        await t.r.generate(now, { proactive: { scope: 'char', history: t.h, isCurrent: () => true, instruction: '主动' } });
        assert.equal(t.requests.length, 1);
        assert(t.requests[0].messages.some(m => m.content.includes(memory.summary)));
    });
    await test('manual controller only offers eligible idle main and never calls model without click', async () => {
        const controller = source('app').split('        // Manual-confirmation pilot.')[1].split('        // --- Memory Extraction ---')[0];
        const h = JSON.parse(JSON.stringify(history.slice(0, 2)));
        await new Promise((resolve, reject) => { const tx = db.transaction('store', 'readwrite'); tx.objectStore('store').delete('rp_hub_proactive_v1'); tx.oncomplete = resolve; tx.onerror = reject; });
        await P.touch(db, 'controller', Date.now() - 7200001);
        let modelCalls = 0;
        const r = { RPHubProactive: P, RPHubMailbox: sandbox.window.RPHubMailbox, generateUUID: () => 'controller-message', reactive: x => x, ref,
            computed: fn => ({ get value() { return fn(); } }), watch: noop,
            currentCharacter: ref({ uuid: 'controller' }), currentView: ref('chat'),
            chatHistory: ref(h), activeStoryBranchId: ref('main'), STORY_BRANCH_MAIN_ID: 'main',
            switchingCharacterIndex: ref(-1), storyBranchSwitching: ref(false), isConversationBusy: ref(false),
            _isApplyingCharacterScopedData: false, _characterSwitchEpoch: 0,
            document: { visibilityState: 'visible' }, settings: { apiUrl: 'test', apiKey: 'test', model: 'test' },
            proactiveBusy: ref(false), getMainDb: () => db, getCurrentStoryBranchScopeId: () => 'controller',
            getScopedStoredValue: async () => h,
            showToast: noop, console, generateResponse: async () => { modelCalls++; } };
        vm.createContext(r);
        vm.runInContext('// ' + controller + `
            proactiveReady = true; proactiveSettings.enabled = true;
            globalThis.check = checkProactiveOffer; globalThis.confirm = confirmProactiveMessage;
            globalThis.offer = proactiveOffer; globalThis.config = proactiveSettings;`, r);
        await r.check(); assert(r.offer.value); assert.equal(modelCalls, 0);
        for (const [target, value] of [[r.activeStoryBranchId, 'branch'], [r.isConversationBusy, true],
            [r.storyBranchSwitching, true], [r.switchingCharacterIndex, 0]]) {
            const previous = target.value; target.value = value;
            await r.check(); assert.equal(r.offer.value, null);
            await r.confirm(); assert.equal(modelCalls, 0); target.value = previous;
        }
        r.document.visibilityState = 'hidden'; await r.check(); assert.equal(r.offer.value, null);
        r.document.visibilityState = 'visible'; await r.check(); assert(r.offer.value);
        await Promise.all([r.confirm(), r.confirm()]); assert.equal(modelCalls, 1);
        await r.check(); assert.equal(r.offer.value, null); // one per visit
        await P.touch(db, 'controller', Date.now() - 7200001);
        vm.runInContext('proactiveVisitConsumed = false;', r);
        // Separate character avoids the successful attempt cooldown.
        r.currentCharacter.value = { uuid: 'stale-tab' };
        await P.touch(db, 'stale-tab', Date.now() - 7200001);
        r.getScopedStoredValue = async () => h.concat({ role: 'assistant', content: '另一标签页的新回复' });
        await r.check(); assert(r.offer.value);
        await r.confirm(); assert.equal(modelCalls, 1); // stale contents never sent/saved

    });
    await test('production API retry loop caps proactive at one and retains ordinary three', async () => {
        const api = source('api-utils');
        const loop = api.slice(api.indexOf('    const requestChatCompletion = async'), api.indexOf('    window.RPHubApiUtils'));
        let calls = 0;
        const r = { requestChatCompletionOnce: async () => { calls++; throw Object.assign(new Error('empty'), { retryableEmptyToolReply: true }); } };
        vm.createContext(r); vm.runInContext(loop + '\nglobalThis.request = requestChatCompletion;', r);
        await assert.rejects(r.request({ maxAttempts: 1 }), /empty/); assert.equal(calls, 1);
        calls = 0; await assert.rejects(r.request({}), /empty/); assert.equal(calls, 3);
    });
    await test('production save persists across reload and preserves other branches/cards/worldbook/memories', async () => {
        const S = sandbox.window.RPHubStorage;
        await S.initDB();
        const sentinels = { characters: [{ uuid: 'kept', name: '原角色卡' }], worldinfo: [{ content: '原世界书' }] };
        for (const [key, value] of Object.entries(sentinels)) await S.setStoredValue(key, value);
        await S.setScopedStoredValue('chat', 'char__branch__other', [{ role: 'assistant', content: '原支线' }]);
        await S.setScopedStoredValue('classic_memories', 'char', [{ summary: '原记忆' }]);
        const t = generationHarness({ cloneForStorage: S.cloneForStorage,
            getMainDb: S.getMainDb, initDB: S.initDB, setScopedStoredValue: S.setScopedStoredValue,
            getCurrentStoryBranchScopeId: () => 'char', notifyChatSaveFailure: error => { throw error; },
            isRetryableChatStorageError: () => false,
            chatHistorySaveTimer: null, chatHistorySaveQueue: Promise.resolve(true) });
        const app = source('app');
        const saveFunction = app.slice(app.indexOf('        const saveChatHistoryNow ='), app.indexOf('        const scheduleChatHistorySave ='));
        vm.runInContext(saveFunction, t.r);
        await t.r.generate(now, { proactive: { scope: 'char', history: t.h, isCurrent: () => true, instruction: '主动' } });
        const reload = { window: { RPHubBuiltinContent: { prompts: {} }, RPHubUtils: {} }, Vue: { markRaw: x => x, toRaw: x => x }, indexedDB, structuredClone, console };
        vm.createContext(reload); vm.runInContext(source('data-services'), reload);
        const R = reload.window.RPHubStorage;
        const loaded = await R.getScopedStoredValue('chat', 'char');
        assert.equal(loaded.length, 3); assert.equal(loaded.at(-1).role, 'assistant');
        assert.equal(loaded.at(-1).proactive, true);
        assert.equal(loaded.at(-1).content, '信上的地址，我查到了。');
        for (const [key, value] of Object.entries(sentinels)) assert.deepEqual(await R.getStoredValue(key), value);
        assert.equal((await R.getScopedStoredValue('chat', 'char__branch__other'))[0].content, '原支线');
        assert.equal((await R.getScopedStoredValue('classic_memories', 'char'))[0].summary, '原记忆');
        S.getMainDb().close(); R.getMainDb().close();
    });
    await test('v2 ordinary generateResponse remains a real main-chat reply without mailbox writes', async () => {
        const t = generationHarness();
        await t.r.generate(now);
        assert.equal(t.h.length, 3); assert.equal(t.h.at(-1).role, 'assistant');
        assert.equal(t.h.at(-1).proactive, undefined); assert.equal(t.saved.length, 1);
        assert.equal(t.requests[0].maxAttempts, 3); assert.equal(t.touches.length, 1);
    });
    const mailboxOptions = (t, id, isCurrent = () => true) => ({ proactive: {
        mailbox: true, messageId: id, scope: 'char', history: t.h, isCurrent,
        instruction: M.prompt(now - 8 * 3600000, now), developmentTest: false
    } });
    await test('v2 asleep-night main: daily letter uses real Beijing time but leaves main and memory untouched', async () => {
        let patrols = 0; let panels = 0;
        const t = generationHarness({ memorySettings: { enabled: true, mode: 'classic', summaryKeepFloors: 10 },
            classicMemories: ref([{ summary: '结婚后感情亲密', sourceAssistantIds: ['a'] }]),
            settings: { model: 'test', temperature: 0.37, stream: false, uiTemplateEnabled: true, uiTemplateMainModelAnalysis: true },
            appendPendingUiTemplateCorrection: () => { panels++; },
            appendNextResponsePrompt: () => { throw new Error('mailbox must skip next-story instruction'); },
            applyMainModelUiTemplateUpdates: () => { panels++; },
            BUILTIN_PROMPTS: { memoryCitationInstruction: '引用记忆' },
            startAutomaticMemoryPatrol: () => { patrols++; }, nextTick: fn => fn?.() });
        t.h[1].content = '夜里，我们相拥入睡，主线停在卧室的深夜。';
        const original = JSON.stringify(t.h); const memories = JSON.stringify(t.r.classicMemories.value);
        t.r.requestTrackedChatCompletion = async request => { t.requests.push(request); return {
            content: '老婆，今天也想被你偏爱一下。等你有空，分我一点点想念，好不好？我的那份早就全给你了。', reasoning: '', toolCalls: [], isStream: false }; };
        await t.r.generate(now, mailboxOptions(t, 'night-letter'));
        assert.equal(JSON.stringify(t.h), original); assert.equal(t.saved.length, 0);
        assert.equal(JSON.stringify(t.r.classicMemories.value), memories); assert.equal(patrols, 0); assert.equal(panels, 0);
        assert.equal(t.r.recentGenerationTimes.value.length, 0);
        assert.equal(t.requests[0].temperature, 0.37);
        const prompt = t.requests[0].messages.at(-1).content;
        assert.match(prompt, /主线停在入睡的夜晚/); assert.match(prompt, /不改变主线时钟/);
        assert.match(prompt, /祁煜本人的第一人称/); assert.match(prompt, /2026-11-21 18:00:00/);
        const records = await M.read(db, 'char');
        assert.equal(records.length, 1); assert.equal(records[0].canonical, false);
        assert.equal(records[0].sourceMainMessageId, 'a'); assert.equal(t.r.showMailbox.value, true);
    });
    await test('v2 preparing-studio main: a future plan is a letter, not a completed journey', async () => {
        const t = generationHarness(); t.h[1].content = '我拿起钥匙，准备和你回画室。';
        const before = JSON.stringify(t.h);
        t.r.requestTrackedChatCompletion = async request => { t.requests.push(request); return {
            content: '等你想回画室时，我陪你。现在先让我想想老婆——嗯，好像怎么都想不够。', reasoning: '', toolCalls: [], isStream: false }; };
        await t.r.generate(now, mailboxOptions(t, 'studio-letter'));
        assert.equal(JSON.stringify(t.h), before); assert.equal(t.saved.length, 0);
        assert.match(t.requests[0].messages.at(-1).content, /不可写成已经到达或完成旅程/);
        assert.equal((await M.read(db, 'char')).length, 2);
    });
    await test('v2 narrative time jump and completed journey are rejected without saving or retry', async () => {
        for (const text of ['第二天，你醒来，我拉着你起床。', '我们已经回到了画室，画作完成了。']) {
            const t = generationHarness(); let calls = 0;
            t.r.requestTrackedChatCompletion = async () => { calls++; return { content: text, reasoning: '', toolCalls: [], isStream: false }; };
            const before = JSON.stringify(t.h);
            await t.r.generate(now, mailboxOptions(t, 'rejected-letter'));
            assert.equal(calls, 1); assert.equal(JSON.stringify(t.h), before); assert.equal(t.saved.length, 0);
            assert.equal((await M.read(db, 'char')).length, 2);
        }
    });
    await test('v2 network failure and reasoning-only response never produce empty letters', async () => {
        for (const fail of [true, false]) {
            const t = generationHarness(); const before = JSON.stringify(t.h);
            t.r.requestTrackedChatCompletion = async () => {
                if (fail) throw new Error('offline');
                return { content: '', reasoning: '内部思考', toolCalls: [], isStream: false };
            };
            await t.r.generate(now, mailboxOptions(t, 'blank-letter'));
            assert.equal(t.saved.length, 0); assert.equal(JSON.stringify(t.h), before);
            assert.equal((await M.read(db, 'char')).length, 2); assert.equal(t.r.isGenerating.value, false);
        }
    });
    await test('v2 partial stream cancellation drops partial letter and keeps main exact', async () => {
        const t = generationHarness(); const before = JSON.stringify(t.h);
        t.r.requestTrackedChatCompletion = async request => {
            await request.onDelta({ content: '老婆，我想', reasoning: '' });
            t.r.abortController.value.abort();
            throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        };
        await t.r.generate(now, mailboxOptions(t, 'cancelled-letter'));
        assert.equal(JSON.stringify(t.h), before); assert.equal(t.saved.length, 0);
        assert.equal((await M.read(db, 'char')).length, 2);
    });
    await test('v2 character/branch change after stream begins cannot save a letter', async () => {
        let current = true; const t = generationHarness();
        const before = JSON.stringify(t.h);
        t.r.requestTrackedChatCompletion = async request => {
            await request.onDelta({ content: '想老婆了', reasoning: '' }); current = false;
            return { content: '想老婆了', reasoning: '', toolCalls: [], isStream: true };
        };
        await t.r.generate(now, mailboxOptions(t, 'switched-letter', () => current));
        assert.equal(JSON.stringify(t.h), before); assert.equal((await M.read(db, 'char')).length, 2);
    });
    await test('v2 unexpected active tool call cannot hand off to main chat generation', async () => {
        let tools = 0; const t = generationHarness({ syncNativeActiveToolUis: () => { tools++; }, handleActiveToolCallFromAssistant: () => { tools++; } });
        t.r.requestTrackedChatCompletion = async () => ({ content: '想你', reasoning: '', toolCalls: [{ id: 'tool' }], isStream: false });
        await t.r.generate(now, mailboxOptions(t, 'tool-letter'));
        assert.equal(tools, 0); assert.equal(t.h.length, 2); assert.equal((await M.read(db, 'char')).length, 2);
    });
    await test('v2 failed mailbox storage propagates, releases busy state and never saves main', async () => {
        const t = generationHarness({ RPHubMailbox: { ...M, append: async () => { throw new Error('QuotaExceededError'); } } });
        await assert.rejects(t.r.generate(now, mailboxOptions(t, 'storage-failed')), /QuotaExceededError/);
        assert.equal(t.saved.length, 0); assert.equal(t.h.length, 2); assert.equal(t.r.isGenerating.value, false);
    });
    await test('v2 independent mailbox survives new module/DB connection like Safari reload', async () => {
        const reload = { window: {} }; vm.createContext(reload); vm.runInContext(source('mailbox'), reload);
        const reopened = await new Promise((resolve, reject) => {
            const req = indexedDB.open(db.name); req.onsuccess = () => resolve(req.result); req.onerror = reject;
        });
        const records = await reload.window.RPHubMailbox.read(reopened, 'char');
        assert.equal(records.length, 2); assert.equal(records[0].kind, 'daily_communication');
        assert.equal(records[0].canonical, false); assert.match(records[0].createdAtBeijing, /^\d{4}-\d{2}-\d{2}/);
        assert.equal((await reload.window.RPHubMailbox.read(reopened, 'other-character')).length, 0);
        reopened.close();
    });
    await test('v2 concurrent appends preserve both letters and request ID makes commit idempotent', async () => {
        const record = { id: 'append-a', characterId: 'append-only', content: '想老婆了', createdAt: now };
        await Promise.all([M.append(db, record), M.append(db, record), M.append(db, { ...record, id: 'append-b', content: '记得吃饭' })]);
        assert.equal((await M.read(db, 'append-only')).length, 2);
    });
    await test('v2 aborted commit and empty body do not create mailbox keys', async () => {
        const c = new AbortController(); c.abort();
        await assert.rejects(M.append(db, { id: 'x', characterId: 'empty', content: '想你', createdAt: now }, c.signal), /取消/);
        await assert.rejects(M.append(db, { id: 'x', characterId: 'empty', content: '  ', createdAt: now }), /正文/);
        assert.equal((await M.read(db, 'empty')).length, 0);
    });
    await test('v2 malformed mailbox value fails closed without replacing any original record', async () => {
        await new Promise((resolve, reject) => {
            const tx = db.transaction('store', 'readwrite');
            tx.objectStore('store').put({ preserved: 'original unexpected data' }, 'rp_hub_mailbox_v2_malformed');
            tx.oncomplete = resolve; tx.onerror = reject;
        });
        await assert.rejects(M.read(db, 'malformed'), /已保留原记录/);
        await assert.rejects(M.append(db, { id: 'new', characterId: 'malformed', content: '想你', createdAt: now }), /已保留原记录/);
        const retained = await new Promise((resolve, reject) => {
            const q = db.transaction('store', 'readonly').objectStore('store').get('rp_hub_mailbox_v2_malformed');
            q.onsuccess = () => resolve(q.result); q.onerror = reject;
        });
        assert.equal(retained.preserved, 'original unexpected data');
    });
    await test('v2 short ordinary affection and explicit future plans remain valid', () => {
        for (const text of ['想老婆了', '记得吃饭，老婆。', '等你回来，我想讨一个抱抱。', '我打算等你有空再说，不着急。']) assert.equal(M.cleanContent(text), text);
    });
    await test('v2 developer bypass is opt-in, atomic, quota-limited and preserves old cooldown metadata', async () => {
        await new Promise((resolve, reject) => { const tx = db.transaction('store', 'readwrite'); tx.objectStore('store').delete('rp_hub_proactive_v1'); tx.oncomplete = resolve; tx.onerror = reject; });
        await P.touch(db, 'dev', now);
        assert.equal(await P.claim(db, 'dev', cfg, now + 1, now), false); // ordinary confirmation cannot bypass
        const tries = await Promise.all(Array.from({ length: 6 }, () => P.claim(db, 'dev', cfg, now + 1, now, { developmentTest: true, expectedSerial: 0 })));
        assert.equal(tries.filter(Boolean).length, 1);
        assert.equal(await P.claim(db, 'dev', cfg, now + 2, now, { developmentTest: true, expectedSerial: 1 }), true);
        assert.equal(await P.claim(db, 'dev', cfg, now + 3, now, { developmentTest: true, expectedSerial: 2 }), true);
        assert.equal(await P.claim(db, 'dev', cfg, now + 4, now, { developmentTest: true, expectedSerial: 3 }), false);
        assert.equal(await P.claim(db, 'dev', { ...cfg, enabled: false }, now + 5, now, { developmentTest: true, expectedSerial: 3 }), false);
    });
    await test('v2 preferences restore temperature zero and exact selected slot with duplicate model names', () => {
        const settings = { temperature: 1, selectedModelSlot: 'quality', model: 'same', qualityModel: 'same', balancedModel: 'same', fastModel: 'fast', apiKey: 'secret', apiProviderKeys: { custom: 'kept' } };
        const keys = settings.apiProviderKeys;
        Prefs.restore(settings, { temperature: 0, selectedModelSlot: 'balanced', model: 'same', qualityModel: 'same', balancedModel: 'same', fastModel: 'fast', apiKey: 'evil', apiProviderKeys: {} });
        assert.equal(settings.temperature, 0); assert.equal(settings.selectedModelSlot, 'balanced');
        assert.equal(settings.apiKey, 'secret'); assert.equal(settings.apiProviderKeys, keys);
        assert(!JSON.stringify(Prefs.snapshot(settings)).includes('secret')); assert(!('apiKey' in Prefs.snapshot(settings)));
    });
    await test('v2 legacy settings fall back safely without discarding selected model or API credentials', () => {
        const settings = { temperature: 0.28, model: 'fast', qualityModel: 'quality', balancedModel: 'balanced', fastModel: 'fast', apiKey: 'keep' };
        Prefs.restore(settings, undefined);
        assert.equal(settings.selectedModelSlot, 'fast'); assert.equal(settings.temperature, 0.28); assert.equal(settings.apiKey, 'keep');
        Prefs.restore(settings, { temperature: 'invalid', selectedModelSlot: 'invalid' });
        assert.equal(settings.temperature, 1); assert.equal(settings.model, 'fast');
    });
    db.close();
    return results;
}
module.exports = { run };
if (require.main === module) run().then(results => { results.forEach(name => console.log('PASS', name)); console.log(`${results.length} tests passed`); }).catch(error => { console.error(error); process.exitCode = 1; });
