/**
 * 配置模块
 */

const path = require('path');

module.exports = {
    // 国内版即梦（只支持扫码登录）
    targetUrlCN: 'https://jimeng.jianying.com/ai-tool/home',
    // 国际版 dreamina（支持邮箱登录，保留备用）
    targetUrlIntl: 'https://dreamina.capcut.com/ai-tool/home',
    // 当前使用的版本
    currentVersion: 'intl', // 'cn' 或 'intl'
    apiServerPort: 3690,
    accountsFile: path.join(__dirname, '..', 'accounts.txt'),
    downloadDir: path.join(__dirname, '..', 'downloads'),
    // 登录状态存储文件
    loginStateFile: path.join(__dirname, '..', 'login-state.json'),
    // Cookie 存储目录
    cookiesDir: path.join(__dirname, '..', 'cookies'),
    // 上次选择的账号文件路径
    lastAccountsFile: path.join(__dirname, '..', 'last-accounts-file.txt'),
    // 上次选择的素材文件夹路径
    lastMaterialsFolder: path.join(__dirname, '..', 'last-materials-folder.txt')
};
