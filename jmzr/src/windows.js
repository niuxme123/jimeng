/**
 * 窗口管理模块
 */

const { BrowserWindow, session } = require('electron');
const path = require('path');
const log = require('./logger');
const config = require('./config');
const auth = require('./auth');

let mainWindow = null;
let jimengWindow = null;

// 多开窗口管理 - 支持不同账号登录不同的窗口
let accountWindows = new Map(); // email -> window

// 视频拦截回调
let onVideoIntercepted = null;
let onApiResponse = null;

// 视频去重集合
let sentVideoUrls = new Set();

/**
 * 设置视频拦截回调
 */
function setVideoInterceptedCallback(callback) {
    onVideoIntercepted = callback;
}

/**
 * 设置 API 响应回调
 */
function setApiResponseCallback(callback) {
    onApiResponse = callback;
}

/**
 * 发送视频到主窗口（带去重）
 */
function sendVideoToMainWindow(video) {
    // 去重：使用不带查询参数的 URL 作为 key
    const urlKey = video.url.split('?')[0];
    if (sentVideoUrls.has(urlKey)) {
        return false;
    }
    sentVideoUrls.add(urlKey);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('video-intercepted', video);
    }
    return true;
}

/**
 * 创建主控制窗口
 */
function createMainWindow(Menu) {
    mainWindow = new BrowserWindow({
        width: 500,
        height: 700,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        title: '即梦AI自动化控制台',
        icon: path.join(__dirname, '..', 'icon.png')
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
    // 不自动打开开发者工具
    // mainWindow.webContents.openDevTools();

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    if (Menu) {
        const menuTemplate = [
            {
                label: '文件',
                submenu: [
                    {
                        label: '加载账号文件',
                        click: () => {
                            // 通过 IPC 通知渲染进程
                            mainWindow.webContents.send('load-accounts-request');
                        }
                    },
                    { type: 'separator' },
                    { role: 'quit' }
                ]
            },
            {
                label: '视图',
                submenu: [
                    { role: 'reload' },
                    { role: 'toggleDevTools' }
                ]
            }
        ];

        const menu = Menu.buildFromTemplate(menuTemplate);
        Menu.setApplicationMenu(menu);
    }

    return mainWindow;
}

/**
 * 创建即梦网站窗口
 * @param {string} partition - 可选的 session partition，用于多账号隔离
 */
function createJimengWindow(partition = null) {
    // 如果指定了 partition（多开模式），创建新窗口
    // 否则检查是否已有默认窗口
    if (!partition && jimengWindow) {
        jimengWindow.focus();
        return jimengWindow;
    }

    // 如果是多开模式且该 partition 的窗口已存在，聚焦它
    if (partition && accountWindows.has(partition)) {
        const existingWindow = accountWindows.get(partition);
        if (!existingWindow.isDestroyed()) {
            existingWindow.focus();
            return existingWindow;
        }
    }

    const windowPartition = partition || 'persist:jimeng';

    const newWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '..', 'preload.js'),
            webSecurity: false,
            partition: windowPartition
        },
        title: partition ? `即梦AI - ${partition}` : '即梦AI - 自动化窗口'
    });

    newWindow.loadURL(config.currentVersion === 'cn' ? config.targetUrlCN : config.targetUrlIntl);

    // 设置请求拦截
    setupRequestInterceptor(newWindow.webContents);

    // 页面加载完成后自动处理弹窗
    newWindow.webContents.on('did-finish-load', () => {
        log.info('页面加载完成，检查弹窗...');
        autoHandlePopupsForWindow(newWindow);
    });

    newWindow.on('closed', () => {
        if (partition) {
            accountWindows.delete(partition);
        } else {
            jimengWindow = null;
        }
    });

    // 根据是否是主窗口进行不同处理
    if (partition) {
        accountWindows.set(partition, newWindow);
    } else {
        jimengWindow = newWindow;
    }

    return newWindow;
}

/**
 * 检查并处理登录状态
 */
async function checkAndHandleLoginStatus() {
    if (!jimengWindow || jimengWindow.isDestroyed()) return;

    try {
        log.info('检查登录状态...');
        const status = await checkLoginStatus();
        log.info('登录状态结果:', status);

        // 通知主窗口
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('login-status-changed', {
                isLoggedIn: status.isLoggedIn === true,
                username: status.username || null
            });
        }

        if (status.isLoggedIn) {
            log.info('已登录，保存状态和设置参数...');
            auth.saveLoginState({ isLoggedIn: true, username: status.username });
            await auth.saveCookies(jimengWindow);

            // 登录成功后设置默认参数
            await setDefaultGenerateParams();
        } else {
            log.info('未登录，等待用户登录...');
        }
    } catch (e) {
        log.error('检查登录状态失败:', e);
    }
}

/**
 * 设置请求拦截器 - 拦截视频下载
 * @param {WebContents} webContents - 网页内容
 * @param {string} windowId - 窗口ID（用于标识视频来源）
 */
function setupRequestInterceptor(webContents, windowId = null) {
    log.info(`设置请求拦截器, windowId: ${windowId}`);

    // 监听网络请求 - 视频文件
    webContents.session.webRequest.onCompleted(
        { urls: ['*://*/*.mp4', '*://*/*.webm', '*://*/*video*', '*://*/*.m3u8'] },
        (details) => {
            log.info('拦截到视频请求:', details.url, '来源窗口:', windowId);

            // 检查是否是无水印视频（通常在 URL 中包含特定标识）
            const url = details.url;
            const isWatermarkFree = url.includes('watermark=0') ||
                                    url.includes('no_watermark') ||
                                    url.includes('no-watermark') ||
                                    url.includes('origin') ||
                                    url.includes('raw') ||
                                    !url.includes('watermark');

            const videoInfo = {
                url: details.url,
                method: details.method,
                timestamp: new Date().toISOString(),
                resourceType: details.resourceType,
                status: details.statusCode,
                isWatermarkFree: isWatermarkFree,
                source: 'network-request',
                windowId: windowId
            };

            if (onVideoIntercepted) {
                onVideoIntercepted(videoInfo);
            }

            // 使用去重函数发送
            sendVideoToMainWindow(videoInfo);
        }
    );

    // 监听 API 响应 - 捕获视频生成结果
    webContents.session.webRequest.onBeforeRequest(
        { urls: [
            '*://*/*generate*',
            '*://*/*create*',
            '*://*/*task*',
            '*://*/api/*',
            '*://*/*submit*',
            '*://*/*result*',
            '*://*/*video*'
        ]},
        (details, callback) => {
            // 对于 POST 请求，记录请求体
            if (details.method === 'POST' && details.uploadData) {
                log.info('API POST 请求:', details.url);
            }
            callback({});
        }
    );

    // 监听 API 响应完成
    webContents.session.webRequest.onCompleted(
        { urls: [
            '*://*/*generate*',
            '*://*/*create*',
            '*://*/*task*',
            '*://*/api/*',
            '*://*/*submit*',
            '*://*/*result*'
        ]},
        (details) => {
            log.info('API请求完成:', details.url, '状态:', details.statusCode);

            // 如果是成功的响应，尝试从页面中提取视频信息
            if (details.statusCode === 200) {
                extractVideoInfoFromPage(webContents, windowId);
            }

            if (mainWindow) {
                mainWindow.webContents.send('api-response', {
                    url: details.url,
                    status: details.statusCode
                });
            }
        }
    );

    // 监听响应头
    webContents.session.webRequest.onHeadersReceived(
        { urls: ['*://*/*'] },
        (details, callback) => {
            const contentType = details.responseHeaders?.['content-type']?.[0] || '';
            if (contentType.includes('video') || contentType.includes('mp4')) {
                log.info('检测到视频响应:', details.url, contentType, '来源窗口:', windowId);

                // 提取视频 URL 的关键信息
                const videoInfo = {
                    url: details.url,
                    contentType: contentType,
                    timestamp: new Date().toISOString(),
                    source: 'response-header',
                    windowId: windowId
                };

                // 使用去重函数发送
                sendVideoToMainWindow(videoInfo);
            }
            callback({});
        }
    );
}

/**
 * 从页面中提取视频信息
 * 支持多种视频源提取方式
 * @param {WebContents} webContents - 网页内容
 * @param {string} windowId - 窗口ID
 */
