// ==UserScript==
// @name         Yandex Forms JSON Preprocessor (IDEAL -> FULL)
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Конвертирует упрощенный JSON от ИИ в полноценный формат (+ нативные ссылки Yandex Images)
// @author       timokaproka
// @match        https://forms.yandex.ru/admin*
// @match        https://forms.yandex.ru/cloud/admin*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    function initConverterUI() {
        const btn = document.createElement('button');
        btn.innerText = 'Конвертировать ИИ-JSON';
        btn.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:9999;padding:10px;background:#ffdb4d;border:none;border-radius:8px;cursor:pointer;font-weight:bold;box-shadow:0 2px 10px rgba(0,0,0,0.2);';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.style.display = 'none';

        btn.onclick = () => fileInput.click();

        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const idealData = JSON.parse(ev.target.result);
                    const forms = Array.isArray(idealData) ? idealData : [idealData];
                    const fullData = forms.map(f => convertToFull(f));

                    downloadJson(fullData, `full_${file.name}`);
                } catch (err) {
                    alert('Ошибка конвертации: ' + err.message);
                }
            };
            reader.readAsText(file);
        };

        document.body.appendChild(btn);
    }

    function generateUniqueKey(prefix) {
        return `${prefix}_${Math.random().toString(36).substr(2, 9)}_${Date.now().toString(36)}`;
    }

    function convertToFull(ideal) {
        const settings = ideal.settings || {};
        let totalScore = 0;
        let quizQuestionsCount = 0;

        const processedQuestions = (ideal.questions || []).map((q, qIndex) => {
            const question = JSON.parse(JSON.stringify(q));

            question.key = generateUniqueKey(`answer_${question.type}`);
            question.hidden = false;
            question.externalValidator = false;

            function processNestedItems(item) {
                if (item.attachment && item.attachment.externalUrl && item.attachment.externalUrl.includes('avatars.mds.yandex.net/get-forms')) {
                    const url = item.attachment.externalUrl;
                    const baseUrl = url.substring(0, url.lastIndexOf('/'));
                    const resolutions = ['56x40', '200x256', '324x180', '360x', '400x512', '720x', '1280x', '2560x'];
                    const links = {};

                    resolutions.forEach(res => {
                        links[res] = `${baseUrl}/${res}`;
                    });

                    item.attachment = {
                        links: links,
                        name: "image.png"
                    };
                }

                if (item.items && Array.isArray(item.items)) {
                    item.items.forEach((subItem, subIndex) => {
                        if (!subItem.key) {
                            subItem.key = generateUniqueKey(`answer_${subItem.type || 'sub'}_${subIndex}`);
                        }
                        processNestedItems(subItem);
                    });
                }
            }

            processNestedItems(question);

            if (question.options) {
                question.options = question.options.map((opt, optIndex) => ({
                    ...opt,
                    key: generateUniqueKey(`opt_${qIndex}_${optIndex}`),
                    hidden: false
                }));
            }

            if (question.type === 'matrix') {
                if (Array.isArray(question.rows)) question.rows = question.rows.map((r, i) => ({ label: r, slug: generateUniqueKey(`row_${i}`) }));
                if (Array.isArray(question.columns)) question.columns = question.columns.map((c, i) => ({ label: c, slug: generateUniqueKey(`col_${i}`) }));
            }

            if (question.quiz) {
                quizQuestionsCount++;
                if (question.options) {
                    const fullQuiz = [];
                    question.options.forEach(opt => {
                        const existingQuiz = question.quiz.find(qz => qz.value === opt.text);
                        if (existingQuiz) {
                            fullQuiz.push({
                                value: opt.text,
                                scores: existingQuiz.scores || 0,
                                correct: existingQuiz.correct || false
                            });
                            if (existingQuiz.correct) totalScore += (existingQuiz.scores || 0);
                        } else {
                            fullQuiz.push({
                                value: opt.text,
                                scores: 0,
                                correct: false
                            });
                        }
                    });
                    question.quiz = fullQuiz;
                } else {
                    question.quiz.forEach(qz => { if (qz.correct) totalScore += (qz.scores || 0); });
                }
            }

            return question;
        });

        return {
            formName: ideal.formName || "Новая форма",
            texts: {
                submit: "Отправить", back: "Назад", next: "Далее",
                title: settings.successMessage || "Спасибо!",
                subtitle: typeof settings.successMessage === 'object' ? settings.successMessage.subtitle : "Ваше сообщение отправлено.",
                redirect: ""
            },
            surveyData: {
                name: ideal.formName,
                isPublished: settings.isPublished || false,
                language: settings.language || "ru",
                quizSettings: {
                    showResults: true, showCorrect: true, countingMethod: "scores",
                    totalScore: totalScore, numberOfQuestions: quizQuestionsCount
                }
            },
            surveyInfo: {
                name: ideal.formName,
                language: settings.language || "ru",
                texts: { title: settings.successMessage || "Спасибо!" },
                allow_multiple_answers: true, share: true, is_new_frontend: true
            },
            quizSettings: {
                showResults: true, showCorrect: true, totalScore: totalScore,
                numberOfQuestions: quizQuestionsCount, numberOfSegments: 2
            },
            submitConditions: [],
            questions: processedQuestions,
            hooks: []
        };
    }

    function downloadJson(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
    }

    initConverterUI();
})();