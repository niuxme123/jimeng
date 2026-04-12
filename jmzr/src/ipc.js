/**
 * IPC 处理模块
 */

const { ipcMain, dialog, session } = require('electron');
const log = require('./logger');
const config = require('./config');
const auth = require('./auth');
const accounts = require('./accounts');
const windows = require('./windows');
const tasks = require('./tasks');
const api = require('./api');

/**
 * 注册所有 IPC 处理器
 */
function registerIpcHandlers() {

    // 加载账号文件
    ipcMain.handle('load-accounts', async () => {
        const result = await accounts.loadAccountsFile(dialog, windows.getMainWindow());

        // 发送账号加载事件到渲染进程
        if (result.count > 0) {
            const mainWindow = windows.getMainWindow();
            if (mainWindow) {
                mainWindow.webContents.send('accounts-loaded', {
                    count: result.count,
                    accounts: result.accounts
                });
            }
        }

        return result;
    });

    // 获取上次选择的文件路径
    ipcMain.handle('get-last-accounts-file', async () => {
        const filePath = accounts.getLastFilePath();
        return { filePath };
    });

    // 自动加载上次的账号文件
    ipcMain.handle('auto-load-last-accounts', async () => {
        const filePath = accounts.getLastFilePath();
        if (filePath) {
            log.info(`自动加载上次的账号文件: ${filePath}`);
            return accounts.loadAccountsFromPath(filePath, windows.getMainWindow());
        }
        return { count: 0 };
    });

    // 获取保存的登录状态
    ipcMain.handle('get-saved-login-state', async () => {
        return auth.getLoginState();
    });

    // 检查登录状态
    ipcMain.handle('check-login-status', async () => {
        return await windows.checkLoginStatus();
    });

    // 显示登录二维码
    ipcMain.handle('show-qr-login', async () => {
        return await windows.showLoginQRCode();
    });

    // 退出登录
    ipcMain.handle('logout', async () => {
        auth.clearLoginState();

        const jimengWindow = windows.getJimengWindow();
        if (jimengWindow) {
            const ses = jimengWindow.webContents.session;
            await ses.clearStorageData({ storages: ['cookies'] });
        }

        const mainWindow = windows.getMainWindow();
        if (mainWindow) {
            mainWindow.webContents.send('login-status-changed', { isLoggedIn: false });
        }

        return { success: true };
    });

    // 提交任务
    ipcMain.handle('submit-task', async (event, taskData) => {
        return await tasks.submitVideoTask(taskData);
    });

    // 获取拦截的视频
    ipcMain.handle('get-videos', async () => {
        return api.getInterceptedVideos();
    });

    // 下载视频
    ipcMain.handle('download-video', async (event, { url, filename }) => {
        return await tasks.downloadVideo(url, filename, config.downloadDir);
    });

    // 打开即梦窗口
    ipcMain.handle('open-jimeng', async () => {
        windows.createJimengWindow();
        return { success: true };
    });

    // 设置默认参数
    ipcMain.handle('set-default-params', async () => {
        return await windows.setDefaultGenerateParams();
    });

    // 分析页面结构
    ipcMain.handle('analyze-page', async () => {
        return await windows.analyzePageStructure();
    });

    // 提取视频链接
    ipcMain.handle('extract-videos', async () => {
        return await windows.extractVideos();
    });

    // 邮箱密码登录
    ipcMain.handle('login-with-email', async (event, { email, password }) => {
        return await windows.loginWithEmail(email, password);
    });

    // 选择素材文件夹
    ipcMain.handle('select-materials-folder', async () => {
        return await accounts.selectMaterialsFolder(dialog, windows.getMainWindow());
    });

    // 自动加载上次的素材文件夹
    ipcMain.handle('auto-load-last-materials', async () => {
        return accounts.loadLastMaterialsFolder();
    });

    // 上传素材到页面
    ipcMain.handle('upload-materials', async (event, { files, generatedText }) => {
        return await windows.uploadMaterials(files, generatedText);
    });

    // 解析文案并匹配素材
    ipcMain.handle('match-prompt-materials', async (event, { text, materials }) => {
        return accounts.matchMaterialsFromPrompt(text, materials);
    });

    log.info('IPC 处理器已注册');
}

module.exports = {
    registerIpcHandlers
};
