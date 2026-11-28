const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const clock = require('../assets/js/real-time.js');

const utc = text => Date.parse(text);
const manual = ianaZone => ({ version: 1, mode: 'manual', ianaZone });
const at = (value, date) => clock.capture(value, utc(date));
const first = at(null, '2026-11-28T15:59:59Z');
const second = at(null, '2026-11-28T16:00:00Z');
const marks = messages => (JSON.stringify(messages).match(/<rphub_real_time_(?:user|system)>/g) || []).length;
const pair = [{ role: 'system', content: 'synthetic system' }, { role: 'user', content: 'synthetic input' }];

test('Beijing default crosses midnight and keeps the legacy visual minute format', () => {
    assert.equal(first.display.zone, 'Asia/Shanghai');
    assert.equal(first.display.offsetMinutes, 480);
    assert.equal(clock.formatHeading(first.display), '【2026年11月28日 星期六 23:59】');
    assert.equal(clock.formatHeading(second.display), '【2026年11月29日 星期日 00:00】');
    assert.match(clock.describe(first), /23:59:59.*UTC\+08:00/);
});

test('manual Cairo skips the nonexistent hour, New York distinguishes the repeated hour, and Kathmandu preserves fractional offsets', () => {
    const before = at(manual('Africa/Cairo'), '2026-04-23T21:59:59Z');
    const after = at(manual('Africa/Cairo'), '2026-04-23T22:00:00Z');
    assert.deepEqual([before.display.localMinute, after.display.localMinute], ['2026-04-23T23:59', '2026-04-24T01:00']);
    assert.deepEqual([before.display.offsetMinutes, after.display.offsetMinutes], [120, 180]);
    const earlier = at(manual('America/New_York'), '2026-11-01T05:30:00Z');
    const later = at(manual('America/New_York'), '2026-11-01T06:30:00Z');
    assert.equal(clock.formatHeading(earlier.display), clock.formatHeading(later.display));
    assert.deepEqual([earlier.display.offsetMinutes, later.display.offsetMinutes], [-240, -300]);
    assert.equal(at(manual('Asia/Kathmandu'), '2026-11-28T00:00:00Z').display.offsetMinutes, 345);
});

test('device mode resolves the zone on every capture and does not write back a transient zone', () => {
    const p = Object.freeze({ version: 1, mode: 'device' });
    const zones = ['Asia/Shanghai', 'Africa/Cairo'];
    const device = () => zones.shift();
    assert.equal(clock.capture(p, first.display.instant, device).display.zone, 'Asia/Shanghai');
    assert.equal(clock.capture(p, first.display.instant, device).display.zone, 'Africa/Cairo');
    assert.deepEqual(p, { version: 1, mode: 'device' });
});

test('manual input requires a named IANA zone, and unsupported saved names get an explicit fallback', () => {
    for (const zone of ['', 'CST', '+05:30', 'Invalid/Example']) assert.equal(clock.isSupportedZone(zone), false);
    for (const zone of ['Africa/Cairo', 'UTC', 'US/Eastern']) assert.equal(clock.isSupportedZone(zone), true);
    const p = Object.freeze(manual('Invalid/Example'));
    const snap = clock.capture(p, first.display.instant);
    assert.equal(snap.fallback, true);
    assert.deepEqual(snap.display, first.display);
    assert.equal(p.ianaZone, 'Invalid/Example');
    assert.equal(clock.capture({ version: 1, mode: 'device' }, first.display.instant, () => '').fallback, true);
});

test('display metadata never invents historical dates and refuses inconsistent or malformed values', () => {
    assert.equal(clock.formatHeading(undefined), '');
    assert.equal(clock.formatHeading({ ...first.display, localMinute: '2026-02-31T25:00' }), '');
    assert.equal(clock.formatHeading({ ...first.display, instant: Infinity }), '');
    assert.equal(clock.formatHeading({ ...first.display, offsetMinutes: first.display.offsetMinutes + 1 }), '');
    assert.equal(clock.formatHeading(JSON.parse(JSON.stringify(first.display))), clock.formatHeading(first.display));
});

