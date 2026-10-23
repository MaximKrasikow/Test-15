/**
 * ============================================================================
 * БЭКЕНД PWA «ОТЧЕТ ЭКСПЕДИТОРА» — версия 0.5 
 * ============================================================================
 * Функция: серверная часть на Google Apps Script. Принимает отчет (текст + все
 * фото одним пакетом), кладет фото в папку Google Диска, дописывает строку
 * в лист водителя (лист = ФИО)
 * ============================================================================
 */

// ID папки на Google Диске, куда складываются фото отчетов.
const FOLDER_ID = '1Sks47o6MQGUWzR-rIx3jXhkWjiw4wrxe';

// Часовой пояс для форматирования времени в таблице.
const SERVER_TZ = 'GMT+3';

// Шапка таблицы. Порядок = порядок колонок = порядок значений в setValues.
const SHEET_HEADERS = [
  'Дата и время создания',   // A -- "ДД:ММ:ГГГГ, ЧЧ:ММ:СС"
  'Торговая точка',          // B -- Текст
  'Показания счетчика',      // C -- Текст: ведущие нули значимы
  'Мелкие игрушки',          // D -- Число (Тип?)
  'Заманухи',                // E -- Число (Тип?)
  'Проброс',                 // F -- Текст
  'Проблемы на маршруте',    // G -- Текст
  'Фото'                     // H -- кликабельные ссылка/и
];


// СКРЫТАЯ ЗАЩИТА ОТ ДУБЛЕЙ 
// Каждый отчет с телефона несет свой reportId. Сервер хранит
// полученные id в СВОЙСТВАХ СКРИПТА (PropertiesService) 24 часа.
// Сценарий: сервер записал строку, но ответ до телефона не доехал (обрыв
// связи) -> телефон пришлет тот же отчет повторно -> сервер узнает id и
// просто ответит «success» без новой строки. Дубля в таблице нет.
// ----------------------------------------------------------------------------
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // сколько помнить полученные id
const DEDUP_MAX_IDS = 120;                // потолок памяти на лист (лимит свойства — 9 КБ)
const DEDUP_SAFE_BYTES = 8000;            // страховочный порог до жесткого лимита 9216 байт

// РАСЧЕТ КВОТ ДЛЯ КОМПАНИИ ДО 10 ВОДИТЕЛЕЙ:
//   один ID вида 'rep_1761213015000_a8x2q' в JSON занимает ~40 байт;
//   потолок 120 ID -> ~5 КБ на водителя при лимите ОДНОГО свойства 9216 байт
//   (запас 4 КБ + страховка DEDUP_SAFE_BYTES: лишние старые ID выкидываются);
//   10 водителей x ~5 КБ = ~50 КБ из 500 КБ ОБЩЕГО лимита свойств скрипта.
// Вывод: при таких настройках переполнение квот математически недостижимо,
// а даже гипотетический сбой записи памяти НЕ роняет отчет (try-catch в doPost).

function dedupKey(safeName) {
  return 'seen_' + safeName;
}

// Читаем память дублей. Поврежденный JSON — начинаем заново.
function dedupRead(safeName) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(dedupKey(safeName));
    return JSON.parse(raw || '{}') || {};
  } catch (e) {
    return {};
  }
}

// Был ли ТАКОЙ отчет уже записан? Просроченные записи (старше TTL) не считаются. #TODO
function dedupHas(safeName, reportId) {
  if (!reportId) return false;
  var map = dedupRead(safeName);
  var border = Date.now() - DEDUP_TTL_MS;
  for (var id in map) {
    if (id === reportId && Number(map[id]) >= border) return true;
  }
  return false;
}

// Запомнить id записанного отчета. Вызывается ТОЛЬКО после фактической
// записи строки: если запись упала с ошибкой — отчет останется на телефоне
// и повторится без помех (память пуста = повторы разрешены). #TODO
function dedupRemember(safeName, reportId) {
  if (!reportId) return;
  var map = dedupRead(safeName);
  var border = Date.now() - DEDUP_TTL_MS;

  // Чистка просроченных записей при каждом пополнении
  for (var id in map) {
    if (Number(map[id]) < border) delete map[id];
  }
  map[reportId] = Date.now();

  // Потолок размера: выкидываем самые СТАРЫЕ записи (по времени получения).
  var ids = Object.keys(map);
  ids.sort(function(a, b) { return map[a] - map[b]; });
  while (ids.length > DEDUP_MAX_IDS) { delete map[ids.shift()]; }

  // Пока сериализованный JSON не влезает в DEDUP_SAFE_BYTES (8000 < 9216 — жесткий лимит одного свойства),
  //  выкидываем самые старые ID. Текущий (только что записанный) ID — самый новый, он
  // выживает всегда. Падение из-за размера стало невозможным.
  var json = JSON.stringify(map);
  while (json.length > DEDUP_SAFE_BYTES && ids.length > 1) {
    delete map[ids.shift()];
    json = JSON.stringify(map);
  }

  try {
    PropertiesService.getScriptProperties().setProperty(dedupKey(safeName), json);
  } catch (propErr) {
    try {
      var fresh = {};
      fresh[reportId] = Date.now();
      PropertiesService.getScriptProperties().setProperty(dedupKey(safeName), JSON.stringify(fresh));
    } catch (fatalErr) {
      Logger.log('КРИТИЧНО: память дублей недоступна (' + fatalErr.message + '). Возможен дубль при потере ответа.');
    }
  }
}

