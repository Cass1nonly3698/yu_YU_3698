// Run with WebKit's JavaScriptCore `jsc` from the repository root. Only synthetic zero bytes.
load('assets/js/full-backup.js');
const rows = [];
for (const mib of [20, 30, 50]) {
    (function () {
        const count = mib * 1048576, padding = (3 - count % 3) % 3;
        let text = 'A'.repeat(Math.ceil(count / 3) * 4 - padding) + '='.repeat(padding);
        const legacy = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text);
        const start = Date.now(), bytes = new Uint8Array(RPHubFullBackup.unpack(['buffer', text]));
        if (bytes.length !== count || bytes.some(value => value !== 0)) throw new Error('Decoded synthetic bytes differ');
        let rejected = false;
        try { RPHubFullBackup.unpack(['buffer', text.slice(0, text.length - 4) + '!AAA']); }
        catch (error) { rejected = error.code === 'FORMAT' && error.message.includes('BUFFER_BYTES'); }
        if (!rejected) throw new Error('Malformed tail accepted');
        rows.push({ decodedMiB: mib, encodedCharacters: text.length, legacyRegexpMatched: legacy, fixedDecodedBytes: bytes.length, allBytesEqual: true, malformedTailRejected: true, elapsedMs: Date.now() - start });
    })();
    if (typeof gc === 'function') gc();
}
print(JSON.stringify({ engine: 'WebKit JavaScriptCore', syntheticOnly: true, rows }));