async function extractVideoInfoFromPage(webContents, windowId = null) {
    try {
        const script = `
            (function() {
                const videos = [];

                // 1. 查找所有 video 元素
                const videoElements = document.querySelectorAll('video');
                videoElements.forEach((video, index) => {
                    if (video.src && !video.src.startsWith('blob:')) {
                        videos.push({
                            type: 'video-src',
                            url: video.src,
                            index: index,
                            poster: video.poster || null
                        });
                    }
                    // 查找 source 子元素
                    const sources = video.querySelectorAll('source');
                    sources.forEach((source, sIndex) => {
                        if (source.src && !source.src.startsWith('blob:')) {
                            videos.push({
                                type: 'video-source',
                                url: source.src,
                                videoIndex: index,
                                sourceIndex: sIndex
                            });
                        }
                    });
                });

                // 2. 查找 iframe 中的视频（可能跨域，不一定能访问）
                try {
                    const iframes = document.querySelectorAll('iframe');
                    iframes.forEach((iframe, iIndex) => {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            const iframeVideos = iframeDoc.querySelectorAll('video');
                            iframeVideos.forEach((v, vIndex) => {
                                if (v.src && !v.src.startsWith('blob:')) {
                                    videos.push({
                                        type: 'iframe-video',
                                        url: v.src,
                                        iframeIndex: iIndex,
                                        videoIndex: vIndex
                                    });
                                }
                            });
                        } catch (e) {
                            // 跨域 iframe，无法访问
                        }
                    });
                } catch (e) {}

                // 3. 查找页面 JS 中的视频 URL（通过全局变量或 window 对象）
                try {
                    // 检查常见的视频播放器对象
                    const playerVars = ['player', 'videoPlayer', '__INITIAL_STATE__', '__NUXT__', 'videoData', 'playInfo'];
                    playerVars.forEach(varName => {
                        try {
                            const data = window[varName];
                            if (data) {
                                const str = JSON.stringify(data);
                                // 匹配 .mp4 或 .webm URL
                                const matches = str.match(/(https?:\\/\\/[^"\\s]+\\.(?:mp4|webm)(?:\\?[^"\\s]*)?)/gi);
                                if (matches) {
                                    matches.forEach(url => {
                                        videos.push({
                                            type: 'js-variable',
                                            url: url.replace(/\\\\u002F/g, '/').replace(/\\\\/g, ''),
                                            source: varName
                                        });
                                    });
                                }
                            }
                        } catch (e) {}
                    });
                } catch (e) {}

                // 4. 查找页面 HTML 中内嵌的视频 URL
                try {
                    const htmlContent = document.documentElement.outerHTML;
                    const urlMatches = htmlContent.match(/(https?:\\/\\/[^"\\s<>]+\\.(?:mp4|webm)(?:\\?[^"\\s<>]*)?)/gi);
                    if (urlMatches) {
                        urlMatches.forEach(url => {
                            const cleanUrl = url.replace(/&amp;/g, '&');
                            if (!videos.some(v => v.url === cleanUrl)) {
                                videos.push({
                                    type: 'html-embedded',
                                    url: cleanUrl
                                });
                            }
                        });
                    }
                } catch (e) {}

                // 5. 查找 aria-label 或 data 属性中的视频 URL
                try {
                    const elementsWithDataUrl = document.querySelectorAll('[data-url*=".mp4"], [data-src*=".mp4"], [data-video*="http"]');
                    elementsWithDataUrl.forEach((el, index) => {
                        const url = el.dataset.url || el.dataset.src || el.dataset.video;
                        if (url && (url.includes('.mp4') || url.includes('.webm'))) {
                            videos.push({
                                type: 'data-attribute',
                                url: url,
                                element: el.tagName
                            });
                        }
                    });
                } catch (e) {}

                // 6. 检查 XHR/Fetch 响应中缓存的数据
                try {
                    // 某些网站会在 localStorage 或 sessionStorage 中缓存视频信息
                    ['localStorage', 'sessionStorage'].forEach(storage => {
                        try {
                            for (let i = 0; i < window[storage].length; i++) {
                                const key = window[storage].key(i);
                                const value = window[storage].getItem(key);
                                if (value && (value.includes('.mp4') || value.includes('.webm'))) {
                                    const matches = value.match(/(https?:\\/\\/[^"\\s]+\\.(?:mp4|webm)(?:\\?[^"\\s]*)?)/gi);
                                    if (matches) {
                                        matches.forEach(url => {
                                            const cleanUrl = url.replace(/\\\\u002F/g, '/').replace(/\\\\/g, '').replace(/\\\\"/g, '"');
                                            if (!videos.some(v => v.url === cleanUrl)) {
                                                videos.push({
                                                    type: 'storage-cache',
                                                    url: cleanUrl,
                                                    source: storage + ':' + key
                                                });
                                            }
                                        });
                                    }
                                }
                            }
                        } catch (e) {}
                    });
                } catch (e) {}

                // 去重
                const uniqueVideos = [];
                const seenUrls = new Set();
                videos.forEach(v => {
                    if (!seenUrls.has(v.url)) {
                        seenUrls.add(v.url);
                        uniqueVideos.push(v);
                    }
                });

                return uniqueVideos;
            })();
        `;

        const videos = await webContents.executeJavaScript(script);
        if (videos && videos.length > 0) {
            log.info('从页面提取到视频:', videos);

            // 分析视频 URL，判断是否无水印
            const processedVideos = videos.map(video => {
                const url = video.url;
                // 判断无水印视频的特征
                const isWatermarkFree = url.includes('watermark=0') ||
                                        url.includes('no_watermark') ||
                                        url.includes('no-watermark') ||
                                        url.includes('origin') ||
                                        url.includes('raw') ||
                                        url.includes('hd') ||
                                        url.includes('source') ||
                                        (!url.includes('watermark') && !url.includes('wm_'));

                return {
                    ...video,
                    timestamp: new Date().toISOString(),
                    source: video.type || 'page-extract',
                    isWatermarkFree: isWatermarkFree
                };
            });

            processedVideos.forEach(video => {
                // 添加 windowId
                video.windowId = windowId;
                // 使用去重函数发送
                sendVideoToMainWindow(video);
            });

            return processedVideos;
        }
        return [];
    } catch (error) {
        log.error('提取页面视频失败:', error);
        return [];
    }
}

/**
 * 自动处理弹窗
 */
async function autoHandlePopups() {
    if (!jimengWindow || jimengWindow.isDestroyed()) return;
    await autoHandlePopupsForWindow(jimengWindow);
}

/**
 * 自动处理指定窗口的弹窗
 */
async function autoHandlePopupsForWindow(targetWindow) {
    if (!targetWindow || targetWindow.isDestroyed()) return;

    const popupScript = `
        (function() {
            var handled = false;

            try {
                // 1. 处理用户协议/隐私政策弹窗
                var agreeButtons = document.querySelectorAll('button, [class*="button"], [class*="btn"]');
                for (var i = 0; i < agreeButtons.length; i++) {
                    var btn = agreeButtons[i];
                    var text = (btn.textContent || '').trim();
                    if (text === '同意' || text === '确认' || text === '接受' ||
                        text === '我同意' || text === '我知道了' || text === '确定' ||
                        text.indexOf('同意并继续') >= 0 || text.indexOf('同意并') >= 0 ||
                        text === 'Agree' || text === 'Accept' || text === 'OK') {
                        btn.click();
                        console.log('[自动处理] 已点击同意按钮:', text);
                        handled = true;
                        break;
                    }
                }

                // 2. 处理复选框
                var checkboxes = document.querySelectorAll('input[type="checkbox"]');
                for (var j = 0; j < checkboxes.length; j++) {
                    var cb = checkboxes[j];
                    if (!cb.checked) {
                        var label = cb.closest('label') || cb.parentElement;
                        var labelText = label ? label.textContent : '';
                        if (labelText.indexOf('协议') >= 0 || labelText.indexOf('同意') >= 0 ||
                            labelText.indexOf('隐私') >= 0 || labelText.indexOf('条款') >= 0) {
                            cb.click();
                            handled = true;
                        }
                    }
                }

                // 3. 处理关闭按钮
                var closeButtons = document.querySelectorAll('[class*="close"], [class*="cancel"], [class*="dismiss"]');
                for (var k = 0; k < closeButtons.length; k++) {
                    var btn = closeButtons[k];
                    var isModalClose = btn.closest('[class*="modal"]') ||
                                         btn.closest('[class*="dialog"]') ||
                                         btn.closest('[class*="popup"]');
                    if (isModalClose) {
                        btn.click();
                        handled = true;
                    }
                }
            } catch (e) {
                console.error('[自动处理] 错误:', e.message);
            }

            // 返回 JSON 字符串
            return JSON.stringify({ handled: handled });
        })();
    `;

    try {
        const jsonStr = await targetWindow.webContents.executeJavaScript(popupScript);
        const result = JSON.parse(jsonStr);
        if (result.handled) {
            log.info('已自动处理弹窗');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('popup-handled', { handled: true });
            }
        }
    } catch (error) {
        // 忽略执行错误
    }
}

/**
 * 检查登录状态
 */
async function checkLoginStatus() {
    // 如果没有即梦窗口，返回保存的状态
    if (!jimengWindow || jimengWindow.isDestroyed()) {
        const state = auth.getLoginState();
        log.info('无即梦窗口，返回保存的状态:', state);
        return state ? { isLoggedIn: state.isLoggedIn === true, username: state.username || null } : { isLoggedIn: false, username: null };
    }

    // 检查 webContents 是否有效
    if (!jimengWindow.webContents || jimengWindow.webContents.isDestroyed()) {
        log.info('webContents 已销毁');
        return { isLoggedIn: false, username: null };
    }

    // 使用 JSON.stringify 确保返回纯字符串，然后解析
    const checkScript = `
        (function() {
            try {
                // 国际版登录状态检测
                console.log('=== 开始检测登录状态 ===');

                // 步骤1：检查是否有 Sign in 按钮（未登录标志）
                var signInButton = null;
                var allMenuItems = document.querySelectorAll('.lv-menu-item');
                console.log('菜单项数量:', allMenuItems.length);

                for (var i = 0; i < allMenuItems.length; i++) {
                    var text = (allMenuItems[i].textContent || '').trim();
                    console.log('菜单项[' + i + ']:', text);
                    if (text === 'Sign in' || text === '登录' || text === '报名') {
                        signInButton = allMenuItems[i];
                        console.log('>>> 找到 Sign in 按钮!');
                        break;
                    }
                }

                // 关键判断：如果有 Sign in 按钮，一定是未登录
                if (signInButton) {
                    console.log('=== 结果: 未登录 (有Sign in按钮) ===');
                    return JSON.stringify({
                        isLoggedIn: false,
                        username: null
                    });
                }

                // 步骤2：检查是否有积分显示（登录后有 "50Upgrade" 之类的）
                var hasCreditDisplay = false;
                var creditText = '';

                // 只在 .lv-menu-item 中查找，确保是导航栏的积分显示
                for (var i = 0; i < allMenuItems.length; i++) {
                    var item = allMenuItems[i];
                    var text = (item.textContent || '').trim();
                    var className = item.className || '';

                    // 登录后的积分显示：class包含credit-display，或文本以数字开头+Upgrade
                    if (className.indexOf('credit-display') >= 0) {
                        hasCreditDisplay = true;
                        creditText = text;
                        console.log('>>> 找到积分显示:', text, className);
                        break;
                    }

                    // 检查 "50Upgrade" 格式（数字+Upgrade）
                    if (/^[0-9]+Upgrade/i.test(text)) {
                        hasCreditDisplay = true;
                        creditText = text;
                        console.log('>>> 找到积分显示:', text);
                        break;
                    }
                }

                // 步骤3：最终判断
                // 没有 Sign in 按钮且没有积分显示 = 状态未知，可能页面未加载完成
                if (!hasCreditDisplay) {
                    console.log('=== 结果: 未登录 (没有积分显示) ===');
                    return JSON.stringify({
                        isLoggedIn: false,
                        username: null
                    });
                }

                console.log('=== 结果: 已登录 ===');
                return JSON.stringify({
                    isLoggedIn: true,
                    username: null,
                    creditText: creditText
                });
            } catch (e) {
                console.error('登录状态检测错误:', e);
                return JSON.stringify({ isLoggedIn: false, username: null, error: e.message });
            }
        })();
    `;

    try {
        const jsonStr = await jimengWindow.webContents.executeJavaScript(checkScript);
        log.info('页面登录状态检查原始结果:', jsonStr);

        // 解析 JSON 字符串
        const result = JSON.parse(jsonStr);
        log.info('页面登录状态检查解析结果:', result);

        return {
            isLoggedIn: result.isLoggedIn === true,
            username: result.username || null
        };
    } catch (error) {
        log.error('检查登录状态失败:', error);
        return { isLoggedIn: false, username: null };
    }
}

/**
 * 分析页面元素结构
 * @param {string} windowId - 可选，指定要分析的窗口（email 或 partition）
 */
