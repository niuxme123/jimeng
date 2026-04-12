/**
 * 任务处理模块
 */

const log = require('./logger');
const windows = require('./windows');

/**
 * 提交视频生成任务
 * 填充文案到页面的文本框
 * @param {object} taskData - 任务数据
 * @param {string} windowId - 目标窗口ID（可选）
 */
async function submitVideoTask(taskData, windowId = null) {
    log.info('提交视频任务:', taskData, '目标窗口:', windowId);

    // 根据windowId获取对应窗口
    let targetWindow = windows.getAccountWindow(windowId);

    // 如果没找到指定窗口，使用主窗口
    if (!targetWindow) {
        targetWindow = windows.getJimengWindow();
    }

    // 如果还是没有，创建新窗口
    if (!targetWindow) {
        windows.createJimengWindow();
        await new Promise(resolve => setTimeout(resolve, 3000));
        targetWindow = windows.getJimengWindow();
    }

    if (!targetWindow || targetWindow.isDestroyed()) {
        return { success: false, error: '目标窗口不存在' };
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

    const result = await targetWindow.webContents.executeJavaScript(submitScript);

    const mainWindow = windows.getMainWindow();
    if (mainWindow) {
        mainWindow.webContents.send('task-submitted', result);
    }

    return result;
}

/**
 * 下载视频
 * 支持重定向和多种 URL 格式
 */
async function downloadVideo(videoUrl, filename, downloadDir) {
    const path = require('path');
    const filePath = path.join(downloadDir, filename);
    return await downloadVideoToPath(videoUrl, filePath);
}

/**
 * 下载视频到指定路径
 * 支持重定向和多种 URL 格式
 */
async function downloadVideoToPath(videoUrl, filePath) {
    const fs = require('fs');
    const http = require('http');
    const https = require('https');

    // 确保 URL 是完整的
    if (!videoUrl.startsWith('http://') && !videoUrl.startsWith('https://')) {
        videoUrl = 'https:' + videoUrl;
    }

    return new Promise((resolve, reject) => {
        const protocol = videoUrl.startsWith('https') ? https : http;

        const request = protocol.get(videoUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Referer': videoUrl
            }
        }, (response) => {
            // 处理重定向
            if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307 || response.statusCode === 308) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    log.info('视频重定向到:', redirectUrl);
                    downloadVideoToPath(redirectUrl, filePath).then(resolve).catch(reject);
                    return;
                }
            }

            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                return;
            }

            const file = fs.createWriteStream(filePath);
            response.pipe(file);

            file.on('finish', () => {
                file.close();
                log.info('视频下载完成:', filePath);
                resolve({ success: true, path: filePath });
            });

            file.on('error', (err) => {
                fs.unlink(filePath, () => {});
                log.error('文件写入失败:', err);
                reject(err);
            });
        });

        request.on('error', (err) => {
            fs.unlink(filePath, () => {});
            log.error('下载失败:', err);
            reject(err);
        });

        // 设置超时
        request.setTimeout(60000, () => {
            request.destroy();
            reject(new Error('下载超时'));
        });
    });
}

module.exports = {
    submitVideoTask,
    downloadVideo,
    downloadVideoToPath
};
