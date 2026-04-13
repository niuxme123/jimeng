/**
 * Electron 主进程入口
 * 即梦AI自动化工具 - 自动登录、提交任务、拦截视频
 */

// 启用垃圾回收暴露（用于手动触发 GC 释放内存）
// 需要在 app ready 之前设置
if (process.platform === 'win32') {
    // Windows 下设置控制台代码页为 UTF-8
    require('child_process').exec('chcp 65001', () => {});
}

const { app, Menu, globalShortcut } = require('electron');
const log = require('./src/logger');
const config = require('./src/config');
const auth = require('./src/auth');
const accounts = require('./src/accounts');
const windows = require('./src/windows');
const api = require('./src/api');
const ipc = require('./src/ipc');

// 全局变量
let interceptedVideos = [];

/**
 * 初始化应用
 */
async function initApp() {
    log.info('应用初始化...');

    // 加载保存的登录状态
    auth.loadLoginState();

    // 加载保存的 Cookies
    await auth.loadCookies();

    // 创建 API 服务器
    api.createApiServer();

    // 注册 IPC 处理器
    ipc.registerIpcHandlers();

    // 创建主窗口
    windows.createMainWindow(Menu);

    // 注册全局快捷键: Ctrl+Shift+Q 退出应用
    globalShortcut.register('CommandOrControl+Shift+Q', () => {
        log.info('快捷键退出应用');
        app.quit();
    });

    // 设置视频拦截回调
    windows.setVideoInterceptedCallback((video) => {
        interceptedVideos.push(video);
        api.addInterceptedVideo(video);
    });

    // 自动加载账号文件
    const accountCount = accounts.autoLoadAccounts();
    if (accountCount > 0) {
        const mainWindow = windows.getMainWindow();
        if (mainWindow) {
            setTimeout(() => {
                mainWindow.webContents.send('accounts-loaded', {
                    count: accountCount,
                    accounts: accounts.getAccounts().map(a => a.username)
                });
            }, 1000);
        }
    }

    // 通知主窗口保存的登录状态
    const mainWindow = windows.getMainWindow();
    const savedLoginState = auth.getLoginState();

    // 启动时不自动打开即梦窗口，等用户手动点击"打开即梦网站"
    log.info('应用初始化完成');
}

// 应用就绪
app.whenReady().then(initApp);

// 所有窗口关闭时退出
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 应用激活 (macOS)
app.on('activate', () => {
    if (windows.getMainWindow() === null) {
        windows.createMainWindow(Menu);
    }
});

// 应用退出前清理
app.on('will-quit', () => {
    // 注销全局快捷键
    globalShortcut.unregisterAll();
    log.info('应用退出');
});
