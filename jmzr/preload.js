/**
 * 预加载脚本
 * 在即梦网站上下文中暴露安全的 API
 */

const { contextBridge, ipcRenderer } = require('electron');

// 暴露 API 给渲染进程
contextBridge.exposeInMainWorld('jimengAPI', {
    // 获取当前账号
    getCurrentAccount: () => ipcRenderer.invoke('get-current-account'),

    // 提交任务
    submitTask: (taskData) => ipcRenderer.invoke('submit-task', taskData),

    // 获取拦截的视频
    getVideos: () => ipcRenderer.invoke('get-videos'),

    // 下载视频
    downloadVideo: (url, filename) => ipcRenderer.invoke('download-video', { url, filename }),

    // 通知主进程
    notify: (event, data) => ipcRenderer.send('notify', { event, data }),

    // 监听事件
    on: (channel, callback) => {
        ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
});

// 注入页面脚本
window.addEventListener('DOMContentLoaded', () => {
    console.log('[即梦自动化] 预加载脚本已注入');

    // 可以在这里添加页面级别的拦截逻辑
});
