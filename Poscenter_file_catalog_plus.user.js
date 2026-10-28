// ==UserScript==
// @name         POScenter Files: удобные папки и массовая загрузка
// @namespace    https://fs.poscenter.org/
// @version      1.1.1
// @description  Рекурсивный поиск по папкам и хранилищу, скачивание, просмотр и ссылки на файлы.
// @match        https://fs.poscenter.org/*
// @run-at       document-idle
// @grant        none
// @author       Jeronimo701
// @license      LicenseRef-Jeronimo701-Personal-Use-1.0
// @homepageURL  https://github.com/jeronimo701/Poscenter-file-catalog-plus
// @updateURL    https://raw.githubusercontent.com/jeronimo701/Poscenter-file-catalog-plus/main/Poscenter_file_catalog_plus.meta.js
// @downloadURL  https://raw.githubusercontent.com/jeronimo701/Poscenter-file-catalog-plus/main/Poscenter_file_catalog_plus.user.js
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_ORIGIN = 'https://storage.yandexcloud.net';
    const BUCKET_NAME = 'fs.poscenter.org';
    const DOWNLOAD_ORIGIN = 'https://fs.poscenter.org';
    const DOWNLOAD_INTERVAL_MS = 180;
    const FILE_TYPE_GROUPS = {
        zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive',
        exe: 'app', msi: 'app', apk: 'app', bat: 'app', cmd: 'app',
        pdf: 'pdf',
        doc: 'document', docx: 'document', odt: 'document', rtf: 'document',
        xls: 'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet',
        ppt: 'presentation', pptx: 'presentation', odp: 'presentation',
        txt: 'text', log: 'text', ini: 'text', cfg: 'text', json: 'text', xml: 'text', html: 'text',
        jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
        mp4: 'video', avi: 'video', mkv: 'video', mov: 'video', webm: 'video',
        mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio',
        bin: 'firmware', hex: 'firmware', img: 'firmware', iso: 'firmware',
    };
    const PREVIEWABLE_EXTENSIONS = new Set([
        'pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
        'mp4', 'webm', 'mov', 'm4v', 'mp3', 'wav', 'ogg', 'flac',
        'txt', 'log', 'json', 'xml',
    ]);
    let activeDownload = null;
    let enhancementQueued = false;

    injectStyles();
    scheduleEnhanceFolders();
    const list = document.getElementById('list');
    if (list) new MutationObserver(scheduleEnhanceFolders).observe(list, { childList: true, subtree: true });
    installSearch();

    function installSearch() {
        const catalogPanel = list?.closest('.panel') || list?.parentElement;
        const toolbar = document.querySelector('.toolbar');
        if (!catalogPanel || !toolbar || document.getElementById('poscenter-search')) return;
        const memory = new Map();
        const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
        let databasePromise;
        let job = null;
        let requestId = 0;
        let debounce;
        let matches = [];
        let shown = 0;
        let selectedIndex = null;
        let scope = 'folder';
        try { scope = localStorage.getItem('poscenter-search-scope') === 'all' ? 'all' : 'folder'; } catch (_) {}

        const panel = document.createElement('section');
        panel.id = 'poscenter-search';
        panel.innerHTML = `
            <div class="poscenter-search-controls">
                <input type="search" aria-label="Поиск файлов и папок" placeholder="Название файла, папки или часть пути" autocomplete="off">
                <div class="poscenter-search-scopes" role="group" aria-label="Область поиска">
                    <button type="button" data-scope="folder">Эта папка и подпапки</button>
                    <button type="button" data-scope="all">Всё хранилище</button>
                </div>
                <button type="button" class="poscenter-search-refresh" title="Заново загрузить список файлов для выбранной области">Обновить индекс</button>
                <button type="button" class="poscenter-search-stop" hidden>Остановить</button>
            </div>
            <div class="poscenter-search-location"></div>
            <div class="poscenter-search-status" role="status" aria-live="polite"></div>
            <progress aria-label="Загрузка поискового индекса" hidden></progress>
            <div class="poscenter-search-results" hidden>
                <div class="poscenter-search-items"></div>
                <button type="button" class="poscenter-search-more" hidden>Показать ещё</button>
            </div>`;
        const input = panel.querySelector('input');
        const status = panel.querySelector('.poscenter-search-status');
        const locationLabel = panel.querySelector('.poscenter-search-location');
        const results = panel.querySelector('.poscenter-search-results');
        const items = panel.querySelector('.poscenter-search-items');
        const more = panel.querySelector('.poscenter-search-more');
        const refresh = panel.querySelector('.poscenter-search-refresh');
        const stop = panel.querySelector('.poscenter-search-stop');
        const progress = panel.querySelector('progress');
        const main = toolbar.closest('main') || toolbar.parentElement;
        main.prepend(panel);
        results.id = 'poscenter-search-output';
        results.prepend(status, progress);
        catalogPanel.before(results);

        function currentPrefix() {
            try { return decodeURIComponent(location.hash.replace(/^#\/?/, '')); }
            catch (_) { return ''; }
        }

        function searchPrefix() { return scope === 'all' ? '' : currentPrefix(); }
        function normalize(text) { return String(text).normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е'); }

        function updateScope() {
            panel.querySelectorAll('[data-scope]').forEach((button) => {
                button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
            });
            locationLabel.textContent = scope === 'all' ? 'Всё хранилище' : `${currentPrefix() || 'Корень'} · включая подпапки`;
        }

        function setLoading(loading) {
            progress.hidden = !loading;
            stop.hidden = !loading;
            refresh.disabled = loading || !input.value.trim();
        }

        function abortJob() {
            job?.controller.abort();
            job = null;
            setLoading(false);
        }

        function clearSearch() {
            clearTimeout(debounce);
            requestId += 1;
            abortJob();
            matches = [];
            selectedIndex = null;
            items.replaceChildren();
            results.hidden = true;
            status.textContent = '';
            catalogPanel.classList.remove('poscenter-search-catalog-hidden');
        }

        function database() {
            if (databasePromise) return databasePromise;
            databasePromise = new Promise((resolve) => {
                let done = false;
                const finish = (db) => {
                    if (done) { db?.close(); return; }
                    done = true;
                    clearTimeout(timeout);
                    resolve(db);
                };
                const timeout = window.setTimeout(() => finish(null), 2500);
                try {
                    const opening = indexedDB.open('poscenter-file-search', 1);
                    opening.onupgradeneeded = () => opening.result.createObjectStore('indexes', { keyPath: 'prefix' });
                    opening.onsuccess = () => finish(opening.result);
                    opening.onerror = () => finish(null);
                    opening.onblocked = () => finish(null);
                } catch (_) { finish(null); }
            });
            return databasePromise;
        }

        async function readCache(prefix) {
            if (memory.has(prefix)) return memory.get(prefix);
            const db = await database();
            if (!db) return null;
            return new Promise((resolve) => {
                try {
                    const reading = db.transaction('indexes').objectStore('indexes').get(prefix);
                    reading.onsuccess = () => {
                        const record = reading.result;
                        if (record && Array.isArray(record.entries) && Number.isFinite(record.savedAt)) {
                            memory.set(prefix, record);
                            resolve(record);
                        } else { resolve(null); }
                    };
                    reading.onerror = () => resolve(null);
                } catch (_) { resolve(null); }
            });
        }

        async function writeCache(record) {
            memory.set(record.prefix, record);
            const db = await database();
            if (!db) return false;
            return new Promise((resolve) => {
                try {
                    const transaction = db.transaction('indexes', 'readwrite');
                    transaction.objectStore('indexes').put({ prefix: record.prefix, savedAt: record.savedAt, entries: record.entries });
                    transaction.oncomplete = () => resolve(true);
                    transaction.onerror = transaction.onabort = () => resolve(false);
                } catch (_) { resolve(false); }
            });
        }

        async function cachedIndex(prefix) {
            const direct = await readCache(prefix);
            const global = prefix ? await readCache('') : null;
            return direct && (!global || direct.savedAt >= global.savedAt) ? direct : global;
        }

        async function fetchIndex(prefix, controller, onPage) {
            const entries = new Map();
            const tokens = new Set();
            let token = '';
            let pages = 0;
            let fileCount = 0;
            do {
                const url = new URL(`${STORAGE_ORIGIN}/${BUCKET_NAME}`);
                url.searchParams.set('list-type', '2');
                url.searchParams.set('prefix', prefix);
                url.searchParams.set('max-keys', '1000');
                if (token) url.searchParams.set('continuation-token', token);
                const response = await fetch(url, { method: 'GET', signal: controller.signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
                if (xml.querySelector('parsererror, Error')) throw new Error('Некорректный ответ хранилища');
                for (const node of xml.querySelectorAll('Contents')) {
                    const key = node.querySelector('Key')?.textContent || '';
                    if (!key || !key.startsWith(prefix) || shouldHideKey(key)) continue;
                    const folder = key.endsWith('/');
                    if (key !== prefix && !entries.has(key)) {
                        entries.set(key, {
                            key, folder,
                            size: Number(node.querySelector('Size')?.textContent || 0),
                            modified: node.querySelector('LastModified')?.textContent || '',
                        });
                        if (!folder) fileCount += 1;
                    }
                    let end = key.lastIndexOf('/', key.length - 2);
                    if (!folder) end = key.lastIndexOf('/');
                    while (end >= prefix.length) {
                        const parent = key.slice(0, end + 1);
                        if (parent !== prefix && !entries.has(parent)) {
                            entries.set(parent, { key: parent, folder: true, size: 0, modified: '' });
                        }
                        end = key.lastIndexOf('/', end - 1);
                    }
                }
                pages += 1;
                onPage(pages, fileCount);
                const truncated = xml.querySelector('IsTruncated')?.textContent?.toLowerCase() === 'true';
                if (!truncated) break;
                token = xml.querySelector('NextContinuationToken')?.textContent || '';
                if (!token || tokens.has(token)) throw new Error('Хранилище не вернуло следующую страницу списка');
                tokens.add(token);
            } while (token);
            const record = { prefix, savedAt: Date.now(), entries: Array.from(entries.values()) };
            record.entries.sort((a, b) => Number(b.folder) - Number(a.folder) || collator.compare(a.key, b.key));
            if (controller.signal.aborted) throw new DOMException('Поиск остановлен', 'AbortError');
            record.persistent = await writeCache(record);
            return record;
        }

        function resultButton(label, action, title) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            if (title) button.title = title;
            button.addEventListener('click', action);
            return button;
        }

        function renderPage(reset = false) {
            if (reset) { shown = 0; items.replaceChildren(); }
            const fragment = document.createDocumentFragment();
            const next = matches.slice(shown, shown + 100);
            for (const entry of next) {
                const row = document.createElement('div');
                row.className = 'poscenter-search-item';
                row.dataset.key = entry.key;
                const info = document.createElement('div');
                info.className = 'poscenter-search-info';
                const name = document.createElement('a');
                name.className = 'poscenter-search-name';
                name.textContent = entry.key.replace(/\/$/, '').split('/').pop();
                const fileUrl = `${DOWNLOAD_ORIGIN}/${entry.key.split('/').map(encodeURIComponent).join('/')}`;
                const extension = name.textContent.match(/\.([a-z0-9]{1,8})$/i)?.[1].toLowerCase() || '';
                if (entry.folder) {
                    name.href = `#/${encodeReadablePath(entry.key)}`;
                } else {
                    name.href = fileUrl;
                    if (PREVIEWABLE_EXTENSIONS.has(extension)) {
                        name.target = '_blank';
                        name.rel = 'noopener noreferrer';
                    } else { name.download = name.textContent; }
                }
                const path = document.createElement('div');
                path.className = 'poscenter-search-path';
                path.textContent = entry.key;
                const meta = document.createElement('div');
                meta.className = 'poscenter-search-meta';
                const size = entry.size < 1024 * 1024 ? `${(entry.size / 1024).toFixed(1)} КБ` : `${(entry.size / 1024 / 1024).toFixed(1)} МБ`;
                meta.textContent = entry.folder ? 'Папка' : `${extension.toUpperCase() || 'Файл'} · ${size}`;
                info.append(name, path, meta);
                const actions = document.createElement('div');
                actions.className = 'poscenter-search-actions';
                if (entry.folder) {
                    const open = document.createElement('a');
                    open.href = name.href;
                    open.textContent = 'Открыть папку';
                    actions.append(open, resultButton('Скачать всё', () => startFolderDownload(entry.key)));
                } else {
                    if (PREVIEWABLE_EXTENSIONS.has(extension)) {
                        const open = document.createElement('a');
                        open.href = fileUrl;
                        open.textContent = 'Открыть';
                        open.target = '_blank';
                        open.rel = 'noopener noreferrer';
                        actions.append(open);
                    }
                    const download = document.createElement('a');
                    download.href = fileUrl;
                    download.download = name.textContent;
                    download.textContent = 'Скачать';
                    actions.append(download);
                }
                const copy = resultButton('Ссылка', async () => {
                    const url = entry.folder ? `${DOWNLOAD_ORIGIN}/#/${encodeReadablePath(entry.key)}` : getReadableUrl(fileUrl);
                    if (!await copyLink(url)) return;
                    copy.textContent = 'Скопировано';
                    window.setTimeout(() => { copy.textContent = 'Ссылка'; }, 1400);
                }, 'Скопировать ссылку');
                copy.className = 'poscenter-search-copy';
                actions.append(copy);
                row.append(info, actions);
                fragment.append(row);
            }
            items.append(fragment);
            shown += next.length;
            more.hidden = shown >= matches.length;
            more.textContent = `Показать ещё (${shown} из ${matches.length})`;
        }

        function renderMatches(record, prefix) {
            if (!record.searchRows) record.searchRows = record.entries.map((entry) => ({ entry, text: normalize(entry.key) }));
            const words = normalize(input.value.trim()).split(/\s+/).filter(Boolean);
            matches = record.searchRows.filter(({ entry, text }) => entry.key !== prefix && entry.key.startsWith(prefix)
                && words.every((word) => text.includes(word))).map(({ entry }) => entry);
            renderPage(true);
            const folders = matches.reduce((total, entry) => total + Number(entry.folder), 0);
            const files = matches.length - folders;
            const noun = (count, one, few, many) => count % 100 >= 11 && count % 100 <= 14 ? many
                : count % 10 === 1 ? one : count % 10 >= 2 && count % 10 <= 4 ? few : many;
            const stamp = new Date(record.savedAt).toLocaleString('ru-RU');
            status.textContent = `Найдено: ${files} ${noun(files, 'файл', 'файла', 'файлов')}, ${folders} ${noun(folders, 'папка', 'папки', 'папок')} · Индекс: ${stamp}`;
            if (record.persistent === false) status.textContent += ' · Кеш доступен до закрытия вкладки';
        }

        async function search(force = false) {
            clearTimeout(debounce);
            if (!input.value.trim()) { clearSearch(); return; }
            const id = ++requestId;
            const prefix = searchPrefix();
            results.hidden = false;
            catalogPanel.classList.add('poscenter-search-catalog-hidden');
            status.textContent = 'Читаю индекс…';
            let cached = null;
            try {
                cached = await cachedIndex(prefix);
                if (id !== requestId) return;
                if (cached) {
                    selectedIndex = cached;
                    renderMatches(cached, prefix);
                } else { items.replaceChildren(); more.hidden = true; }
                if (job && (force || job.prefix !== prefix)) abortJob();
                if (!force && cached && Date.now() - cached.savedAt < 24 * 60 * 60 * 1000 && !job) return;
                if (!job) {
                    const controller = new AbortController();
                    const task = { prefix, controller };
                    job = task;
                    task.promise = fetchIndex(prefix, controller, (pages, found) => {
                        if (job === task) status.textContent = `Загружаю индекс: страниц ${pages}, файлов ${found}${cached ? ' · показан сохранённый список' : ''}`;
                    });
                }
                const task = job;
                setLoading(true);
                status.textContent = cached ? 'Обновляю индекс · показан сохранённый список…' : 'Загружаю список файлов и папок…';
                const record = await task.promise;
                if (id !== requestId) return;
                selectedIndex = record;
                renderMatches(record, prefix);
            } catch (error) {
                if (id !== requestId) return;
                if (error.name === 'AbortError') {
                    if (selectedIndex) renderMatches(selectedIndex, prefix);
                    status.textContent = `Загрузка индекса остановлена${selectedIndex ? ' · показан сохранённый список' : ''}`;
                } else {
                    status.textContent = `Ошибка загрузки индекса: ${error.message}${cached ? ' · показан сохранённый список' : ''}`;
                }
            } finally {
                if (id === requestId) { job = null; setLoading(false); }
            }
        }

        input.addEventListener('input', () => {
            clearTimeout(debounce);
            if (!input.value.trim()) { clearSearch(); return; }
            if (!job) refresh.disabled = false;
            debounce = window.setTimeout(() => search(), 220);
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') { event.preventDefault(); search(); }
            if (event.key === 'Escape') { input.value = ''; clearSearch(); input.focus(); }
        });
        panel.querySelectorAll('[data-scope]').forEach((button) => button.addEventListener('click', () => {
            if (scope === button.dataset.scope) return;
            requestId += 1;
            abortJob();
            selectedIndex = null;
            scope = button.dataset.scope;
            try { localStorage.setItem('poscenter-search-scope', scope); } catch (_) {}
            updateScope();
            search();
        }));
        refresh.addEventListener('click', () => {
            if (!input.value.trim()) { input.focus(); return; }
            search(true);
        });
        stop.addEventListener('click', () => job?.controller.abort());
        more.addEventListener('click', () => renderPage());
        window.addEventListener('hashchange', () => {
            input.value = '';
            clearSearch();
            updateScope();
        });
        updateScope();
        setLoading(false);
    }

    function scheduleEnhanceFolders() {
        if (enhancementQueued) return;
        enhancementQueued = true;
        window.requestAnimationFrame(() => {
            enhancementQueued = false;
            enhanceFolders();
        });
    }

    function enhanceFolders() {
        document.querySelectorAll('.row').forEach((row) => {
            const openButton = row.querySelector('button[data-open-prefix]');
            const nameCell = row.querySelector('.name-cell');
            if (!openButton) {
                enhanceFileIcon(row, nameCell);
                return;
            }
            if (!nameCell || row.dataset.poscenterFolderEnhanced) return;

            row.dataset.poscenterFolderEnhanced = 'true';
            nameCell.classList.add('poscenter-folder-name');
            nameCell.tabIndex = 0;
            nameCell.setAttribute('role', 'button');
            nameCell.title = 'Открыть папку';
            nameCell.addEventListener('click', () => openButton.click());
            nameCell.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openButton.click();
                }
            });

            const downloadButton = document.createElement('button');
            downloadButton.type = 'button';
            downloadButton.className = 'poscenter-download-folder';
            downloadButton.textContent = 'Скачать всё';
            downloadButton.title = 'Скачать все файлы внутри папки и её вложенных папок';
            downloadButton.addEventListener('click', (event) => {
                event.stopPropagation();
                startFolderDownload(openButton.dataset.openPrefix || '');
            });
            const copyLinkButton = document.createElement('button');
            copyLinkButton.type = 'button';
            copyLinkButton.className = 'poscenter-copy-folder-link';
            copyLinkButton.textContent = 'Скопировать ссылку';
            copyLinkButton.title = 'Скопировать прямую ссылку на эту папку';
            copyLinkButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                const copied = await copyFolderLink(openButton.dataset.openPrefix || '');
                if (!copied) return;
                const originalText = copyLinkButton.textContent;
                copyLinkButton.textContent = 'Скопировано';
                window.setTimeout(() => { copyLinkButton.textContent = originalText; }, 1400);
            });
            row.querySelector('.actions')?.append(downloadButton, copyLinkButton);
        });
    }

    function enhanceFileIcon(row, nameCell) {
        const downloadLink = row.querySelector('.actions a.action-link[download]');
        if (!nameCell || row.dataset.poscenterFileIconEnhanced || !downloadLink) return;
        const icon = nameCell.querySelector('.icon');
        const name = nameCell.querySelector('.name-main')?.textContent.trim() || '';
        if (!icon || !name) return;
        const extension = name.match(/\.([a-z0-9]{1,8})$/i)?.[1].toLowerCase() || '';
        const label = extension && extension.length <= 4 ? extension.toUpperCase() : 'FILE';
        const type = document.createElement('span');
        type.className = 'poscenter-file-type';
        type.textContent = label;
        icon.replaceChildren(type);
        icon.classList.add('poscenter-file-icon');
        icon.dataset.kind = FILE_TYPE_GROUPS[extension] || 'other';
        icon.title = extension ? `Файл ${extension.toUpperCase()}` : 'Файл';
        row.classList.add('poscenter-file-row');
        if (PREVIEWABLE_EXTENSIONS.has(extension)) {
            const openLink = document.createElement('a');
            openLink.className = 'poscenter-open-file';
            openLink.href = downloadLink.href;
            openLink.target = '_blank';
            openLink.rel = 'noopener noreferrer';
            openLink.textContent = 'Открыть';
            openLink.title = 'Открыть файл в новой вкладке';
            downloadLink.before(openLink);
            row.classList.add('poscenter-previewable-file');
        }
        const copyLinkButton = document.createElement('button');
        copyLinkButton.type = 'button';
        copyLinkButton.className = 'poscenter-copy-file-link';
        copyLinkButton.textContent = 'Ссылка';
        copyLinkButton.title = 'Скопировать ссылку на файл';
        copyLinkButton.addEventListener('click', async () => {
            if (!await copyLink(getReadableUrl(downloadLink.href))) return;
            copyLinkButton.textContent = '✓';
            copyLinkButton.title = 'Ссылка скопирована';
            window.setTimeout(() => {
                copyLinkButton.textContent = 'Ссылка';
                copyLinkButton.title = 'Скопировать ссылку на файл';
            }, 1400);
        });
        downloadLink.after(copyLinkButton);
        row.dataset.poscenterFileIconEnhanced = 'true';
    }

    async function startFolderDownload(prefix) {
        if (!prefix || activeDownload) return;
        const progress = showProgress('Подготовка списка файлов...', true);
        activeDownload = { cancelled: false, progress };

        try {
            const files = await listFolderFiles(prefix, (pages, found) => {
                setProgress(progress, `Проверено страниц: ${pages}. Найдено файлов: ${found}.`, 0);
            });
            if (activeDownload.cancelled) {
                finishProgress(progress, 'Загрузка отменена.', false);
                return;
            }
            if (!files.length) {
                finishProgress(progress, 'В папке и вложенных папках нет файлов.', false);
                return;
            }

            const folderName = prefix.replace(/\/$/, '').split('/').pop() || 'папка';
            const accepted = confirm(`Папка «${folderName}»: найдено файлов ${files.length}.\n\nБраузер скачает их по отдельности. При первом запуске разрешите несколько загрузок для fs.poscenter.org.`);
            if (!accepted) {
                finishProgress(progress, 'Загрузка отменена.', false);
                return;
            }

            for (let index = 0; index < files.length; index += 1) {
                if (activeDownload.cancelled) {
                    finishProgress(progress, `Остановлено: отправлено ${index} из ${files.length}.`, false);
                    return;
                }
                downloadFile(files[index]);
                const sent = index + 1;
                setProgress(progress, `Отправлено браузеру: ${sent} из ${files.length}.`, sent / files.length);
                await wait(DOWNLOAD_INTERVAL_MS);
            }
            finishProgress(progress, `Отправлено браузеру: ${files.length} из ${files.length}.`, true);
        } catch (error) {
            console.error('POScenter folder download:', error);
            finishProgress(progress, `Ошибка: ${error.message}`, false);
        } finally {
            activeDownload = null;
        }
    }

    async function listFolderFiles(prefix, onProgress) {
        const files = [];
        let continuationToken = '';
        let pages = 0;
        do {
            const url = new URL(`${STORAGE_ORIGIN}/${BUCKET_NAME}`);
            url.searchParams.set('list-type', '2');
            url.searchParams.set('prefix', prefix);
            url.searchParams.set('max-keys', '1000');
            if (continuationToken) url.searchParams.set('continuation-token', continuationToken);

            const response = await fetch(url, { method: 'GET' });
            const xmlText = await response.text();
            if (!response.ok) throw new Error(`не удалось прочитать список файлов (HTTP ${response.status})`);
            const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
            if (xml.querySelector('parsererror')) throw new Error('сервер вернул некорректный список файлов');

            files.push(...[...xml.querySelectorAll('Contents > Key')]
                .map((node) => node.textContent || '')
                .filter((key) => key && !key.endsWith('/') && !shouldHideKey(key)));
            pages += 1;
            onProgress(pages, files.length);
            continuationToken = xml.querySelector('NextContinuationToken')?.textContent || '';
            const truncated = xml.querySelector('IsTruncated')?.textContent?.toLowerCase() === 'true';
            if (!truncated) break;
        } while (continuationToken);

        return files;
    }

    function shouldHideKey(key) {
        const lower = key.toLowerCase();
        return lower === 'index.html' || lower.endsWith('/index.html') || lower === 'favicon.svg' || lower.endsWith('/favicon.svg');
    }

    function downloadFile(key) {
        const encodedPath = key.split('/').map(encodeURIComponent).join('/');
        const link = document.createElement('a');
        link.href = `${DOWNLOAD_ORIGIN}/${encodedPath}`;
        link.download = key.split('/').pop() || 'file';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    async function copyFolderLink(prefix) {
        const url = `${DOWNLOAD_ORIGIN}/#/${encodeReadablePath(prefix)}`;
        return copyLink(url);
    }

    function encodeReadablePath(path) {
        return path.split('/').map((segment) => Array.from(segment, (char) => {
            if (/[\p{L}\p{M}\p{N}]/u.test(char)) return char;
            return encodeURIComponent(char).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
        }).join('')).join('/');
    }

    function getReadableUrl(value) {
        const url = new URL(value, location.origin);
        const readablePath = url.pathname.split('/').map((segment) => {
            try { return encodeReadablePath(decodeURIComponent(segment)); }
            catch (_) { return segment; }
        }).join('/');
        return `${url.origin}${readablePath}${url.search}${url.hash}`;
    }

    async function copyLink(url) {
        try {
            await navigator.clipboard.writeText(url);
            return true;
        } catch (_) {
            const textarea = document.createElement('textarea');
            textarea.value = url;
            textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand('copy');
            textarea.remove();
            return copied;
        }
    }

    function showProgress(message, cancellable) {
        document.getElementById('poscenter-folder-progress')?.remove();
        const panel = document.createElement('div');
        panel.id = 'poscenter-folder-progress';
        panel.innerHTML = `
            <div class="poscenter-progress-title">Скачивание папки</div>
            <div class="poscenter-progress-text"></div>
            <div class="poscenter-progress-track"><div class="poscenter-progress-bar"></div></div>
            <div class="poscenter-progress-actions"></div>`;
        const actions = panel.querySelector('.poscenter-progress-actions');
        if (cancellable) {
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.textContent = 'Остановить';
            cancel.onclick = () => { if (activeDownload) activeDownload.cancelled = true; };
            actions.appendChild(cancel);
        }
        document.body.appendChild(panel);
        setProgress(panel, message, 0);
        return panel;
    }

    function setProgress(panel, message, fraction) {
        if (!panel?.isConnected) return;
        panel.querySelector('.poscenter-progress-text').textContent = message;
        panel.querySelector('.poscenter-progress-bar').style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    }

    function finishProgress(panel, message, success) {
        if (!panel?.isConnected) return;
        setProgress(panel, message, success ? 1 : 0);
        panel.classList.toggle('poscenter-progress-success', success);
        const actions = panel.querySelector('.poscenter-progress-actions');
        actions.replaceChildren();
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Закрыть';
        close.onclick = () => panel.remove();
        actions.appendChild(close);
    }

    function wait(milliseconds) {
        return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #poscenter-search, #poscenter-search-output { padding:16px; background:var(--surface,#fff); color:var(--text,#1b2430); border:1px solid var(--border,#dbe4f0); border-radius:8px; }
            #poscenter-search { margin:0 0 18px; }
            #poscenter-search-output { margin:18px 0; }
            .poscenter-search-controls { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
            #poscenter-search input { flex:1 1 270px; min-width:0; width:100%; height:40px; padding:8px 12px; color:var(--text,#1b2430); background:var(--surface,#fff); border:1px solid var(--border,#dbe4f0); border-radius:6px; font:inherit; }
            #poscenter-search input:focus-visible { outline:2px solid var(--accent,#005ff9); outline-offset:1px; }
            #poscenter-search button, #poscenter-search-output button, .poscenter-search-actions a { min-height:36px; padding:6px 10px; border:1px solid var(--border,#dbe4f0); border-radius:6px; background:var(--surface-2,#f7f9fd); color:var(--text,#1b2430); font:inherit; font-size:14px; line-height:1.4; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; }
            #poscenter-search button:disabled { opacity:.5; cursor:default; }
            #poscenter-search button:hover:not(:disabled), #poscenter-search-output button:hover, .poscenter-search-actions a:hover { background:var(--surface-3,#eef3fb); }
            .poscenter-search-scopes { display:flex; flex:0 1 auto; }
            #poscenter-search .poscenter-search-scopes button { border-radius:0; min-height:40px; }
            #poscenter-search .poscenter-search-scopes button:first-child { border-radius:6px 0 0 6px; }
            #poscenter-search .poscenter-search-scopes button:last-child { border-radius:0 6px 6px 0; border-left:0; }
            #poscenter-search .poscenter-search-scopes button[aria-pressed="true"] { background:var(--accent,#005ff9); color:#fff; }
            #poscenter-search .poscenter-search-scopes button[aria-pressed="true"]:hover { background:var(--accent-hover,#0047c2); }
            .poscenter-search-location { margin-top:8px; color:var(--muted,#6b7280); font-size:13px; overflow-wrap:anywhere; }
            .poscenter-search-status { margin-top:6px; font-size:14px; overflow-wrap:anywhere; }
            #poscenter-search-output progress { display:block; width:100%; height:7px; margin:10px 0; accent-color:var(--accent,#005ff9); }
            #poscenter-search [hidden], #poscenter-search-output[hidden], #poscenter-search-output [hidden], .poscenter-search-catalog-hidden { display:none!important; }
            .poscenter-search-results { margin-top:12px; border-top:1px solid var(--border,#dbe4f0); }
            .poscenter-search-item { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:14px; padding:14px 0; border-bottom:1px solid var(--border,#dbe4f0); }
            .poscenter-search-info { min-width:0; }
            .poscenter-search-name { color:var(--text,#1b2430); font-weight:700; text-decoration:none; overflow-wrap:anywhere; }
            .poscenter-search-name:hover { text-decoration:underline; }
            .poscenter-search-path { color:var(--muted,#6b7280); font-size:13px; overflow-wrap:anywhere; margin-top:3px; }
            .poscenter-search-meta { color:var(--muted,#6b7280); font-size:12px; margin-top:3px; }
            .poscenter-search-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:flex-end; }
            #poscenter-search-output .poscenter-search-copy { width:112px; }
            #poscenter-search-output .poscenter-search-more { margin-top:14px; }
            @media(max-width:700px) {
                #poscenter-search input { flex-basis:100%; }
                .poscenter-search-scopes { flex:1 1 100%; }
                #poscenter-search .poscenter-search-scopes button { flex:1; }
                .poscenter-search-item { grid-template-columns:minmax(0,1fr); gap:10px; }
                .poscenter-search-actions { justify-content:flex-start; }
            }
            @media (min-width:861px) {
                #list .row.poscenter-file-row { grid-template-columns:minmax(180px,1.8fr) 65px minmax(125px,150px) 185px; }
                #list .row.poscenter-previewable-file { grid-template-columns:minmax(180px,1.8fr) 65px minmax(125px,150px) 275px; }
            }
            .row.poscenter-file-row .actions { gap:8px; white-space:nowrap; }
            .poscenter-open-file, .poscenter-copy-file-link { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 10px; border:1px solid var(--border,#b8c8da); border-radius:10px; background:var(--surface-2,#f7f9fd); color:var(--text,#1b2430); font:inherit; text-decoration:none; cursor:pointer; }
            .poscenter-copy-file-link { width:72px; flex:0 0 72px; padding:0 4px; }
            .poscenter-open-file:hover, .poscenter-open-file:focus-visible, .poscenter-copy-file-link:hover, .poscenter-copy-file-link:focus-visible { background:var(--surface-3,#eef3fb); }
            .icon.poscenter-file-icon { position:relative; isolation:isolate; border:0; background:transparent; color:#fff; }
            .icon.poscenter-file-icon::before { content:''; position:absolute; inset:3px 6px; z-index:-1; border-radius:3px; background:var(--poscenter-file-color,#59677b); clip-path:polygon(0 0,70% 0,100% 25%,100% 100%,0 100%); }
            .icon.poscenter-file-icon::after { content:''; position:absolute; top:3px; right:6px; width:8px; height:8px; background:#ffffff88; clip-path:polygon(0 0,0 100%,100% 100%); }
            .icon.poscenter-file-icon .poscenter-file-type { position:relative; z-index:1; margin-top:10px; color:#fff; font:800 8px/1 Arial,sans-serif; letter-spacing:0; }
            .icon.poscenter-file-icon[data-kind="archive"] { --poscenter-file-color:#8a5b15; }
            .icon.poscenter-file-icon[data-kind="app"] { --poscenter-file-color:#286e67; }
            .icon.poscenter-file-icon[data-kind="pdf"] { --poscenter-file-color:#b7404a; }
            .icon.poscenter-file-icon[data-kind="document"] { --poscenter-file-color:#3a67a9; }
            .icon.poscenter-file-icon[data-kind="sheet"] { --poscenter-file-color:#21775c; }
            .icon.poscenter-file-icon[data-kind="presentation"] { --poscenter-file-color:#a95330; }
            .icon.poscenter-file-icon[data-kind="image"] { --poscenter-file-color:#7952a6; }
            .icon.poscenter-file-icon[data-kind="video"] { --poscenter-file-color:#a23f77; }
            .icon.poscenter-file-icon[data-kind="audio"] { --poscenter-file-color:#7f5aaf; }
            .icon.poscenter-file-icon[data-kind="firmware"] { --poscenter-file-color:#626c2c; }
            .poscenter-folder-name { cursor:pointer; border-radius:8px; padding:4px; margin:-4px; }
            .poscenter-folder-name:hover, .poscenter-folder-name:focus-visible { background:#eef3fb; outline:2px solid #89b8ff; outline-offset:2px; }
            .poscenter-download-folder, .poscenter-copy-folder-link { margin-left:8px; min-height:40px; padding:0 12px; border:1px solid #b8c8da; border-radius:10px; background:#f7f9fd; color:#1b2430; font:inherit; font-weight:700; cursor:pointer; }
            .poscenter-download-folder:hover, .poscenter-copy-folder-link:hover { background:#e7f0ff; border-color:#72a5e8; }
            #poscenter-folder-progress { position:fixed; z-index:2147483647; right:20px; bottom:20px; width:min(380px, calc(100vw - 40px)); padding:16px; border:1px solid #cfd9e7; border-radius:8px; background:#fff; color:#1b2430; box-shadow:0 12px 32px rgba(15,23,42,.2); font:14px system-ui,sans-serif; }
            .poscenter-progress-title { font-weight:800; margin-bottom:8px; }
            .poscenter-progress-text { color:#536273; min-height:40px; }
            .poscenter-progress-track { height:7px; margin:10px 0 14px; overflow:hidden; border-radius:4px; background:#e5ebf3; }
            .poscenter-progress-bar { width:0; height:100%; background:#1769d1; transition:width .15s ease; }
            .poscenter-progress-success .poscenter-progress-bar { background:#27804b; }
            .poscenter-progress-actions { display:flex; justify-content:flex-end; }
            .poscenter-progress-actions button { padding:7px 10px; border:1px solid #aebdcd; border-radius:5px; background:#f7f9fd; color:#1b2430; cursor:pointer; font:inherit; }
            @media (max-width:860px) { .poscenter-download-folder, .poscenter-copy-folder-link { margin-left:0; } }
        `;
        document.head.appendChild(style);
    }
})();
