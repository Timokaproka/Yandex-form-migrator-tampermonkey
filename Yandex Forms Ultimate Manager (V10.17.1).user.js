// ==UserScript==
// @name         Yandex Forms Ultimate Manager (V10.17.1)
// @namespace    http://tampermonkey.net/
// @version      10.17.1
// @description  Импорт/экспорт форм, массовое управление папками и авто-восстановление структуры папок (Фикс чекбоксов)
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
                console.log(`[Yandex Forms Manager] Перехвачен сигнал удаления формы: ${surveyId}`);
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
    const RATE_LIMIT_FORM_CREATE = 9000;
    const RATE_LIMIT_DELETE = 500;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const svgExport = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/></svg>`;
    const svgImport = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M12 12v6"/><path d="m15 15-3-3-3 3"/></svg>`;
    const svgDelete = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;

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

    function cleanSystemKeys(obj, parentKey = '') {
        if (!obj || typeof obj !== 'object') return;

        if (Array.isArray(obj)) {
            obj.forEach(item => cleanSystemKeys(item, parentKey));
        } else {
            if (parentKey !== 'attachment') {
                delete obj.id;
            }
            delete obj.key;

            for (const k in obj) {
                cleanSystemKeys(obj[k], k);
            }
        }
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

    function isGroupsPage() {
        return window.location.pathname.includes('/groups/all');
    }

    // ==========================================
    // БЛОК 2: СЕТЕВОЙ МОДУЛЬ (АПИ ПАПОК И ФОРМ)
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
        let bestUrl = null;
        let fileName = "image.png";

        if (attachmentObj.externalUrl) {
            bestUrl = attachmentObj.externalUrl;
            fileName = bestUrl.split('/').pop().split('?')[0] || "image.png";
        } else if (attachmentObj.links) {
            const links = attachmentObj.links;
            bestUrl = links["orig"] || links["2560x"] || links["1280x"] || links["720x"] || Object.values(links)[0];
            fileName = attachmentObj.name || "image.jpg";
        }

        if (!bestUrl) return null;

        try {
            console.log(`[Yandex Forms Manager] Загрузка изображения: ${bestUrl}`);
            const imgRes = await gmFetch({ method: "GET", url: bestUrl, responseType: "blob" });
            const formData = new FormData();
            formData.append('image', imgRes.response, fileName);
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
            console.warn(`[Yandex Forms Manager] Ошибка загрузки изображения:`, e);
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
            if (obj.externalUrl && typeof obj.externalUrl === 'string' && !obj.externalUrl.includes('yandex.net')) {
                return await uploadImageDirect(obj, ctx, surveyId);
            }
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

    async function getGroupSurveys(groupId, ctx) {
        const h = { ...ctx.headers, "Content-Type": "application/json" };
        try {
            const res = await fetch(`${ctx.baseUrl}getSurveyGroup`, {
                method: "POST",
                headers: h,
                body: JSON.stringify({ groupId: parseInt(groupId, 10) })
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.surveys && Array.isArray(data.surveys)) {
                    return data.surveys.map(item => item.id);
                }
            }
        } catch (e) {
            console.error(`[Yandex Forms Manager] Ошибка получения списка форм группы ${groupId}:`, e);
        }
        return [];
    }

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
        console.log(`[Yandex Forms Manager] Применение данных для формы ID: ${surveyId}`);

        try {
            let surveyUpdatePayload = data.surveyData ? { ...data.surveyData } : { name: data.formName };
            surveyUpdatePayload.name = data.formName || surveyUpdatePayload.name || "Импортированная форма";
            if (data.texts) surveyUpdatePayload.texts = data.texts;

            surveyUpdatePayload = await processAttachments(surveyUpdatePayload, ctx, surveyId);
            await fetch(`${ctx.baseUrl}updateSurveyData`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, survey: surveyUpdatePayload }) });
        } catch (e) {
            console.warn("[Yandex Forms Manager] Ошибка настройки surveyData:", e);
        }

        if (data.surveyInfo) {
            try {
                let surveyInfoPayload = { ...data.surveyInfo };
                surveyInfoPayload.name = data.formName || surveyInfoPayload.name || "Импортированная форма";
                if (data.texts) surveyInfoPayload.texts = data.texts;

                surveyInfoPayload = await processAttachments(surveyInfoPayload, ctx, surveyId);
                await fetch(`${ctx.baseUrl}updateSurveyInfo`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, surveyInfo: surveyInfoPayload }) });
            } catch (e) {
                console.warn("[Yandex Forms Manager] Ошибка настройки surveyInfo:", e);
            }
        }

        if (data.quizSettings) {
            try {
                const quizPayload = await processAttachments(data.quizSettings, ctx, surveyId);
                await fetch(`${ctx.baseUrl}updateQuizSettingsLA`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, quiz: quizPayload }) });
            } catch (e) {
                console.warn("[Yandex Forms Manager] Ошибка настройки квиза:", e);
            }
        }

        if (data.submitConditions?.length > 0) {
            try {
                await fetch(`${ctx.baseUrl}updateSubmitConditions`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, conditions: data.submitConditions }) });
            } catch (e) {
                console.warn("[Yandex Forms Manager] Ошибка применения условий отправки:", e);
            }
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
        } catch (e) {
            console.warn("[Yandex Forms Manager] Ошибка отключения уведомлений:", e);
        }

        try {
            if (data.questions && data.questions.length > 0) {
                const init = await fetch(`${ctx.baseUrl}surveyQuestionsLA`, { method: "POST", headers: h, body: JSON.stringify({ surveyId }) }).then(r => r.json());
                const pageId = init.nodes[0].id;

                for (let i = 0; i < data.questions.length; i++) {
                    let q = data.questions[i];
                    q = await processAttachments(q, ctx, surveyId);

                    const isSeries = q.type === 'series';
                    const seriesItems = isSeries && Array.isArray(q.items) ? [...q.items] : [];

                    if (isSeries) {
                        q.items = [];
                    }

                    const payload = {
                        surveyId,
                        page: pageId,
                        position: i + 1,
                        question: { ...q }
                    };

                    cleanSystemKeys(payload.question);

                    const response = await fetch(`${ctx.baseUrl}addSurveyQuestion`, { method: "POST", headers: h, body: JSON.stringify(payload) });
                    const responseData = await response.json();
                    await sleep(400);

                    if (isSeries && seriesItems.length > 0 && responseData.id) {
                        const newSeriesId = responseData.id;
                        const newSeriesKey = responseData.key;

                        for (let j = 0; j < seriesItems.length; j++) {
                            let subQ = seriesItems[j];
                            subQ = await processAttachments(subQ, ctx, surveyId);

                            const subPayload = {
                                surveyId: surveyId,
                                page: newSeriesId,
                                series: newSeriesKey,
                                position: j + 1,
                                question: { ...subQ }
                            };

                            cleanSystemKeys(subPayload.question);

                            await fetch(`${ctx.baseUrl}addSurveyQuestion`, { method: "POST", headers: h, body: JSON.stringify(subPayload) });
                            await sleep(400);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("[Yandex Forms Manager] Ошибка добавления вопросов:", e);
        }
    }

    async function createFormViaAPI(ctx) {
        console.log(`[Yandex Forms Manager] Попытка быстрого создания формы через API...`);
        const h = { ...ctx.headers, "Content-Type": "application/json" };
        const payload = { survey: { name: "Новая форма (Импорт)" } };

        if (ctx.finalId) {
            if (ctx.isCloud) payload.collabId = ctx.finalId;
            else payload.orgId = ctx.finalId;
        }

        const endpoints = ["createSurvey", "create", "addSurvey"];
        for (let ep of endpoints) {
            try {
                const res = await fetch(`${ctx.baseUrl}${ep}`, {
                    method: "POST",
                    headers: h,
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    const data = await res.json();
                    const newId = data?.result?.survey?.id || data?.id;
                    if (newId) return newId;
                }
            } catch (e) {
                console.warn(`[Yandex Forms Manager] Ошибка при API-создании (${ep}):`, e);
            }
        }
        return null;
    }

    async function createFormViaIframe(createUrl) {
        return new Promise((resolve, reject) => {
            console.log(`[Yandex Forms Manager] Запрос на создание новой формы (Iframe Fallback)...`);
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            document.body.appendChild(iframe);

            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("Timeout (Iframe)"));
            }, 30000);

            const cleanup = () => {
                clearTimeout(timer); clearInterval(interval);
                if (document.body.contains(iframe)) document.body.removeChild(iframe);
            };

            let interactionTimer = 0;

            const interval = setInterval(() => {
                try {
                    const curr = iframe.contentWindow.location.href;
                    const match = curr.match(/[a-f0-9]{24}/);

                    if (match && !curr.includes('new-form')) {
                        cleanup();
                        resolve(match[0]);
                        return;
                    }

                    if (curr.includes('new-form') && iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
                        interactionTimer++;
                        if (interactionTimer % 2 === 0) {
                            const doc = iframe.contentDocument;
                            const buttons = Array.from(doc.querySelectorAll('button, a, div[role="button"]'));
                            const blankBtn = buttons.find(b => b.innerText && (b.innerText.includes('С нуля') || b.innerText.includes('Чистый лист')));
                            if (blankBtn) blankBtn.click();

                            const inputs = doc.querySelectorAll('input, textarea');
                            for (let el of inputs) {
                                if (el.placeholder && (el.placeholder.toLowerCase().includes('название') || el.placeholder.toLowerCase().includes('title'))) {
                                    el.focus();
                                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
                                    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

                                    if (el.tagName === 'INPUT' && nativeInputValueSetter) nativeInputValueSetter.call(el, "Import...");
                                    if (el.tagName === 'TEXTAREA' && nativeTextareaValueSetter) nativeTextareaValueSetter.call(el, "Import...");

                                    el.dispatchEvent(new Event('input', { bubbles: true }));
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                                    break;
                                }
                            }
                        }
                    }
                } catch (e) {}
            }, 500);
            iframe.src = createUrl;
        });
    }

    // ==========================================
    // БЛОК 2.5: УПРАВЛЕНИЕ ГРУППАМИ ПРИ ИМПОРТЕ
    // ==========================================
    let workspaceGroupsCache = null;

    // Подтягиваем все существующие папки в кэш с правильными параметрами (Фикс дублирования)
    async function initGroupsCache(ctx) {
        workspaceGroupsCache = {};
        if (!ctx.isCloud || !ctx.finalId) return;

        try {
            const h = { ...ctx.headers, "Content-Type": "application/json" };
            const payload = {
                collab_id: ctx.finalId,
                offset: 0,
                limit: 1000,
                ownership: "mine",
                show_all: false,
                orderby: "-modified",
                favourite: null
            };

            const res = await fetch(`${ctx.baseUrl}getSurveyGroups`, {
                method: "POST",
                headers: h,
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                const data = await res.json();

                // Гибкий парсинг массива папок (Яндекс может вернуть массив прямо в data или внутри ключей)
                let groupsArray = [];
                if (Array.isArray(data)) groupsArray = data;
                else if (data && Array.isArray(data.groups)) groupsArray = data.groups;
                else if (data && data.result && Array.isArray(data.result)) groupsArray = data.result;

                groupsArray.forEach(g => {
                    if (g && g.name && g.id) {
                        workspaceGroupsCache[g.name.trim()] = g.id; // trim() исключает дубли из-за случайных пробелов
                    }
                });
                console.log("[Yandex Forms Manager] Кэш существующих папок загружен:", workspaceGroupsCache);
            }
        } catch (e) {
            console.warn("[Yandex Forms Manager] Ошибка кэширования папок:", e);
        }
    }

    // Получаем ID папки по имени (создаем новую, если её нет в кэше)
    async function resolveGroupIdByName(groupName, ctx) {
        if (!ctx.isCloud || !ctx.finalId || !groupName) return null;

        groupName = groupName.trim(); // Очищаем от лишних пробелов

        if (workspaceGroupsCache === null) {
            await initGroupsCache(ctx);
        }

        if (workspaceGroupsCache[groupName]) {
            console.log(`[Yandex Forms Manager] Найдена существующая папка: "${groupName}" (ID: ${workspaceGroupsCache[groupName]})`);
            return workspaceGroupsCache[groupName];
        }

        console.log(`[Yandex Forms Manager] Создание новой папки: "${groupName}"`);
        try {
            const h = { ...ctx.headers, "Content-Type": "application/json" };
            const res = await fetch(`${ctx.baseUrl}createSurveyGroup`, {
                method: "POST",
                headers: h,
                body: JSON.stringify({ name: groupName, collab_id: ctx.finalId })
            });
            if (res.ok) {
                const data = await res.json();
                const newId = data.id || (data.group && data.group.id);
                if (newId) {
                    workspaceGroupsCache[groupName] = newId; // Добавляем новую папку в кэш
                    return newId;
                }
            }
        } catch (e) {
            console.warn(`[Yandex Forms Manager] Ошибка создания папки "${groupName}":`, e);
        }
        return null;
    }

    // Помещаем форму в папку
    async function moveSurveyToGroup(surveyId, groupId, ctx) {
        try {
            console.log(`[Yandex Forms Manager] Перемещение формы ${surveyId} в папку ID ${groupId}`);
            const h = { ...ctx.headers, "Content-Type": "application/json" };
            await fetch(`${ctx.baseUrl}addSurveysToSurveyGroup`, {
                method: "POST",
                headers: h,
                body: JSON.stringify({ groupId: parseInt(groupId, 10), surveys: [surveyId] })
            });
        } catch (e) {
            console.warn(`[Yandex Forms Manager] Ошибка перемещения формы в папку:`, e);
        }
    }

    // ==========================================
    // БЛОК 3: ИНТЕРФЕЙС И РОУТИНГ
    // ==========================================
    function initUI() {
        const selectedForms = new Set();
        const selectedGroups = new Set();

        document.addEventListener('YandexFormDeleted', (e) => {
            if (e.detail && e.detail.surveyId) {
                if (selectedForms.has(e.detail.surveyId)) {
                    selectedForms.delete(e.detail.surveyId);
                    updateFormCounters();
                    updateFormSelectAllBtn();
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
                        if (Array.isArray(parsedData)) {
                            allFormsToImport.push(...parsedData);
                        } else {
                            allFormsToImport.push(parsedData);
                        }
                    } catch (err) {
                        console.error(`[Yandex Forms Manager] Ошибка парсинга:`, err);
                    }

                    filesProcessed++;
                    if (filesProcessed === files.length && allFormsToImport.length > 0) {
                        runBulkImportForms(allFormsToImport, getContext());
                    }
                };
                reader.readAsText(file);
            });
            e.target.value = '';
        });

        async function runBulkImportForms(formsArray, ctx) {
            console.log(`[Yandex Forms Manager] Запуск конвейера импорта. Всего форм: ${formsArray.length}.`);

            // Сбрасываем кэш перед началом новой пачки импорта
            workspaceGroupsCache = null;

            for (let i = 0; i < formsArray.length; i++) {
                const data = formsArray[i];
                try {
                    if (i > 0) await sleep(RATE_LIMIT_FORM_CREATE);

                    let newSurveyId = await createFormViaAPI(ctx);

                    if (!newSurveyId) {
                        const separator = ctx.createUrl.includes('?') ? '&' : '?';
                        const urlWithCacheBuster = `${ctx.createUrl}${separator}_=${Date.now()}`;
                        newSurveyId = await createFormViaIframe(urlWithCacheBuster);
                    }

                    if (newSurveyId) {
                        await applyData(newSurveyId, data, ctx);

                        // --- ЛОГИКА ДОБАВЛЕНИЯ В ПАПКУ ---
                        // Проверяем: 1) Мы в Yandex Cloud/360, 2) В JSON есть имя папки
                        if (ctx.isCloud && data.surveyData && data.surveyData.group && data.surveyData.group.name) {
                            const targetGroupName = data.surveyData.group.name;
                            const targetGroupId = await resolveGroupIdByName(targetGroupName, ctx);

                            if (targetGroupId) {
                                await moveSurveyToGroup(newSurveyId, targetGroupId, ctx);
                                await sleep(300); // Даем серверу время обработать связку
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[Yandex Forms Manager] Сбой при импорте формы:`, err);
                }
            }
            location.reload();
        }

        function updateFormCounters() {
            const exportSpan = document.querySelector('.migrator-btn-export .export-counter');
            if (exportSpan) exportSpan.innerText = `Экспорт (${selectedForms.size})`;
            const deleteSpan = document.querySelector('.migrator-btn-delete .delete-counter');
            if (deleteSpan) deleteSpan.innerText = `Удалить (${selectedForms.size})`;
        }

        function updateFormSelectAllBtn() {
            const btnText = document.querySelector('.migrator-bulk-actions .migrator-btn-selectall .g-button__text');
            if (!btnText) return;
            const checkboxes = document.querySelectorAll('.migrator-form-checkbox');
            if (checkboxes.length === 0) {
                btnText.innerText = 'Выбрать все';
                return;
            }
            const allChecked = Array.from(checkboxes).every(cb => selectedForms.has(cb.value));
            btnText.innerText = allChecked ? 'Снять выделение' : 'Выбрать все';
        }

        async function doBulkExportForms() {
            if (selectedForms.size === 0) return;
            const ids = Array.from(selectedForms);
            const ctx = getContext();
            const bulkData = [];
            for (let i = 0; i < ids.length; i++) {
                try {
                    const data = await fetchSurveyData(ids[i], ctx);
                    bulkData.push({ originalId: ids[i], ...data });
                } catch (err) {
                    console.error(`[Yandex Forms Manager] Ошибка экспорта формы ID ${ids[i]}:`, err);
                }
            }
            const blob = new Blob([JSON.stringify(bulkData, null, 2)], { type: "application/json" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `forms_export_${ids.length}_items.json`;
            a.click();
        }

        async function doBulkDeleteForms() {
            if (selectedForms.size === 0) return;
            if (!confirm(`Удалить ${selectedForms.size} форм(ы)?`)) return;
            const ids = Array.from(selectedForms);
            const ctx = getContext();
            const h = { ...ctx.headers, "Content-Type": "application/json" };
            for (let i = 0; i < ids.length; i++) {
                try {
                    await fetch(`${ctx.baseUrl}deleteSurvey`, {
                        method: "POST",
                        headers: h,
                        body: JSON.stringify({ surveyId: ids[i] })
                    });
                } catch (err) {}
                await sleep(RATE_LIMIT_DELETE);
            }
            location.reload();
        }

        function injectFormCheckboxes() {
            const rows = document.querySelectorAll('.g-table__row, tr');
            let domChanged = false;
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

                if (link.parentNode) {
                    link.parentNode.style.position = 'relative';
                    link.parentNode.style.paddingLeft = '36px';
                }

                const container = document.createElement('div');
                container.className = 'migrator-checkbox-container';
                container.style.cssText = 'position: absolute; left: 12px; top: 50%; transform: translateY(-50%); z-index: 100; line-height: 0;';
                container.onclick = (e) => e.stopPropagation();

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'migrator-form-checkbox';
                cb.value = surveyId;
                cb.checked = selectedForms.has(surveyId);
                cb.style.cssText = 'width: 16px; height: 16px; cursor: pointer; margin: 0; padding: 0; outline: none; display: block;';

                cb.addEventListener('change', (e) => {
                    if (e.target.checked) selectedForms.add(surveyId);
                    else selectedForms.delete(surveyId);
                    updateFormCounters();
                    updateFormSelectAllBtn();
                });

                container.appendChild(cb);
                link.parentNode.insertBefore(container, link);
                domChanged = true;
            });
            if (domChanged) updateFormSelectAllBtn();
        }

        function injectFormControlPanel() {
            const filtersContainer = document.querySelector('.Main-Filters');
            if (!filtersContainer) return;
            if (document.querySelector('.migrator-bulk-actions')) return;

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'migrator-bulk-actions';
            actionsDiv.style.cssText = 'display: flex; gap: 8px; margin-left: auto;';

            const btnSelectAll = document.createElement('button');
            btnSelectAll.className = 'g-button g-button_view_flat-secondary g-button_size_l g-button_pin_round-round migrator-btn-selectall';
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
                updateFormCounters();
                updateFormSelectAllBtn();
            };

            const btnExportBulk = document.createElement('button');
            btnExportBulk.className = 'g-button g-button_view_normal g-button_size_l g-button_pin_round-round migrator-btn-export';
            btnExportBulk.type = 'button';
            btnExportBulk.innerHTML = `<span class="g-button__text" style="display:flex;align-items:center;gap:6px;">${svgExport} <span class="export-counter">Экспорт (${selectedForms.size})</span></span>`;
            btnExportBulk.onclick = doBulkExportForms;

            const btnImportBulk = document.createElement('button');
            btnImportBulk.className = 'g-button g-button_view_normal g-button_size_l g-button_pin_round-round migrator-btn-import';
            btnImportBulk.type = 'button';
            btnImportBulk.innerHTML = `<span class="g-button__text" style="display:flex;align-items:center;gap:6px;">${svgImport} <span>Импорт</span></span>`;
            btnImportBulk.onclick = () => mainBulkFileInput.click();

            const btnDeleteBulk = document.createElement('button');
            btnDeleteBulk.className = 'g-button g-button_view_normal g-button_size_l g-button_pin_round-round migrator-btn-delete';
            btnDeleteBulk.type = 'button';
            btnDeleteBulk.innerHTML = `<span class="g-button__text" style="display:flex;align-items:center;gap:6px;color:#cc0000;">${svgDelete} <span class="delete-counter">Удалить (${selectedForms.size})</span></span>`;
            btnDeleteBulk.onclick = doBulkDeleteForms;

            actionsDiv.appendChild(btnSelectAll);
            actionsDiv.appendChild(btnExportBulk);
            actionsDiv.appendChild(btnImportBulk);
            actionsDiv.appendChild(btnDeleteBulk);
            filtersContainer.appendChild(actionsDiv);
            updateFormSelectAllBtn();
        }

        function updateGroupCounters() {
            const exportCounter = document.querySelector('.manager-btn-export .export-counter');
            if (exportCounter) exportCounter.innerText = `Экспорт (${selectedGroups.size})`;
            const deleteCounter = document.querySelector('.manager-btn-delete .delete-counter');
            if (deleteCounter) deleteCounter.innerText = `Удалить (${selectedGroups.size})`;
        }

        function updateGroupSelectAllBtn() {
            const btnText = document.querySelector('.manager-bulk-actions .manager-btn-selectall .g-button__text');
            if (!btnText) return;
            const checkboxes = document.querySelectorAll('.manager-group-checkbox');
            if (checkboxes.length === 0) {
                btnText.innerText = 'Выбрать все';
                return;
            }
            const allChecked = Array.from(checkboxes).every(cb => selectedGroups.has(cb.value));
            btnText.innerText = allChecked ? 'Снять выделение' : 'Выбрать все';
        }

        async function doBulkExportGroups() {
            if (selectedGroups.size === 0) return;
            const groupIds = Array.from(selectedGroups);
            const ctx = getContext();
            const bulkData = [];
            let foundForms = 0;

            for (let i = 0; i < groupIds.length; i++) {
                const groupId = groupIds[i];
                const surveyIds = await getGroupSurveys(groupId, ctx);
                if (surveyIds.length === 0) continue;
                for (const surveyId of surveyIds) {
                    try {
                        const data = await fetchSurveyData(surveyId, ctx);
                        data.groupId = groupId;
                        bulkData.push(data);
                        foundForms++;
                    } catch (err) {}
                }
            }

            if (foundForms === 0) return;
            const blob = new Blob([JSON.stringify(bulkData, null, 2)], { type: "application/json" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `groups_export_${groupIds.length}_folders_${foundForms}_forms.json`;
            a.click();
        }

        async function doBulkDeleteGroups() {
            if (selectedGroups.size === 0) return;
            if (!confirm(`Удалить ${selectedGroups.size} папок? Содержимое будет безвозвратно удалено.`)) return;
            const groupIds = Array.from(selectedGroups);
            const ctx = getContext();
            const h = { ...ctx.headers, "Content-Type": "application/json" };
            for (let i = 0; i < groupIds.length; i++) {
                try {
                    await fetch(`${ctx.baseUrl}deleteGroup`, {
                        method: "POST",
                        headers: h,
                        body: JSON.stringify({ groupId: parseInt(groupIds[i], 10) })
                    });
                } catch (err) {}
                await sleep(RATE_LIMIT_DELETE);
            }
            location.reload();
        }

        function injectGroupCheckboxes() {
            const groups = document.querySelectorAll('section.Main-Group');
            let domChanged = false;
            groups.forEach(group => {
                const settingsLink = group.querySelector('.Main-GroupActionButtons a[href*="/settings"]');
                if (!settingsLink) return;
                const matchId = settingsLink.href.match(/\/groups\/(\d+)\//);
                if (!matchId || matchId.length < 2) return;
                const groupId = matchId[1];

                const textWrapper = group.querySelector('.Main-GroupTitleTextWrapper');
                if (!textWrapper) return;

                const existingContainer = textWrapper.querySelector('.manager-checkbox-container');
                if (existingContainer) {
                    const cb = existingContainer.querySelector('.manager-group-checkbox');
                    if (cb && cb.value !== groupId) {
                        cb.value = groupId;
                        cb.checked = selectedGroups.has(groupId);
                        domChanged = true;
                    }
                    return;
                }

                const container = document.createElement('div');
                container.className = 'manager-checkbox-container';
                container.style.cssText = 'display: flex; align-items: center; margin-right: 8px; z-index: 1000; position: relative;';

                const stopProp = (e) => e.stopPropagation();
                container.onclick = stopProp;
                container.onmousedown = stopProp;
                container.onmouseup = stopProp;

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'manager-group-checkbox';
                cb.value = groupId;
                cb.checked = selectedGroups.has(groupId);
                cb.style.cssText = 'width: 16px; height: 16px; cursor: pointer; margin: 0; padding: 0;';

                cb.addEventListener('change', (e) => {
                    if (e.target.checked) selectedGroups.add(groupId);
                    else selectedGroups.delete(groupId);
                    updateGroupCounters();
                    updateGroupSelectAllBtn();
                });

                container.appendChild(cb);
                textWrapper.insertBefore(container, textWrapper.firstChild);
                domChanged = true;
            });
            if (domChanged) updateGroupSelectAllBtn();
        }

        function injectGroupControlPanel() {
            const filtersContainer = document.querySelector('.Main-Filters');
            if (!filtersContainer) return;
            if (document.querySelector('.manager-bulk-actions')) return;

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'manager-bulk-actions';
            actionsDiv.style.cssText = 'display: flex; gap: 8px; margin-left: auto; align-items: center;';

            const btnSelectAll = document.createElement('button');
            btnSelectAll.className = 'g-button g-button_view_flat-secondary g-button_size_l g-button_pin_round-round manager-btn-selectall';
            btnSelectAll.type = 'button';
            btnSelectAll.innerHTML = '<span class="g-button__text">Выбрать все</span>';
            btnSelectAll.onclick = () => {
                const checkboxes = document.querySelectorAll('.manager-group-checkbox');
                if (checkboxes.length === 0) return;
                const allChecked = Array.from(checkboxes).every(cb => selectedGroups.has(cb.value));
                const newState = !allChecked;
                checkboxes.forEach(cb => {
                    cb.checked = newState;
                    if (newState) selectedGroups.add(cb.value);
                    else selectedGroups.delete(cb.value);
                });
                updateGroupCounters();
                updateGroupSelectAllBtn();
            };

            const btnExportBulk = document.createElement('button');
            btnExportBulk.className = 'g-button g-button_view_normal g-button_size_l g-button_pin_round-round manager-btn-export';
            btnExportBulk.type = 'button';
            btnExportBulk.innerHTML = `<span class="g-button__text" style="display:flex;align-items:center;gap:6px;">${svgExport} <span class="export-counter">Экспорт (${selectedGroups.size})</span></span>`;
            btnExportBulk.onclick = doBulkExportGroups;

            const btnDeleteBulk = document.createElement('button');
            btnDeleteBulk.className = 'g-button g-button_view_normal g-button_size_l g-button_pin_round-round manager-btn-delete';
            btnDeleteBulk.type = 'button';
            btnDeleteBulk.innerHTML = `<span class="g-button__text" style="display:flex;align-items:center;gap:6px;color:#cc0000;">${svgDelete} <span class="delete-counter">Удалить (${selectedGroups.size})</span></span>`;
            btnDeleteBulk.onclick = doBulkDeleteGroups;

            actionsDiv.appendChild(btnSelectAll);
            actionsDiv.appendChild(btnExportBulk);
            actionsDiv.appendChild(btnDeleteBulk);
            filtersContainer.appendChild(actionsDiv);
            updateGroupSelectAllBtn();
        }

        function removeUnusedPanels() {
            if (isGroupsPage()) {
                const oldFormPanel = document.querySelector('.migrator-bulk-actions');
                if (oldFormPanel) oldFormPanel.remove();
            } else {
                const oldGroupPanel = document.querySelector('.manager-bulk-actions');
                if (oldGroupPanel) oldGroupPanel.remove();
            }
        }

        function checkAndInject() {
            removeUnusedPanels();
            if (isGroupsPage()) {
                injectGroupCheckboxes();
                injectGroupControlPanel();
            } else {
                injectFormCheckboxes();
                injectFormControlPanel();
            }
        }

        setInterval(checkAndInject, 1000);

        const observer = new MutationObserver(() => {
            checkAndInject();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    initUI();

})();