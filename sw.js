const CACHE_NAME = 'driver-pwa-v8';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './app.js',
    './manifest.json'
];

// Установка: предварительная загрузка базовых файлов в кэш
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

// Активация: мгновенная очистка старых версий кэша
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Обработка запросов
self.addEventListener('fetch', (event) => {
    // Игнорируем не-GET запросы (отправка отчетов в Google идет напрямую через app.js)
    if (event.request.method !== 'GET') {
        return;
    }

    // Стратегия Network-First с переключением на Cache в офлайне
    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // Если сетевой ответ успешен, обновляем файл в кэше
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // При отсутствии сети отдаем локальную копию
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // Если запрашивалась навигация по приложению, возвращаем index.html
                    if (event.request.mode === 'navigate') {
                        return caches.match('./index.html');
                    }
                });
            })
    );
});