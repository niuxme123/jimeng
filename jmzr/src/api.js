/**
 * API 服务器模块
 */

const http = require('http');
const { URL } = require('url');
const log = require('./logger');
const config = require('./config');
const auth = require('./auth');
const windows = require('./windows');
const tasks = require('./tasks');
const accounts = require('./accounts');

let interceptedVideos = [];
let seenVideoUrls = new Set(); // 用于去重

/**
 * 创建 API 服务器
 */
function createApiServer() {
    const server = http.createServer(async (req, res) => {
        const parsedUrl = new URL(req.url, `http://localhost:${config.apiServerPort}`);
        const pathname = parsedUrl.pathname;

        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            if (pathname === '/api/accounts' && req.method === 'GET') {
                res.end(JSON.stringify({ accounts: accounts.getAccounts().map(a => a.username) }));

            } else if (pathname === '/api/login' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    const { index } = JSON.parse(body);
                    // 登录逻辑
                    res.end(JSON.stringify({ success: true, message: '请使用扫码登录' }));
                });

            } else if (pathname === '/api/show-qr' && req.method === 'POST') {
                const result = await windows.showLoginQRCode();
                res.end(JSON.stringify(result));

            } else if (pathname === '/api/submit' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    const taskData = JSON.parse(body);
                    const result = await tasks.submitVideoTask(taskData);
                    res.end(JSON.stringify(result));
                });

            } else if (pathname === '/api/videos' && req.method === 'GET') {
                res.end(JSON.stringify({ videos: interceptedVideos }));

            } else if (pathname === '/api/download' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    const { url, filename } = JSON.parse(body);
                    const result = await tasks.downloadVideo(url, filename, config.downloadDir);
                    res.end(JSON.stringify(result));
                });

            } else if (pathname === '/api/status' && req.method === 'GET') {
                const status = await windows.checkLoginStatus();
                res.end(JSON.stringify(status));

            } else if (pathname === '/api/logout' && req.method === 'POST') {
                auth.clearLoginState();
                res.end(JSON.stringify({ success: true }));

            } else {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error.message }));
        }
    });

    server.listen(config.apiServerPort, () => {
        log.info(`API服务器启动: http://localhost:${config.apiServerPort}`);
    });

    return server;
}

/**
 * 添加拦截的视频（带去重）
 */
function addInterceptedVideo(video) {
    // 去重：检查 URL 是否已存在
    const urlKey = video.url.split('?')[0]; // 使用不带参数的 URL 作为 key
    if (seenVideoUrls.has(urlKey)) {
        return false; // 已存在，不添加
    }
    seenVideoUrls.add(urlKey);
    interceptedVideos.push(video);
    return true;
}

/**
 * 获取拦截的视频列表
 */
function getInterceptedVideos() {
    return interceptedVideos;
}

/**
 * 清空拦截的视频列表
 */
function clearInterceptedVideos() {
    interceptedVideos = [];
    seenVideoUrls.clear();
}

module.exports = {
    createApiServer,
    addInterceptedVideo,
    getInterceptedVideos,
    clearInterceptedVideos
};
