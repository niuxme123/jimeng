/**
 * 任务处理模块
 */

const log = require('./logger');
const windows = require('./windows');

/**
 * 提交视频生成任务
 * 填充文案到页面的文本框
 */
async function submitVideoTask(taskData) {
    log.info('提交视频任务:', taskData);

    let jimengWindow = windows.getJimengWindow();
    if (!jimengWindow) {
        windows.createJimengWindow();
        await new Promise(resolve => setTimeout(resolve, 3000));
        jimengWindow = windows.getJimengWindow();
    }

    const submitScript = `
        (async function() {
            const taskData = ${JSON.stringify(taskData)};

            function waitForElement(selector, timeout = 10000) {
                return new Promise((resolve, reject) => {
                    const startTime = Date.now();
                    function check() {
                        const element = document.querySelector(selector);
                        if (element) {
                            resolve(element);
                            return;
                        }
                        if (Date.now() - startTime > timeout) {
                            reject(new Error('元素未找到: ' + selector));
                            return;
                        }
                        setTimeout(check, 100);
                    }
                    check();
                });
            }

            try {
                // 国际版使用 tiptap ProseMirror 编辑器
                let textInput = document.querySelector('div[contenteditable="true"].ProseMirror') ||
                               document.querySelector('div[contenteditable="true"]') ||
                               document.querySelector('textarea');

                if (textInput && taskData.text) {
                    console.log('找到文本输入框，填充文案...');
                    textInput.focus();

                    // 对于 contenteditable 元素，使用 innerHTML 或 textContent
                    if (textInput.contentEditable === 'true') {
                        // 清空现有内容
                        textInput.innerHTML = '';

                        // 创建段落元素
                        const p = document.createElement('p');
                        const span = document.createElement('span');
                        span.textContent = taskData.text;
                        p.appendChild(span);
                        textInput.appendChild(p);

                        // 触发事件
                        textInput.dispatchEvent(new Event('input', { bubbles: true }));
                        textInput.dispatchEvent(new Event('change', { bubbles: true }));
                        textInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

                        console.log('文案已填充到编辑器');
                    } else {
                        // 普通 textarea
                        textInput.value = taskData.text;
                        textInput.dispatchEvent(new Event('input', { bubbles: true }));
                        textInput.dispatchEvent(new Event('change', { bubbles: true }));
                    }

                    return { success: true, message: '文案已填充到页面' };
                }

                return { success: false, error: '未找到文本输入框' };

            } catch (error) {
                console.error('填充文案失败:', error);
                return { success: false, error: error.message };
            }
        })();
    `;

    const result = await jimengWindow.webContents.executeJavaScript(submitScript);

    const mainWindow = windows.getMainWindow();
    if (mainWindow) {
        mainWindow.webContents.send('task-submitted', result);
    }

    return result;
}

/**
 * 下载视频
 */
async function downloadVideo(videoUrl, filename, downloadDir) {
    const fs = require('fs');
    const http = require('http');
    const https = require('https');
    const path = require('path');

    const filePath = path.join(downloadDir, filename);
    const file = fs.createWriteStream(filePath);

    return new Promise((resolve, reject) => {
        const protocol = videoUrl.startsWith('https') ? https : http;

        protocol.get(videoUrl, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                log.info('视频下载完成:', filePath);
                resolve({ success: true, path: filePath });
            });
        }).on('error', (err) => {
            fs.unlink(filePath, () => {});
            log.error('下载失败:', err);
            reject(err);
        });
    });
}

module.exports = {
    submitVideoTask,
    downloadVideo
};
