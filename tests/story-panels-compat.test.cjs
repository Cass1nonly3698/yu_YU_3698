// Offline prompt-contract tests. These do not predict or validate model output.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/js/built-in-content.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'assets/js/app.js'), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');

function harness({ panelsEnabled = true, truncation = true } = {}) {
    // No browser storage, credentials or network APIs are provided to this VM.
    const sandbox = {
        window: {},
        computed: getter => ({ get value() { return getter(); } }),
        isTruncationEnabled: { value: truncation },
        isAutoImageGenEnabled: { value: false },
        settings: { imageGenCount: 2 },
        memorySettings: { enabled: false },
        isUiTemplateAnalysisEnabled: () => false
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    sandbox.BUILTIN_PRESETS = sandbox.window.RPHubBuiltinPresets.managedPresets;
    sandbox.BUILTIN_PROMPTS = sandbox.window.RPHubBuiltinContent.prompts;
    const disabled = [
        ...sandbox.window.RPHubBuiltinPresets.corePresets,
        ...['timestamp', 'deUserCentric', 'writingStyle', 'nsfw'].map(key => sandbox.BUILTIN_PRESETS[key])
    ].map(preset => ({ ...preset, enabled: false }));
    sandbox.presets = { value: [
        ...disabled,
        { ...sandbox.BUILTIN_PRESETS.storyPanels, role: 'system', enabled: panelsEnabled },
        { name: 'COT', content: 'test COT', enabled: true }
    ] };
    function productionSection(start, end) {
        const from = app.indexOf(start);
        const to = app.indexOf(end, from);
        assert.ok(from >= 0 && to > from, 'production helper boundaries exist');
        return app.slice(from, to);
    }
    vm.runInContext(
        productionSection('        const isPresetEnabled =', '        const getPresetRoleLabel =')
        + productionSection('        const appendNextResponsePrompt =', '        const generateResponse =')
        + '\nglobalThis.helpers = { isPresetEnabled, normalizePreset, syncBuiltinPreset, appendNextResponsePrompt };',
        sandbox
    );
    return sandbox;
}

const h = harness();
const panel = h.BUILTIN_PRESETS.storyPanels.content;
const reminder = h.BUILTIN_PROMPTS.buildNextResponsePrompt({ storyPanelsEnabled: true });

test('panel visibility is based on current-mainline user knowledge, not other characters or player knowledge', () => {
    assert.match(panel, /区分角色已知、玩家已知与当前主线已向 \{\{user\}\} 揭晓/);
    assert.match(panel, /通过观察、对话或实际交互已经获知/);
    assert.match(panel, /玩家从旁白、内心、角色设定、世界书或记忆读到秘密，都不构成/);
    assert.doesNotMatch(panel, /主角或人物必须可见/);
});

test('unrevealed works, gifts, surprises and plans cannot disclose names, answers or designs', () => {
    assert.match(panel, /尚未向 \{\{user\}\} 揭晓的画作、礼物、惊喜、秘密计划及隐藏细节/);
    assert.match(panel, /不得通过面板提前披露名称、内容、伏笔答案或具体设计/);
    assert.match(panel, /只公开名称不等于其他细节也已揭晓/);
    assert.match(panel, /不得为生成面板擅自补写/);
});

test('confidentiality takes precedence over panel novelty and frequency; omission is allowed', () => {
    assert.match(panel, /防剧透边界优先于“积极生成”“突出新增与变化”“不复述正文”/);
    assert.match(panel, /没有合适的公开信息时允许不生成面板，不用空白面板凑数/);
    assert.match(reminder, /不得为凑面板泄密或补写揭晓过程，无合适公开信息可不生成/);
});

test('revealed information remains specific and attractive; preparing a surprise is allowed', () => {
    assert.match(panel, /不禁止角色准备或保留惊喜/);
    assert.match(panel, /已向 \{\{user\}\} 实际公开的信息仍可正常、具体、美观地展示/);
    assert.match(reminder, /已公开内容仍可正常美观展示/);
});

// Synthetic acceptance scenarios exercise the actual per-turn helper with COT,
// writing style, de-user-centric and timestamp presets effectively disabled.
// Assertions concern instructions delivered, never an invented model response.
const scenarios = [
    {
        name: '《慕岸》未揭晓：请求携带保密规则（不模拟模型遵守结果）',
        history: '祁煜说这幅画暂时不让顺顺看，准备之后揭晓。',
        input: '我点点头，继续和你聊天。',
        rule: /不得通过面板提前披露名称、内容、伏笔答案或具体设计/
    },
    {
        name: '《慕岸》已揭晓：请求保留公开信息的展示许可',
        history: '祁煜展示画作并介绍画名《慕岸》，顺顺已经看见画面。',
        input: '我仔细看着你给我介绍的画。',
        rule: /已向 \{\{user\}\} 实际公开的信息仍可正常、具体、美观地展示/
    },
    {
        name: '无合适公开信息：请求允许不生成面板',
        history: '惊喜尚未揭晓，本轮没有适合面板展示的公开新信息。',
        input: '我握着你的手。',
        rule: /没有合适的公开信息时允许不生成面板/
    }
];
for (const scenario of scenarios) {
    test(scenario.name, () => {
        const t = harness();
        const enabled = t.presets.value.map(t.helpers.normalizePreset).filter(t.helpers.isPresetEnabled);
        assert.deepEqual(Array.from(enabled, p => p.name), ['剧情面板']);
        const messages = [
            { role: 'system', content: enabled[0].content },
            { role: 'assistant', content: scenario.history },
            { role: 'user', content: scenario.input, _sourceIndexes: [1] }
        ];
        t.helpers.appendNextResponsePrompt(messages);
        assert.match(messages[0].content, scenario.rule);
        assert.ok(messages[2].content.startsWith(scenario.input));
        assert.match(messages[2].content, /仅用 \{\{user\}\} 在当前主线已实际获知的信息/);
        assert.match(messages[2].content, /防剧透优先于积极生成、突出新增与变化和不复述正文/);
        assert.doesNotMatch(messages[2].content, /一轮结束时|<writing_style>|<thinking_protocol>/);
        assert.equal(messages.length, 3);
    });
}

test('disabled panel does not leave a per-turn panel reminder', () => {
    const t = harness({ panelsEnabled: false });
    const messages = [{ role: 'user', content: '测试', _sourceIndexes: [0] }];
    t.helpers.appendNextResponsePrompt(messages);
    assert.doesNotMatch(messages[0].content, /面板|防剧透/);
});

test('builtin panel synchronization preserves its off switch and other disabled presets', () => {
    const t = harness({ panelsEnabled: false });
    const before = JSON.stringify(t.presets.value);
    t.helpers.syncBuiltinPreset(t.BUILTIN_PRESETS.storyPanels);
    assert.equal(JSON.stringify(t.presets.value), before);
    assert.equal(t.helpers.isPresetEnabled(t.presets.value.find(p => p.name === 'COT')), false);
    assert.equal(t.presets.value.find(p => p.name === 'COT').enabled, true);
});

test('existing panel timing, integration, visual design, HTML format and UI safety are unchanged', () => {
    const lines = panel.split('\n').filter(line => /^- (时机|衔接|设计|格式|边界)：/.test(line));
    assert.equal(lines.length, 5);
    assert.equal(hash(JSON.stringify(lines)), '93790ddf0363b544d0dc3ace3c240834797e807382d84c1ec9d219c5aa722a32');
});

test('all builtin source outside the panel preset and its per-turn reminder matches the baseline', () => {
    const masked = source.replace(/\r\n/g, '\n')
        .replace(/^.*storyPanelsEnabled \? '.*' : '',$/m, '<panel-reminder>')
        .replace(/        storyPanels: Object\.freeze\(\{[\s\S]*?(?=        timestamp: Object\.freeze)/, '<panel-preset>\n');
    assert.equal(hash(masked), '4e75ad676b99354b9d6b8b146b39e6a5e2c24a2cb85194cfc6094ea20d765849');
});