/** Единая точка формирования JSON-ответа клиенту. */
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----------------------------------------------------------------------------
// Единая точка ОШИБОК. КОД:
//   VALIDATION — отчет не будет принят НИКОГДА: #TODO придумать лог или давать пользователю на проверку и переотпраку?
//                телефон откладывает его в сторону, очередь идет дальше;
//   BUSY       — временная занятость: телефон повторит позже;
//   SERVER     — прочие сбои: телефон повторит позже.
// ----------------------------------------------------------------------------
function jsonError(code, message) {
  Logger.log('ОТКАЗ [' + code + ']: ' + message);
  return jsonOut({ status: 'error', code: code, message: message });
}

// ===========
// ДИАГНОСТИКА 
// ===========
function testAuth() {
  Logger.log('Проверка Drive API v3...');

  var file = Drive.Files.create({
    name: 'test_drive_v3.txt',
    mimeType: 'text/plain',
    parents: [FOLDER_ID]
  }, Utilities.newBlob('Тестовая проверка Drive v3'));

  Drive.Files.remove(file.id); // проверочный файл сразу удаляем
  Logger.log('УСПЕХ: доступ к Google Диску (v3) подтвержден, тестовый файл удален.');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Скрипт должен быть привязан к Таблице (Расширения -> Apps Script)!');
  Logger.log('УСПЕХ: доступ к таблице "' + ss.getName() + '" подтвержден.');
}

