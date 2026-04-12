/**
 * 登录状态管理模块
 */

const fs = require('fs');
const path = require('path');
const { session } = require('electron');
const log = require('./logger');
const config = require('./config');

// 确保目录存在
if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
}
if (!fs.existsSync(config.cookiesDir)) {
    fs.mkdirSync(config.cookiesDir, { recursive: true });
}

// 当前登录状态
let loginState = null;

/**
 * 加载登录状态
 */
function loadLoginState() {
    try {
        if (fs.existsSync(config.loginStateFile)) {
            const content = fs.readFileSync(config.loginStateFile, 'utf-8');
            loginState = JSON.parse(content);
            log.info('加载登录状态:', loginState);
            return loginState;
        }
    } catch (error) {
        log.error('加载登录状态失败:', error);
    }
    loginState = { isLoggedIn: false, username: null, lastLoginTime: null };
    return loginState;
}

/**
 * 保存登录状态
 */
function saveLoginState(state) {
    try {
        loginState = {
            isLoggedIn: state.isLoggedIn,
            username: state.username || null,
            lastLoginTime: state.isLoggedIn ? new Date().toISOString() : null,
            logoutTime: state.isLoggedIn ? null : new Date().toISOString()
        };
        fs.writeFileSync(config.loginStateFile, JSON.stringify(loginState, null, 2));
        log.info('保存登录状态:', loginState);
    } catch (error) {
        log.error('保存登录状态失败:', error);
    }
}

/**
 * 获取当前登录状态
 */
function getLoginState() {
    // 返回可序列化的简单对象
    if (!loginState) {
        return { isLoggedIn: false, username: null, lastLoginTime: null };
    }
    return {
        isLoggedIn: loginState.isLoggedIn === true,
        username: loginState.username || null,
        lastLoginTime: loginState.lastLoginTime || null
    };
}

/**
 * 保存 Cookies
 */
async function saveCookies(window) {
    if (!window) return;

    try {
        const ses = window.webContents.session;
        const cookies = await ses.cookies.get({});

        const cookiesFile = path.join(config.cookiesDir, 'jimeng_cookies.json');
        fs.writeFileSync(cookiesFile, JSON.stringify(cookies, null, 2));
        log.info('保存 Cookies 成功, 共', cookies.length, '条');
    } catch (error) {
        log.error('保存 Cookies 失败:', error);
    }
}

/**
 * 加载 Cookies
 */
async function loadCookies() {
    const cookiesFile = path.join(config.cookiesDir, 'jimeng_cookies.json');

    try {
        if (!fs.existsSync(cookiesFile)) {
            log.info('没有保存的 Cookies');
            return false;
        }

        const content = fs.readFileSync(cookiesFile, 'utf-8');
        const cookies = JSON.parse(content);

        if (!cookies || cookies.length === 0) {
            return false;
        }

        // 创建一个持久化 session
        const ses = session.fromPartition('persist:jimeng');

        for (const cookie of cookies) {
            try {
                await ses.cookies.set({
                    url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path}`,
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path,
                    secure: cookie.secure,
                    httpOnly: cookie.httpOnly,
                    expirationDate: cookie.expirationDate
                });
            } catch (e) {
                // 忽略单个 cookie 设置失败
            }
        }

        log.info('加载 Cookies 成功, 共', cookies.length, '条');
        return true;
    } catch (error) {
        log.error('加载 Cookies 失败:', error);
        return false;
    }
}

/**
 * 清除登录状态
 */
function clearLoginState() {
    saveLoginState({ isLoggedIn: false });

    // 清除 Cookies 文件
    const cookiesFile = path.join(config.cookiesDir, 'jimeng_cookies.json');
    if (fs.existsSync(cookiesFile)) {
        fs.unlinkSync(cookiesFile);
    }

    log.info('已清除登录状态');
}

module.exports = {
    loadLoginState,
    saveLoginState,
    getLoginState,
    saveCookies,
    loadCookies,
    clearLoginState
};
