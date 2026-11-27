/* Synthetic fixtures only. No user content, real credentials or network endpoints. */
(function (root) {
    function fixture() {
        const memory = (id, extra = {}) => ({ id, no: 1, turn: 1, classicMemory: true, enabled: false,
            summary: '合成记忆：已一起讨论画室布置，出游仍是计划。', sourceUserIds: ['u-a'], sourceAssistantIds: ['a-a'],
            embeddingQ: 'A/4o', embeddingScale: 0.025, embeddingDims: 3, embeddingEncoding: 'int8:maxabs:v1',
            embeddingModel: 'synthetic-embedding', embeddingApiUrl: 'https://offline.invalid', ...extra });
        const char = { uuid: 'char-a', name: '合成角色 · 祁煜', description: '仅用于隔离测试的人物资料', createdAt: 1,
            mes_example: '合成示例', favorite: true, avatar: 'data:image/png;base64,AA==',
            worldInfo: [{ id: 'wi-char', comment: '角色合成设定', content: '合成资料', enabled: false, position: 'user_top' }],
            regexScripts: [{ id: 'rx-char', name: '合成正则', regex: 'TEST', replacement: '替换', enabled: false }],
            uiTemplates: [{ id: 'ui-a', name: '合成模板', variableState: { mood: '安稳', pendingPlan: '出游' }, htmlTemplate: '<div>合成面板</div>' }] };
        const chat = [{ id: 'u-a', role: 'user', content: '合成原文：我们谈了布置，明天出游只是计划。', imageAttachments: [{ dataUrl: 'data:image/png;base64,AA==' }] },
            { id: 'a-a', role: 'assistant', content: '合成回复😀。\n\n保留单独星号 * 和完整正文。', reasoning: '合成思考原字段', toolCalls: [{ id: 'tool-a', status: 'done', query: '合成' }] }];
        const globals = {
            characters: [char, { uuid: 'char-b', name: '合成配角', description: '合成', createdAt: 2 }],
            settings: { apiUrl: 'https://offline.invalid', apiKey: 'SYNTHETIC-PRIVATE-CANARY', apiProviderKeys: { test: 'SYNTHETIC-PROVIDER-KEY' }, imageGenKey: 'SYNTHETIC-IMAGE-KEY', model: 'synthetic-chat', fontSize: 17, styleFilterEnabled: false },
            presets: [{ id: 'preset-custom', name: '合成自定义预设', role: 'user', content: '合成正文', enabled: false }],
            regex: [{ id: 'regex1', name: '合成', regex: 'x', replacement: 'y', enabled: false }], global_regex: [],
            worldinfo: [], global_worldinfo: [{ id: 'global-wi', comment: '全局设定', content: '合成全局', constant: true, enabled: true }],
            worldinfo_settings: { scanDepth: 5, maxDepth: 10 }, global_ui_templates: [{ id: 'global-ui', variableState: { count: 3 } }],
            active_tools: [{ id: 'search', enabled: false, apiKey: 'SYNTHETIC-TOOL-KEY' }],
            user: { uuid: 'profile-a', name: '合成用户', preferences: '合成偏好' }, user_profiles: [{ uuid: 'profile-a', name: '合成用户' }], active_profile_id: 'profile-a', last_active_char: 0,
            memory_settings: { enabled: true, mode: 'enhanced', embeddingModel: 'synthetic-embedding', classicModel: 'synthetic-summary', summaryKeepFloors: 20 },
            chat_preferences_v2: { temperature: 0.7, selectedModelSlot: 'quality', model: 'synthetic-chat', qualityModel: 'synthetic-chat' }, token_usage_history: [{ id: 'usage-a', promptTokens: 111 }],
            proactive_v1: { characters: { 'char-a': { lastInteraction: 10, attemptSerial: 2 } }, daily: { '2026-11-28': 1 } }
        };
        const records = Object.entries(globals).map(([key, value]) => ({ key: 'rp_hub_' + key, value }));
        records.push({ key: 'rp_hub_chat_char-a', value: chat }, { key: 'rp_hub_chat_char-a__branch__side', value: structuredClone(chat) }, { key: 'rp_hub_chat_char-b', value: [] },
            { key: 'rp_hub_branches_char-a', value: { version: 1, activeBranchId: 'side', branches: [{ id: 'main', name: '主线' }, { id: 'side', name: '合成支线' }] } },
            { key: 'rp_hub_classic_memories_char-a', value: [memory('m-disabled'), memory('m-compressed', { no: 4, enabled: true, secondaryCompressed: true, turnStart: 1, turnEnd: 5, sourceMemories: [memory('m-source', { no: 3 })] })] },
            { key: 'rp_hub_classic_memories_char-a__branch__side', value: [memory('m-side', { embedding: new Float32Array([0.25, -0.5, 1]) })] },
            { key: 'rp_hub_mailbox_v2_char-a', value: [{ id: 'letter-a', characterId: 'char-a', content: '合成小纸条：记得我们的约定。', createdAt: 1, canonical: false, kind: 'daily_communication', sourceMainScopeId: 'char-a', sourceMainMessageId: 'a-a' }] });
        return { schema: 1, records, local: [
            { key: 'rphub-appearance', value: 'dark' }, { key: 'rp_hub_visual_cottage_v1', value: '{"version":1,"scene":"studio","mode":"night"}' },
            { key: 'rp_hub_proactive_config_v1', value: '{"enabled":true,"intervalHours":2,"dailyLimit":3}' }
        ] };
    }
    if (typeof module === 'object' && module.exports) module.exports = fixture;
    else root.makeFullBackupFixture = fixture;
})(typeof window === 'undefined' ? globalThis : window);
