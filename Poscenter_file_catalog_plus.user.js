// ==UserScript==
// @name         POScenter Files: удобные папки и массовая загрузка
// @namespace    https://fs.poscenter.org/
// @version      1.0.8
// @description  Открытие папок по названию, скачивание, просмотр и ссылки на файлы.
// @match        https://fs.poscenter.org/*
// @run-at       document-idle
// @grant        none
// @author       Jeronimo701
// @license      LicenseRef-Jeronimo701-Personal-Use-1.0
// @updateURL    https://gist.githubusercontent.com/jeronimo701/59bda3878da869e16e54c3f22084f9b3/raw/Poscenter_file_catalog_plus.user.js
// @downloadURL  https://gist.githubusercontent.com/jeronimo701/59bda3878da869e16e54c3f22084f9b3/raw/Poscenter_file_catalog_plus.user.js
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