async function analyzePageStructure(windowId = null) {
    let targetWindow = null;

    log.info('分析页面结构请求, windowId:', windowId);

    // 确定要分析的窗口
    if (windowId && accountWindows && accountWindows.size > 0) {
        // 查找指定的窗口
        accountWindows.forEach((win, partition) => {
            if (partition.includes(windowId) || partition === windowId) {
                if (win && !win.isDestroyed()) {
                    targetWindow = win;
                }
            }
        });
    }

    // 如果没有找到指定窗口，使用主窗口
    if (!targetWindow) {
        if (jimengWindow && !jimengWindow.isDestroyed()) {
            targetWindow = jimengWindow;
            log.info('使用主窗口');
        }
    }

    if (!targetWindow) {
        log.info('没有可分析的窗口');
        return null;
    }

    log.info('分析页面结构... 目标窗口:', windowId || '主窗口');

    const analyzeScript = `
        (function() {
            var info = {};

            // ===== 分析文本输入框 =====
            var textInput = document.querySelector('div[contenteditable="true"].ProseMirror') ||
                           document.querySelector('div[contenteditable="true"]') ||
                           document.querySelector('textarea');
            if (textInput) {
                info.textInput = {
                    tagName: textInput.tagName,
                    className: textInput.className,
                    contentEditable: textInput.contentEditable,
                    innerHTML: textInput.innerHTML.substring(0, 1000),
                    textContent: textInput.textContent.substring(0, 500)
                };
            }

            // ===== 分析已上传的引用素材 =====
            var referenceItems = document.querySelectorAll('.reference-item-GyRAe7, [class*="reference-item"]');
            info.referenceItems = [];
            for (var i = 0; i < referenceItems.length; i++) {
                var item = referenceItems[i];
                var img = item.querySelector('img');
                var label = item.querySelector('[class*="label"], [class*="name"], span, div');
                info.referenceItems.push({
                    index: i,
                    className: item.className,
                    dataAttributes: Object.keys(item.dataset).map(function(k) { return k + '=' + item.dataset[k]; }),
                    hasImage: !!img,
                    imgSrc: img ? img.src.substring(0, 50) : null,
                    label: label ? label.textContent.trim() : item.textContent.trim().substring(0, 30),
                    outerHTML: item.outerHTML.substring(0, 300)
                });
            }

            // ===== 分析 @ 引用下拉列表（如果有的话）=====
            var mentionList = document.querySelector('[class*="mention"], [class*="at-list"], [class*="reference-list"]');
            if (mentionList) {
                info.mentionList = {
                    className: mentionList.className,
                    html: mentionList.outerHTML.substring(0, 1000)
                };
            }

            // 查找 dimension-layout 容器
            var container = document.querySelector('[class*="dimension-layout"]');
            if (container) {
                info.container = {
                    className: container.className,
                    html: container.outerHTML.substring(0, 2000)
                };
            }

            // 查找所有可能是选项的元素
            var allButtons = document.querySelectorAll('div[role="button"], button, [class*="select"], [class*="option"], [class*="item"], [class*="btn"]');
            info.buttons = [];
            for (var i = 0; i < allButtons.length && i < 150; i++) {
                var btn = allButtons[i];
                var text = (btn.textContent || '').trim();
                if (text.length > 0 && text.length < 100) {
                    info.buttons.push({
                        text: text,
                        className: btn.className,
                        tagName: btn.tagName
                    });
                }
            }

            // 查找下拉菜单选项（重要！可能在body下的独立层）
            var dropdownOptions = document.querySelectorAll('.lv-select-dropdown [class*="option"], .lv-select-dropdown [class*="item"], [class*="select-dropdown"] [class*="option"], .lv-dropdown [class*="option"], .lv-dropdown-menu [class*="item"]');
            info.dropdownOptions = [];
            for (var i = 0; i < dropdownOptions.length; i++) {
                var opt = dropdownOptions[i];
                info.dropdownOptions.push({
                    text: (opt.textContent || '').trim(),
                    className: opt.className
                });
            }

            // ===== 重要：查找所有弹出层和popover =====
            var popovers = document.querySelectorAll('[class*="popover"], [class*="popup"], [class*="dropdown"], [class*="modal"], .lv-popover, .lv-popover-inner');
            info.popovers = [];
            for (var i = 0; i < popovers.length; i++) {
                var p = popovers[i];
                info.popovers.push({
                    className: p.className,
                    html: p.outerHTML.substring(0, 1000)
                });
            }

            // 查找 lv-popover 内的所有可点击元素
            var popoverItems = document.querySelectorAll('.lv-popover div[role="button"], .lv-popover button, .lv-popover [class*="option"], .lv-popover [class*="item"]');
            info.popoverItems = [];
            for (var i = 0; i < popoverItems.length; i++) {
                var item = popoverItems[i];
                info.popoverItems.push({
                    text: (item.textContent || '').trim(),
                    className: item.className,
                    tagName: item.tagName
                });
            }

            // 如果上面没找到，尝试查找所有弹出层
            if (info.popovers.length === 0) {
                var allPopovers = document.querySelectorAll('[class*="popover"], [class*="popup"], [class*="dropdown-menu"]');
                info.allPopovers = [];
                for (var i = 0; i < allPopovers.length; i++) {
                    var p = allPopovers[i];
                    info.allPopovers.push({
                        className: p.className,
                        text: (p.textContent || '').trim().substring(0, 200)
                    });
                }
            }

            // 查找所有包含 Seedance 或 Fast 的元素
            var seedanceEls = document.querySelectorAll('[class*="seedance"], [class*="model"]');
            info.seedanceElements = [];
            for (var i = 0; i < seedanceEls.length; i++) {
                var el = seedanceEls[i];
                var text = (el.textContent || '').trim();
                if (text.indexOf('Seedance') >= 0 || text.indexOf('Fast') >= 0 || text.indexOf('VIP') >= 0 || text.indexOf('720p') >= 0) {
                    info.seedanceElements.push({
                        className: el.className,
                        text: text.substring(0, 100)
                    });
                }
            }

            // 查找开关
            var switches = document.querySelectorAll('[class*="switch"], [class*="toggle"], [role="switch"], input[type="checkbox"]');
            info.switches = [];
            for (var i = 0; i < switches.length; i++) {
                var sw = switches[i];
                var parent = sw.parentElement;
                info.switches.push({
                    className: sw.className,
                    tagName: sw.tagName,
                    parentText: parent ? (parent.textContent || '').substring(0, 100) : ''
                });
            }

            // 查找比例相关
            var ratios = document.querySelectorAll('[class*="ratio"], [class*="scale"], [class*="dimension"], [class*="proportion"]');
            info.ratios = [];
            for (var i = 0; i < ratios.length; i++) {
                info.ratios.push({
                    className: ratios[i].className,
                    text: (ratios[i].textContent || '').substring(0, 50)
                });
            }

            // 查找时长相关
            var durations = document.querySelectorAll('[class*="duration"], [class*="time"], [class*="length"]');
            info.durations = [];
            for (var i = 0; i < durations.length; i++) {
                info.durations.push({
                    className: durations[i].className,
                    text: (durations[i].textContent || '').substring(0, 50)
                });
            }

            // 查找模型相关
            var models = document.querySelectorAll('[class*="model"], [class*="version"], [class*="seedance"]');
            info.models = [];
            for (var i = 0; i < models.length; i++) {
                info.models.push({
                    className: models[i].className,
                    text: (models[i].textContent || '').substring(0, 100)
                });
            }

            return JSON.stringify(info);
        })();
    `;

    try {
        const jsonStr = await targetWindow.webContents.executeJavaScript(analyzeScript);
        const result = JSON.parse(jsonStr);

        // 保存到文件
        const fs = require('fs');
        const path = require('path');
        const logFile = path.join(__dirname, '..', 'page-structure.json');
        fs.writeFileSync(logFile, JSON.stringify(result, null, 2));

        log.info('页面结构已保存到: ' + logFile);

        // 同时打印关键信息
        if (result.buttons) {
            log.info('--- 按钮列表 ---');
            result.buttons.forEach(function(b) {
                if (b.text.indexOf('视频') >= 0 || b.text.indexOf('生成') >= 0 ||
                    b.text.indexOf('Seedance') >= 0 || b.text.indexOf('9:16') >= 0 ||
                    b.text.indexOf('15') >= 0 || b.text.indexOf('参考') >= 0) {
                    log.info('按钮: "' + b.text + '" class="' + b.className + '"');
                }
            });
        }

        if (result.switches) {
            log.info('--- 开关列表 ---');
            result.switches.forEach(function(s) {
                log.info('开关: class="' + s.className + '" parent="' + s.parentText.substring(0, 30) + '"');
            });
        }

        return result;
    } catch (error) {
        log.error('分析页面结构失败:', error);
        return null;
    }
}

/**
 * 设置默认生成参数
 * 国际版流程: AI Video → Omni reference → Seedance 2.0 Fast (非VIP) → 9:16 → 15s
 */
