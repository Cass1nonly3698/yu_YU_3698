/* Device-local decoration. Media never enters the chat settings or backup stores. */
(function () {
    'use strict';

    const MAX_BYTES = 5 * 1024 * 1024;
    const MAX_SECONDS = 5;
    const DATABASE = 'RPHubLocalOpening';
    const STORE = 'media';
    const entryKey = new URL('.', location.href).pathname;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const videoType = 'video/mp4';

    function openStore(create) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE, 1);
            let missing = false;
            let blocked = false;
            request.onupgradeneeded = () => {
                if (create) request.result.createObjectStore(STORE);
                else {
                    missing = true;
                    request.transaction.abort();
                }
            };
            request.onblocked = () => {
                blocked = true;
                reject(new Error('Opening media database is busy'));
            };
            request.onerror = () => missing ? resolve(null) : reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                if (blocked) db.close();
                else resolve(db);
            };
        });
    }

    async function mediaTransaction(mode, action, create = false) {
        const db = await openStore(create);
        if (!db) return null;
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, mode);
                const request = action(tx.objectStore(STORE));
                tx.oncomplete = () => resolve(request.result);
                tx.onabort = () => reject(tx.error || request.error || new Error('Opening media transaction aborted'));
            });
        } finally {
            db.close();
        }
    }

    const savedMedia = () => mediaTransaction('readonly', store => store.get(entryKey));
    const validDuration = seconds => Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_SECONDS;
    const validRecord = record => record?.version === 1 && record.blob instanceof Blob
        && record.blob.type === videoType && record.blob.size > 0 && record.blob.size <= MAX_BYTES
        && validDuration(record.duration);

    const startupTrace = Object.create(null);
    const CHAT_HANDOFF_MS = 1200;

    function startupBlock(overlay) {
        if (reducedMotion.matches) return 'reduced-motion';
        if ('skip' in overlay.dataset) return 'interaction';
        try {
            return localStorage.getItem('rp_hub_full_backup_pending_v1') ? 'restore-pending' : '';
        } catch (_) {
            return 'storage-unavailable';
        }
    }

    function releaseVideo(video, url) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    }

    async function startOpening(overlay) {
        const startedAt = Number(overlay.dataset.startedAt);
        const deadline = startedAt + Number(overlay.dataset.startupBudget);
        const mark = label => { startupTrace[label] ??= Math.round(performance.now() - startedAt); };
        mark('script');
        const blocked = startupBlock(overlay);
        if (blocked || !Number.isFinite(deadline) || performance.now() >= deadline) {
            startupTrace.result = blocked || 'script-timeout';
            return;
        }

        const video = overlay.querySelector('video');
        const events = new AbortController();
        const options = { signal:events.signal };
        let phase = 'reading';
        let record;
        let url;
        let frameRequest;
        let playAccepted = false;
        const startupTimeout = {
            reading:'idb-timeout', 'waiting-visible':'visibility-timeout', starting:'first-frame-timeout'
        };
        let timer = setTimeout(() => hide(startupTimeout[phase]), deadline - performance.now());

        function hide(reason) {
            if (phase === 'closed') return;
            startupTrace.exitPhase = phase;
            startupTrace.readyState = video.readyState;
            startupTrace.mediaMs = Math.round(video.currentTime * 1000);
            phase = 'closed';
            startupTrace.result = reason;
            mark('closed');
            events.abort();
            clearTimeout(timer);
            if (frameRequest !== undefined) video.cancelVideoFrameCallback?.(frameRequest);
            overlay.hidden = true;
            overlay.classList.remove('is-playing', 'is-fading');
            if (url) releaseVideo(video, url);
        }

        function reveal() {
            if (phase !== 'starting' || !playAccepted || video.paused
                || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
            const blocked = startupBlock(overlay);
            const expired = performance.now() >= deadline;
            if (blocked || expired || !validDuration(video.duration)) {
                hide(blocked || (expired ? 'first-frame-timeout' : 'duration'));
                return;
            }
            if (document.visibilityState !== 'visible') {
                hide('hidden');
                return;
            }
            phase = 'playing';
            mark('first-frame');
            clearTimeout(timer);
            overlay.classList.add('is-playing');
            timer = setTimeout(() => hide('playback-timeout'), video.duration * 1000 + 650);
        }

        async function playWhenVisible() {
            if (phase !== 'waiting-visible' || document.visibilityState !== 'visible') return;
            const blocked = startupBlock(overlay);
            if (blocked || performance.now() >= deadline) {
                hide(blocked || 'visibility-timeout');
                return;
            }
            phase = 'starting';
            try {
                url = URL.createObjectURL(record.blob);
                overlay.hidden = false;
                video.muted = true;
                video.playsInline = true;
                video.src = url;
                // Observe presentation for diagnosis, never gate visibility on this callback.
                if (video.requestVideoFrameCallback) {
                    frameRequest = video.requestVideoFrameCallback(() => {
                        frameRequest = undefined;
                        mark('presented-frame');
                    });
                }
                mark('play-request');
                await video.play();
                if (phase !== 'starting') return;
                mark('play-accepted');
                playAccepted = true;
                // Decoding can succeed before the browser schedules a presentation callback.
                reveal();
            } catch (error) {
                if (phase === 'closed') return;
                const name = error?.name;
                startupTrace.playError = ['NotAllowedError', 'NotSupportedError', 'AbortError'].includes(name) ? name : 'Other';
                hide('play-rejected');
            }
        }

        function finish() {
            if (phase !== 'playing' || reducedMotion.matches) {
                hide('ended-before-display');
                return;
            }
            mark('ended');
            clearTimeout(timer);
            phase = 'handoff';
            if (performance.getEntriesByName('rphub-chat-startup-ready').length) fade();
            else {
                mark('handoff-wait');
                // Keep the last frame briefly while chat renders; never hold initialization.
                timer = setTimeout(() => fade(true), CHAT_HANDOFF_MS);
            }
        }

        function fade(timedOut = false) {
            if (phase !== 'handoff') return;
            phase = 'fading';
            clearTimeout(timer);
            if (timedOut) mark('handoff-timeout');
            mark('fade');
            overlay.classList.add('is-fading');
            timer = setTimeout(() => hide('played'), 300);
        }

        document.addEventListener('rphub-chat-startup-ready', () => fade(), options);
        window.addEventListener('pagehide', () => hide('page-hidden'), options);
        reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) hide('reduced-motion'); }, options);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') playWhenVisible();
            else if (['starting', 'playing', 'handoff', 'fading'].includes(phase)) hide('hidden');
        }, options);
        for (const name of ['pointerdown', 'keydown']) {
            document.addEventListener(name, event => {
                if (event.isTrusted && event.target?.closest?.('#app')) hide('interaction');
            }, { ...options, capture:true });
        }
        video.addEventListener('loadedmetadata', () => mark('metadata'), options);
        video.addEventListener('loadeddata', () => { mark('decoded-frame'); reveal(); }, options);
        video.addEventListener('playing', () => { mark('playing-event'); reveal(); }, options);
        video.addEventListener('error', () => {
            startupTrace.mediaError = video.error?.code;
            hide('media-error');
        }, options);
        video.addEventListener('pause', () => { if (phase === 'playing' && !video.ended) hide('pause'); }, options);
        // A stalled notification is not a terminal decoder error. The playback watchdog stays armed.
        video.addEventListener('stalled', () => mark('stalled'), options);
        video.addEventListener('ended', finish, options);
        overlay.addEventListener('transitionend', event => {
            if (event.target === overlay && event.propertyName === 'opacity' && phase === 'fading') hide('played');
        }, options);

        mark('idb-request');
        try {
            record = await savedMedia();
        } catch (_) {
            hide('idb-error');
            return;
        }
        if (phase !== 'reading') return;
        mark('idb-result');
        if (!validRecord(record)) {
            hide(record ? 'invalid-record' : 'no-video');
            return;
        }
        if (performance.now() >= deadline) {
            hide('idb-timeout');
            return;
        }
        phase = 'waiting-visible';
        if (document.visibilityState !== 'visible') mark('waiting-visible');
        await playWhenVisible();
    }

    function openingDiagnostics(overlay) {
        const elapsed = performance.getEntriesByName('rphub-chat-startup-ready')[0]?.startTime;
        const chatReady = Number.isFinite(elapsed) ? Math.round(elapsed - Number(overlay.dataset.startedAt)) : 'pending';
        const reasons = {
            'played':'已播放', 'no-video':'未设置视频', 'script-timeout':'播放器加载超时',
            'visibility-timeout':'页面未及时进入前台', 'first-frame-timeout':'视频首帧超时',
            'idb-timeout':'读取视频超时', 'idb-error':'读取视频失败', 'play-rejected':'浏览器拒绝启动视频',
            'media-error':'媒体解码失败', 'interaction':'操作小家时取消', 'reduced-motion':'已启用减少动态效果',
            'hidden':'页面切到后台', 'page-hidden':'已离开页面', 'restore-pending':'等待资料恢复',
            'storage-unavailable':'本地存储暂不可用', 'invalid-record':'本地视频记录无效',
            'playback-timeout':'播放未及时结束', 'ended-before-display':'视频提前结束',
            'duration':'视频时长不符合要求', 'pause':'播放暂停', 'stalled':'播放停滞'
        };
        const { result, ...timing } = startupTrace;
        return [
            `本次开场 · ${reasons[result] || result || '处理中'}`,
            `诊断 v3 · 首帧上限 ${overlay.dataset.startupBudget}ms · 聊天衔接上限 ${CHAT_HANDOFF_MS}ms`,
            `前台 ${document.visibilityState} · PWA ${matchMedia('(display-mode: standalone)').matches || navigator.standalone === true} · 减少动态效果 ${reducedMotion.matches}`,
            '时间点为毫秒（从开场初始化起）；first-frame 表示可解码画面，presented-frame 表示帧回调',
            ...Object.entries(timing).map(([label, value]) => `${label} ${value}`),
            `chat-ready ${chatReady}`
        ].join('\n');
    }

    async function isMp4(file) {
        // iOS Files can omit the MIME type. Check the container header before handing bytes to the decoder.
        const header = await file.slice(0, 64).arrayBuffer();
        if (header.byteLength < 16) return false;
        const view = new DataView(header);
        const boxSize = view.getUint32(0);
        if (view.getUint32(4) !== 0x66747970 || boxSize < 16 || boxSize > file.size) return false;
        const bytes = new Uint8Array(header);
        const brand = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
        const mp4Brand = /^(isom|iso[2-9]|mp4[12]|avc1|hvc1|hev1|M4V |dash|MSNV|mp71)$/;
        if (mp4Brand.test(brand(8))) return true;
        for (let offset = 16; offset + 4 <= Math.min(header.byteLength, boxSize); offset += 4) {
            if (mp4Brand.test(brand(offset))) return true;
        }
        return false;
    }

    function inspectVideo(blob) {
        const probe = document.createElement('video');
        const url = URL.createObjectURL(blob);
        probe.muted = true;
        probe.playsInline = true;
        probe.preload = 'auto';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('无法读取视频画面，请使用可播放的 H.264 MP4。')), 5000);
            const finish = callback => value => {
                clearTimeout(timer);
                callback(value);
            };
            const accept = finish(resolve);
            const fail = finish(reject);
            probe.addEventListener('loadedmetadata', () => {
                if (!validDuration(probe.duration)) {
                    fail(new Error('开场视频时长须为 5 秒以内。'));
                } else if (!probe.videoWidth || !probe.videoHeight) {
                    fail(new Error('所选 MP4 没有可播放的视频画面。'));
                } else if (probe.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
                    // Decode a frame even when only metadata was fetched initially.
                    probe.currentTime = Math.min(0.1, probe.duration / 2);
                }
            }, { once:true });
            probe.addEventListener('loadeddata', () => {
                if (validDuration(probe.duration) && probe.videoWidth && probe.videoHeight) {
                    accept(probe.duration);
                }
            }, { once:true });
            probe.addEventListener('error', () => fail(new Error('视频无法解码，请选择可播放的 MP4。')), { once:true });
            probe.src = url;
        }).finally(() => releaseVideo(probe, url));
    }

    function bindSettings(dialog, overlay) {
        const input = dialog.querySelector('input');
        const [choose, preview, remove] = dialog.querySelectorAll('[data-opening-action]');
        const status = dialog.querySelector('[role="status"]');
        const player = dialog.querySelector('video');
        const diagnosis = dialog.querySelector('[data-opening-diagnosis]');
        diagnosis.parentElement.addEventListener('toggle', () => {
            if (diagnosis.parentElement.open) diagnosis.textContent = openingDiagnostics(overlay);
        });
        let previewUrl;
        let current;
        let busy = false;
        let visit = 0;

        function paint(message) {
            choose.textContent = validRecord(current) ? '替换视频' : '导入视频';
            choose.disabled = busy;
            preview.disabled = busy || !validRecord(current);
            remove.disabled = busy || !current;
            status.textContent = message ?? (validRecord(current) ? '已设置本机开场视频。' : '尚未设置开场视频。');
        }

        function stopPreview() {
            if (previewUrl) {
                const url = previewUrl;
                previewUrl = undefined;
                player.hidden = true;
                releaseVideo(player, url);
            }
        }

        async function update(action, onError) {
            const activeVisit = visit;
            busy = true;
            paint('正在处理…');
            try {
                const message = await action(activeVisit);
                if (activeVisit === visit) paint(message);
            } catch (error) {
                if (activeVisit === visit) paint(onError(error));
            } finally {
                busy = false;
                if (dialog.open) {
                    choose.disabled = false;
                    preview.disabled = !validRecord(current);
                    remove.disabled = !current;
                }
            }
        }

        document.addEventListener('click', event => {
            if (!event.target.closest?.('[data-open-local-opening]') || dialog.open || busy) return;
            visit++;
            current = null;
            diagnosis.parentElement.open = false;
            dialog.showModal();
            update(async activeVisit => {
                const record = await savedMedia();
                if (activeVisit === visit) current = record;
            }, () => '无法读取本机开场视频，请稍后重试。');
        });

        choose.addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
            const [file] = input.files;
            input.value = '';
            if (!file || !dialog.open || busy) return;
            stopPreview();
            update(async activeVisit => {
                if (file.size > MAX_BYTES) throw new Error('视频超过 5 MiB。');
                if (!await isMp4(file)) throw new Error('请选择 MP4 视频文件。');
                const blob = file.slice(0, file.size, videoType);
                const duration = await inspectVideo(blob);
                if (activeVisit !== visit || !dialog.open) return;
                const record = { version:1, blob, duration };
                try {
                    await mediaTransaction('readwrite', store => store.put(record, entryKey), true);
                } catch (error) {
                    throw new Error(error?.name === 'QuotaExceededError'
                        ? '本机存储空间不足，原开场视频已保留。'
                        : '无法保存本机开场视频，原设置已保留。');
                }
                current = record;
                return '开场视频已保存在本机。';
            }, error => error.message);
        });

        preview.addEventListener('click', async () => {
            stopPreview();
            const url = URL.createObjectURL(current.blob);
            previewUrl = url;
            player.hidden = false;
            player.muted = true;
            player.src = url;
            try {
                await player.play();
            } catch (_) {
                if (previewUrl === url) {
                    stopPreview();
                    paint('无法预览该视频，请重试或替换。');
                }
            }
        });
        player.addEventListener('error', () => {
            if (!previewUrl) return;
            stopPreview();
            paint('无法预览该视频，请重试或替换。');
        });

        remove.addEventListener('click', () => {
            if (!window.confirm('移除本机开场视频？所选原文件会保留。')) return;
            stopPreview();
            update(async () => {
                await mediaTransaction('readwrite', store => store.delete(entryKey));
                current = null;
                return '本机开场视频已移除。';
            }, () => '无法移除本机开场视频，请重试。');
        });
        dialog.addEventListener('close', () => {
            visit++;
            stopPreview();
        });
        window.addEventListener('pagehide', stopPreview);
    }

    const overlay = document.getElementById('local-opening');
    const dialog = document.getElementById('local-opening-settings');
    if (dialog && typeof dialog.showModal === 'function' && globalThis.indexedDB) {
        bindSettings(dialog, overlay);
        document.documentElement.classList.add('local-opening-ready');
    }
    if (overlay && globalThis.indexedDB) startOpening(overlay);
})();
