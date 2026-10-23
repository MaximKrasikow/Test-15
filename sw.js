// ============================================================================
// SERVICE WORKER — офлайн-оболочка приложения. Версия 0.5
// ============================================================================
// РОЛЬ ЭТОГО ФАЙЛА: работает в фоне, без интерфейса, и делает две вещи:
//   1. При первой установке скачивает файлы приложения (HTML, JS, иконки)
//      в постоянную память телефона — благодаря этому форма открывается
//      даже без интернета (режим «полет», подвалы, трасса).
//   2. Перехватывает запросы файлов: при наличии сети обновляет кэш свежими
//      версиями (водители автоматически получают обновления), при отсутствии
//      сети отдает файлы из памяти телефона.
//
// СТРАТЕГИЯ NETWORK-FIRST («сначала сеть, потом кэш»):
//   онлайн  -> файл берется из интернета (свежий) и попутно обновляется в кэше;
//   офлайн  -> файл берется из кэша телефона.
// ============================================================================

// Версия кэша.
const CACHE_NAME = 'driver-pwa-v12';

// Оболочка приложения: минимальный набор для работы офлайн.
// Иконки в списке, чтобы ярлык/логотип показывались даже без сети.
const ASSETS_TO_CACHE = [
    './',                     
    './index.html',           
    './app.js',               
    './manifest.json',        
    './icon-192.png',
    './icon-512.png',
    './apple-touch-icon.png'
];


//1: УСТАНОВКА (первое открытие приложения или выход новой версии)
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // Каждый файл качается независимо:
            return Promise.all(
                ASSETS_TO_CACHE.map((path) =>
                    cache.add(path).catch((err) => {
                        console.warn('SW: не удалось закэшировать', path, err);
                    })
                )
            );
        }).then(() => self.skipWaiting())
    );
});

// 2: АКТИВАЦИЯ — чистка старых версий кэша
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                // Удаляем ВСЕ кэши с другими номерами версии (v7, v8, v9...),
                keys.filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
            // claim: воркер сразу берет под контроль уже открытые вкладки — обновление применяется без перезагрузки телефона
    );
});

// 3: ПЕРЕХВАТ ЗАПРОСОВ
self.addEventListener('fetch', (event) => {
    const req = event.request;

    // POST-запросы (отправка отчетов в Google) не перехватываем.
    // Ими управляет очередь в app.js — вмешательство воркера сломает.
    if (req.method !== 'GET') return;

    // Обрабатываем ТОЛЬКО файлы нашего сайта.
    // Раньше перехватывались все запросы подряд, включая сторонние, — теперь чужие домены проходят мимо воркера без изменений.
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // Получаем свежие файлы
    event.respondWith(
        fetch(req)
            .then((networkResponse) => {
                // В кэш кладем только успешные ответы нашего же сайта.
                // status 200 + type 'basic' отсекают страницы ошибок инепрозрачные (opaque) ответы сторонних ресурсов.
                const okToCache = networkResponse &&
                                  networkResponse.status === 200 &&
                                  networkResponse.type === 'basic';

                if (okToCache) {
                    const clone = networkResponse.clone();
                    caches.open(CACHE_NAME)
                        .then((cache) => cache.put(req, clone))
                        .catch(() => {});
                }
                return networkResponse;
            })
            // сети нет — ищем файл в памяти телефона
            .catch(() =>
                caches.match(req).then((cached) => {
                    if (cached) return cached;
                    if (req.mode === 'navigate') {
                        return caches.match('./index.html');
                    }
                    // Файла нет ни в кэше, ни в сети — сетевая ошибка
                    return Response.error();
                })
            )
    );
});
