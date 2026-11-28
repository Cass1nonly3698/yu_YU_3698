/* Full local backups. No network, model, push, or framework storage access. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.RPHubFullBackup = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
    'use strict';
    const FORMAT = 'RP-Hub encrypted backup', VERSION = 1, ITERATIONS = 600000;
    const MAX_BYTES = 128 * 1024 * 1024, MAX_FILE_BYTES = 180 * 1024 * 1024;
    const PENDING = 'rp_hub_full_backup_pending_v1', LOCK = 'rp-hub-local-data-v1';
    const JOURNAL = 'RPHubFullBackupJournal', MAIN = 'RPHubDB', LEGACY = 'SillyTavernDB';
    const GLOBAL = new Set(['characters', 'settings', 'presets', 'regex', 'global_regex', 'worldinfo',
        'global_worldinfo', 'worldinfo_settings', 'global_ui_templates', 'active_tools', 'user',
        'user_profiles', 'active_profile_id', 'last_active_char', 'memory_settings',
        'chat_preferences_v2', 'token_usage_history', 'proactive_v1']);
    const LOCAL = ['rphub-appearance', 'rp_hub_visual_cottage_v1', 'rp_hub_proactive_config_v1'];
    class BackupError extends Error {
        constructor(code, message) { super(message); this.name = 'BackupError'; this.code = code; }
    }
    const fail = (code, message) => { throw new BackupError(code, message); };
    const allowed = key => typeof key === 'string' && key.startsWith('rp_hub_') && (
        GLOBAL.has(key.slice(7)) || /^(?:chat|classic_memories|branches|mailbox_v2)_.+/.test(key.slice(7)));
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const b64 = bytes => {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
        return btoa(binary);
    };
    const BASE64 = new Int16Array(128).fill(-1);
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((char, index) => { BASE64[char.charCodeAt(0)] = index; });
    const unb64 = (text, stage = 'DATA_BASE64') => {
        const labels = { OUTER_SALT: '外层盐值', OUTER_IV: '外层初始向量', OUTER_CIPHER: '外层密文', MEMORY_VECTOR: '解密后的记忆向量', TYPED_BYTES: '解密后的类型化数据', BUFFER_BYTES: '解密后的字节数据' };
        const invalid = () => fail('FORMAT', `${labels[stage] || '数据'}编码无效（${stage}）；本次校验已停止`);
        if (typeof text !== 'string' || text.length % 4) invalid();
        const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
        const end = text.length - padding, bytes = new Uint8Array(text.length / 4 * 3 - padding);
        const sextet = index => { const code = text.charCodeAt(index); return code < 128 ? BASE64[code] : -1; };
        // Fixed work per quartet, no backtracking, giant binary string or per-character callback array.
        for (let i = 0, j = 0; i < text.length; i += 4) {
            const a = sextet(i), b = sextet(i + 1), c = i + 2 < end ? sextet(i + 2) : 0, d = i + 3 < end ? sextet(i + 3) : 0;
            if (a < 0 || b < 0 || c < 0 || d < 0) invalid();
            bytes[j++] = a << 2 | b >> 4;
            if (i + 2 < end) bytes[j++] = b << 4 | c >> 2;
            if (i + 3 < end) bytes[j++] = c << 6 | d;
        }
        return bytes;
    };
    // Tagged encoding preserves undefined, dates, typed arrays and literal object keys without collisions.
    function pack(value, depth = 0) {
        if (depth > 100) fail('FORMAT', '数据嵌套过深');
        if (value === null) return ['null'];
        if (value === undefined) return ['undefined'];
        if (['string', 'boolean', 'number'].includes(typeof value)) {
            if (typeof value === 'number' && !Number.isFinite(value)) fail('FORMAT', '不支持的数值格式');
            return [typeof value, value];
        }
        if (value instanceof Date) return ['date', value.toISOString()];
        if (value instanceof ArrayBuffer) return ['buffer', b64(new Uint8Array(value))];
        if (ArrayBuffer.isView(value)) {
            if (!['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array'].includes(value.constructor.name)) fail('FORMAT', '不支持的向量格式');
            return ['typed', value.constructor.name, b64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
        }
        if (Array.isArray(value)) return ['array', Array.from(value, item => pack(item, depth + 1))];
        if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
            return ['object', Object.keys(value).sort().map(key => [key, pack(value[key], depth + 1)])];
        }
        fail('FORMAT', '含有暂不支持的数据类型，未省略或转换');
    }
    function unpack(value, depth = 0) {
        if (depth > 100 || !Array.isArray(value)) fail('FORMAT', '数据结构无效');
        const [tag, data] = value;
        if (tag === 'null' && value.length === 1) return null;
        if (tag === 'undefined' && value.length === 1) return undefined;
        if (['string', 'boolean', 'number'].includes(tag) && value.length === 2 && typeof data === tag && (tag !== 'number' || Number.isFinite(data))) return data;
        if (tag === 'date' && value.length === 2 && typeof data === 'string' && Number.isFinite(Date.parse(data))) return new Date(data);
        if (tag === 'buffer' && value.length === 2) return unb64(data, 'BUFFER_BYTES').buffer;
        if (tag === 'typed' && value.length === 3) {
            const types = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };
            if (!Object.hasOwn(types, data)) fail('FORMAT', '未知的向量类型');
            const bytes = unb64(value[2], 'TYPED_BYTES');
            if (bytes.length % types[data].BYTES_PER_ELEMENT) fail('FORMAT', '向量字节长度无效');
            return new types[data](bytes.buffer);
        }
        if (tag === 'array' && value.length === 2 && Array.isArray(data)) return data.map(item => unpack(item, depth + 1));
        if (tag === 'object' && value.length === 2 && Array.isArray(data)) {
            const seen = new Set();
            return Object.fromEntries(data.map(pair => {
                if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || seen.has(pair[0])) fail('FORMAT', '对象字段无效或重复');
                seen.add(pair[0]); return [pair[0], unpack(pair[1], depth + 1)];
            }));
        }
        fail('FORMAT', '未知的数据格式');
    }
    const canonical = value => JSON.stringify(pack(value));
    const same = (a, b) => canonical(a) === canonical(b);
    const logical = key => key.startsWith('silly_tavern_') ? 'rp_hub_' + key.slice(13) : key;
    function counts(snapshot) {
        const out = { characters: 0, branches: 0, messages: 0, summaries: 0, compressed: 0, vectors: 0, worldinfo: 0, presets: 0, letters: 0, records: snapshot.records.length };
        const memories = list => { for (const m of list) { out.summaries++; if (m.secondaryCompressed) out.compressed++; if (m.embeddingQ || m.embedding?.length) out.vectors++; if (Array.isArray(m.sourceMemories)) memories(m.sourceMemories); } };
        for (const { key, value } of snapshot.records) {
            if (key === 'rp_hub_characters') { out.characters = value.length; for (const c of value) out.worldinfo += c.worldInfo?.length || 0; }
            else if (key.startsWith('rp_hub_chat_') && key !== 'rp_hub_chat_preferences_v2') out.messages += value.length;
            else if (key.startsWith('rp_hub_branches_')) out.branches += value.branches?.length || 0;
            else if (key.startsWith('rp_hub_classic_memories_')) memories(value);
            else if (key.startsWith('rp_hub_mailbox_v2_')) out.letters += value.length;
            else if (key === 'rp_hub_presets') out.presets = value.length;
            else if (key === 'rp_hub_global_worldinfo') out.worldinfo += value.length;
        }
        return out;
    }
    function validate(snapshot) {
        if (!object(snapshot) || snapshot.schema !== 1 || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.local)) fail('FORMAT', '未知备份版本或结构');
        if (Object.keys(snapshot).sort().join(',') !== 'local,records,schema') fail('FORMAT', '备份含未知的数据分区');
        if (snapshot.records.length > 100000 || snapshot.local.length > LOCAL.length) fail('FORMAT', '记录数量异常');
        const seen = new Set(), locals = new Set(), records = new Map();
        for (const r of snapshot.records) {
            if (!object(r) || Object.keys(r).some(k => !['key', 'value'].includes(k)) || !allowed(r.key) || seen.has(r.key)) fail('FORMAT', '含有未知、受保护或重复的数据键');
            seen.add(r.key); records.set(r.key, r.value); pack(r.value);
        }
        for (const r of snapshot.local) {
            if (!object(r) || Object.keys(r).some(k => !['key', 'value'].includes(k)) || !LOCAL.includes(r.key) || locals.has(r.key) || typeof r.value !== 'string') fail('FORMAT', '本地设置格式无效');
            locals.add(r.key);
        }
        const chars = records.get('rp_hub_characters') || [];
        if (!Array.isArray(chars)) fail('FORMAT', '角色清单无效');
        const owners = new Set();
        for (const c of chars) {
            if (!object(c) || typeof c.uuid !== 'string' || !c.uuid || c.uuid.includes('__branch__') || owners.has(c.uuid)) fail('FORMAT', '角色 UUID 缺失或重复，不能重建身份');
            owners.add(c.uuid);
        }
        const arrayNames = new Set(['presets', 'regex', 'global_regex', 'worldinfo', 'global_worldinfo', 'global_ui_templates', 'active_tools', 'user_profiles', 'token_usage_history']);
        for (const [key, value] of records) {
            const name = key.slice(7);
            if (arrayNames.has(name) && !Array.isArray(value)) fail('FORMAT', '条目集合格式无效');
            if (['settings', 'user', 'memory_settings', 'chat_preferences_v2', 'worldinfo_settings', 'proactive_v1'].includes(name) && !object(value)) fail('FORMAT', '设置记录格式无效');
            if (GLOBAL.has(name)) continue;
            const m = /^(chat|classic_memories|branches|mailbox_v2)_(.+)$/.exec(name);
            const scope = m[2], owner = scope.split('__branch__')[0];
            if (!owners.has(owner)) fail('FORMAT', '资料没有对应的角色 UUID');
            if (m[1] === 'branches') {
                if (!object(value) || !Array.isArray(value.branches) || new Set(value.branches.map(b => b?.id)).size !== value.branches.length) fail('FORMAT', '分支清单无效或重复');
                continue;
            }
            if (!Array.isArray(value) || value.some(v => !object(v))) fail('FORMAT', '消息或记忆集合无效');
            const ids = value.map(v => v.id).filter(Boolean);
            if (new Set(ids).size !== ids.length) fail('FORMAT', '消息或记忆 ID 重复');
            if (m[1] === 'classic_memories') {
                const chat = records.get('rp_hub_chat_' + scope);
                if (!Array.isArray(chat)) fail('FORMAT', '记忆缺少同分支原文');
                const messageIds = new Set(chat.map(v => v.id).filter(Boolean));
                const check = list => list.forEach(memory => {
                    if (!object(memory) || typeof memory.summary !== 'string') fail('FORMAT', '记忆正文格式无效');
                    for (const source of [...(memory.sourceUserIds || []), ...(memory.sourceAssistantIds || [])]) if (!messageIds.has(source)) fail('FORMAT', '记忆来源消息缺失，请先核查源数据');
                    if (memory.embeddingQ !== undefined && (memory.embeddingEncoding !== 'int8:maxabs:v1' || unb64(memory.embeddingQ, 'MEMORY_VECTOR').length !== memory.embeddingDims || !(memory.embeddingScale > 0))) fail('FORMAT', '记忆向量编码或维度无效（MEMORY_VECTOR_SHAPE）');
                    if (memory.sourceMemories !== undefined) { if (!Array.isArray(memory.sourceMemories)) fail('FORMAT', '二次记忆来源无效'); check(memory.sourceMemories); }
                });
                check(value);
            }
        }
        return snapshot;
    }
    function create(options = {}) {
        const env = { indexedDB: globalThis.indexedDB, localStorage: globalThis.localStorage,
            crypto: globalThis.crypto, locks: globalThis.navigator?.locks,
            estimate: () => globalThis.navigator?.storage?.estimate?.(), ...options };
        const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
        const hash = async value => b64(new Uint8Array(await env.crypto.subtle.digest('SHA-256', encoder.encode(canonical(value)))));
        const fingerprint = s => hash({ records: [...s.records].sort((a, b) => a.key.localeCompare(b.key)), local: [...s.local].sort((a, b) => a.key.localeCompare(b.key)) });
        async function exclusive(fn) {
            if (!env.locks?.request) fail('LOCK_UNAVAILABLE', '此浏览器缺少安全恢复所需的跨窗口锁，请先升级浏览器');
            return env.locks.request(LOCK, { mode: 'exclusive', ifAvailable: true }, lock => {
                if (!lock) fail('BUSY', '请关闭其他新家窗口或正在运行的备份，再重试');
                return fn();
            });
        }
        function openDB(name, createJournal = false) {
            return new Promise((resolve, reject) => {
                const r = createJournal ? env.indexedDB.open(name, 1) : env.indexedDB.open(name);
                r.onupgradeneeded = () => { if (createJournal) r.result.createObjectStore('jobs', { keyPath: 'id' }); else r.transaction.abort(); };
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(new BackupError('DATABASE', '无法安全打开已有数据库'));
                r.onblocked = () => reject(new BackupError('BUSY', '数据库被其他窗口占用'));
            });
        }
        async function exists(name) {
            if (!env.indexedDB?.databases) fail('DATABASE_LIST', '浏览器不支持安全枚举数据库，未打开或创建数据');
            return (await env.indexedDB.databases()).some(db => db.name === name);
        }
        async function read(name) {
            if (!await exists(name)) return [];
            const db = await openDB(name);
            try {
                if (!db.objectStoreNames.contains('store')) fail('FORMAT', '数据库缺少预期的数据表');
                return await new Promise((resolve, reject) => {
                    const tx = db.transaction('store', 'readonly'), result = [];
                    const r = tx.objectStore('store').openCursor();
                    r.onsuccess = () => { const cursor = r.result; if (cursor) { result.push({ key: cursor.key, value: cursor.value }); cursor.continue(); } };
                    tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(new BackupError('DATABASE', '只读资料检查失败'));
                });
            } finally { db.close(); }
        }
        async function capture() {
            const primary = await read(MAIN), legacy = await read(LEGACY), merged = new Map();
            for (const record of [...legacy, ...primary]) {
                const key = logical(record.key);
                if (!allowed(key)) fail('UNKNOWN_KEY', '发现未支持的数据键；为防遗漏，已停止备份或预检');
                merged.set(key, { key, value: record.value });
            }
            const local = LOCAL.flatMap(key => { const value = env.localStorage.getItem(key); return value === null ? [] : [{ key, value }]; });
            return validate({ schema: 1, records: [...merged.values()].sort((a, b) => a.key.localeCompare(b.key)), local });
        }
        async function keyFor(password, salt) {
            if (typeof password !== 'string' || password.length < 10 || password.length > 1024) fail('PASSWORD', '密码至少 10 个字符，请妥善保管');
            const material = await env.crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
            return env.crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        }
        const aad = e => encoder.encode(JSON.stringify([e.format, e.version, e.kind, e.iterations, e.salt, e.iv]));
        async function seal(value, password, kind) {
            const plain = encoder.encode(canonical(value));
            if (plain.length > MAX_BYTES * (kind === 'journal' ? 4 : 1)) fail('SIZE', '完整数据或回退记录超过本版安全处理上限，未截断或省略');
            const salt = env.crypto.getRandomValues(new Uint8Array(16)), iv = env.crypto.getRandomValues(new Uint8Array(12));
            const envelope = { format: FORMAT, version: VERSION, kind, iterations: ITERATIONS, salt: b64(salt), iv: b64(iv) };
            const key = await keyFor(password, salt);
            const cipher = await env.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(envelope), tagLength: 128 }, key, plain);
            return JSON.stringify({ ...envelope, cipher: b64(new Uint8Array(cipher)) });
        }
        async function unseal(text, password, kind) {
            if (typeof text !== 'string' || text.length > MAX_FILE_BYTES * (kind === 'journal' ? 4 : 1)) fail('SIZE', '文件过大或不是完整备份文件');
            let e;
            try { e = JSON.parse(text); } catch (_) { fail('FORMAT', '文件损坏或不是完整备份格式（FILE_JSON）'); }
            if (!object(e) || Object.keys(e).sort().join(',') !== 'cipher,format,iterations,iv,kind,salt,version' || e.format !== FORMAT || e.version !== VERSION || e.kind !== kind || e.iterations !== ITERATIONS) fail('FORMAT', '未知文件版本或加密参数，未尝试恢复');
            if (typeof e.salt === 'string' && e.salt.length !== 24) fail('FORMAT', '外层盐值长度无效（OUTER_SALT_LENGTH）');
            if (typeof e.iv === 'string' && e.iv.length !== 16) fail('FORMAT', '外层初始向量长度无效（OUTER_IV_LENGTH）');
            if (typeof e.cipher === 'string' && e.cipher.length > Math.ceil((MAX_BYTES * (kind === 'journal' ? 4 : 1) + 16) / 3) * 4) fail('FORMAT', '外层密文长度无效（OUTER_CIPHER_LENGTH）');
            const salt = unb64(e.salt, 'OUTER_SALT'), iv = unb64(e.iv, 'OUTER_IV'), cipher = unb64(e.cipher, 'OUTER_CIPHER');
            if (salt.length !== 16) fail('FORMAT', '外层盐值长度无效（OUTER_SALT_LENGTH）');
            if (iv.length !== 12) fail('FORMAT', '外层初始向量长度无效（OUTER_IV_LENGTH）');
            if (cipher.length < 16 || cipher.length > MAX_BYTES * (kind === 'journal' ? 4 : 1) + 16) fail('FORMAT', '外层密文长度无效（OUTER_CIPHER_LENGTH）');
            const key = await keyFor(password, salt);
            let plain;
            try { plain = await env.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(e), tagLength: 128 }, key, cipher); }
            catch (_) { fail('DECRYPT', '密码错误或文件已损坏（GCM_AUTH）；未写入任何资料'); }
            try { return unpack(JSON.parse(decoder.decode(plain))); }
            catch (error) { if (error?.name === 'BackupError') throw error; fail('FORMAT', '解密后的数据格式无效（CONTENT_JSON）'); }
        }
        async function backup(password) {
            return exclusive(async () => {
                if (env.localStorage.getItem(PENDING)) fail('PENDING', '请先处理上次未完成的恢复');
                const data = await capture();
                const archive = { formatVersion: 1, snapshotId: env.crypto.randomUUID(), createdAt: Date.now(), sourceVersion: '2e42cec', data, digest: await fingerprint(data) };
                return { text: await seal(archive, password, 'backup'), counts: counts(data), snapshotId: archive.snapshotId };
            });
        }
        async function decrypt(text, password) {
            const archive = await unseal(text, password, 'backup');
            if (!object(archive) || Object.keys(archive).sort().join(',') !== 'createdAt,data,digest,formatVersion,snapshotId,sourceVersion' || archive.formatVersion !== 1 || typeof archive.snapshotId !== 'string' || !Number.isSafeInteger(archive.createdAt)) fail('FORMAT', '未知备份内容版本');
            validate(archive.data);
            if (await fingerprint(archive.data) !== archive.digest) fail('INTEGRITY', '资料完整性校验未通过（CONTENT_DIGEST）');
            return archive;
        }
        function merge(target, incoming) {
            const records = new Map(target.records.map(r => [r.key, r.value]));
            const incomingKeys = new Set(incoming.records.map(r => r.key));
            for (const r of incoming.records) {
                let value = r.value, prior = records.get(r.key);
                if (r.key.startsWith('rp_hub_chat_') && r.key !== 'rp_hub_chat_preferences_v2' && prior !== undefined && !same(prior, value)) {
                    const memoryKey = 'rp_hub_classic_memories_' + r.key.slice('rp_hub_chat_'.length);
                    if (!incomingKeys.has(memoryKey) && records.has(memoryKey)) records.set(memoryKey, []);
                }
                if (r.key === 'rp_hub_characters' && Array.isArray(prior)) {
                    const ids = new Set(value.map(c => c.uuid)); value = [...value, ...prior.filter(c => !ids.has(c.uuid))];
                }
                if (r.key.startsWith('rp_hub_branches_') && prior?.branches && value?.branches) {
                    const ids = new Set(value.branches.map(b => b.id)); value = { ...value, branches: [...value.branches, ...prior.branches.filter(b => !ids.has(b.id))] };
                }
                if (r.key.startsWith('rp_hub_mailbox_v2_') && Array.isArray(prior)) {
                    const ids = new Set(value.map(m => m.id)); value = [...value, ...prior.filter(m => !ids.has(m.id))];
                }
                records.set(r.key, value);
            }
            const local = new Map(target.local.map(r => [r.key, r.value]));
            incoming.local.forEach(r => local.set(r.key, r.value));
            return validate({ schema: 1, records: [...records].map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key)), local: [...local].map(([key, value]) => ({ key, value })) });
        }
        async function preflight(archive) {
            return exclusive(async () => {
                if (env.localStorage.getItem(PENDING)) fail('PENDING', '请先处理上次未完成的恢复');
                validate(archive.data);
                if (await fingerprint(archive.data) !== archive.digest) fail('INTEGRITY', '备份已被改动');
                const before = await capture(), after = merge(before, archive.data), changes = [];
                for (const type of ['records', 'local']) {
                    const old = new Map(before[type].map(r => [r.key, r.value]));
                    for (const r of after[type]) if (!old.has(r.key) || !same(old.get(r.key), r.value)) changes.push({ key: r.key, type, conflict: old.has(r.key) });
                }
                const plan = { archive, targetDigest: await fingerprint(before), afterDigest: await fingerprint(after), changes, counts: counts(archive.data) };
                const estimate = await env.estimate?.();
                const available = estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) ? Math.max(0, estimate.quota - estimate.usage) : null;
                const required = changes.length ? encoder.encode(canonical({ before, after })).length * 3 + 65536 : 0;
                if (available !== null && available < required) fail('QUOTA', '预检发现可用空间不足以保留加密回退记录，未开始恢复');
                plan.capacity = { available, required };
                plan.planDigest = await hash({ source: archive.digest, target: plan.targetDigest, after: plan.afterDigest, changes });
                return plan;
            });
        }
        async function journal(action, record) {
            const db = await openDB(JOURNAL, true);
            try { return await new Promise((resolve, reject) => {
                const tx = action === 'get' ? db.transaction('jobs', 'readonly') : db.transaction('jobs', 'readwrite', { durability: 'strict' }), store = tx.objectStore('jobs');
                const req = action === 'get' ? store.get(record) : action === 'put' ? store.put(record) : store.delete(record);
                tx.oncomplete = () => resolve(req.result); tx.onerror = tx.onabort = () => reject(new BackupError('JOURNAL', '加密回退记录未能安全保存或读取'));
            }); } finally { db.close(); }
        }
        async function writeMain(entries) {
            let db;
            if (await exists(MAIN)) db = await openDB(MAIN);
            else db = await new Promise((resolve, reject) => {
                const r = env.indexedDB.open(MAIN, 1); r.onupgradeneeded = () => r.result.createObjectStore('store');
                r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new BackupError('DATABASE', '无法创建新家资料库'));
            });
            try { await new Promise((resolve, reject) => {
                const tx = db.transaction('store', 'readwrite', { durability: 'strict' }), store = tx.objectStore('store');
                try { for (const r of entries) r.absent ? store.delete(r.key) : store.put(r.value, r.key); }
                catch (_) { tx.abort(); reject(new BackupError('WRITE', '资料事务未提交，可能空间不足')); }
                tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(new BackupError('WRITE', '资料写入失败或存储空间不足'));
            }); } finally { db.close(); }
        }
        const point = async name => { if (env.failpoint) await env.failpoint(name); };
        async function compatible(job) {
            const current = await capture();
            for (const type of ['records', 'local']) {
                const old = new Map(job.before[type].map(r => [r.key, r.value])), next = new Map(job.after[type].map(r => [r.key, r.value]));
                const actual = new Map(current[type].map(r => [r.key, r.value]));
                for (const key of new Set([...old.keys(), ...next.keys(), ...actual.keys()])) {
                    const is = map => actual.has(key) === map.has(key) && (!actual.has(key) || same(actual.get(key), map.get(key)));
                    if (!is(old) && !is(next)) fail('CHANGED', '恢复期间资料发生额外变化；已保留现场，请勿继续聊天');
                }
            }
        }
        async function finish(job) {
            // Keep the encrypted journal until verification and both storage phases have succeeded.
            env.localStorage.removeItem(PENDING);
            // A crash here only leaves an encrypted, inactive journal, never a missing active rollback.
            try { await journal('delete', job.id); } catch (_) { /* No active restore remains. */ }
        }
        async function rollback(job) {
            await compatible(job);
            await writeMain(job.undo);
            for (const r of job.undoLocal) r.absent ? env.localStorage.removeItem(r.key) : env.localStorage.setItem(r.key, r.value);
            if (await fingerprint(await capture()) !== job.beforeDigest) fail('VERIFY', '回退核对未通过，请保留恢复记录');
            await finish(job);
            return { status: 'rolled-back' };
        }
        async function apply(job) {
            await compatible(job);
            await point('before-main');
            await writeMain(job.writes);
            await point('after-main');
            for (const r of job.writesLocal) env.localStorage.setItem(r.key, r.value);
            await point('after-local');
            if (await fingerprint(await capture()) !== job.afterDigest) fail('VERIFY', '恢复后的逐项一致性核对失败');
            await point('after-verify');
            await finish(job);
            return { status: 'verified', counts: counts(job.after) };
        }
        async function restore(plan, password, confirmation = {}) {
            return exclusive(async () => {
                if (env.localStorage.getItem(PENDING)) fail('PENDING', '请先处理上次未完成的恢复');
                if (confirmation.planDigest !== plan.planDigest || (plan.changes.some(c => c.conflict) && confirmation.replaceConflicts !== true)) fail('CONFIRM', '请核对预检结果并明确确认冲突替换');
                if (await fingerprint(plan.archive.data) !== plan.archive.digest) fail('INTEGRITY', '备份已被改动');
                const before = await capture();
                if (await fingerprint(before) !== plan.targetDigest) fail('STALE', '预检后目标资料已变化，请重新预检');
                const after = merge(before, plan.archive.data);
                if (await fingerprint(after) !== plan.afterDigest) fail('INTEGRITY', '恢复计划不匹配');
                const expectedChanges = [];
                for (const type of ['records', 'local']) {
                    const old = new Map(before[type].map(r => [r.key, r.value]));
                    for (const r of after[type]) if (!old.has(r.key) || !same(old.get(r.key), r.value)) expectedChanges.push({ key: r.key, type, conflict: old.has(r.key) });
                }
                if (!same(expectedChanges, plan.changes) || await hash({ source: plan.archive.digest, target: plan.targetDigest, after: plan.afterDigest, changes: expectedChanges }) !== plan.planDigest) fail('INTEGRITY', '预检确认清单已变化');
                if (!plan.changes.length) return { status: 'unchanged', counts: counts(after) };
                const raw = new Map((await read(MAIN)).map(r => [r.key, r.value]));
                const job = { id: env.crypto.randomUUID(), before, after, beforeDigest: plan.targetDigest, afterDigest: plan.afterDigest,
                    writes: plan.changes.filter(c => c.type === 'records').map(c => after.records.find(r => r.key === c.key)),
                    writesLocal: plan.changes.filter(c => c.type === 'local').map(c => after.local.find(r => r.key === c.key)),
                    undo: plan.changes.filter(c => c.type === 'records').map(c => raw.has(c.key) ? { key: c.key, value: raw.get(c.key) } : { key: c.key, absent: true }),
                    undoLocal: plan.changes.filter(c => c.type === 'local').map(c => { const value = env.localStorage.getItem(c.key); return value === null ? { key: c.key, absent: true } : { key: c.key, value }; }) };
                const envelope = await seal(job, password, 'journal');
                const estimate = await env.estimate?.();
                if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) && estimate.quota - estimate.usage < encoder.encode(envelope).length + encoder.encode(canonical(job.writes)).length) fail('QUOTA', '可用空间不足以同时保留资料与加密回退记录，未开始恢复');
                await journal('put', { id: job.id, envelope });
                try { env.localStorage.setItem(PENDING, job.id); } catch (_) { await journal('delete', job.id); fail('QUOTA', '无法保存恢复状态，未开始恢复'); }
                try { return await apply(job); }
                catch (error) {
                    if (error.code === 'SIMULATED_CRASH') throw error;
                    try { await rollback(job); } catch (_) { fail('RECOVERY_REQUIRED', '恢复未完成；加密回退记录已保留，请使用同一密码继续或回退'); }
                    fail('ROLLED_BACK', '恢复未完成，已核对并回退到恢复前资料；原推送身份未触碰');
                }
            });
        }
        async function recover(password, mode = 'resume') {
            return exclusive(async () => {
                if (!['resume', 'rollback'].includes(mode)) fail('FORMAT', '恢复操作无效');
                const id = env.localStorage.getItem(PENDING);
                if (!id) return { status: 'nothing-pending' };
                const saved = await journal('get', id);
                if (!saved) fail('JOURNAL', '恢复记录缺失，请保留当前资料及原备份文件');
                const job = await unseal(saved.envelope, password, 'journal');
                if (job.id !== id) fail('INTEGRITY', '恢复记录标识不匹配');
                return mode === 'rollback' ? rollback(job) : apply(job);
            });
        }
        return Object.freeze({ backup, decrypt, preflight, restore, recover, capture, fingerprint, pending: () => env.localStorage.getItem(PENDING) });
    }
    return Object.freeze({ create, pack, unpack, validate, counts, allowed, constants: { PENDING, LOCK, MAX_BYTES, MAX_FILE_BYTES, ITERATIONS } });
});
