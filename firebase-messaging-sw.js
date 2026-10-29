/* ATARI ESPORTS Firebase Cloud Messaging service worker.
   Place at the site root as /firebase-messaging-sw.js.
   Firebase web config is public app config; never put service-account credentials here.
*/
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCG5z5eOebJVuI6eKalUcRBBrDruxSdXwo',
  authDomain: 'atari-esports-f2b66.firebaseapp.com',
  projectId: 'atari-esports-f2b66',
  storageBucket: 'atari-esports-f2b66.firebasestorage.app',
  messagingSenderId: '153334650647',
  appId: '1:153334650647:web:9f210ab15d129f0950c952',
  measurementId: 'G-N3Q9B35MR9'
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const d = (payload && payload.data) || {};
  const n = (payload && payload.notification) || {};
  if (payload && payload.notification) return; // FCM already displays notification payloads.
  const title = d.title || n.title || 'ATARI ESPORTS';
  const options = {
    body: d.body || n.body || 'You have a new update.',
    icon: '/icon-192.png', badge: '/icon-192.png',
    data: {
      page: d.page || d.type || (d.action === 'matchUpdate' ? 'match' : 'chat'),
      tournamentId: d.tournamentId || '', pid: d.pid || '', name: d.name || '', url: d.url || '/',
      action: d.action || '', eventKind: d.eventKind || ''
    }
  };
  return self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const target = new URL(d.url || '/', self.location.origin);
  if (d.page) target.searchParams.set('goto', d.page);
  if (d.tournamentId) target.searchParams.set('tid', d.tournamentId);
  if (d.pid) target.searchParams.set('pid', d.pid);
  if (d.name) target.searchParams.set('name', d.name);
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of wins) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        try { client.postMessage({ atariNav: { page: d.page || 'chat', tournamentId: d.tournamentId || '', pid: d.pid || '', name: d.name || '' } }); } catch (_) {}
        return client.focus();
      }
    }
    return clients.openWindow(target.href);
  })());
});
