/* Visual-only room backgrounds. */
(function () {
    'use strict';
    const STORAGE_KEY = 'rp_hub_visual_cottage_v1';
    const DEFAULT_SCENE = 'cottage';
    const SCENES = {
        cottage: {
            label: '小房子',
            photos: {
                day: 'assets/images/cottage/balcony-day-v2.png',
                dusk: 'assets/images/cottage/balcony-dusk-v2.png',
                night: 'assets/images/cottage/balcony-night-v2.png'
            }
        },
        studio: {
            label: '白沙湾画室',
            photos: {
                day: 'assets/images/studio/day.webp',
                dusk: 'assets/images/studio/dusk.webp',
                night: 'assets/images/studio/night.webp'
            }
        }
    };
    const MODES = ['auto', 'day', 'dusk', 'night'];
    const LABELS = { day: '温柔日光', dusk: '一室晚霞', night: '留一盏灯' };
    function phaseAt(timestamp) {
        const minutes = ((Math.floor(timestamp / 60000) + 480) % 1440 + 1440) % 1440;
        return minutes >= 360 && minutes < 1020 ? 'day' : minutes >= 1020 && minutes < 1140 ? 'dusk' : 'night';
    }
    function normalizePreference(value) {
        const scene = value?.scene;
        return {
            version: 1,
            scene: typeof scene === 'string' && Object.prototype.hasOwnProperty.call(SCENES, scene) ? scene : DEFAULT_SCENE,
            mode: MODES.includes(value?.mode) ? value.mode : 'auto'
        };
    }
    const scene = `<div class="cottage-atmosphere" aria-hidden="true">
      <div class="cottage-photo"></div><div class="cottage-reading-wash"></div>
    </div>`;

    function mount(root, options = {}) {
        if (!root || root.dataset.cottageMounted) return null;
        root.dataset.cottageMounted = 'true';
        const host = root.querySelector('[data-cottage-host]');
        if (!host) return null;
        const now = options.now || Date.now;
        let preference = normalizePreference(null), storage;
        try { storage = options.storage || window.localStorage; preference = normalizePreference(JSON.parse(storage.getItem(STORAGE_KEY))); } catch (_) { /* Visuals still work without storage. */ }
        host.innerHTML = scene + `<div class="cottage-toolbar">
          <div class="cottage-place"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></svg><span><span data-cottage-place></span><small data-cottage-caption></small></span></div>
          <details class="cottage-controls"><summary aria-label="背景设置"><span data-cottage-icon aria-hidden="true"></span><span data-cottage-label></span><span class="cottage-chevron" aria-hidden="true">⌄</span></summary>
            <div class="cottage-popover"><p class="cottage-eyebrow">背景设置</p><h2>把喜欢的时刻留下来</h2>
              <fieldset class="cottage-scene-field"><legend>所在空间</legend>
                <div class="cottage-options cottage-scene-options">${Object.entries(SCENES).map(([id, definition]) =>
                    `<button type="button" data-cottage-scene="${id}">${definition.label}</button>`).join('')}</div>
              </fieldset>
              <div class="cottage-options" role="group" aria-label="手动预览昼夜"><button type="button" data-cottage-mode="day"><span aria-hidden="true">☀</span>白天</button><button type="button" data-cottage-mode="dusk"><span aria-hidden="true">◒</span>黄昏</button><button type="button" data-cottage-mode="night"><span aria-hidden="true">☾</span>夜晚</button></div>
              <button class="cottage-auto" type="button" data-cottage-mode="auto"><span>跟随北京时间</span><span aria-hidden="true">◷</span></button>
              <p class="cottage-schedule">白天 06–17 时 · 黄昏 17–19 时 · 夜晚 19–06 时</p>
              <p class="cottage-privacy">场景与时间设置仅影响聊天背景。</p><p class="cottage-save-status" role="status" aria-live="polite"></p>
            </div>
          </details></div>`;
        const details = host.querySelector('details');
        const status = host.querySelector('.cottage-save-status');
        const photo = host.querySelector('.cottage-photo');
        let renderedPhoto;
        function render() {
            const phase = preference.mode === 'auto' ? phaseAt(now()) : preference.mode;
            const definition = SCENES[preference.scene];
            const photoUrl = definition.photos[phase];
            if (renderedPhoto !== photoUrl) {
                photo.style.backgroundImage = `url("${photoUrl}")`;
                renderedPhoto = photoUrl;
            }
            root.dataset.cottageScene = preference.scene;
            root.dataset.cottagePhase = phase;
            root.dataset.cottageMode = preference.mode;
            host.querySelector('[data-cottage-place]').textContent = definition.label;
            host.querySelector('[data-cottage-caption]').textContent = LABELS[phase];
            host.querySelector('[data-cottage-icon]').textContent = { day: '☀', dusk: '◒', night: '☾' }[phase];
            host.querySelector('[data-cottage-label]').textContent = (preference.mode === 'auto' ? '自动' : '手动') + ' · ' + { day: '白天', dusk: '黄昏', night: '夜晚' }[phase];
            host.querySelectorAll('[data-cottage-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.cottageMode === preference.mode)));
            host.querySelectorAll('[data-cottage-scene]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.cottageScene === preference.scene)));
        }
        function choose(event) {
            const button = event.target.closest('button[data-cottage-mode], button[data-cottage-scene]');
            if (!button || !host.contains(button)) return;
            const { cottageScene = preference.scene, cottageMode = preference.mode } = button.dataset;
            preference = normalizePreference({ scene: cottageScene, mode: cottageMode });
            try { storage.setItem(STORAGE_KEY, JSON.stringify(preference)); status.textContent = '已记住你的选择'; }
            catch (_) { status.textContent = '本次可预览；浏览器暂时无法保存选择。'; }
            render();
        }
        function outside(event) { if (!details.contains(event.target)) details.open = false; }
        function escape(event) { if (event.key === 'Escape' && details.open) { details.open = false; details.querySelector('summary').focus(); } }
        function sync(event) { if (event.key === STORAGE_KEY) { try { preference = normalizePreference(JSON.parse(event.newValue)); } catch (_) { preference = normalizePreference(null); } render(); } }
        host.addEventListener('click', choose);
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', escape);
        document.addEventListener('visibilitychange', render);
        window.addEventListener('pageshow', render);
        window.addEventListener('storage', sync);
        const interval = window.setInterval(render, 30000);
        render();
        return { render, destroy() {
            window.clearInterval(interval);
            host.removeEventListener('click', choose);
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('keydown', escape);
            document.removeEventListener('visibilitychange', render);
            window.removeEventListener('pageshow', render);
            window.removeEventListener('storage', sync);
            host.replaceChildren();
            delete root.dataset.cottageMounted;
        } };
    }
    window.RPHubCottage = Object.freeze({ phaseAt, normalizePreference, mount, storageKey: STORAGE_KEY });
    const start = () => document.querySelectorAll('.cottage-room').forEach(root => mount(root));
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    }
})();
