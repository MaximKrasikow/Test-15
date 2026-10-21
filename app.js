const GAS_URL = 'https://script.google.com/macros/s/AKfycbwLZhLhH-wWDQVbjiJPzTwx--2rcgDJDdJK-jFfOAB91rJW8qzDKNgGQwxe4qhzGPO9/exec';

// Регистрация Service Worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Ошибка регистрации SW:', err);
    });
}

// ============================================================================
// 1. НАДЕЖНОЕ ОФЛАЙН-ХРАНИЛИЩЕ (INDEXEDDB)
// ============================================================================
const DB_NAME = 'DriverReportsDB';
const DB_VERSION = 1;
const STORE_NAME = 'reports_queue';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

async function dbPut(item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).put(item);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// Автоматический перенос зависших отчетов из старого localStorage (если есть)
async function migrateFromLocalStorage() {
    try {
        const oldData = localStorage.getItem('driver_queue');
        if (oldData) {
            const oldQueue = JSON.parse(oldData);
            if (Array.isArray(oldQueue) && oldQueue.length > 0) {
                for (const item of oldQueue) {
                    await dbPut(item);
                }
            }
            localStorage.removeItem('driver_queue');
        }
    } catch (e) {
        console.warn('Миграция не требуется или завершена:', e);
    }
}

// ============================================================================
// 2. ИНТЕРФЕЙС И СОСТОЯНИЕ СЕТИ
// ============================================================================
const uIn = document.getElementById('username');
const statusEl = document.getElementById('status');
const netStatusEl = document.getElementById('netStatus');
const submitBtn = document.getElementById('submitBtn');

uIn.value = localStorage.getItem('drv') || '';
uIn.oninput = () => localStorage.setItem('drv', uIn.value.trim());

async function updateStatusUI() {
    const queue = await dbGetAll();
    const count = queue.length;

    if (navigator.onLine) {
        netStatusEl.className = 'badge online';
        netStatusEl.innerText = '● Подключение: Онлайн';
        if (count > 0) {
            statusEl.innerText = `В очереди: ${count} отчетов. Выгружаю...`;
            syncQueue();
        } else {
            statusEl.innerText = 'Готово к заполнению';
        }
    } else {
        netStatusEl.className = 'badge offline';
        netStatusEl.innerText = '○ Подключение: Офлайн (накопление)';
        statusEl.innerText = count > 0 
            ? `Офлайн. В памяти сохранено: ${count} отчетов` 
            : 'Офлайн. Отчет сохранится в память';
    }
}

window.addEventListener('online', updateStatusUI);
window.addEventListener('offline', updateStatusUI);

// ============================================================================
// 3. СЖАТИЕ ФОТОГРАФИИ (1280px для четкости цифр счетчика)
// ============================================================================
function compressImage(file) {
    if (!file) return Promise.resolve(null);
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (e) => {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                const maxDim = 1280;
                let w = img.width;
                let h = img.height;

                if (w > maxDim || h > maxDim) {
                    if (w > h) {
                        h = Math.round((h * maxDim) / w);
                        w = maxDim;
                    } else {
                        w = Math.round((w * maxDim) / h);
                        h = maxDim;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);

                // Качество 0.70 сохраняет резкость текста и циферблатов при весе ~150 Кб
                resolve(canvas.toDataURL('image/jpeg', 0.7).split(',')[1]);
            };
            img.onerror = () => resolve(null);
        };
        reader.onerror = () => resolve(null);
    });
}

function clearForm() {
    ['pointName', 'meter', 'smallToys', 'zamanukha', 'probros', 'problems', 'photo'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

// ============================================================================
// 4. ЕДИНАЯ АТОМАРНАЯ ОТПРАВКА НА СЕРВЕР
// ============================================================================
async function sendReportToServer(item) {
    const payload = {
        action: 'REPORT',
        user: item.user,
        pointName: item.pointName,
        meter: item.meter,
        smallToys: item.smallToys,
        zamanukha: item.zamanukha,
        probros: item.probros,
        problems: item.problems,
        timestamp: item.timestamp,
        photoBase64: item.photoBase64
    };

    const response = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`Сбой сети HTTP: ${response.status}`);
    }

    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (parseErr) {
        throw new Error('Google вернул некорректный ответ (проверьте права веб-приложения)');
    }

    if (data.status !== 'success') {
        throw new Error(data.message || 'Ошибка обработки на стороне Google');
    }

    return data;
}

// ============================================================================
// 5. ОБРАБОТКА НАЖАТИЯ «ОТПРАВИТЬ»
// ============================================================================
async function handleFormSubmit() {
    const user = uIn.value.trim();
    const point = document.getElementById('pointName').value.trim();

    if (!user || !point) {
        alert('Заполните ФИО водителя и наименование точки!');
        return;
    }

    submitBtn.disabled = true;
    statusEl.innerText = 'Обработка данных и сжатие фото...';

    try {
        const photoFile = document.getElementById('photo').files[0];
        const photoBase64 = await compressImage(photoFile);
        const creationTime = new Date().toLocaleString('ru-RU');

        const item = {
            id: 'rep_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
            user: user,
            pointName: point,
            meter: document.getElementById('meter').value.trim(),
            smallToys: document.getElementById('smallToys').value.trim(),
            zamanukha: document.getElementById('zamanukha').value.trim(),
            probros: document.getElementById('probros').value.trim(),
            problems: document.getElementById('problems').value.trim(),
            photoBase64: photoBase64,
            timestamp: creationTime,
            createdAt: Date.now(),
            retries: 0
        };

        // Сохраняем сначала в локальную базу данных
        await dbPut(item);
        clearForm();

        if (!navigator.onLine) {
            const queue = await dbGetAll();
            statusEl.innerText = `Офлайн. Сохранен отчет за ${creationTime} (В очереди: ${queue.length})`;
            return;
        }

        await syncQueue();
    } catch (err) {
        console.error('Ошибка сохранения формы:', err);
        statusEl.innerText = 'Ошибка сохранения: ' + err.message;
    } finally {
        submitBtn.disabled = false;
    }
}

// ============================================================================
// 6. СИНХРОНИЗАТОР ОЧЕРЕДИ С СЕРВЕРОМ
// ============================================================================
let isSyncing = false;

async function syncQueue() {
    if (isSyncing || !navigator.onLine) return;
    isSyncing = true;

    try {
        let queue = await dbGetAll();

        while (queue.length > 0 && navigator.onLine) {
            const currentItem = queue[0];
            statusEl.innerText = `Отправка отчета: ${currentItem.pointName} [${currentItem.timestamp}]...`;

            try {
                await sendReportToServer(currentItem);
                // Удаляем из базы только после 100% подтверждения сервером
                await dbDelete(currentItem.id);
                queue = await dbGetAll();
                statusEl.innerText = `Успешно отправлен: ${currentItem.pointName}!`;
            } catch (err) {
                console.error('Сбой отправки записи:', err);
                // Отчет НЕ удаляется. Записываем ошибку и прерываем цикл до восстановления
                currentItem.retries = (currentItem.retries || 0) + 1;
                currentItem.lastError = err.message;
                await dbPut(currentItem);
                
                statusEl.innerText = `Сбой отправки (${err.message}). Отчеты сохранены (${queue.length} в очереди).`;
                break;
            }
        }

        if (queue.length === 0) {
            statusEl.innerText = 'Все накопленные отчеты успешно выгружены в таблицу!';
        }
    } finally {
        isSyncing = false;
    }
}

// Запуск при загрузке страницы
(async function init() {
    await migrateFromLocalStorage();
    await updateStatusUI();
})();