async function setDefaultGenerateParams() {
    if (!jimengWindow || jimengWindow.isDestroyed()) return;

    log.info('设置默认生成参数...');

    // 延迟等待页面完全渲染
    await new Promise(resolve => setTimeout(resolve, 2000));

    const paramsScript = `
        (async function() {
            var results = [];

            async function sleep(ms) {
                return new Promise(function(r) { setTimeout(r, ms); });
            }

            try {
                // ========== 1. 选择 "AI Video" 模式 ==========
                console.log('步骤1: 选择 AI Video 模式...');
                var currentModeLabel = document.querySelector('.lv-select-view-value');
                var currentMode = currentModeLabel ? (currentModeLabel.textContent || '').trim() : '';
                console.log('当前模式:', currentMode);

                if (currentMode !== 'AI Video') {
                    // 点击模式选择器
                    var modeSelect = document.querySelector('.lv-select.lv-select-single.branded-ttZCKU') ||
                                     document.querySelector('.toolbar-select-OO8YBx');
                    if (modeSelect) {
                        modeSelect.click();
                        await sleep(800);
                    }

                    // 选择 AI Video 选项
                    var allOptions = document.querySelectorAll('.lv-select-option');
                    console.log('找到选项数量:', allOptions.length);
                    var found = false;
                    for (var i = 0; i < allOptions.length; i++) {
                        var opt = allOptions[i];
                        var text = (opt.textContent || '').trim();
                        console.log('选项文本:', text);
                        if (text === 'AI Video') {
                            opt.click();
                            await sleep(2000);
                            results.push({ label: '生成模式', success: true, value: 'AI Video' });
                            found = true;
                            break;
                        }
                    }

                    if (!found) {
                        results.push({ label: '生成模式', success: false, error: '未找到 AI Video 选项' });
                    }
                } else {
                    results.push({ label: '生成模式', success: true, value: '已是 AI Video 模式' });
                }

                // ========== 2. 选择 "Omni reference" (全能参考) ==========
                await sleep(1000);
                console.log('步骤2: 选择 Omni reference...');

                // 查找参考类型选择器 (First and last frames)
                var refSelectors = document.querySelectorAll('.lv-select.lv-select-single');
                var refSelect = null;

                for (var i = 0; i < refSelectors.length; i++) {
                    var sel = refSelectors[i];
                    var text = (sel.textContent || '').trim();
                    console.log('参考选择器文本:', text);
                    if (text.indexOf('First and last frames') >= 0 || text.indexOf('Omni reference') >= 0) {
                        refSelect = sel;
                        break;
                    }
                }

                if (refSelect) {
                    var currentRef = (refSelect.textContent || '').trim();
                    console.log('当前参考模式:', currentRef);
                    if (currentRef.indexOf('Omni reference') < 0) {
                        refSelect.click();
                        await sleep(800);

                        var foundRef = false;
                        var refOptions = document.querySelectorAll('.lv-select-option');

                        for (var i = 0; i < refOptions.length; i++) {
                            var opt = refOptions[i];
                            var text = (opt.textContent || '').trim();
                            console.log('参考选项:', text);
                            if (text.indexOf('Omni reference') >= 0) {
                                opt.click();
                                await sleep(800);
                                results.push({ label: '全能参考', success: true, value: 'Omni reference' });
                                foundRef = true;
                                break;
                            }
                        }

                        if (!foundRef) {
                            document.body.click();
                            results.push({ label: '全能参考', success: false, error: '未找到 Omni reference 选项' });
                        }
                    } else {
                        results.push({ label: '全能参考', success: true, value: '已是 Omni reference' });
                    }
                } else {
                    results.push({ label: '全能参考', success: false, error: '未找到参考选择器' });
                }

                // ========== 3. 选择模型 Seedance 2.0 Fast (非VIP) ==========
                await sleep(800);
                console.log('步骤3: 选择模型...');

                var modelSelectors = document.querySelectorAll('.lv-select.lv-select-single');
                var modelSelect = null;

                for (var i = 0; i < modelSelectors.length; i++) {
                    var sel = modelSelectors[i];
                    var text = (sel.textContent || '').trim();
                    console.log('模型选择器文本:', text);
                    if (text.indexOf('Seedance') >= 0) {
                        modelSelect = sel;
                        break;
                    }
                }

                if (modelSelect) {
                    var currentModel = (modelSelect.textContent || '').trim();
                    console.log('当前模型:', currentModel);
                    // 检查是否已经是 Seedance 2.0 Fast (非VIP)
                    if (currentModel.indexOf('Seedance 2.0 Fast') >= 0 && currentModel.indexOf('VIP') < 0) {
                        results.push({ label: '模型', success: true, value: '已是 Seedance 2.0 Fast' });
                    } else {
                        modelSelect.click();
                        await sleep(800);

                        var foundModel = false;
                        var modelOptions = document.querySelectorAll('.lv-select-option');

                        for (var i = 0; i < modelOptions.length; i++) {
                            var opt = modelOptions[i];
                            var text = (opt.textContent || '').trim();
                            console.log('模型选项:', text);
                            // 选择包含 Seedance 2.0 Fast 且不包含 VIP 的选项
                            if (text.indexOf('Seedance 2.0 Fast') >= 0 && text.indexOf('VIP') < 0) {
                                opt.click();
                                await sleep(800);
                                results.push({ label: '模型', success: true, value: 'Seedance 2.0 Fast' });
                                foundModel = true;
                                break;
                            }
                        }

                        if (!foundModel) {
                            document.body.click();
                            results.push({ label: '模型', success: false, error: '未找到 Seedance 2.0 Fast 选项' });
                        }
                    }
                } else {
                    results.push({ label: '模型', success: false, error: '未找到模型选择器' });
                }

                // ========== 4. 设置比例 9:16 ==========
                await sleep(800);
                console.log('步骤4: 设置比例 9:16...');

                // 比例按钮是 BUTTON 类型，类名 toolbar-button-atztV1
                var ratioButton = document.querySelector('.toolbar-button-atztV1');

                if (!ratioButton) {
                    // 备用方案：查找包含 : 的按钮
                    var allButtons = document.querySelectorAll('button');
                    for (var i = 0; i < allButtons.length; i++) {
                        var btn = allButtons[i];
                        var text = (btn.textContent || '').trim();
                        if (text === '16:9' || text === '9:16' || text === '1:1' || text === '4:3') {
                            ratioButton = btn;
                            break;
                        }
                    }
                }

                if (ratioButton) {
                    var currentRatio = (ratioButton.textContent || '').trim();
                    console.log('当前比例:', currentRatio);
                    if (currentRatio !== '9:16') {
                        ratioButton.click();
                        await sleep(800);

                        var found916 = false;

                        // 方法1: 查找 lv-popover 内的选项
                        var popover = document.querySelector('.lv-popover');
                        if (popover) {
                            console.log('找到弹出层');
                            // 查找所有可点击元素
                            var items = popover.querySelectorAll('div, span, button, li');
                            for (var i = 0; i < items.length; i++) {
                                var item = items[i];
                                var text = (item.textContent || '').trim();
                                if (text === '9:16') {
                                    console.log('找到 9:16 选项');
                                    item.click();
                                    await sleep(500);
                                    results.push({ label: '比例', success: true, value: '9:16' });
                                    found916 = true;
                                    break;
                                }
                            }
                        }

                        // 方法2: 查找所有比例为 9:16 的按钮或选项
                        if (!found916) {
                            var allItems = document.querySelectorAll('[class*="option"], [class*="item"], button, div[role="button"]');
                            for (var i = 0; i < allItems.length; i++) {
                                var item = allItems[i];
                                var text = (item.textContent || '').trim();
                                if (text === '9:16') {
                                    console.log('通过遍历找到 9:16');
                                    item.click();
                                    await sleep(500);
                                    results.push({ label: '比例', success: true, value: '9:16' });
                                    found916 = true;
                                    break;
                                }
                            }
                        }

                        if (!found916) {
                            document.body.click();
                            results.push({ label: '比例', success: false, error: '未找到 9:16 选项' });
                        }
                    } else {
                        results.push({ label: '比例', success: true, value: '已是 9:16' });
                    }
                } else {
                    results.push({ label: '比例', success: false, error: '未找到比例按钮' });
                }

                // ========== 5. 设置时长 15s ==========
                await sleep(800);
                console.log('步骤5: 设置时长 15s...');

                // 时长选择器显示如 "5s" 或 "15s"
                var durationSelectors = document.querySelectorAll('.lv-select.lv-select-single');
                var durationSelect = null;

                for (var i = 0; i < durationSelectors.length; i++) {
                    var sel = durationSelectors[i];
                    var text = (sel.textContent || '').trim();
                    console.log('时长选择器文本:', text);
                    // 查找包含 "s" 且长度短的（5s, 15s 等）
                    if ((text === '5s' || text === '10s' || text === '15s' || /^[0-9]+s$/.test(text)) &&
                        text.indexOf('Seedance') < 0 && text.indexOf('Omni') < 0 && text.indexOf('reference') < 0) {
                        durationSelect = sel;
                        break;
                    }
                }

                if (durationSelect) {
                    var currentDuration = (durationSelect.textContent || '').trim();
                    console.log('当前时长:', currentDuration);
                    if (currentDuration !== '15s') {
                        durationSelect.click();
                        await sleep(800);

                        var found15s = false;
                        var durationOptions = document.querySelectorAll('.lv-select-option');

                        for (var i = 0; i < durationOptions.length; i++) {
                            var opt = durationOptions[i];
                            var text = (opt.textContent || '').trim();
                            console.log('时长选项:', text);
                            if (text === '15s' || text === '15') {
                                opt.click();
                                await sleep(500);
                                results.push({ label: '时长', success: true, value: '15s' });
                                found15s = true;
                                break;
                            }
                        }

                        if (!found15s) {
                            document.body.click();
                            results.push({ label: '时长', success: false, error: '未找到 15s 选项' });
                        }
                    } else {
                        results.push({ label: '时长', success: true, value: '已是 15s' });
                    }
                } else {
                    results.push({ label: '时长', success: false, error: '未找到时长选择器' });
                }

                console.log('参数设置完成:', results);
                return JSON.stringify({ success: true, results: results });
            } catch (e) {
                console.error('参数设置错误:', e);
                return JSON.stringify({ success: false, results: results, error: e.message });
            }
        })();
    `;

    try {
        const jsonStr = await jimengWindow.webContents.executeJavaScript(paramsScript);
        const result = JSON.parse(jsonStr);

        // 打印结果
        if (result.results) {
            result.results.forEach(function(r) {
                if (r.success) {
                    log.info('[参数] ' + r.label + ': ' + r.value + ' ✓');
                } else {
                    log.info('[参数] ' + r.label + ': ' + r.error + ' ✗');
                }
            });
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('params-set', result);
        }

        return result;
    } catch (error) {
        log.error('设置参数失败:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 显示登录二维码
 */
async function showLoginQRCode() {
    log.info('显示登录二维码...');

    if (!jimengWindow) {
        createJimengWindow();
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const qrScript = `
        (async function() {
            try {
                let loginButton = document.querySelector('div[class*="login-button-"]') ||
                                 document.querySelector('.login-button') ||
                                 document.querySelector('[class*="login"]');

                if (!loginButton) {
                    const allDivs = document.querySelectorAll('div');
                    for (const div of allDivs) {
                        const text = div.textContent ? div.textContent.trim() : '';
                        if (text === '登录' || text === 'Sign in') {
                            loginButton = div;
                            break;
                        }
                    }
                }

                if (loginButton) {
                    loginButton.click();
                    await new Promise(r => setTimeout(r, 1500));
                }

                return {
                    success: true,
                    message: '二维码已显示，请使用抖音/剪映APP扫码登录'
                };

            } catch (error) {
                return { success: false, error: error.message };
            }
        })();
    `;

    const result = await jimengWindow.webContents.executeJavaScript(qrScript);
    log.info('二维码结果:', result);

    if (mainWindow) {
        mainWindow.webContents.send('qr-code-result', result);
    }

    if (jimengWindow) {
        jimengWindow.focus();
    }

    return result;
}

/**
 * 使用邮箱密码登录
 * 每个邮箱使用独立的窗口和 session
 * @param {string} email - 邮箱账号
 * @param {string} password - 密码
 */
async function loginWithEmail(email, password) {
    log.info(`开始邮箱登录: ${email}...`);

    // 为每个邮箱创建独立的 session partition
    // 不使用 persist: 前缀，这样每次都是全新的临时 session
    const partition = `jimeng_${email.replace(/[^a-zA-Z0-9]/g, '_')}`;

    // 检查是否已有该账号的窗口
    let targetWindow = accountWindows.get(partition);

    if (targetWindow && !targetWindow.isDestroyed()) {
        log.info(`账号 ${email} 的窗口已存在，聚焦窗口`);
        targetWindow.focus();
        return { success: true, message: '窗口已存在', email };
    }

    // 创建新窗口
    targetWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '..', 'preload.js'),
            webSecurity: false,
            partition: partition
        },
        title: `即梦AI - ${email}`
    });

    targetWindow.loadURL(config.currentVersion === 'cn' ? config.targetUrlCN : config.targetUrlIntl);

    // 设置请求拦截，传入窗口ID用于标识视频来源
    setupRequestInterceptor(targetWindow.webContents, partition);

    // 页面加载完成后设置标题并处理弹窗
    targetWindow.webContents.on('did-finish-load', () => {
        // 强制设置窗口标题
        targetWindow.setTitle(`即梦AI - ${email}`);
        log.info(`页面加载完成 [${email}]，检查弹窗...`);
        autoHandlePopupsForWindow(targetWindow);
    });

    // 页面标题变化时重新设置
    targetWindow.on('page-title-updated', (event) => {
        event.preventDefault();
        targetWindow.setTitle(`即梦AI - ${email}`);
    });

    targetWindow.on('closed', () => {
        accountWindows.delete(partition);
        log.info(`账号 ${email} 的窗口已关闭`);

        // 通知前端窗口已关闭
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account-window-closed', {
                windowId: partition,
                email: email
            });
        }
    });

    // 保存到账号窗口映射
    accountWindows.set(partition, targetWindow);

    // 等待页面加载完成
    await new Promise(resolve => {
        targetWindow.webContents.once('did-finish-load', resolve);
        // 超时保护
        setTimeout(resolve, 15000);
    });

    // 等待页面渲染完成 - 增加到5秒
    log.info('等待页面渲染...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 等待 Sign in 按钮出现（最多等待10秒）
    log.info('等待 Sign in 按钮出现...');
    let retryCount = 0;
    const maxRetries = 10;
    while (retryCount < maxRetries) {
        const hasSignIn = await targetWindow.webContents.executeJavaScript(`
            (function() {
                var items = document.querySelectorAll('.lv-menu-item');
                for (var i = 0; i < items.length; i++) {
                    if (items[i].textContent.trim() === 'Sign in') {
                        return true;
                    }
                }
                return false;
            })();
        `);

        if (hasSignIn) {
            log.info('Sign in 按钮已出现');
            break;
        }

        retryCount++;
        log.info(`等待 Sign in 按钮... (${retryCount}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 先分析页面元素，用于调试
    const debugScript = `
        (function() {
            var info = {
                url: window.location.href,
                title: document.title,
                buttons: [],
                menuItems: [],
                signInButton: null,
                hasCreditDisplay: false,
                creditText: ''
            };

            // 收集所有 .lv-menu-item 菜单项
            document.querySelectorAll('.lv-menu-item').forEach(function(item) {
                var text = (item.textContent || '').trim();
                if (text && item.offsetWidth > 0) {
                    info.menuItems.push(text);
                    // 查找 Sign in 按钮
                    if (text === 'Sign in' || text === '登录' || text === '報名') {
                        info.signInButton = {
                            text: text,
                            className: item.className,
                            found: true
                        };
                    }
                }
            });

            // 检查是否有积分显示（已登录状态）
            document.querySelectorAll('.lv-menu-item').forEach(function(item) {
                var text = (item.textContent || '').trim();
                if (/^[0-9]+Upgrade/i.test(text) || (text.includes('Upgrade') && text.length < 20)) {
                    info.hasCreditDisplay = true;
                    info.creditText = text;
                }
            });

            return JSON.stringify(info);
        })();
    `;

    try {
        const debugInfo = await targetWindow.webContents.executeJavaScript(debugScript);
        const pageInfo = JSON.parse(debugInfo);
        log.info('=== 页面调试信息 ===');
        log.info('URL:', pageInfo.url);
        log.info('菜单项:', pageInfo.menuItems);
        log.info('Sign in 按钮:', pageInfo.signInButton);
        log.info('积分显示:', pageInfo.hasCreditDisplay ? pageInfo.creditText : '无');

        // 发送到主窗口显示
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('debug-info', {
                url: pageInfo.url,
                title: pageInfo.title,
                menuItems: pageInfo.menuItems,
                signInButton: pageInfo.signInButton,
                hasCreditDisplay: pageInfo.hasCreditDisplay,
                creditText: pageInfo.creditText
            });
        }
    } catch (e) {
        log.error('获取页面调试信息失败:', e);
    }

    const loginScript = `
        (async function() {
            async function sleep(ms) {
                return new Promise(function(r) { setTimeout(r, ms); });
            }

            try {
                // 步骤1：点击登录按钮（参照油猴脚本）
                console.log('步骤1: 点击登录按钮...');
                let loginButton = document.querySelector('div[class*="login-button-"]') ||
                                 document.querySelector('.login-button');

                // 如果通过class没找到，尝试通过文本内容查找
                if (!loginButton) {
                    const allDivs = document.querySelectorAll('div');
                    for (const div of allDivs) {
                        if (div.textContent && (div.textContent.trim() === 'Sign in' || div.textContent.trim() === '登录')) {
                            loginButton = div;
                            break;
                        }
                    }
                }

                if (loginButton) {
                    loginButton.click();
                    console.log('已点击登录按钮');
                    await sleep(1000);
                }

                // 步骤2：等待邮箱登录选项出现并点击
                console.log('步骤2: 等待邮箱登录选项...');
                await sleep(500);

                let emailLogin = null;

                // 方法1：通过完整的wrapper结构查找（参照油猴脚本）
                const wrappers = document.querySelectorAll('.lv_new_third_part_sign_in_expand-wrapper');
                console.log('找到 ' + wrappers.length + ' 个登录选项wrapper');

                for (const wrapper of wrappers) {
                    const button = wrapper.querySelector('.lv_new_third_part_sign_in_expand-button');
                    if (button) {
                        const span = button.querySelector('.lv_new_third_part_sign_in_expand-label');
                        const spanText = span ? span.textContent.trim() : '';
                        console.log('检查wrapper中的按钮文本: "' + spanText + '"');

                        if (spanText === '使用電子郵件繼續' || spanText === '使用电子邮件继续' || spanText === 'Continue with email') {
                            emailLogin = button;
                            console.log('✓ 通过精确文本匹配找到邮箱登录按钮');
                            break;
                        }
                    }
                }

                // 方法2：直接查找按钮
                if (!emailLogin) {
                    const loginButtons = document.querySelectorAll('.lv_new_third_part_sign_in_expand-button');
                    console.log('备用方案：找到 ' + loginButtons.length + ' 个登录按钮');

                    for (const button of loginButtons) {
                        const span = button.querySelector('.lv_new_third_part_sign_in_expand-label');
                        const spanText = span ? span.textContent.trim() : '';
                        console.log('检查按钮文本: "' + spanText + '"');

                        if (spanText === '使用電子郵件繼續' || spanText === '使用电子邮件继续' || spanText === 'Continue with email') {
                            emailLogin = button;
                            console.log('✓ 通过备用方案找到邮箱登录按钮');
                            break;
                        }

                        // 排除Google登录
                        if (spanText.includes('Google') || spanText.includes('谷歌')) {
                            console.log('✗ 跳过Google登录按钮');
                            continue;
                        }
                    }
                }

                // 方法3：通过span标签的文本内容查找
                if (!emailLogin) {
                    console.log('尝试通过span标签查找邮箱登录按钮...');
                    const allButtons = document.querySelectorAll('.lv_new_third_part_sign_in_expand-button');
                    for (const button of allButtons) {
                        const span = button.querySelector('.lv_new_third_part_sign_in_expand-label');
                        if (span) {
                            const spanText = span.textContent || '';
                            console.log('检查span文本: "' + spanText + '"');

                            if (spanText.includes('使用電子郵件繼續') ||
                                spanText.includes('使用电子邮件继续') ||
                                spanText.includes('Continue with email') ||
                                spanText.includes('電子郵件') ||
                                spanText.includes('电子邮件') ||
                                spanText.includes('email')) {
                                if (!spanText.includes('Google') && !spanText.includes('谷歌')) {
                                    emailLogin = button;
                                    console.log('通过span文本找到邮箱登录按钮');
                                    break;
                                }
                            }
                        }
                    }
                }

                if (!emailLogin) {
                    // 调试信息
                    console.log('=== 调试信息：所有登录按钮 ===');
                    const allButtons = document.querySelectorAll('.lv_new_third_part_sign_in_expand-button');
                    allButtons.forEach(function(btn, index) {
                        const text = btn.textContent || '';
                        const span = btn.querySelector('.lv_new_third_part_sign_in_expand-label');
                        const spanText = span ? span.textContent : '';
                        console.log('按钮' + (index + 1) + ': 完整文本="' + text + '", span文本="' + spanText + '"');
                    });
                    return JSON.stringify({ success: false, error: '无法找到邮箱登录选项' });
                }

                emailLogin.click();
                console.log('已点击邮箱登录');
                await sleep(1500);

                // 步骤3：填充邮箱账号（参照油猴脚本，使用 React 方式）
                console.log('步骤3: 填充邮箱地址...');
                let emailInput = document.querySelector('input[placeholder*="電子郵件"]') ||
                                document.querySelector('input[placeholder*="email"]') ||
                                document.querySelector('input[type="email"]') ||
                                document.querySelector('input[placeholder*="邮件"]');

                if (!emailInput) {
                    emailInput = document.querySelector('input[type="email"]') ||
                                document.querySelector('input[name*="email"]') ||
                                document.querySelector('input[id*="email"]');
                }

                if (!emailInput) {
                    return JSON.stringify({ success: false, error: '未找到邮箱输入框' });
                }

                // 使用 React 的方式填充值（防止被清空）
                var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeInputValueSetter.call(emailInput, '${email}');
                emailInput.dispatchEvent(new Event('input', { bubbles: true }));
                emailInput.dispatchEvent(new Event('change', { bubbles: true }));
                console.log('已填充邮箱地址');

                // 步骤4：填充密码
                console.log('步骤4: 填充密码...');
                let passwordInput = document.querySelector('input[type="password"]');

                if (!passwordInput) {
                    passwordInput = document.querySelector('input[placeholder*="密碼"]') ||
                                   document.querySelector('input[placeholder*="password"]') ||
                                   document.querySelector('input[placeholder*="密码"]');
                }

                if (!passwordInput) {
                    return JSON.stringify({ success: false, error: '未找到密码输入框' });
                }

                // 使用 React 的方式填充值（防止被清空）
                nativeInputValueSetter.call(passwordInput, '${password}');
                passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
                console.log('已填充密码');

                await sleep(500);

                // 步骤5：点击继续按钮（参照油猴脚本的精确选择器）
                console.log('步骤5: 点击继续按钮...');
                let continueButton = document.querySelector('button.lv_new_sign_in_panel_wide-sign-in-button.lv_new_sign_in_panel_wide-primary-button');

                if (!continueButton) {
                    // 备用方案：通过文本查找
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        const text = (btn.textContent || '').trim();
                        if (text === 'Continue' || text === '继续' || text === '登錄' || text === '登录' || text === 'Sign in') {
                            continueButton = btn;
                            break;
                        }
                    }
                }

                if (!continueButton) {
                    return JSON.stringify({ success: false, error: '未找到Continue按钮' });
                }

                continueButton.click();
                console.log('已点击Continue按钮');

                return JSON.stringify({ success: true, message: '登录请求已提交' });

            } catch (error) {
                return JSON.stringify({ success: false, error: error.message });
            }
        })();
    `;

    try {
        const jsonStr = await targetWindow.webContents.executeJavaScript(loginScript);
        const result = JSON.parse(jsonStr);
        log.info('邮箱登录结果:', result);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('login-result', { ...result, email, windowId: partition });
        }

        // 如果登录请求已提交，等待登录完成并设置参数
        if (result.success) {
            log.info('登录请求已提交，等待登录完成...');

            // 等待登录完成（检测积分显示出现）
            let loginCheckCount = 0;
            const maxChecks = 30; // 最多检查30次，每次2秒

            const checkLoginComplete = async () => {
                loginCheckCount++;

                const loginStatus = await targetWindow.webContents.executeJavaScript(`
                    (function() {
                        var items = document.querySelectorAll('.lv-menu-item');
                        for (var i = 0; i < items.length; i++) {
                            var text = items[i].textContent.trim();
                            // 检测积分显示（如 "50Upgrade"）
                            if (/^[0-9]+Upgrade/i.test(text)) {
                                return { isLoggedIn: true, credit: text };
                            }
                        }
                        // 检测是否还有 Sign in 按钮
                        for (var i = 0; i < items.length; i++) {
                            var text = items[i].textContent.trim();
                            if (text === 'Sign in') {
                                return { isLoggedIn: false };
                            }
                        }
                        return { isLoggedIn: false, unknown: true };
                    })();
                `);

                log.info(`登录状态检查(${loginCheckCount}/${maxChecks}):`, loginStatus);

                if (loginStatus.isLoggedIn) {
                    log.info('登录成功！开始设置默认参数...');

                    // 通知主窗口
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('login-status-changed', {
                            isLoggedIn: true,
                            email: email,
                            windowId: partition
                        });
                    }

                    // 设置默认参数
                    await setDefaultGenerateParamsForWindow(targetWindow, partition);
                    return;
                }

                if (loginCheckCount < maxChecks) {
                    await new Promise(r => setTimeout(r, 2000));
                    await checkLoginComplete();
                } else {
                    log.info('登录检查超时，请手动确认登录状态');
                }
            };

            // 开始检查登录状态
            setTimeout(checkLoginComplete, 3000);
        }

        return { ...result, windowId: partition, email };
    } catch (error) {
        log.error('邮箱登录失败:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 为指定窗口设置默认生成参数
 * @param {BrowserWindow} targetWindow - 目标窗口
 * @param {string} windowId - 窗口ID（用于通知前端）
 */
async function setDefaultGenerateParamsForWindow(targetWindow, windowId = null) {
    if (!targetWindow || targetWindow.isDestroyed()) return;

    log.info('设置默认生成参数...');

    // 延迟等待页面完全渲染
    await new Promise(resolve => setTimeout(resolve, 2000));

    const paramsScript = `
        (async function() {
            var results = [];

            async function sleep(ms) {
                return new Promise(function(r) { setTimeout(r, ms); });
            }

            try {
                // ========== 1. 选择 "AI Video" 模式 ==========
                console.log('步骤1: 选择 AI Video 模式...');
                var currentModeLabel = document.querySelector('.lv-select-view-value');
                var currentMode = currentModeLabel ? (currentModeLabel.textContent || '').trim() : '';
                console.log('当前模式:', currentMode);

                if (currentMode !== 'AI Video') {
                    var modeSelect = document.querySelector('.lv-select.lv-select-single.branded-ttZCKU') ||
                                     document.querySelector('.toolbar-select-OO8YBx');
                    if (modeSelect) {
                        modeSelect.click();
                        await sleep(800);
                    }

                    var allOptions = document.querySelectorAll('.lv-select-option');
                    console.log('找到选项数量:', allOptions.length);
                    var found = false;
                    for (var i = 0; i < allOptions.length; i++) {
                        var opt = allOptions[i];
                        var text = (opt.textContent || '').trim();
                        console.log('选项文本:', text);
                        if (text === 'AI Video') {
                            opt.click();
                            await sleep(2000);
                            results.push({ label: '生成模式', success: true, value: 'AI Video' });
                            found = true;
                            break;
                        }
                    }

                    if (!found) {
                        results.push({ label: '生成模式', success: false, error: '未找到 AI Video 选项' });
                    }
                } else {
                    results.push({ label: '生成模式', success: true, value: '已是 AI Video 模式' });
                }

                // ========== 2. 选择 "Omni reference" ==========
                await sleep(1000);
                console.log('步骤2: 选择 Omni reference...');

                var refSelectors = document.querySelectorAll('.lv-select.lv-select-single');
                var refSelect = null;

                for (var i = 0; i < refSelectors.length; i++) {
                    var sel = refSelectors[i];
                    var text = (sel.textContent || '').trim();
                    console.log('参考选择器文本:', text);
                    if (text.indexOf('First and last frames') >= 0 || text.indexOf('Omni reference') >= 0) {
                        refSelect = sel;
                        break;
                    }
                }

                if (refSelect) {
                    var currentRef = (refSelect.textContent || '').trim();
                    console.log('当前参考模式:', currentRef);
                    if (currentRef.indexOf('Omni reference') < 0) {
                        refSelect.click();
                        await sleep(800);

                        var foundRef = false;
                        var refOptions = document.querySelectorAll('.lv-select-option');

                        for (var i = 0; i < refOptions.length; i++) {
                            var opt = refOptions[i];
                            var text = (opt.textContent || '').trim();
                            console.log('参考选项:', text);
                            if (text.indexOf('Omni reference') >= 0) {
                                opt.click();
                                await sleep(800);
                                results.push({ label: '全能参考', success: true, value: 'Omni reference' });
                                foundRef = true;
                                break;
                            }
                        }

                        if (!foundRef) {
                            document.body.click();
                            results.push({ label: '全能参考', success: false, error: '未找到 Omni reference 选项' });
                        }
                    } else {
                        results.push({ label: '全能参考', success: true, value: '已是 Omni reference' });
                    }
                }

                // ========== 3. 选择模型 Seedance 2.0 Fast ==========
                await sleep(800);
                console.log('步骤3: 选择模型...');

                var modelSelectors = document.querySelectorAll('.lv-select.lv-select-single');
                var modelSelect = null;

                for (var i = 0; i < modelSelectors.length; i++) {
                    var sel = modelSelectors[i];
                    var text = (sel.textContent || '').trim();
                    if (text.indexOf('Seedance') >= 0) {
                        modelSelect = sel;
                        break;
                    }
                }

                if (modelSelect) {
                    var currentModel = (modelSelect.textContent || '').trim();
                    if (currentModel.indexOf('Seedance 2.0 Fast') >= 0 && currentModel.indexOf('VIP') < 0) {
                        results.push({ label: '模型', success: true, value: '已是 Seedance 2.0 Fast' });
                    } else {
                        modelSelect.click();
                        await sleep(800);

                        var foundModel = false;
                        var modelOptions = document.querySelectorAll('.lv-select-option');

                        for (var i = 0; i < modelOptions.length; i++) {
                            var opt = modelOptions[i];
                            var text = (opt.textContent || '').trim();
                            if (text.indexOf('Seedance 2.0 Fast') >= 0 && text.indexOf('VIP') < 0) {
                                opt.click();
                                await sleep(800);
                                results.push({ label: '模型', success: true, value: 'Seedance 2.0 Fast' });
                                foundModel = true;
                                break;
                            }
                        }

                        if (!foundModel) {
                            document.body.click();
                            results.push({ label: '模型', success: false, error: '未找到 Seedance 2.0 Fast 选项' });
                        }
                    }
                }

                // ========== 4. 设置比例 9:16 ==========
                await sleep(800);
                console.log('步骤4: 设置比例 9:16...');

                var ratioButton = document.querySelector('.toolbar-button-atztV1');
                if (!ratioButton) {
                    var allButtons = document.querySelectorAll('button');
                    for (var i = 0; i < allButtons.length; i++) {
                        var text = (allButtons[i].textContent || '').trim();
                        if (text === '16:9' || text === '9:16' || text === '1:1') {
                            ratioButton = allButtons[i];
                            break;
                        }
                    }
                }

                if (ratioButton) {
                    var currentRatio = (ratioButton.textContent || '').trim();
                    if (currentRatio !== '9:16') {
                        ratioButton.click();
                        await sleep(800);

                        var found916 = false;
                        var popover = document.querySelector('.lv-popover');
                        if (popover) {
                            var items = popover.querySelectorAll('div, span, button, li');
                            for (var i = 0; i < items.length; i++) {
                                if (items[i].textContent.trim() === '9:16') {
                                    items[i].click();
                                    await sleep(500);
                                    results.push({ label: '比例', success: true, value: '9:16' });
                                    found916 = true;
                                    break;
                                }
                            }
                        }

                        if (!found916) {
                            var allItems = document.querySelectorAll('[class*="option"], [class*="item"], button, div[role="button"]');
                            for (var i = 0; i < allItems.length; i++) {
                                if (allItems[i].textContent.trim() === '9:16') {
                                    allItems[i].click();
                                    await sleep(500);
                                    results.push({ label: '比例', success: true, value: '9:16' });
                                    found916 = true;
                                    break;
                                }
                            }
                        }

                        if (!found916) {
                            document.body.click();
                            results.push({ label: '比例', success: false, error: '未找到 9:16 选项' });
                        }
                    } else {
                        results.push({ label: '比例', success: true, value: '已是 9:16' });
                    }
                }

                // ========== 5. 设置时长 15s ==========
                await sleep(800);
                console.log('步骤5: 设置时长 15s...');

                var durationSelectors = document.querySelectorAll('.lv-select.lv-select-single');
                var durationSelect = null;

                for (var i = 0; i < durationSelectors.length; i++) {
                    var text = (durationSelectors[i].textContent || '').trim();
                    if ((text === '5s' || text === '10s' || text === '15s' || /^[0-9]+s$/.test(text)) &&
                        text.indexOf('Seedance') < 0 && text.indexOf('Omni') < 0) {
                        durationSelect = durationSelectors[i];
                        break;
                    }
                }

                if (durationSelect) {
                    var currentDuration = (durationSelect.textContent || '').trim();
                    if (currentDuration !== '15s') {
                        durationSelect.click();
                        await sleep(800);

                        var durationOptions = document.querySelectorAll('.lv-select-option');
                        for (var i = 0; i < durationOptions.length; i++) {
                            var text = (durationOptions[i].textContent || '').trim();
                            if (text === '15s' || text === '15') {
                                durationOptions[i].click();
                                await sleep(500);
                                results.push({ label: '时长', success: true, value: '15s' });
                                break;
                            }
                        }
                    } else {
                        results.push({ label: '时长', success: true, value: '已是 15s' });
                    }
                }

                console.log('参数设置完成:', results);
                return JSON.stringify({ success: true, results: results });
            } catch (e) {
                console.error('参数设置错误:', e);
                return JSON.stringify({ success: false, results: results, error: e.message });
            }
        })();
    `;

    try {
        const jsonStr = await targetWindow.webContents.executeJavaScript(paramsScript);
        const result = JSON.parse(jsonStr);

        if (result.results) {
            result.results.forEach(function(r) {
                if (r.success) {
                    log.info('[参数] ' + r.label + ': ' + r.value + ' ✓');
                } else {
                    log.info('[参数] ' + r.label + ': ' + r.error + ' ✗');
                }
            });
        }

        // 添加 windowId 到结果中
        result.windowId = windowId;

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('params-set', result);
        }

        return result;
    } catch (error) {
        log.error('设置参数失败:', error);
        return { success: false, error: error.message, windowId: windowId };
    }
}

/**
 * 上传素材到页面
 * 使用 Chrome DevTools Protocol (CDP) 来设置文件
 */
async function uploadMaterials(files, generatedText = null, windowId = null) {
    log.info(`uploadMaterials 调用: windowId=${windowId}, accountWindows.size=${accountWindows.size}`);

    // 打印所有已打开的窗口
    if (accountWindows.size > 0) {
        for (const [partition, win] of accountWindows) {
            log.info(`  - 窗口: ${partition}, isDestroyed=${win ? win.isDestroyed() : 'null'}`);
        }
    }

    // 确定目标窗口 - 使用 getAccountWindow 函数
    let targetWindow = getAccountWindow(windowId);
    log.info(`getAccountWindow 结果: ${targetWindow ? '找到窗口' : '未找到窗口'}`);

    // 如果没找到指定窗口，使用主窗口
    if (!targetWindow) {
        if (jimengWindow && !jimengWindow.isDestroyed()) {
            targetWindow = jimengWindow;
            log.info('使用主窗口 jimengWindow');
        }
    }

    if (!targetWindow || targetWindow.isDestroyed()) {
        return { success: false, error: '请先打开即梦窗口' };
    }

    if (!files || files.length === 0) {
        return { success: false, error: '没有素材文件' };
    }

    log.info(`准备上传 ${files.length} 个素材到窗口: ${windowId || '主窗口'}`);
    if (generatedText) {
        log.info('待填充文案:', generatedText);
    }

    try {
        // 获取所有要上传的文件路径
        const filePaths = files.map(f => f.path);
        log.info('上传文件列表:', filePaths);

        // 方法1: 使用 debug API (Electron 的 webContents.debugger)
        // 这是最可靠的方法来设置文件输入

        // 先获取 input 元素的 backendNodeId
        const inputInfo = await targetWindow.webContents.executeJavaScript(`
            (function() {
                var fileInput = document.querySelector('input.file-input-cYZKvJ') ||
                               document.querySelector('input[type="file"]');
                if (fileInput) {
                    // 触发 focus 以确保元素可交互
                    fileInput.focus();
                    return { found: true };
                }
                return { found: false };
            })();
        `);

        log.info('文件输入框检查:', inputInfo);

        if (!inputInfo.found) {
            return { success: false, error: '未找到文件输入框' };
        }

        // 方法2: 使用 CDP (Chrome DevTools Protocol)
        // 通过 session.protocol 或 webContents.executeJavaScript 配合 File API

        // 尝试使用 Electron 内置的文件上传支持
        // 通过在页面中创建 File 对象并触发 change 事件
        const uploadScript = `
            (function() {
                var filePaths = ${JSON.stringify(filePaths)};
                var fileInput = document.querySelector('input.file-input-cYZKvJ') ||
                               document.querySelector('input[type="file"]');

                if (!fileInput) {
                    return JSON.stringify({ success: false, error: '未找到文件输入框' });
                }

                console.log('尝试设置文件:', filePaths);

                // 由于安全限制，无法直接通过 JS 设置 file input 的值
                // 但在 Electron 中，我们可以通过特定方式实现

                // 返回需要设置的文件路径，让后端通过 CDP 处理
                return JSON.stringify({
                    success: true,
                    message: '需要在后端设置文件',
                    inputFound: true
                });
            })();
        `;

        const scriptResult = await targetWindow.webContents.executeJavaScript(uploadScript);
        log.info('脚本执行结果:', scriptResult);

        // 方法3: 使用 Electron 的 session.protocol 或 webRequest
        // 最可靠的方式是使用 debugger API

        try {
            // 启用 debugger
            const debuggerEnabled = await targetWindow.webContents.debugger.isAttached();
            if (!debuggerEnabled) {
                await targetWindow.webContents.debugger.attach('1.3');
            }

            // 获取 document 节点
            const { root } = await targetWindow.webContents.debugger.sendCommand('DOM.getDocument');

            // 查找 file input 元素
            const { nodeIds } = await targetWindow.webContents.debugger.sendCommand('DOM.querySelectorAll', {
                nodeId: root.nodeId,
                selector: 'input[type="file"]'
            });

            if (nodeIds && nodeIds.length > 0) {
                log.info('找到 input 元素，nodeId:', nodeIds[0]);

                // 设置文件
                await targetWindow.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
                    nodeId: nodeIds[0],
                    files: filePaths
                });

                log.info('CDP 设置文件成功!');

                // 触发 change 事件
                await targetWindow.webContents.executeJavaScript(`
                    (function() {
                        var fileInput = document.querySelector('input.file-input-cYZKvJ') ||
                                       document.querySelector('input[type="file"]');
                        if (fileInput) {
                            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                            console.log('已触发 change 事件');
                        }
                    })();
                `);

                // 如果有文案需要填充，填充到编辑器
                if (generatedText && generatedText.originalText && generatedText.references) {
                    log.info(`准备填充文案，targetWindow=${targetWindow ? '有效' : 'null'}, isDestroyed=${targetWindow ? targetWindow.isDestroyed() : 'N/A'}`);
                    if (!targetWindow || targetWindow.isDestroyed()) {
                        log.error('targetWindow 无效，无法填充文案');
                    } else {
                        await fillPromptToEditor(generatedText.originalText, generatedText.references, targetWindow);
                    }
                }

                return { success: true, count: files.length, files: filePaths };
            } else {
                log.error('未找到 file input 节点');
                return { success: false, error: '未找到 file input 节点' };
            }

        } catch (debuggerError) {
            log.error('CDP 方法失败:', debuggerError.message);

            // 如果 debugger 已经 attached，不要重复 attach
            // 尝试使用简化的方式

            return { success: false, error: '文件上传需要 debugger 支持: ' + debuggerError.message };
        }

    } catch (error) {
        log.error('上传素材失败:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 填充文案到 ProseMirror 编辑器并插入引用
 * @param {string} originalText - 原始文案
 * @param {object} references - 引用信息 { "街道转角": "@Image1", "阿俊": "@Image3(@Audio1声音)" }
 */
async function fillPromptToEditor(originalText, references, targetWindow = null) {
    // 如果没有指定窗口，使用主窗口
    if (!targetWindow) {
        targetWindow = jimengWindow;
    }

    if (!targetWindow || targetWindow.isDestroyed()) {
        return { success: false, error: '即梦窗口不存在' };
    }

    log.info('填充文案到编辑器...');
    log.info('引用信息:', references);

    const fillScript = `
        (async function() {
            const originalText = ${JSON.stringify(originalText)};
            const references = ${JSON.stringify(references)};

            try {
                // 找到 ProseMirror 编辑器
                let textInput = document.querySelector('div[contenteditable="true"].ProseMirror') ||
                               document.querySelector('div[contenteditable="true"]') ||
                               document.querySelector('textarea');

                if (!textInput) {
                    return { success: false, error: '未找到文本输入框' };
                }

                console.log('找到文本输入框，开始填充...');
                textInput.focus();

                // 先填充原始文案
                if (textInput.contentEditable === 'true') {
                    textInput.innerHTML = '';
                    const p = document.createElement('p');
                    const span = document.createElement('span');
                    span.textContent = originalText;
                    p.appendChild(span);
                    textInput.appendChild(p);
                } else {
                    textInput.value = originalText;
                }

                // 触发输入事件
                textInput.dispatchEvent(new Event('input', { bubbles: true }));
                textInput.dispatchEvent(new Event('change', { bubbles: true }));

                console.log('原始文案已填充');

                // 等待一下
                await new Promise(r => setTimeout(r, 500));

                // 依次插入引用
                const refEntries = Object.entries(references);

                for (const [key, ref] of refEntries) {
                    console.log('插入引用:', key, '->', ref);

                    // 解析 key，判断是否是 _image 或 _audio
                    const isImageRef = key.endsWith('_image');
                    const isAudioRef = key.endsWith('_audio');
                    const baseName = isImageRef || isAudioRef ? key.replace(/_(image|audio)$/, '') : key;

                    // 找到文案中该名称的位置
                    const walker = document.createTreeWalker(textInput, NodeFilter.SHOW_TEXT, null, false);
                    let found = false;

                    while (walker.nextNode() && !found) {
                        const node = walker.currentNode;
                        const textContent = node.textContent;
                        const index = textContent.indexOf(baseName);

                        if (index !== -1) {
                            // 找到了，设置光标位置
                            const range = document.createRange();

                            if (isAudioRef) {
                                // 音频引用：放在人物名称后面
                                range.setStart(node, index + baseName.length);
                            } else {
                                // 图片引用：放在人物名称前面
                                range.setStart(node, index);
                            }
                            range.collapse(true);

                            const sel = window.getSelection();
                            sel.removeAllRanges();
                            sel.addRange(range);

                            console.log('光标已定位到:', baseName, isAudioRef ? '(后)' : '(前)');
                            found = true;

                            // 音频引用：先插入左括号，再选择音频，最后插入"声音)"
                            if (isAudioRef) {
                                // 先插入 "("
                                document.execCommand('insertText', false, '(');
                                await new Promise(r => setTimeout(r, 100));

                                // 点击 @ 按钮打开下拉框
                                let btnClicked = false;
                                const allBtns = document.querySelectorAll('button, [role="button"]');
                                for (const btn of allBtns) {
                                    const svgPath = btn.querySelector('svg path[d*="M12.81 2.1"]');
                                    if (svgPath && btn.offsetWidth > 0 && btn.offsetHeight > 0) {
                                        btn.click();
                                        console.log('已点击 @ 按钮（音频）');
                                        btnClicked = true;
                                        break;
                                    }
                                }

                                if (!btnClicked) {
                                    console.log('未找到 @ 按钮');
                                    continue;
                                }

                                // 等待下拉框出现
                                await new Promise(r => setTimeout(r, 500));

                                // 在下拉框中选择对应的音频选项
                                const popup = document.querySelector('.lv-select-popup');
                                if (popup) {
                                    console.log('找到下拉框（音频）');
                                    const options = popup.querySelectorAll('li[role="option"].lv-select-option');
                                    console.log('选项数量:', options.length);

                                    // ref 格式是 (@Audio1声音)，需要提取 Audio1
                                    const refName = ref.replace('(@', '').replace('声音)', '');
                                    console.log('需要匹配（音频）:', refName);

                                    let clicked = false;
                                    for (let i = 0; i < options.length; i++) {
                                        const opt = options[i];
                                        const labelEl = opt.querySelector('.option-label-gcSqds, .ellipsis-text-ozkfCQ');
                                        const text = labelEl ? labelEl.textContent.trim() : opt.textContent.trim();
                                        console.log('选项[' + i + ']文本:', text);

                                        if (text === refName) {
                                            console.log('找到匹配选项[' + i + ']，准备点击:', text);
                                            opt.style.outline = '2px solid red';
                                            await new Promise(r => setTimeout(r, 300));
                                            opt.style.outline = '';
                                            opt.click();
                                            clicked = true;
                                            break;
                                        }
                                    }

                                    if (!clicked) {
                                        console.log('未找到匹配选项:', refName);
                                        document.body.click();
                                    } else {
                                        // 等待下拉框消失
                                        console.log('等待下拉框消失...');
                                        let waitCount = 0;
                                        while (waitCount < 20) {
                                            const popupCheck = document.querySelector('.lv-select-popup');
                                            if (!popupCheck || popupCheck.style.display === 'none' || popupCheck.offsetParent === null) {
                                                console.log('下拉框已消失');
                                                break;
                                            }
                                            await new Promise(r => setTimeout(r, 200));
                                            waitCount++;
                                        }
                                        await new Promise(r => setTimeout(r, 300));

                                        // 插入 "声音)"
                                        document.execCommand('insertText', false, '声音)');
                                        console.log('已插入音频引用');
                                    }
                                } else {
                                    console.log('未找到下拉框');
                                }
                                continue;
                            }

                            // 图片引用需要点击 @ 按钮打开下拉框
                            let btnClicked2 = false;

                            // 查找带有 @ 图标的按钮（SVG path 包含特定 d 属性）
                            const allBtns2 = document.querySelectorAll('button, [role="button"]');
                            for (const btn of allBtns2) {
                                const svgPath = btn.querySelector('svg path[d*="M12.81 2.1"]');
                                if (svgPath && btn.offsetWidth > 0 && btn.offsetHeight > 0) {
                                    btn.click();
                                    console.log('已点击 @ 按钮');
                                    btnClicked2 = true;
                                    break;
                                }
                            }

                            if (!btnClicked2) {
                                console.log('未找到 @ 按钮');
                                continue;
                            }

                            // 等待下拉框出现
                            await new Promise(r => setTimeout(r, 500));

                            // 在下拉框中选择对应的选项
                            const popup = document.querySelector('.lv-select-popup');
                            if (popup) {
                                console.log('找到下拉框');
                                const options = popup.querySelectorAll('li[role="option"].lv-select-option');
                                console.log('选项数量:', options.length);

                                // 需要匹配的名称（去掉@符号）
                                const refName = ref.replace('@', '');
                                console.log('需要匹配:', refName);

                                let clicked = false;
                                for (let i = 0; i < options.length; i++) {
                                    const opt = options[i];
                                    const labelEl = opt.querySelector('.option-label-gcSqds, .ellipsis-text-ozkfCQ');
                                    const text = labelEl ? labelEl.textContent.trim() : opt.textContent.trim();
                                    console.log('选项[' + i + ']文本:', text);

                                    // 匹配引用名（如 Image1, Image2, Image3, Audio1）
                                    if (text === refName) {
                                        console.log('找到匹配选项[' + i + ']，准备点击:', text);
                                        // 先高亮显示确认
                                        opt.style.outline = '2px solid red';
                                        await new Promise(r => setTimeout(r, 300));
                                        opt.style.outline = '';
                                        // 点击选项
                                        opt.click();
                                        clicked = true;
                                        break;
                                    }
                                }

                                if (!clicked) {
                                    console.log('未找到匹配选项:', refName);
                                    // 尝试关闭下拉框
                                    document.body.click();
                                } else {
                                    // 点击成功后，等待下拉框消失
                                    console.log('等待下拉框消失...');
                                    let waitCount = 0;
                                    while (waitCount < 20) {
                                        const popupCheck = document.querySelector('.lv-select-popup');
                                        if (!popupCheck || popupCheck.style.display === 'none' || popupCheck.offsetParent === null) {
                                            console.log('下拉框已消失');
                                            break;
                                        }
                                        await new Promise(r => setTimeout(r, 200));
                                        waitCount++;
                                    }
                                    // 额外等待一下确保稳定
                                    await new Promise(r => setTimeout(r, 300));
                                }
                            } else {
                                console.log('未找到下拉框');
                            }
                        }
                    }

                    if (!found) {
                        console.log('未找到文本:', baseName);
                    }
                }

                return { success: true, message: '文案和引用已填充' };

            } catch (error) {
                console.error('填充失败:', error);
                return { success: false, error: error.message };
            }
        })();
    `;

    try {
        const result = await targetWindow.webContents.executeJavaScript(fillScript);
        log.info('填充文案结果:', result);
        return result;
    } catch (error) {
        log.error('填充文案失败:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 获取主窗口
 */
function getMainWindow() {
    return mainWindow;
}

/**
 * 获取即梦窗口
 */
function getJimengWindow() {
    return jimengWindow;
}

/**
 * 关闭即梦窗口
 */
function closeJimengWindow() {
    if (jimengWindow) {
        jimengWindow.close();
        jimengWindow = null;
    }
}

/**
 * 手动提取当前页面的所有视频链接
 * 用于在生成视频后获取下载地址
 */
async function extractVideos() {
    if (!jimengWindow || jimengWindow.isDestroyed()) {
        return { success: false, error: '请先打开即梦窗口', videos: [] };
    }

    log.info('手动提取视频链接...');

    try {
        const videos = await extractVideoInfoFromPage(jimengWindow.webContents);

        if (videos.length > 0) {
            log.info(`提取到 ${videos.length} 个视频链接`);

            // 同时发送到主窗口（使用去重函数）
            videos.forEach(video => {
                sendVideoToMainWindow(video);
            });

            return { success: true, count: videos.length, videos };
        } else {
            log.info('未找到视频链接');
            return { success: true, count: 0, videos: [], message: '未找到视频链接，请确保视频已生成完成' };
        }
    } catch (error) {
        log.error('提取视频失败:', error);
        return { success: false, error: error.message, videos: [] };
    }
}

/**
 * 获取所有账号窗口（多开支持）
 */
function getAccountWindows() {
    const windows = {};
    accountWindows.forEach((window, partition) => {
        if (!window.isDestroyed()) {
            windows[partition] = window;
        }
    });
    return windows;
}

/**
 * 根据窗口ID获取单个账号窗口
 * @param {string} windowId - 窗口ID或partition
 * @returns {BrowserWindow|null}
 */
function getAccountWindow(windowId) {
    if (!windowId) {
        log.info('getAccountWindow: windowId 为空');
        return null;
    }

    log.info(`getAccountWindow: 查找窗口 ${windowId}, accountWindows.size=${accountWindows.size}`);

    // 直接匹配
    if (accountWindows.has(windowId)) {
        const win = accountWindows.get(windowId);
        if (win && !win.isDestroyed()) {
            log.info(`getAccountWindow: 直接匹配成功 ${windowId}`);
            return win;
        }
    }

    // 模糊匹配（windowId可能是邮箱的一部分）
    for (const [partition, win] of accountWindows) {
        log.info(`  检查: partition=${partition}, windowId=${windowId}`);
        if (partition.includes(windowId) || windowId.includes(partition)) {
            if (win && !win.isDestroyed()) {
                log.info(`getAccountWindow: 模糊匹配成功 ${partition}`);
                return win;
            }
        }
    }

    log.info(`getAccountWindow: 未找到匹配的窗口`);
    return null;
}

/**
 * 获取所有已登录的账号列表
 */
function getLoggedInAccounts() {
    const accounts = [];
    accountWindows.forEach((window, partition) => {
        if (!window.isDestroyed()) {
            // 从 partition 中提取邮箱
            const emailMatch = partition.match(/persist:jimeng_(.+)/);
            if (emailMatch) {
                accounts.push({
                    partition,
                    email: emailMatch[1].replace(/_/g, '.').replace(/_/g, '@'),
                    window
                });
            }
        }
    });
    return accounts;
}

module.exports = {
    createMainWindow,
    createJimengWindow,
    getMainWindow,
    getJimengWindow,
    closeJimengWindow,
    checkLoginStatus,
    showLoginQRCode,
    loginWithEmail,
    autoHandlePopups,
    analyzePageStructure,
    setDefaultGenerateParams,
    setVideoInterceptedCallback,
    setApiResponseCallback,
    uploadMaterials,
    extractVideos,
    // 多开支持
    createJimengWindow,
    getAccountWindows,
    getAccountWindow
};
