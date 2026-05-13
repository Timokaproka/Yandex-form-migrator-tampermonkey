// ==UserScript==
// @name         Yandex Forms Image Uploader (V1.2)
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Локальная загрузка изображений в новую форму через Hybrid Engine (API + Iframe)
// @author       timokaproka
// @match        https://forms.yandex.ru/admin*
// @match        https://forms.yandex.ru/cloud/admin*
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

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
        
        const headers = {
            "x-csrf-token": csrf,
            "x-use-collab": "1",
            "x-sdk": "1",
            "Content-Type": "application/json"
        };

        if (finalId) {
            headers["x-collab-org-id"] = finalId;
        }

        return { finalId, baseUrl, createUrl, headers, isCloud };
    }

    // НОВЫЙ МЕТОД: Прямое создание через API (быстрее и надежнее)
    async function createFormViaAPI(ctx) {
        const payload = { survey: { name: "Техническая форма (Загрузка изображений)" } };
        if (ctx.finalId) {
            if (ctx.isCloud) payload.collabId = ctx.finalId;
            else payload.orgId = ctx.finalId;
        }

        try {
            const res = await fetch(window.location.origin + ctx.baseUrl + "createSurvey", {
                method: "POST",
                headers: ctx.headers,
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const data = await res.json();
                return data?.result?.survey?.id || data?.id;
            }
        } catch (e) {
            console.warn("Ошибка при API-создании формы:", e);
        }
        return null;
    }

    async function createFormViaIframe(createUrl) {
        return new Promise((resolve, reject) => {
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            document.body.appendChild(iframe);

            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("Превышено время ожидания создания формы (Iframe)"));
            }, 30000);

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
                        resolve(match[0]);
                    }
                    
                    // Попытка триггернуть сохранение, если это SPA
                    if (curr.includes('new-form') && iframe.contentDocument?.readyState === 'complete') {
                        const input = iframe.contentDocument.querySelector('input[placeholder*="название"], textarea[placeholder*="название"]');
                        if (input && !input.value) {
                             input.value = "Auto-save...";
                             input.dispatchEvent(new Event('input', { bubbles: true }));
                             input.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                    }
                } catch (e) {}
            }, 1000);

            iframe.src = createUrl;
        });
    }

    async function uploadSingleImage(file, surveyId, ctx) {
        const formData = new FormData();
        formData.append('image', file, file.name);
        formData.append('surveyId', surveyId);

        const uploadHeaders = { ...ctx.headers };
        delete uploadHeaders["Content-Type"]; // Fetch сам выставит multipart/form-data с boundary

        const res = await fetch(window.location.origin + ctx.baseUrl + "uploadImages", {
            method: "POST",
            headers: uploadHeaders,
            body: formData
        });

        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
    }

    function initUI() {
        if (document.getElementById('yandex-image-uploader-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'yandex-image-uploader-btn';
        btn.innerText = 'Загрузить изображения на хостинг Яндекса';
        btn.style.cssText = 'position: fixed; bottom: 80px; left: 20px; z-index: 10000; padding: 12px 20px; background: #000; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-family: sans-serif; font-size: 14px; box-shadow: 0 4px 6px rgba(0,0,0,0.3);';

        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = 'image/*';
        input.style.display = 'none';

        btn.onclick = () => input.click();

        input.onchange = async (e) => {
            const files = Array.from(e.target.files);
            if (!files.length) return;

            const ctx = getContext();
            btn.innerText = 'Создание технической формы...';
            btn.disabled = true;
            btn.style.opacity = '0.7';

            try {
                // Гибридное создание: API -> Iframe
                let surveyId = await createFormViaAPI(ctx);
                if (!surveyId) {
                    console.log("API метод не сработал, запускаю Iframe...");
                    const separator = ctx.createUrl.includes('?') ? '&' : '?';
                    const urlWithCacheBuster = `${ctx.createUrl}${separator}_=${Date.now()}`;
                    surveyId = await createFormViaIframe(urlWithCacheBuster);
                }

                const results = [];
                const jsonMapping = {};

                for (let i = 0; i < files.length; i++) {
                    btn.innerText = `Загрузка: файл ${i + 1} из ${files.length}...`;
                    const file = files[i];

                    try {
                        const response = await uploadSingleImage(file, surveyId, ctx);
                        let bestLink = null;

                        if (response && response.links) {
                            bestLink = response.links["orig"] || response.links["2560x"] || Object.values(response.links)[0];
                        }

                        if (bestLink) {
                            results.push(`"${file.name}": "${bestLink}",`);
                            jsonMapping[file.name] = bestLink;
                        } else {
                            results.push(`"${file.name}": "Ошибка получения ссылки",`);
                        }
                    } catch (uploadErr) {
                        results.push(`"${file.name}": "Сбой сети (${uploadErr.message})",`);
                    }
                }

                showResultsDialog(results, jsonMapping, surveyId);
            } catch (err) {
                alert('Произошла ошибка: ' + err.message);
            } finally {
                btn.innerText = 'Загрузить изображения на хостинг Яндекса';
                btn.disabled = false;
                btn.style.opacity = '1';
                input.value = '';
            }
        };

        document.body.appendChild(btn);
        document.body.appendChild(input);
    }

    // Функция showResultsDialog остается без изменений...
    function showResultsDialog(textResults, jsonMapping, surveyId) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 10001; display: flex; align-items: center; justify-content: center;';
        const modal = document.createElement('div');
        modal.style.cssText = 'background: #fff; padding: 24px; border-radius: 12px; width: 800px; max-width: 90%; max-height: 85vh; display: flex; flex-direction: column; gap: 16px; font-family: sans-serif;';
        const title = document.createElement('h3');
        title.innerText = 'Изображения успешно загружены';
        title.style.margin = '0';
        const info = document.createElement('div');
        info.innerText = `Все файлы прикреплены к созданной форме (ID: ${surveyId}).`;
        info.style.fontSize = '14px';
        const textarea = document.createElement('textarea');
        textarea.value = textResults.join('\n');
        textarea.style.cssText = 'width: 100%; flex-grow: 1; min-height: 250px; font-family: monospace; font-size: 13px; padding: 12px; box-sizing: border-box; resize: vertical; border: 1px solid #ccc; border-radius: 6px;';
        textarea.readOnly = true;
        const closeBtn = document.createElement('button');
        closeBtn.innerText = 'Закрыть';
        closeBtn.style.cssText = 'padding: 10px 20px; background: #fc0; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; margin-left: auto;';
        closeBtn.onclick = () => document.body.removeChild(overlay);
        modal.appendChild(title);
        modal.appendChild(info);
        modal.appendChild(textarea);
        modal.appendChild(closeBtn);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    initUI();
})();
