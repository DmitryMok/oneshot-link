// Service Worker — нужен для PWA installability и Share Target
// Fetch не перехватываем: сервис работает только онлайн
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));
