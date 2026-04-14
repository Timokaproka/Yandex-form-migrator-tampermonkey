// ==UserScript==
// @name         Yandex Forms Migrator Single (V9.10)
// @namespace    http://tampermonkey.net/
// @version      9.10
// @description  Исправлена привязка изображений к вопросам и сохранение id во вложениях
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
    // БЛОК 0: УТИЛИТЫ И UI КОНСТАНТЫ
    // ==========================================
    const svgExport = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/></svg>`;
    const svgImport = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M12 12v6"/><path d="m15 15-3-3-3 3"/></svg>`;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
            // Исключаем удаление ID для вложений, чтобы сервер смог привязать изображение
            if (parentKey !== 'attachment') {
                delete obj.id;
            }
            delete obj.key;

            for (const k in obj) {
                cleanSystemKeys(obj[k], k);
            }
        }
    }

    function createMenuItem(text, iconSvg, onClick) {
        const li = document.createElement('li');
        li.className = 'g-menu__list-item migrator-item';
        li.setAttribute('role', 'none');

        const wrapper = document.createElement('div');
        wrapper.setAttribute('role', 'menuitem');
        wrapper.setAttribute('tabindex', '0');
        wrapper.className = 'g-menu__item g-menu__item_interactive g-dropdown-menu__menu-item';
        wrapper.style.cursor = 'pointer';

        const content = document.createElement('div');
        content.className = 'g-menu__item-content';
        content.style.display = 'flex';
        content.style.alignItems = 'center';
        content.style.gap = '8px';

        const iconContainer = document.createElement('span');
        iconContainer.style.display = 'flex';
        iconContainer.style.opacity = '0.7';
        iconContainer.innerHTML = iconSvg;

        const textSpan = document.createElement('span');
        textSpan.innerText = text;

        content.appendChild(iconContainer);
        content.appendChild(textSpan);
        wrapper.appendChild(content);
        li.appendChild(wrapper);

        li.addEventListener('mouseenter', () => {
            const menu = li.closest('.g-menu');
            if (menu) {
                menu.querySelectorAll('.g-menu__item_selected').forEach(el => el.classList.remove('g-menu__item_selected'));
            }
        });

        li.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.body.click();
            onClick();
        });

        return li;
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
        } else if (orgId) {
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
        let bestUrl = null;
        let fileName = "image.png";

        if (attachmentObj.externalUrl) {
            bestUrl = attachmentObj.externalUrl;
            fileName = bestUrl.split('/').pop().split('?')[0] || "image.png";
        } else if (attachmentObj.links) {
            bestUrl = attachmentObj.links["2560x"] || attachmentObj.links["1280x"] || attachmentObj.links["720x"] || Object.values(attachmentObj.links)[0];
            fileName = attachmentObj.name || "image.jpg";
        }

        if (!bestUrl) return null;

        try {
            console.log(`[Yandex Forms Migrator Single] Загрузка изображения: ${bestUrl}`);
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
            console.warn("[Yandex Forms Migrator Single] Ошибка загрузки изображения:", e);
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


    // ==========================================
    // БЛОК 3: МОДУЛЬ БИЗНЕС-ЛОГИКИ
    // ==========================================
    async function createFormViaIframe(createUrl) {
        return new Promise((resolve, reject) => {
            console.log("[Yandex Forms Migrator Single] Отправка запроса на создание новой формы (Iframe)...");
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            document.body.appendChild(iframe);

            const timer = setTimeout(() => {
                cleanup();
                console.error("[Yandex Forms Migrator Single] Превышено время ожидания создания формы.");
                reject(new Error("Превышено время ожидания создания формы"));
            }, 15000);

            const cleanup = () => {
                clearTimeout(timer);
                clearInterval(interval);
                if (document.body.contains(iframe)) document.body.removeChild(iframe);
            };

            const interval = setInterval(() => {
                try {
                    const curr = iframe.contentWindow.location.href;
                    const match = curr.match(/[a-f0-9]{24}/);
                    if (match && !curr.includes('new-form')) {
                        cleanup();
                        console.log(`[Yandex Forms Migrator Single] Форма успешно создана. ID: ${match[0]}`);
                        resolve(match[0]);
                    }
                } catch (e) {}
            }, 500);

            iframe.src = createUrl;
        });
    }

    async function fetchSurveyData(surveyId, ctx) {
        const headers = { ...ctx.headers, "Content-Type": "application/json" };
        const [surveyRes, infoRes, submitRes, quizRes, questionsRes, hooksRes] = await Promise.all([
            fetch(`${ctx.baseUrl}getSurveyData`, { method: "POST", headers, body: JSON.stringify({ surveyId }) }).then(r => r.json()),
            fetch(`${ctx.baseUrl}getSurveyInfo`, { method: "POST", headers, body: JSON.stringify({ surveyId }) }).then(r => r.json()),
            fetch(`${ctx.baseUrl}getSubmitConditions`, { method: "POST", headers, body: JSON.stringify({ surveyId }) }).then(r => r.json()),
            fetch(`${ctx.baseUrl}getQuizSettingsLA`, { method: "POST", headers, body: JSON.stringify({ surveyId }) }).then(r => r.json()),
            fetch(`${ctx.baseUrl}surveyQuestionsLA`, { method: "POST", headers, body: JSON.stringify({ surveyId }) }).then(r => r.json()),
            fetch(`${ctx.baseUrl}getHooks`, { method: "POST", headers, body: JSON.stringify({ surveyId }) }).then(r => r.json()).catch(() => [])
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

    async function runExport(surveyId) {
        try {
            console.log(`[Yandex Forms Migrator Single] Запуск экспорта формы ID: ${surveyId}`);
            const ctx = getContext();
            const exportResult = await fetchSurveyData(surveyId, ctx);

            console.log("[Yandex Forms Migrator Single] Данные собраны. Формирование файла...");
            const blob = new Blob([JSON.stringify(exportResult, null, 2)], { type: "application/json" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `form_full_${surveyId}.json`;
            a.click();
            console.log("[Yandex Forms Migrator Single] Экспорт завершен. Файл скачан.");
        } catch (err) {
            console.error("[Yandex Forms Migrator Single] Ошибка экспорта:", err);
            alert("Ошибка экспорта: " + err.message);
        }
    }

    async function applyData(surveyId, data, ctx) {
        const h = { ...ctx.headers, "Content-Type": "application/json" };
        console.log(`[Yandex Forms Migrator Single] Начало применения данных для формы ID: ${surveyId}`);

        // 1. Основные настройки формы
        try {
            console.log("[Yandex Forms Migrator Single] Применение основных настроек (surveyData)...");
            let surveyUpdatePayload = data.surveyData ? { ...data.surveyData } : { name: data.formName };
            surveyUpdatePayload.name = data.formName || surveyUpdatePayload.name || "Импортированная форма";
            if (data.texts) surveyUpdatePayload.texts = data.texts;

            surveyUpdatePayload = await processAttachments(surveyUpdatePayload, ctx, surveyId);
            await fetch(`${ctx.baseUrl}updateSurveyData`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, survey: surveyUpdatePayload }) });
        } catch (e) {
            console.warn("[Yandex Forms Migrator Single] Не удалось применить основные настройки:", e);
        }

        // 2. Расширенные настройки
        if (data.surveyInfo) {
            try {
                console.log("[Yandex Forms Migrator Single] Применение расширенных настроек (surveyInfo)...");
                let surveyInfoPayload = { ...data.surveyInfo };
                surveyInfoPayload.name = data.formName || surveyInfoPayload.name || "Импортированная форма";
                if (data.texts) surveyInfoPayload.texts = data.texts;

                surveyInfoPayload = await processAttachments(surveyInfoPayload, ctx, surveyId);
                await fetch(`${ctx.baseUrl}updateSurveyInfo`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, surveyInfo: surveyInfoPayload }) });
            } catch (e) {
                console.warn("[Yandex Forms Migrator Single] Не удалось применить расширенные настройки:", e);
            }
        }

        // 3. Настройки квиза
        if (data.quizSettings) {
            try {
                console.log("[Yandex Forms Migrator Single] Применение настроек квиза...");
                const quizPayload = await processAttachments(data.quizSettings, ctx, surveyId);
                await fetch(`${ctx.baseUrl}updateQuizSettingsLA`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, quiz: quizPayload }) });
            } catch (e) {
                console.warn("[Yandex Forms Migrator Single] Не удалось применить настройки квиза:", e);
            }
        }

        // 4. Условия отправки
        if (data.submitConditions?.length > 0) {
            try {
                console.log("[Yandex Forms Migrator Single] Применение условий отправки...");
                await fetch(`${ctx.baseUrl}updateSubmitConditions`, { method: "POST", headers: h, body: JSON.stringify({ surveyId, conditions: data.submitConditions }) });
            } catch (e) {
                console.warn("[Yandex Forms Migrator Single] Не удалось применить условия отправки:", e);
            }
        }

        // 5. Динамическое отключение дефолтных интеграций (уведомлений)
        try {
            console.log("[Yandex Forms Migrator Single] Отключение интеграций по умолчанию...");
            const newHooks = await fetch(`${ctx.baseUrl}getHooks`, { method: "POST", headers: h, body: JSON.stringify({ surveyId }) }).then(r => r.json());
            if (Array.isArray(newHooks)) {
                for (const hook of newHooks) {
                    if (hook && hook.id) {
                        await fetch(`${ctx.baseUrl}updateHook`, {
                            method: "POST",
                            headers: h,
                            body: JSON.stringify({ surveyId, groupId: hook.id, active: false })
                        });
                        await sleep(200);
                    }
                }
            }
        } catch (e) {
            console.warn("[Yandex Forms Migrator Single] Не удалось отключить дефолтные уведомления:", e);
        }

        // 6. Вопросы
        try {
            if (data.questions && data.questions.length > 0) {
                console.log(`[Yandex Forms Migrator Single] Обработка вопросов (${data.questions.length} шт.)...`);
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

                    // Добавление вложенных вопросов в созданную группу по правильной архитектуре
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
                console.log("[Yandex Forms Migrator Single] Вопросы успешно добавлены.");
            }
        } catch (e) {
            console.warn("[Yandex Forms Migrator Single] Не удалось добавить вопросы:", e);
        }
    }


    // ==========================================
    // БЛОК 4: МОДУЛЬ ПОЛЬЗОВАТЕЛЬСКОГО ИНТЕРФЕЙСА
    // ==========================================
    function initEditorLogic() {
        const editorFileInput = document.createElement('input');
        editorFileInput.type = 'file';
        editorFileInput.accept = '.json';
        editorFileInput.style.display = 'none';
        document.body.appendChild(editorFileInput);

        editorFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                console.log(`[Yandex Forms Migrator Single] Выбран файл для импорта в редакторе: ${file.name}`);
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const parsedData = JSON.parse(ev.target.result);
                        console.log(`[Yandex Forms Migrator Single] Файл прочитан. Подготовка к импорту формы: "${parsedData.formName || 'Без названия'}"`);

                        const ctx = getContext();
                        const surveyId = window.location.pathname.match(/[a-f0-9]{24}/)?.[0];
                        if (surveyId) {
                            await applyData(surveyId, parsedData, ctx);
                            console.log("[Yandex Forms Migrator Single] Импорт завершен. Перезагрузка страницы.");
                            alert("Миграция завершена!");
                            location.reload();
                        }
                    } catch (err) {
                        console.error("[Yandex Forms Migrator Single] Ошибка импорта в редакторе:", err);
                        alert("Ошибка импорта: " + err.message);
                    }
                };
                reader.readAsText(file);
            }
            e.target.value = '';
        });

        const observer = new MutationObserver(() => {
            const popup = document.querySelector('[data-qa="additional-form-actions-popup"]');
            if (!popup) return;

            const menu = popup.querySelector('ul.g-dropdown-menu__menu');
            if (menu && !menu.querySelector('.migrator-item')) {
                const separator = document.createElement('li');
                separator.className = 'g-menu__list-item migrator-item';
                separator.style.cssText = 'height: 1px; background: #e5e5e5; margin: 4px 0;';

                menu.appendChild(separator);
                menu.appendChild(createMenuItem('Экспорт в JSON', svgExport, () => {
                    const surveyId = window.location.pathname.match(/[a-f0-9]{24}/)?.[0];
                    if (surveyId) runExport(surveyId);
                }));
                menu.appendChild(createMenuItem('Импорт из JSON', svgImport, () => editorFileInput.click()));
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    function initMainPageLogic() {
        const mainFileInput = document.createElement('input');
        mainFileInput.type = 'file';
        mainFileInput.accept = '.json';
        mainFileInput.style.display = 'none';
        document.body.appendChild(mainFileInput);

        const getSurveyIdFromMenu = () => {
            const activeBtn = document.querySelector('.g-table__actions-button[aria-expanded="true"]');
            if (!activeBtn) return null;

            const row = activeBtn.closest('.g-table__row, tr');
            if (!row) return null;

            const link = row.querySelector('a[href*="/admin/"]');
            if (!link) return null;

            const match = link.href.match(/[a-f0-9]{24}/);
            return match ? match[0] : null;
        };

        mainFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                console.log(`[Yandex Forms Migrator Single] Выбран файл для импорта на главной странице: ${file.name}`);
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const parsedData = JSON.parse(ev.target.result);
                        console.log(`[Yandex Forms Migrator Single] Файл прочитан. Подготовка к импорту формы: "${parsedData.formName || 'Без названия'}"`);

                        const ctx = getContext();
                        const newSurveyId = await createFormViaIframe(ctx.createUrl);
                        if (newSurveyId) {
                            await applyData(newSurveyId, parsedData, ctx);
                            console.log("[Yandex Forms Migrator Single] Импорт завершен. Перезагрузка страницы.");
                            alert("Импорт завершен!");
                            location.reload();
                        }
                    } catch (err) {
                        console.error("[Yandex Forms Migrator Single] Ошибка импорта на главной:", err);
                        alert("Ошибка импорта: " + err.message);
                    }
                };
                reader.readAsText(file);
            }
            e.target.value = '';
        });

        const observer = new MutationObserver(() => {
            const menu = document.querySelector('.g-popup_visible ul.g-menu, .g-popup_open ul.g-menu, ul.g-dropdown-menu__menu');

            if (menu && !menu.querySelector('.migrator-item')) {
                const activeBtn = document.querySelector('.g-table__actions-button[aria-expanded="true"]');
                if (!activeBtn) return;

                const separator = document.createElement('li');
                separator.className = 'g-menu__list-item migrator-item';
                separator.style.cssText = 'height: 1px; background: #e5e5e5; margin: 4px 0;';

                menu.appendChild(separator);
                menu.appendChild(createMenuItem('Экспорт в JSON', svgExport, () => {
                    const surveyId = getSurveyIdFromMenu();
                    if (surveyId) runExport(surveyId);
                }));
                menu.appendChild(createMenuItem('Импорт из JSON', svgImport, () => mainFileInput.click()));
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Инициализация
    initEditorLogic();
    initMainPageLogic();

})();