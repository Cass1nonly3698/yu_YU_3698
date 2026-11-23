/* No fetch handler, app-shell cache, chat reads, model calls or periodic/background sync. */
importScripts('./assets/js/push-test-store.js');
const TITLE = '老公💌';
const BODY = '老婆，今天也想你了。🐟💗';
const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
self.addEventListener('push', event => {
    event.waitUntil((async () => {
        let data; try { data = event.data?.json(); } catch (_) {}
        const id = validId(data?.id) ? data.id : crypto.randomUUID();
        const url = new URL('push-test.html', self.registration.scope);
        url.searchParams.set('notice', id);
        // Always show, even for malformed payload or unavailable IndexedDB. Never silent push.
        await self.registration.showNotification(TITLE, {
            body: BODY, icon: new URL('assets/pwa/haishen-192.png', self.registration.scope).href,
            tag: `haishen-test-${id}`, data: { id, url: url.href }
        });
        try { await HaishenPushStore.saveNotice({ id, title: TITLE, body: BODY, receivedAt: Date.now() }); } catch (_) {}
    })());
});
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil((async () => {
        const id = validId(event.notification.data?.id) ? event.notification.data.id : '';
        const target = new URL('push-test.html', self.registration.scope);
        if (id) target.searchParams.set('notice', id);
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = windows.find(client => { const u = new URL(client.url); return u.origin === target.origin && u.pathname === target.pathname; });
        if (existing) { await existing.navigate(target.href); await existing.focus(); }
        else await self.clients.openWindow(target.href);
    })());
});