test('one snapshot supplies the system and exact user slots without mutating context, and rebuilding replaces both', () => {
    const base = [pair[0], { role: 'developer', content: 'synthetic developer' }, pair[1],
        { role: 'user', content: 'synthetic preset, not the chosen user' }];
    const original = JSON.stringify(base);
    const injection = clock.addReference(base, 2, first);
    assert.equal(injection.positions, 2);
    assert.equal(marks(injection.messages), 2);
    assert.match(injection.messages[2].content, /<rphub_real_time_system>.*23:59:59/);
    assert.match(injection.messages[3].content, /^synthetic input\n\n<rphub_real_time_user>.*23:59:59/);
    assert.equal(injection.messages[4], base[3]);
    const rebuilt = clock.addReference(injection.messages, 2, second);
    assert.equal(marks(rebuilt.messages), 2);
    assert.equal((JSON.stringify(rebuilt.messages).match(/00:00:00/g) || []).length, 2);
    assert.equal(JSON.stringify(base), original);
});

test('image parts, native tool IDs and signatures survive; missing legitimate user slots use system only', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } };
    const user = { role: 'user', content: [image] };
    const call = { role: 'assistant', tool_calls: [{ id: 'synthetic-tool', thought_signature: 'unchanged' }] };
    const tool = { role: 'tool', tool_call_id: 'synthetic-tool', content: 'synthetic result' };
    const base = [pair[0], user, call, tool];
    const { messages } = clock.addReference(base, 1, first);
    assert.equal(messages[2].content[0], image);
    assert.equal(messages[2].content[1].type, 'text');
    assert.deepEqual(messages.slice(3), [call, tool]);
    const systemOnly = clock.addReference(base, -1, first);
    assert.equal(systemOnly.positions, 1);
    assert.equal(marks(systemOnly.messages), 1);
    assert.equal(systemOnly.messages[2], user);
});

function mockTransport(respond) {
    const sent = [];
    const context = vm.createContext({ window: {}, URL, AbortController, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        console: { info() {} }, fetch: async (url, options) => {
            assert.equal(new URL(url).hostname, 'mock.invalid');
            const body = options.body && JSON.parse(options.body);
            sent.push(body);
            return respond(body, sent.length);
        } });
    for (const name of ['built-in-content', 'core-utils', 'api-utils']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../assets/js/${name}.js`), 'utf8'), context);
    }
    return { sent, api: context.window.RPHubApiClient };
}
const mockChat = { url: 'https://mock.invalid/v1/chat/completions', apiKey: 'synthetic', model: 'test', messages: pair };
const jsonReply = content => Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

test('actual API serialization uses fresh time after the existing preparation hook on Gemini empty retries', async () => {
    const { api, sent } = mockTransport((_, call) => jsonReply(call === 1 ? '' : 'synthetic response'));
    const order = [];
    const response = await api.requestChatCompletion({ ...mockChat, replyInTool: true,
        onBeforeRequest: () => order.push('original-preparation'), mapRequestMessages: (base, attempt) => {
            order.push(attempt);
            return clock.addReference(base, 1, attempt === 1 ? first : second).messages;
        } });
    assert.equal(response.content, 'synthetic response');
    assert.deepEqual(order, ['original-preparation', 1, 'original-preparation', 2]);
    assert.deepEqual(sent.map(body => marks(body.messages)), [2, 2]);
    assert.match(JSON.stringify(sent[0]), /23:59:59/);
    assert.match(JSON.stringify(sent[1]), /00:00:00/);
    assert.doesNotMatch(JSON.stringify(sent[1]), /23:59:59/);
    assert.equal(marks(pair), 0);
});

test('plain auxiliary and vector requests bypass the timing hook even when serialized by the same client', async () => {
    const { api, sent } = mockTransport(() => jsonReply('synthetic response'));
    for (const kind of ['summary', 'secondary', 'ui_template']) await api.requestChatCompletion({ ...mockChat, model: kind });
    const vector = { model: 'synthetic-embed', input: ['synthetic text'] };
    await api.requestJson({ url: 'https://mock.invalid/v1/embeddings', apiKey: 'synthetic', body: vector });
    assert.deepEqual(sent.slice(0, 3).map(body => marks(body.messages)), [0, 0, 0]);
    assert.deepEqual(sent[3], vector);
});
