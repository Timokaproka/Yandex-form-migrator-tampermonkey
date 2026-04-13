// ==UserScript==
// @name         Yandex Forms Migrator Massive (V10.6)
// @namespace    http://tampermonkey.net/
// @version      10.6
// @description  Перенос всех свойств вопроса (включая description, лимиты, матрицы)
// @author       timokaproka
// @match        https://forms.yandex.ru/admin*
// @match        https://forms.yandex.ru/cloud/admin*
// @icon         https://yastatic.net/s3/cloud/forms/v27.97.0/public/i/icons/color/favicon-new-64.png
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      avatars.mds.yandex.net
// @connect      s3.mds.yandex.net
// @connect      forms.yandex.ru
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // ПЕРЕХВАТЧИК УДАЛЕНИЯ ФОРМ (XHR / Fetch)
    // ==========================================
    function tryExtractSurveyId(url, body) {
        if (body && typeof body === 'string') {
            try {
                const parsed = JSON.parse(body);
                if (parsed.surveyId) return parsed.surveyId;
            } catch(e) {}
        }
        try {
            const urlObj = new URL(url, window.location.origin);
            return urlObj.searchParams.get('surveyId');
        } catch(e) {
            return null;
        }
    }

    function checkDeletionSignal(url, body) {
        if (typeof url === 'string' && url.toLowerCase().includes('delete')) {
            const surveyId = tryExtractSurveyId(url, body);
            if (surveyId) {
                document.dispatchEvent(new CustomEvent('YandexFormDeleted', { detail: { surveyId } }));
            }
        }
    }

    if (typeof unsafeWindow !== 'undefined') {
        const origFetch = unsafeWindow.fetch;
        unsafeWindow.fetch = async function(...args) {
            const response = await origFetch.apply(this, args);
            try { checkDeletionSignal(args[0], args[1]?.body); } catch(e) {}
            return response;
        };

        const origXhrOpen = unsafeWindow.XMLHttpRequest.prototype.open;
        unsafeWindow.XMLHttpRequest.prototype.open = function(method, url) {
            this._requestUrl = url;
            return origXhrOpen.apply(this, arguments);
        };

        const origXhrSend = unsafeWindow.XMLHttpRequest.prototype.send;
        unsafeWindow.XMLHttpRequest.prototype.send = function(body) {
            this.addEventListener('load', function() {
                try {
                    if (this._requestUrl && this._requestUrl.toLowerCase().includes('delete') && this.status >= 200 && this.status < 300) {
                        checkDeletionSignal(this._requestUrl, body);
                    }
                } catch(e) {}
            });
            return origXhrSend.apply(this, arguments);
        };
    }

    // ==========================================
    // УТИЛИТЫ И КОНСТАНТЫ
    // ==========================================
    const RATE_LIMIT_DELAY = 9000;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const svgExport = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/></svg>`;
    const svgImport = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M12 12v6"/><path d="m15 15-3-3-3 3"/></svg>`;

    function sanitizeData(obj) {
        if (!obj) return obj;
        if (Array.isArray(obj)) return obj.map(sanitizeData);
        if (typeof obj === 'object') {
            const sanitized = {};
            const forbiddenKeys = ['id', 'slug', 'owner', 'createdAt', 'updatedAt', 'publicUrl', 'created', 'profile', 'is_public', 'is_favourite'];
            for (const key in obj) {
                if (forbiddenKeys.includes(key)) continue;
                sanitized[key] = sanitizeData(obj[key]);
            }
            return sanitized;
        }
        return obj;
    }

    // ==========================================
    // БЛОК 1: МОДУЛЬ КОНТЕКСТА
    // ==========================================
    function getContext() {
        let collabId = "";
        let orgId = "";
        let csrf = "";

        if (typeof unsafeWindow !== 'undefined' && unsafeWindow.__DATA__) {
            const d = unsafeWindow.__DATA__;
            collabId = d.currentOrganization?.collab_id || d.collabOrgId || "";
            orgId = d.appSettings?.orgId || d.orgId || "";
            csrf = d.csrfToken || "";
        }

        if (!csrf) {
            csrf = document.querySelector('meta[name="csrf-token"]')?.content || "";
        }

        const finalId = collabId || orgId || unsafeWindow?.AppConfig?.orgId || "";
        const isCloud = window.location.pathname.includes('/cloud/');
        const baseUrl = isCloud ? "/cloud/admin/gateway/root/form/" : "/admin/gateway/root/form/";

        let createUrl = isCloud ? "/cloud/admin/new-form" : "/admin/new-form";
        if (collabId) {
            createUrl += `?collab_id=${collabId}`;
        } else if (orgId && isCloud) {
            createUrl += `?collab_id=${orgId}`;
        } else if (orgId && !isCloud) {
            createUrl += `?orgId=${orgId}`;
        }

        const headers = {
            "x-csrf-token": csrf,
            "x-use-collab": "1",
            "x-sdk": "1"
        };

        if (finalId) {
            headers["x-collab-org-id"] = finalId;
        }

        return { finalId, baseUrl, createUrl, headers, isCloud };
    }


    // ==========================================
    // БЛОК 2: СЕТЕВОЙ МОДУЛЬ И ОБРАБОТКА ВЛОЖЕНИЙ
    // ==========================================
    function gmFetch(details) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                ...details,
                onload: (res) => (res.status >= 200 && res.status < 300) ? resolve(res) : reject(res),
                onerror: reject
            });
        });
    }

    async function uploadImageDirect(attachmentObj, ctx, targetSurveyId) {
        if (!attachmentObj || !attachmentObj.links) return null;

        const links = attachmentObj.links;
        const bestUrl = links["orig"] || links["2560x"] || links["1280x"] || links["720x"] || Object.values(links)[0];

        if (!bestUrl) return null;

        try {
            const imgRes = await gmFetch({ method: "GET", url: bestUrl, responseType: "blob" });
            const formData = new FormData();
            formData.append('image', imgRes.response, attachmentObj.name || "image.jpg");
            formData.append('surveyId', targetSurveyId);

            const uploadHeaders = {
                "x-csrf-token": ctx.headers["x-csrf-token"],
                "x-use-collab": "1",
                "x-sdk": "1"
            };
            if (ctx.finalId) uploadHeaders["x-collab-org-id"] = ctx.finalId;

            const uploadRes = await gmFetch({
                method: "POST",
                url: window.location.origin + ctx.baseUrl + "uploadImages",
                headers: uploadHeaders,
                data: formData
            });

            return JSON.parse(uploadRes.responseText);
        } catch (e) {
            return null;
        }
    }

    async function processAttachments(obj, ctx, surveyId) {
        if (!obj) return obj;
        if (Array.isArray(obj)) {
            const newArr = [];
            for (let item of obj) {
                newArr.push(await processAttachments(item, ctx, surveyId));
            }
            return newArr;
        }
        if (typeof obj === 'object') {
            if (obj.links && typeof obj.links === 'object') {
                const urls = Object.values(obj.links);
                if (urls.length > 0 && typeof urls[0] === 'string' && (urls[0].includes('yandex.net') || urls[0].includes('yandex.ru'))) {
                    return await uploadImageDirect(obj, ctx, surveyId);
                }
            }

            const newObj = {};
            for (const key in obj) {
                newObj[key] = await processAttachments(obj[key], ctx, surveyId);
            }
            return newObj;
        }
        return obj;
    }


    // ==========================================
    // БЛОК 3: БИЗНЕС-ЛОГИКА (ЭКСПОРТ/ИМПОРТ)
    // ==========================================
    async function fetchSurveyData(surveyId, ctx) {
        const h = { ...ctx.headers, "Content-Type": "application/json" };
        const [surveyRes, infoRes, submitRes, quizRes, questionsRes, hooksRes] = await Promise.all([
            fetch(`${ctx.baseUrl}getSurveyData`, { method: "POST", headers: h, body: JSON.stringify({ surveyId }) }).then(r => r.json()),
            fetch(`${ctx.baseUrl}getSurveyInfo`, { method: "POST", headers: h, body: JSON.stringify({ surveyId }) }).then(r => r.json()),
            fetch(`${ctx.baseUrl}getSubmitConditions`, { method: "POST", headers: h, body: JSON.stringify({ surveyId }) }).then(r => r.json()),
            fetch(`${ctx.baseUrl}getQuizSettingsLA`, { method: "POST", headers: h, body: JSON.stringify({ surveyId }) }).then(r => r.json()),
            fetch(`${ctx.baseUrl}surveyQuestionsLA`, { method: "POST", headers: h, body: JSON.stringify({ surveyId }) }).then(r => r.json()),
            fetch(`${ctx.baseUrl}getHooks`, { method: "POST", headers: h, body: JSON.stringify({ surveyId }) }).then(r => r.json()).catch(() => [])
        ]);

        const orderedIds = questionsRes.nodes[0].items.map(item => `q_${item.id}`);
        const sortedQuestions = orderedIds.map(key => questionsRes.questionsMap[key]).filter(Boolean);

        return {
            formName: surveyRes.name,
            texts: infoRes.texts || {},
            surveyData: sanitizeData(surveyRes),
            surveyInfo: sanitizeData(infoRes),
            submitConditions: submitRes.conditions || (Array.isArray(submitRes) ? submitRes : []),
            quizSettings: quizRes.quizSettings || quizRes,
            questions: sortedQuestions,
            hooks: hooksRes
        };
    }

    async function applyData(surveyId, data, ctx) {
        const h = { ...ctx.headers, "Content-Type": "application/json" };

        try {
            let surveyUpdatePayload = data.surveyData ? { ...data.surveyData } : { name: data.formName };
            surveyUpdatePayload.name = data.formName || surveyUpdatePayload.name || "Импортированная форма";
            if (data.texts) surveyUpdatePayload.texts = data.texts;

            surveyUpdatePayload = await processAttachments(surveyUpdatePayload, ctx, surveyId);
            await fetch(`${ctx.baseUrl}updateSurveyData`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, survey: surveyUpdatePayload }) });
        } catch (e) {}

        if (data.surveyInfo) {
            try {
                let surveyInfoPayload = { ...data.surveyInfo };
                surveyInfoPayload.name = data.formName || surveyInfoPayload.name || "Импортированная форма";
                if (data.texts) surveyInfoPayload.texts = data.texts;

                surveyInfoPayload = await processAttachments(surveyInfoPayload, ctx, surveyId);
                await fetch(`${ctx.baseUrl}updateSurveyInfo`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, surveyInfo: surveyInfoPayload }) });
            } catch (e) {}
        }

        if (data.quizSettings) {
            try {
                const quizPayload = await processAttachments(data.quizSettings, ctx, surveyId);
                await fetch(`${ctx.baseUrl}updateQuizSettingsLA`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, quiz: quizPayload }) });
            } catch (e) {}
        }

        if (data.submitConditions?.length > 0) {
            try {
                await fetch(`${ctx.baseUrl}updateSubmitConditions`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, conditions: data.submitConditions }) });
            } catch (e) {}
        }

        try {
            const newHooks = await fetch(`${ctx.baseUrl}getHooks`, { method: "POST", headers: h, body: JSON.stringify({ surveyId }) }).then(r => r.json());
            if (Array.isArray(newHooks)) {
                for (const hook of newHooks) {
                    if (hook && hook.id) {
                        await fetch(`${ctx.baseUrl}updateHook`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, groupId: hook.id, active: false }) });
                        await sleep(200);
                    }
                }
            }
        } catch (e) {}

        try {
            const init = await fetch(`${ctx.baseUrl}surveyQuestionsLA`, { method: "POST", headers: h, body: JSON.stringify({ surveyId }) }).then(r => r.json());
            const pageId = init.nodes[0].id;

            for (let i = 0; i < data.questions.length; i++) {
                let q = data.questions[i];
                q = await processAttachments(q, ctx, surveyId);

                // Копирование всех свойств вопроса вместо явного перечисления
                const payload = {
                    surveyId, page: pageId, position: i + 1,
                    question: { ...q }
                };

                delete payload.question.id; delete payload.question.key;

                await fetch(`${ctx.baseUrl}addSurveyQuestion`, { method: "POST", headers: h, body: JSON.stringify(payload) });
                await sleep(400);
            }
        } catch (e) {}
    }

    async function createFormViaIframe(createUrl) {
        return new Promise((resolve, reject) => {
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            document.body.appendChild(iframe);

            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("Превышено время ожидания создания формы (Iframe Timeout)"));
            }, 25000);

            const cleanup = () => {
                clearTimeout(timer); clearInterval(interval);
                if (document.body.contains(iframe)) document.body.removeChild(iframe);
            };

            const interval = setInterval(() => {
                try {
                    const curr = iframe.contentWindow.location.href;
                    const match = curr.match(/[a-f0-9]{24}/);
                    if (match && !curr.includes('new-form')) {
                        cleanup();
                        resolve(match[0]);
                    }
                } catch (e) {}
            }, 500);

            iframe.src = createUrl;
        });
    }

    // ==========================================
    // БЛОК 4: ИНТЕРФЕЙС И МАССОВЫЕ ДЕЙСТВИЯ
    // ==========================================
    function initUI() {
        const selectedForms = new Set();

        function updateExportCounter() {
            const counterSpan = document.querySelector('.migrator-btn-export .export-counter');
            if (counterSpan) {
                counterSpan.innerText = `Экспорт (${selectedForms.size})`;
            }
        }

        function updateSelectAllButtonState() {
            const btnText = document.querySelector('.migrator-bulk-actions button:first-child .g-button__text');
            if (!btnText) return;

            if (selectedForms.size === 0) {
                btnText.innerText = 'Выбрать все';
                return;
            }

            const checkboxes = document.querySelectorAll('.migrator-form-checkbox');
            if (checkboxes.length === 0) {
                btnText.innerText = 'Выбрать все';
                return;
            }

            const allChecked = Array.from(checkboxes).every(cb => selectedForms.has(cb.value));
            btnText.innerText = allChecked ? 'Снять выделение' : 'Выбрать все';
        }

        document.addEventListener('YandexFormDeleted', (e) => {
            if (e.detail && e.detail.surveyId) {
                if (selectedForms.has(e.detail.surveyId)) {
                    selectedForms.delete(e.detail.surveyId);
                    updateExportCounter();
                    updateSelectAllButtonState();
                }
            }
        });

        const mainBulkFileInput = document.createElement('input');
        mainBulkFileInput.type = 'file';
        mainBulkFileInput.accept = '.json';
        mainBulkFileInput.multiple = true;
        mainBulkFileInput.style.display = 'none';
        document.body.appendChild(mainBulkFileInput);

        mainBulkFileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;

            const allFormsToImport = [];
            let filesProcessed = 0;

            files.forEach(file => {
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const parsedData = JSON.parse(ev.target.result);
                        if (Array.isArray(parsedData)) allFormsToImport.push(...parsedData);
                        else allFormsToImport.push(parsedData);
                    } catch (err) {}

                    filesProcessed++;
                    if (filesProcessed === files.length && allFormsToImport.length > 0) {
                        runBulkImport(allFormsToImport, getContext());
                    }
                };
                reader.readAsText(file);
            });
            e.target.value = '';
        });

        async function runBulkImport(formsArray, ctx) {
            for (let i = 0; i < formsArray.length; i++) {
                const data = formsArray[i];

                try {
                    if (i > 0) {
                        await sleep(RATE_LIMIT_DELAY);
                    }

                    const separator = ctx.createUrl.includes('?') ? '&' : '?';
                    const urlWithCacheBuster = `${ctx.createUrl}${separator}_=${Date.now()}`;

                    const newSurveyId = await createFormViaIframe(urlWithCacheBuster);
                    await applyData(newSurveyId, data, ctx);
                } catch (err) {}
            }

            location.reload();
        }

        async function doBulkExport() {
            if (selectedForms.size === 0) {
                return;
            }

            const ids = Array.from(selectedForms);
            const ctx = getContext();
            const bulkData = [];

            for (const id of ids) {
                try {
                    const data = await fetchSurveyData(id, ctx);
                    bulkData.push({ originalId: id, ...data });
                } catch (err) {}
            }

            const blob = new Blob([JSON.stringify(bulkData, null, 2)], { type: "application/json" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `forms_bulk_export_${ids.length}_items.json`;
            a.click();
        }

        const observer = new MutationObserver(() => {
            let domChanged = false;

            const rows = document.querySelectorAll('.g-table__row, tr');
            rows.forEach(row => {
                const link = row.querySelector('a[href*="/admin/"]');
                if (!link) return;

                const match = link.href.match(/[a-f0-9]{24}/);
                if (!match) return;
                const surveyId = match[0];

                const existingContainer = row.querySelector('.migrator-checkbox-container');
                if (existingContainer) {
                    const cb = existingContainer.querySelector('.migrator-form-checkbox');
                    if (cb && cb.value !== surveyId) {
                        cb.value = surveyId;
                        cb.checked = selectedForms.has(surveyId);
                        domChanged = true;
                    }
                    return;
                }

                const container = document.createElement('div');
                container.className = 'migrator-checkbox-container';
                container.style.cssText = 'display: inline-block; vertical-align: middle; margin-left: 15px;';
                container.onclick = (e) => e.stopPropagation();

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'migrator-form-checkbox';
                cb.value = surveyId;
                cb.checked = selectedForms.has(surveyId);
                cb.style.cssText = 'width: 16px; height: 16px; cursor: pointer; margin: 0;';

                cb.addEventListener('change', (e) => {
                    if (e.target.checked) selectedForms.add(surveyId);
                    else selectedForms.delete(surveyId);

                    updateExportCounter();
                    updateSelectAllButtonState();
                });

                container.appendChild(cb);
                link.parentNode.insertBefore(container, link.nextSibling);
                domChanged = true;
            });

            const filtersContainer = document.querySelector('.Main-Filters');
            if (filtersContainer && !document.querySelector('.migrator-bulk-actions')) {
                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'migrator-bulk-actions';
                actionsDiv.style.cssText = 'display: flex; gap: 8px; margin-left: auto;';

                const btnSelectAll = document.createElement('button');
                btnSelectAll.className = 'g-button g-button_view_flat-secondary g-button_size_l g-button_pin_round-round';
                btnSelectAll.type = 'button';
                btnSelectAll.innerHTML = '<span class="g-button__text">Выбрать все</span>';

                btnSelectAll.onclick = () => {
                    const checkboxes = document.querySelectorAll('.migrator-form-checkbox');
                    if (checkboxes.length === 0) return;

                    const allChecked = Array.from(checkboxes).every(cb => selectedForms.has(cb.value));
                    const newState = !allChecked;

                    checkboxes.forEach(cb => {
                        cb.checked = newState;
                        if (newState) selectedForms.add(cb.value);
                        else selectedForms.delete(cb.value);
                    });

                    updateExportCounter();
                    updateSelectAllButtonState();
                };

                const btnExportBulk = document.createElement('button');
                btnExportBulk.className = 'g-button g-button_view_normal g-button_size_l g-button_pin_round-round migrator-btn-export';
                btnExportBulk.type = 'button';
                btnExportBulk.innerHTML = `<span class="g-button__text" style="display:flex;align-items:center;gap:6px;">${svgExport} <span class="export-counter">Экспорт (${selectedForms.size})</span></span>`;
                btnExportBulk.onclick = doBulkExport;

                const btnImportBulk = document.createElement('button');
                btnImportBulk.className = 'g-button g-button_view_normal g-button_size_l g-button_pin_round-round migrator-btn-import';
                btnImportBulk.type = 'button';
                btnImportBulk.innerHTML = `<span class="g-button__text" style="display:flex;align-items:center;gap:6px;">${svgImport} <span>Импорт</span></span>`;
                btnImportBulk.onclick = () => mainBulkFileInput.click();

                actionsDiv.appendChild(btnSelectAll);
                actionsDiv.appendChild(btnExportBulk);
                actionsDiv.appendChild(btnImportBulk);

                filtersContainer.appendChild(actionsDiv);
                domChanged = true;
            }

            if (domChanged) {
                updateSelectAllButtonState();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    initUI();

})();