// ============================================================================
// ПРОВЕРКА ЖИЗНИ СЕРВЕРА
// ЧТО делает: отвечает текстом, если открыть ссылку /exec в браузере (GET).
// ============================================================================
function doGet(e) {
  return ContentService
    .createTextOutput('Сервер отчетов активен.')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ============================================================================
// ЗАГРУЗКА ФОТО НА GOOGLE ДИСК (массив фото, каждое — независимо)
// ============================================================================
/**
 * Функция:декодирует каждый Base64-элемент в JPEG и кладет в папку
 * FOLDER_ID. Сбой ОДНОГО фото не мешает остальным и не отменяет отчет #Todo или нужно возвращать пользователю чтобы он отправлял заново?
 *
 * @param {Array|null} photoList - массив чистых Base64-строк (без data:-заголовка)
 * @param {string} safeName      - имя водителя (уже очищенное)
 * @return {Array<{text: string, url: string}>} части для ячейки «Фото»:
 *         с url = кликабельная ссылка, без url = текст пояснения об ошибке
 */
function uploadPhotos(photoList, safeName) {
  if (!photoList || !photoList.length) return [];

  var parts = [];
  // Одна метка времени на ВСЕ фото отчета + номер фото: имена не пересекутся
  // даже при загрузке нескольких файлов в одну секунду.
  var dateStr = Utilities.formatDate(new Date(), SERVER_TZ, 'yyyy-MM-dd_HH-mm-ss');

  for (var i = 0; i < photoList.length; i++) {
    var n = i + 1;
    try {
      var fileName = safeName + '_' + dateStr + '_' + n + '.jpg';
      var blob = Utilities.newBlob(
        Utilities.base64Decode(photoList[i]), 'image/jpeg', fileName);

      var f = Drive.Files.create({
        name: fileName,
        mimeType: 'image/jpeg',
        parents: [FOLDER_ID]
      }, blob, { fields: 'id, webViewLink' });

      // «Просмотр по ссылке для всех».
      try {
        Drive.Permissions.create({ role: 'reader', type: 'anyone' }, f.id);
      } catch (pErr) {
        Logger.log('Предупреждение прав доступа (не критично): ' + pErr.message);
      }

      parts.push({ text: '📷 Фото ' + n, url: f.webViewLink });

    } catch (driveErr) {
      // Сбой одного фото: отчет спасаем, в ячейке будет пояснение #Todo или нужно возвращать пользователю чтобы он отправлял заново?
      Logger.log('ОШИБКА ЗАГРУЗКИ ФОТО #' + n + ': ' + driveErr.message);
      parts.push({ text: 'Фото ' + n + ': ошибка (' + driveErr.message + ')' });
    }
  }
  return parts;
}

// ===============================
// ГЛАВНЫЙ ПРИЕМНИК ОТЧЕТОВ (POST)
// ===============================
function doPost(e) {
  try {
    // Валидация запроса до всего остального.
    if (!e || !e.postData || !e.postData.contents) {
      return jsonError('VALIDATION', 'Получен пустой запрос.');
    }

    var data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonError('VALIDATION', 'Тело запроса не является корректным JSON.');
    }

    if (data.action !== 'REPORT') {
      return jsonError('VALIDATION', 'Недопустимое действие: ' + data.action);
    }
    if (!data.user || !data.pointName) {
      return jsonError('VALIDATION', 'Отсутствуют обязательные поля: водитель или торговая точка.');
    }

    // Валидация ФИО для имени листа: запрещенные символы Google Sheets -> '_', до 50 симв.
    var safeName = String(data.user)
      .replace(/[\\/*?:\[\]']/g, '_')
      .trim()
      .substring(0, 50) || 'Без имени';

    // ------------------------------------------------------------------
    // БЫСТРАЯ ПРОВЕРКА ДУБЛЯ ДО ЗАГРУЗКИ ФОТО.
    // Раньше повторная отправка (ретрай после обрыва связи) СНАЧАЛА грузила
    // все фото на Диск и лишь под замком натыкалась на проверку дублей —
    // в папке Drive накапливались мусорные копии файлов. Теперь известный
    // дубль отсеивается мгновенно, без единой операции Drive.
    // ------------------------------------------------------------------
    try {
      if (dedupHas(safeName, data.reportId)) {
        Logger.log('Дубль отклонен на раннем этапе (без загрузки фото): ' + data.reportId);
        return jsonOut({ status: 'success', duplicate: true, sheetName: safeName });
      }
    } catch (earlyErr) {
      Logger.log('Ранняя проверка дубля пропущена: ' + earlyErr.message);
    }

    var probeLock = LockService.getScriptLock();
    if (!probeLock.tryLock(1000)) {
      return jsonError('BUSY', 'Сервер перегружен другими водителями. Отчет остался в телефоне и отправится повторно автоматически.');
    }
    try { probeLock.releaseLock(); } catch (relErr) {}

    var photoParts = uploadPhotos(data.photos, safeName);

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) {
      return jsonError('BUSY', 'Сервер занят обработкой других данных. Повторите попытку через минуту.');
    }

    var lastRow;
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();

      // Лист = водитель. Создаем с шапкой при первом отчете.
      var sheet = ss.getSheetByName(safeName);
      if (!sheet) {
        sheet = ss.insertSheet(safeName);
        sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
        sheet.getRange('A1:H1').setFontWeight('bold').setBackground('#e8f0fe');
        sheet.setFrozenRows(1);
        sheet.getRange('C2:C').setNumberFormat('@');
      }

      if (dedupHas(safeName, data.reportId)) {
        Logger.log('Дубль отклонен: ' + data.reportId + ' (лист ' + safeName + ')');
        return jsonOut({ status: 'success', duplicate: true, sheetName: safeName });
      }

      var createdMs = Number(data.createdAt);
      var displayTime = (data.createdAt && !isNaN(createdMs))
        ? Utilities.formatDate(new Date(createdMs), SERVER_TZ, 'dd.MM.yyyy HH:mm:ss')
        : Utilities.formatDate(new Date(), SERVER_TZ, 'dd.MM.yyyy HH:mm:ss');

      var photoCell = 'Без фото';
      if (photoParts.length) {
        var texts = [];
        for (var k = 0; k < photoParts.length; k++) texts.push(photoParts[k].text);
        photoCell = texts.join('\n');
      }

      var nextRow = sheet.getLastRow() + 1;
      sheet.getRange(nextRow, 3).setNumberFormat('@');

      sheet.getRange(nextRow, 1, 1, 8).setValues([[
        displayTime,                  // A — время заполнения
        data.pointName,               // B — Текст
        data.meter || '',             // C — Текст
        Number(data.smallToys) || 0,  // D — Число
        Number(data.zamanukha) || 0,  // E — Число
        data.probros || '',           // F — Текст
        data.problems || 'Нет',       // G — Текст
        photoCell                     // H — ссылки фото
      ]]);
      lastRow = nextRow;

      if (photoParts.length) {
        var builder = SpreadsheetApp.newRichTextValue().setText(photoCell);
        var pos = 0;
        for (var j = 0; j < photoParts.length; j++) {
          if (photoParts[j].url) {
            builder.setLinkUrl(pos, pos + photoParts[j].text.length, photoParts[j].url);
          }
          pos += photoParts[j].text.length + 1;
        }
        sheet.getRange(lastRow, 8).setRichTextValue(builder.build());
      }

      // Форсируем запись до ответа клиенту
      SpreadsheetApp.flush();

      try {
        dedupRemember(safeName, data.reportId);
      } catch (memErr) {
        Logger.log('НЕ КРИТИЧНО: reportId не запомнен (' + (memErr.message || memErr) + '). Отчет записан, будет ответ success.');
      }

    } finally {
      try { lock.releaseLock(); } catch (e2) {}
    }

    // Только после этого ответа телефон удалит отчет из своей базы.
    return jsonOut({ status: 'success', row: lastRow, sheetName: safeName });

  } catch (err) {
    // Любая НЕОЖИДАННАЯ ошибка — SERVER (временная): телефон повторит позже.
    Logger.log('ОШИБКА doPost: ' + (err.message || err));
    return jsonError('SERVER', err.message || String(err));
  }
}
