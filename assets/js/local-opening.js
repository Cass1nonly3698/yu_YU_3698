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

    function canStartOpening(overlay) {
        if (reducedMotion.matches || document.visibilityState !== 'visible' || 'skip' in overlay.dataset) return false;
        try {
            return !localStorage.getItem('rp_hub_full_backup_pending_v1');
        } catch (_) {
            return false;
        }
    }

    function releaseVideo(video, url) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    }

    async function startOpening(overlay) {
        const deadline = Number(overlay.dataset.deadline);
        if (!Number.isFinite(deadline) || performance.now() >= deadline || !canStartOpening(overlay)) return;

        const video = overlay.querySelector('video');
        const events = new AbortController();
        const options = { signal:events.signal };
        let phase = 'loading';
        let url;
        let frameRequest;
        let firstFrame = false;
        let playing = false;
        let timer = setTimeout(hide, deadline - performance.now());

        function hide() {
            if (phase === 'closed') return;
            phase = 'closed';
            events.abort();
            clearTimeout(timer);
            if (frameRequest !== undefined) video.cancelVideoFrameCallback?.(frameRequest);
            overlay.hidden = true;
            overlay.classList.remove('is-playing', 'is-fading');
            if (url) releaseVideo(video, url);
        }

        function reveal() {
            if (phase !== 'loading' || !firstFrame || !playing) return;
            if (performance.now() >= deadline || !canStartOpening(overlay) || !validDuration(video.duration)) {
                hide();
                return;
            }
            phase = 'playing';
            clearTimeout(timer);
            overlay.classList.add('is-playing');
            // A suspended or broken decoder can fail to deliver ended.
            timer = setTimeout(hide, video.duration * 1000 + 650);
        }

        function finish() {
            if (phase !== 'playing' || reducedMotion.matches) {
                hide();
                return;
            }
            phase = 'fading';
            clearTimeout(timer);
            overlay.classList.add('is-fading');
            timer = setTimeout(hide, 300);
        }

        window.addEventListener('pagehide', hide, options);
        reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) hide(); }, options);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') hide(); }, options);
        for (const name of ['pointerdown', 'keydown']) document.addEventListener(name, hide, { ...options, capture:true });
        video.addEventListener('error', hide, options);
        video.addEventListener('pause', () => { if (phase === 'playing' && !video.ended) hide(); }, options);
        video.addEventListener('stalled', () => { if (phase === 'playing') hide(); }, options);
        video.addEventListener('ended', finish, options);
        overlay.addEventListener('transitionend', event => {
            if (event.target === overlay && event.propertyName === 'opacity' && phase === 'fading') hide();
        }, options);

        try {
            const record = await savedMedia();
            if (phase !== 'loading') return;
            if (!validRecord(record) || performance.now() >= deadline || !canStartOpening(overlay)) {
                hide();
                return;
            }

            url = URL.createObjectURL(record.blob);
            overlay.hidden = false;
            video.muted = true;
            video.src = url;
            if (video.requestVideoFrameCallback) {
                frameRequest = video.requestVideoFrameCallback(() => {
                    frameRequest = undefined;
                    firstFrame = true;
                    reveal();
                });
            } else {
                video.addEventListener('playing', () => {
                    firstFrame = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
                    reveal();
                }, options);
            }

            await video.play();
            playing = true;
            reveal();
        } catch (_) {
            hide();
        }
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

    function bindSettings(dialog) {
        const input = dialog.querySelector('input');
        const [choose, preview, remove] = dialog.querySelectorAll('[data-opening-action]');
        const status = dialog.querySelector('[role="status"]');
        const player = dialog.querySelector('video');
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
        bindSettings(dialog);
        document.documentElement.classList.add('local-opening-ready');
    }
    if (overlay && globalThis.indexedDB) startOpening(overlay);
})();
