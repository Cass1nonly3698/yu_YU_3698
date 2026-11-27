/* Loaded before application initialization; never touches push identity. */
(function () {
    'use strict';
    const pending = 'rp_hub_full_backup_pending_v1', lockName = 'rp-hub-local-data-v1';
    const redirect = () => location.replace(new URL('full-backup.html?recovery=1', location.href).href);
    const blocked = () => { try { return !!localStorage.getItem(pending); } catch (_) { return true; } };
    if (blocked()) redirect();
    let release, started = false;
    window.addEventListener('pagehide', () => release?.(), { once: true });
    window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
    window.addEventListener('storage', event => { if (event.key === pending && event.newValue) redirect(); });
    window.RPHubBackupGate = Object.freeze({
        start(mount) {
            if (started) return;
            started = true;
            if (blocked()) return redirect();
            if (!navigator.locks?.request) return mount(); // Existing chat still works; the tool will refuse unsafe restoration.
            navigator.locks.request(lockName, { mode: 'shared' }, async () => {
                if (blocked()) return redirect();
                const lifetime = new Promise(resolve => { release = resolve; });
                mount();
                await lifetime;
            }).catch(() => { document.body.textContent = '资料锁初始化失败，请关闭其他窗口后重开。'; });
        }
    });
})();
