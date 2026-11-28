/* The device clock supplies real-time context; the story clock stays in the conversation. */
(function (root) {
    'use strict';
    const BEIJING = 'Asia/Shanghai';
    const defaults = Object.freeze({ version: 1, mode: 'beijing' });
    const legacyKey = 'rp_hub_real_time_external_v1';
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const pad = number => String(number).padStart(2, '0');
    const zoneSyntax = /^(?:UTC|[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+)$/;
    const formatters = new Map();
    const baseMessages = new WeakMap();

    function normalizePreference(value) {
        if (value?.version === 1 && value.mode === 'device') return { version: 1, mode: 'device' };
        if (value?.version === 1 && value.mode === 'manual') {
            const ianaZone = typeof value.ianaZone === 'string' ? value.ianaZone.trim().slice(0, 128) : '';
            return { version: 1, mode: 'manual', ianaZone };
        }
        return { ...defaults };
    }

    function formatter(timeZone) {
        if (formatters.has(timeZone)) return formatters.get(timeZone);
        const value = new Intl.DateTimeFormat('en-GB', {
            timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        if (formatters.size >= 16) formatters.delete(formatters.keys().next().value);
        formatters.set(timeZone, value);
        return value;
    }

    function isSupportedZone(zone) {
        if (typeof zone !== 'string' || zone.length > 128 || !zoneSyntax.test(zone)) return false;
        try { formatter(zone); return true; }
        catch (_) { return false; }
    }

    const localZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
    function capture(value, now = Date.now(), resolveDeviceZone = localZone) {
        const preference = normalizePreference(value);
        let zone = BEIJING, fallback = false;
        if (preference.mode === 'manual') {
            if (isSupportedZone(preference.ianaZone)) zone = preference.ianaZone;
            else fallback = true;
        } else if (preference.mode === 'device') {
            try {
                const deviceZone = resolveDeviceZone();
                if (!deviceZone) fallback = true;
                else { formatter(deviceZone); zone = deviceZone; }
            } catch (_) { fallback = true; }
        }
        const instant = Math.floor(now / 1000) * 1000;
        const fields = Object.fromEntries(formatter(zone).formatToParts(new Date(instant))
            .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
        const date = `${fields.year.padStart(4, '0')}-${fields.month}-${fields.day}`;
        const localMinute = `${date}T${fields.hour}:${fields.minute}`;
        // Interpret the wall-clock fields as UTC to find the offset at this instant, including DST.
        const wallClock = new Date(`${localMinute}:${fields.second}Z`);
        const offsetMinutes = Math.round((wallClock.getTime() - instant) / 60000);
        const time = `${date} ${weekdays[wallClock.getUTCDay()]} ${fields.hour}:${fields.minute}:${fields.second}`;
        return { mode: preference.mode, fallback, time,
            display: { version: 1, instant, zone, offsetMinutes, localMinute } };
    }

    function formatOffset(offsetMinutes) {
        const total = Math.abs(offsetMinutes);
        return `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
    }

    function formatHeading(display) {
        if (display?.version !== 1 || typeof display.localMinute !== 'string'
            || typeof display.zone !== 'string' || !/^[A-Za-z0-9_+./-]{1,128}$/.test(display.zone)
            || !Number.isSafeInteger(display.instant) || display.instant % 1000 !== 0
            || !Number.isInteger(display.offsetMinutes) || Math.abs(display.offsetMinutes) > 14 * 60) return '';
        const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(display.localMinute);
        if (!fields) return '';
        const wall = new Date(display.instant + display.offsetMinutes * 60000);
        if (!Number.isFinite(wall.getTime()) || wall.toISOString().slice(0, 16) !== display.localMinute) return '';
        return `【${fields[1]}年${fields[2]}月${fields[3]}日 ${weekdays[wall.getUTCDay()]} ${fields[4]}:${fields[5]}】`;
    }

    const describe = snap => `${snap.time}（${snap.display.zone}，UTC${formatOffset(snap.display.offsetMinutes)}）`;

    function addReference(messages, userIndex, snap) {
        // Retry builds always use the base. Passing our decorated array back here also replaces both slots.
        const base = baseMessages.get(messages) || messages;
        const result = base.slice();
        const reference = `当前现实时间：${describe(snap)}。这是本次发送时设备读取的时间，仅供角色参考。`
            + '保持角色口吻、当前场景和剧情时间；不要据此推进剧情或代替用户行动。'
            + '界面会显示现实时间，无需将这条现实时间标签写入正文。';
        const user = Number.isInteger(userIndex) ? base[userIndex] : null;
        const attach = user?.role === 'user' && (typeof user.content === 'string' || Array.isArray(user.content));
        if (attach) {
            const hint = `<rphub_real_time_user>${reference}</rphub_real_time_user>`;
            result[userIndex] = { ...user, content: Array.isArray(user.content)
                ? [...user.content, { type: 'text', text: hint }] : `${user.content}\n\n${hint}` };
        }
        const position = base.reduce((index, message, i) =>
            message.role === 'system' || message.role === 'developer' ? i + 1 : index, 0);
        result.splice(position, 0, { role: 'system', content: `<rphub_real_time_system>${reference}</rphub_real_time_system>` });
        baseMessages.set(result, base);
        return { messages: result, positions: attach ? 2 : 1 };
    }

    const api = Object.freeze({ defaults, legacyKey, normalizePreference, isSupportedZone, capture,
        describe, formatHeading, formatOffset, addReference });
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.RPHubRealTime = api;
})(typeof window === 'undefined' ? globalThis : window);
