/**
 * 账号管理模块
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const config = require('./config');

let accounts = [];

/**
 * 标准化名称：移除标点符号和空格
 */
function normalizeName(name) {
    return name.replace(/[、，。！？,.\s]/g, '').toLowerCase();
}

/**
 * 加载账号文件
 */
async function loadAccountsFile(dialog, mainWindow) {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Text Files', extensions: ['txt'] }],
        defaultPath: config.accountsFile
    });

    if (result.canceled || result.filePaths.length === 0) {
        return { count: 0 };
    }

    const filePath = result.filePaths[0];

    // 保存文件路径
    saveLastFilePath(filePath);

    return loadAccountsFromPath(filePath, mainWindow);
}

/**
 * 保存上次选择的文件路径
 */
function saveLastFilePath(filePath) {
    try {
        fs.writeFileSync(config.lastAccountsFile, filePath, 'utf-8');
        log.info(`已保存文件路径: ${filePath}`);
    } catch (err) {
        log.error(`保存文件路径失败: ${err.message}`);
    }
}

/**
 * 从指定路径加载账号
 */
function loadAccountsFromPath(filePath, mainWindow) {
    const content = fs.readFileSync(filePath, 'utf-8');

    accounts = parseAccounts(content);

    log.info(`加载了 ${accounts.length} 个账号`);

    // 发送账号加载事件到渲染进程
    if (mainWindow && accounts.length > 0) {
        mainWindow.webContents.send('accounts-loaded', {
            count: accounts.length,
            accounts: accounts.map(a => ({ email: a.email, password: a.password }))
        });
    }

    return { count: accounts.length, accounts: accounts.map(a => ({ email: a.email, password: a.password })) };
}

/**
 * 获取上次选择的文件路径
 */
function getLastFilePath() {
    try {
        if (fs.existsSync(config.lastAccountsFile)) {
            const filePath = fs.readFileSync(config.lastAccountsFile, 'utf-8').trim();
            if (filePath && fs.existsSync(filePath)) {
                return filePath;
            }
        }
    } catch (err) {
        log.error(`读取上次文件路径失败: ${err.message}`);
    }
    return null;
}

/**
 * 解析账号文件
 * 格式: 邮箱----用户名----token----cookies----国家----积分----其他----时间
 * 或者简单格式: 邮箱 密码
 */
function parseAccounts(content) {
    const lines = content.split('\n').filter(line => line.trim());
    const accountList = [];

    log.info(`解析文件，共 ${lines.length} 行`);

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();

        // 检测分隔符类型
        const hasDashes = trimmedLine.includes('----');
        const hasChineseDash = trimmedLine.includes('——');

        if (index < 3) {
            log.info(`第${index + 1}行长度: ${trimmedLine.length}, 包含----: ${hasDashes}, 包含——: ${hasChineseDash}`);
            log.info(`第${index + 1}行前50字符: "${trimmedLine.substring(0, 50)}"`);
        }

        if (trimmedLine.startsWith('#')) {
            return; // 跳过注释
        }

        if (hasDashes) {
            const parts = trimmedLine.split('----');
            if (parts[0] && parts[0].trim()) {
                accountList.push({
                    email: parts[0].trim(),
                    password: parts[1]?.trim() || '',  // 第二部分是密码
                    token: parts[2]?.trim() || '',
                    cookies: parts[3]?.trim() || '',
                    country: parts[4]?.trim() || '',
                    credits: parts[5]?.trim() || '',
                    extra: parts[6]?.trim() || '',
                    updateTime: parts[7]?.trim() || ''
                });
            }
        } else if (hasChineseDash) {
            // 中文破折号
            const parts = trimmedLine.split('——');
            if (parts[0] && parts[0].trim()) {
                accountList.push({
                    email: parts[0].trim(),
                    password: parts[1]?.trim() || '',  // 第二部分是密码
                    token: parts[2]?.trim() || '',
                    cookies: parts[3]?.trim() || '',
                    country: parts[4]?.trim() || '',
                    credits: parts[5]?.trim() || '',
                    extra: parts[6]?.trim() || '',
                    updateTime: parts[7]?.trim() || ''
                });
            }
        }
    });

    log.info(`解析完成，共 ${accountList.length} 个有效账号`);

    return accountList;
}

/**
 * 自动加载默认账号文件
 */
function autoLoadAccounts() {
    if (fs.existsSync(config.accountsFile)) {
        const content = fs.readFileSync(config.accountsFile, 'utf-8');
        accounts = parseAccounts(content);
        log.info(`自动加载了 ${accounts.length} 个账号`);
        return accounts.length;
    }
    return 0;
}

/**
 * 获取账号列表
 */
function getAccounts() {
    return accounts;
}

/**
 * 获取指定账号
 */
function getAccount(index) {
    if (index >= 0 && index < accounts.length) {
        return accounts[index];
    }
    return null;
}

/**
 * 选择素材文件夹
 */
async function selectMaterialsFolder(dialog, mainWindow) {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
        return { folder: null, files: [] };
    }

    const folderPath = result.filePaths[0];

    // 保存文件夹路径
    saveLastMaterialsFolder(folderPath);

    // 扫描文件夹中的文件
    const files = scanMaterialsFolder(folderPath);

    log.info(`选择了素材文件夹: ${folderPath}, 共 ${files.length} 个文件`);

    return { folder: folderPath, files: files };
}

/**
 * 保存上次选择的素材文件夹路径
 */
function saveLastMaterialsFolder(folderPath) {
    try {
        fs.writeFileSync(config.lastMaterialsFolder, folderPath, 'utf-8');
        log.info(`已保存素材文件夹路径: ${folderPath}`);
    } catch (err) {
        log.error(`保存素材文件夹路径失败: ${err.message}`);
    }
}

/**
 * 加载上次的素材文件夹
 */
function loadLastMaterialsFolder() {
    try {
        if (fs.existsSync(config.lastMaterialsFolder)) {
            const folderPath = fs.readFileSync(config.lastMaterialsFolder, 'utf-8').trim();
            if (folderPath && fs.existsSync(folderPath)) {
                const files = scanMaterialsFolder(folderPath);
                log.info(`加载上次的素材文件夹: ${folderPath}, 共 ${files.length} 个文件`);
                return { folder: folderPath, files: files };
            }
        }
    } catch (err) {
        log.error(`读取上次素材文件夹失败: ${err.message}`);
    }
    return null;
}

/**
 * 扫描素材文件夹
 * 查找视频、音频、图片文件
 */
function scanMaterialsFolder(folderPath) {
    const supportedExtensions = [
        // 图片
        '.jpg', '.jpeg', '.png', '.webp', '.bmp',
        // 视频
        '.mp4', '.mov',
        // 音频
        '.mp3', '.wav'
    ];

    const files = [];

    try {
        const items = fs.readdirSync(folderPath);

        items.forEach(item => {
            const itemPath = path.join(folderPath, item);
            const stat = fs.statSync(itemPath);

            if (stat.isFile()) {
                const ext = path.extname(item).toLowerCase();
                if (supportedExtensions.includes(ext)) {
                    files.push({
                        name: item,
                        path: itemPath,
                        ext: ext,
                        type: getFileType(ext)
                    });
                }
            }
        });

        // 按文件名排序
        files.sort((a, b) => a.name.localeCompare(b.name));

    } catch (err) {
        log.error(`扫描素材文件夹失败: ${err.message}`);
    }

    return files;
}

/**
 * 根据扩展名获取文件类型
 */
function getFileType(ext) {
    const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
    const videoExts = ['.mp4', '.mov'];
    const audioExts = ['.mp3', '.wav'];

    if (imageExts.includes(ext)) return 'image';
    if (videoExts.includes(ext)) return 'video';
    if (audioExts.includes(ext)) return 'audio';
    return 'unknown';
}

/**
 * 解析文案，提取场景、道具、人物信息
 * 支持多种格式：
 * - 场景为XXX / 场景是XXX / 场景:XXX / 场景：XXX
 * - 道具为XXX / 道具是XXX / 道具:XXX / 道具：XXX
 * - 人物为XXX / 人物是XXX / 人物:XXX / 人物：XXX
 * - 人物支持多值，用顿号、逗号分隔
 * - 人物名称后的数字标识会自动去掉，如：苏念1、林峰2 → ["苏念", "林峰"]
 */
function parsePromptText(promptText) {
    const result = {
        scenes: [],
        props: [],
        characters: [],
        speakingCharacters: [],  // 有台词的人物
        cleanedText: promptText
    };

    log.info('开始解析文案...');

    // 辅助函数：清理提取的文本
    const cleanText = (text) => {
        return text
            .trim()
            .replace(/[）)\（(].*$/g, '')  // 去掉括号及之后的内容
            .trim();
    };

    // 辅助函数：清理人物名称（去掉末尾的数字）
    const cleanCharacterName = (name) => {
        return name
            .trim()
            .replace(/[0-9]+$/, '')  // 去掉末尾的数字
            .trim();
    };

    // 提取场景：支持多种格式
    let sceneMatch = promptText.match(/场景[为是：:]([^）)\（(，。,\n]+)/);
    if (sceneMatch) {
        const scene = cleanText(sceneMatch[1]);
        if (scene) {
            result.scenes.push(scene);
            log.info(`解析到场景: "${scene}"`);
        }
    }

    // 提取道具：支持多种格式
    let propMatch = promptText.match(/道具[为是：:]([^）)\（(，。,\n]+)/);
    if (propMatch) {
        const prop = cleanText(propMatch[1]);
        if (prop) {
            result.props.push(prop);
            log.info(`解析到道具: "${prop}"`);
        }
    }

    // 提取人物：支持多种格式
    // 人物可以有多个，支持顿号、逗号、空格分隔
    // 人物名后的数字标识会被去掉：苏念1、林峰2 → ["苏念", "林峰"]
    let characterMatch = promptText.match(/人物[为是：:]([^）)\（\n]+)/);
    if (characterMatch) {
        let characterText = cleanText(characterMatch[1]);
        if (characterText) {
            log.info(`原始人物文本: "${characterText}"`);

            // 用顿号、逗号、空格分隔
            const characters = characterText.split(/[、，,\s]+/).filter(s => s.trim());

            characters.forEach(char => {
                let trimmed = char.trim();

                // 如果是 "1.苏念" 或 "1、苏念" 格式，去掉前面的序号
                const prefixMatch = trimmed.match(/^[0-9]+[.、．:：]\s*(.+)$/);
                if (prefixMatch) {
                    trimmed = prefixMatch[1].trim();
                }

                // 去掉人物名末尾的数字标识（如 苏念1 → 苏念）
                trimmed = cleanCharacterName(trimmed);

                if (trimmed && !result.characters.includes(trimmed)) {
                    result.characters.push(trimmed);
                    log.info(`解析到人物: "${trimmed}"`);
                }
            });
        }
    }

    // 提取有台词的人物（从对话格式中识别）
    result.speakingCharacters = extractSpeakingCharacters(promptText);
    if (result.speakingCharacters.length > 0) {
        log.info(`有台词的人物: [${result.speakingCharacters.join(', ')}]`);
    }

    return result;
}

/**
 * 从文案中提取有台词的人物
 * 只有实际有对话的人物才被识别为"有台词人物"
 */
function extractSpeakingCharacters(text) {
    const speakers = [];

    // 移除镜头描述 [...], 避免干扰
    const cleanText = text.replace(/\[镜头[^\]]*\]/g, '');

    // 模式1: xx对xx(情绪)说[：:]
    // 例: 婆婆对大儿子(偏心)说：
    const pattern1 = /([^\s\n、，,。！？]+?)对[^\s\n、，,。！？]+?\([^)]+\)说[：:]/g;
    let match;
    while ((match = pattern1.exec(cleanText)) !== null) {
        const speaker = match[1].trim();
        if (speaker && !speakers.includes(speaker)) {
            speakers.push(speaker);
            log.info(`从对话提取说话人(格式1): "${speaker}"`);
        }
    }

    // 模式2: xx对xx说[：:]
    // 例: 晓冉对婆婆说：
    const pattern2 = /([^\s\n、，,。！？]+?)对[^\s\n、，,。！？]+?说[：:]/g;
    while ((match = pattern2.exec(cleanText)) !== null) {
        const speaker = match[1].trim();
        if (speaker && !speakers.includes(speaker)) {
            speakers.push(speaker);
            log.info(`从对话提取说话人(格式2): "${speaker}"`);
        }
    }

    // 模式3: xx(情绪)说[：:]
    // 例: 大儿子(生气)说：
    const pattern3 = /([^\s\n、，,。！？]+?)\([^)]+\)说[：:]/g;
    while ((match = pattern3.exec(cleanText)) !== null) {
        const speaker = match[1].trim();
        if (speaker && !speakers.includes(speaker)) {
            speakers.push(speaker);
            log.info(`从对话提取说话人(格式3): "${speaker}"`);
        }
    }

    // 模式4: xx说[：:] 或 xx说道[：:]
    // 例: 晓冉说： 或 晓冉说道：
    const pattern4 = /([^\s\n、，,。！？]+?)(?:说|说道)[：:]/g;
    while ((match = pattern4.exec(cleanText)) !== null) {
        const speaker = match[1].trim();
        // 排除已被其他模式匹配的（包含"对"的）
        if (speaker && !speakers.includes(speaker) && !speaker.includes('对')) {
            speakers.push(speaker);
            log.info(`从对话提取说话人(格式4): "${speaker}"`);
        }
    }

    return speakers;
}

/**
 * 根据文案匹配素材文件
 */
function matchMaterialsFromPrompt(promptText, materialsFiles) {
    const parsed = parsePromptText(promptText);
    const matchedFiles = [];

    log.info('解析文案结果:', parsed);
    log.info('素材文件数量:', materialsFiles ? materialsFiles.length : 0);

    if (!materialsFiles || materialsFiles.length === 0) {
        log.warn('没有素材文件可供匹配');
        return { parsed, matchedFiles: [] };
    }

    // 打印所有素材文件名
    log.info('素材文件列表:');
    materialsFiles.forEach(f => {
        // 使用不区分大小写的正则来去除扩展名
        const nameWithoutExt = f.name.replace(/\.[^.]+$/i, '');
        log.info(`  - 原始: ${f.name}, 无扩展名: ${nameWithoutExt}, 类型: ${f.type}`);
    });

    // 匹配场景图片
    parsed.scenes.forEach(scene => {
        log.info(`查找场景素材: "${scene}"`);
        const sceneFile = materialsFiles.find(f => {
            const nameWithoutExt = f.name.replace(/\.[^.]+$/i, '');
            const normalizedFileName = normalizeName(nameWithoutExt);
            const normalizedScene = normalizeName(scene);
            return (normalizedFileName === normalizedScene ||
                    normalizedFileName.includes(normalizedScene) ||
                    normalizedScene.includes(normalizedFileName)) && f.type === 'image';
        });
        if (sceneFile) {
            matchedFiles.push({ ...sceneFile, category: 'scene' });
            log.info(`✓ 匹配到场景: ${scene} -> ${sceneFile.name}`);
        } else {
            log.warn(`✗ 未找到场景素材: ${scene}`);
        }
    });

    // 匹配道具图片
    parsed.props.forEach(prop => {
        log.info(`查找道具素材: "${prop}"`);
        const propFile = materialsFiles.find(f => {
            const nameWithoutExt = f.name.replace(/\.[^.]+$/i, '');
            const normalizedFileName = normalizeName(nameWithoutExt);
            const normalizedProp = normalizeName(prop);
            return (normalizedFileName === normalizedProp ||
                    normalizedFileName.includes(normalizedProp) ||
                    normalizedProp.includes(normalizedFileName)) && f.type === 'image';
        });
        if (propFile) {
            matchedFiles.push({ ...propFile, category: 'prop' });
            log.info(`✓ 匹配到道具: ${prop} -> ${propFile.name}`);
        } else {
            log.warn(`✗ 未找到道具素材: ${prop}`);
        }
    });

    // 匹配人物（图片+音频）
    // 重要规则：只有有台词的人物才匹配音频
    // 人物名称可能包含多个关键词，用顿号分隔，如 "阿俊、助理"
    parsed.characters.forEach(character => {
        log.info(`查找人物素材: "${character}"`);

        // 拆分人物名称（支持顿号、逗号等分隔符）
        const charNames = character.split(/[、，,]/).map(s => s.trim()).filter(s => s);
        log.info(`  拆分后的关键词: [${charNames.join(', ')}]`);

        // 为每个关键词查找图片
        charNames.forEach(charName => {
            const charImage = materialsFiles.find(f => {
                const nameWithoutExt = f.name.replace(/\.[^.]+$/i, '');
                const normalizedFileName = normalizeName(nameWithoutExt);
                const normalizedChar = normalizeName(charName);
                return (normalizedFileName === normalizedChar ||
                        normalizedFileName.includes(normalizedChar) ||
                        normalizedChar.includes(normalizedFileName)) && f.type === 'image';
            });

            if (charImage) {
                // 检查是否已经添加过
                if (!matchedFiles.find(f => f.path === charImage.path)) {
                    matchedFiles.push({ ...charImage, category: 'character' });
                    log.info(`✓ 匹配到人物图片: ${charName} -> ${charImage.name}`);
                } else {
                    log.info(`  ${charName} -> ${charImage.name} (已添加)`);
                }
            } else {
                log.warn(`✗ 未找到人物图片: ${charName}.png 或 ${charName}.jpg`);
            }

            // 检查该人物是否有台词
            const isSpeakingCharacter = parsed.speakingCharacters.some(s =>
                normalizeName(s) === normalizeName(charName)
            );

            // 只有有台词的人物才匹配音频
            if (!isSpeakingCharacter) {
                log.info(`  ${charName} 无台词，跳过音频匹配`);
                return;
            }

            // 为有台词的人物查找音频
            const charAudio = materialsFiles.find(f => {
                const nameWithoutExt = f.name.replace(/\.[^.]+$/i, '');
                const normalizedFileName = normalizeName(nameWithoutExt);
                const normalizedChar = normalizeName(charName);
                return (normalizedFileName === normalizedChar ||
                        normalizedFileName.includes(normalizedChar) ||
                        normalizedChar.includes(normalizedFileName)) && f.type === 'audio';
            });

            if (charAudio) {
                // 检查是否已经添加过
                if (!matchedFiles.find(f => f.path === charAudio.path)) {
                    matchedFiles.push({ ...charAudio, category: 'character_audio' });
                    log.info(`✓ 匹配到人物音频(有台词): ${charName} -> ${charAudio.name}`);
                } else {
                    log.info(`  ${charName} -> ${charAudio.name} (已添加)`);
                }
            } else {
                log.warn(`✗ 未找到人物音频: ${charName}.mp3 或 ${charName}.wav`);
            }
        });
    });

    log.info(`总共匹配到 ${matchedFiles.length} 个素材文件`);

    // 生成带引用的文案
    const generatedText = generatePromptWithReferences(promptText, parsed, matchedFiles);

    return {
        parsed,
        matchedFiles,
        generatedText
    };
}

/**
 * 生成带 @Image1 @Audio1 引用的文案
 * 上传顺序: Image1, Image2, ... Audio1, Audio2, ...
 * 返回: { originalText, references }
 * references 格式: { "街道转角": "@Image1", "阿俊": "@Image3(@Audio1声音)" }
 */
function generatePromptWithReferences(originalText, parsed, matchedFiles) {
    // 按类型分组并编号
    let imageIndex = 0;
    let audioIndex = 0;

    // 为每个匹配的文件分配引用编号
    const fileReferences = {};
    matchedFiles.forEach(file => {
        if (file.type === 'image') {
            imageIndex++;
            fileReferences[file.path] = {
                ref: `@Image${imageIndex}`,
                type: 'image',
                category: file.category,
                name: file.name.replace(/\.[^.]+$/i, '')
            };
        } else if (file.type === 'audio') {
            audioIndex++;
            fileReferences[file.path] = {
                ref: `@Audio${audioIndex}`,
                type: 'audio',
                category: file.category,
                name: file.name.replace(/\.[^.]+$/i, '')
            };
        }
    });

    log.info('文件引用映射:', fileReferences);

    // 构建引用映射表：{ "名称": "@Image1" } 或 { "阿俊": "@Image3(@Audio1声音)" }
    const references = {};

    // 场景引用
    parsed.scenes.forEach(scene => {
        const normalizedScene = normalizeName(scene);
        const sceneFile = matchedFiles.find(f => {
            if (f.category !== 'scene') return false;
            const nameWithoutExt = f.name.replace(/\.[^.]+$/i, '');
            const normalizedFileName = normalizeName(nameWithoutExt);
            return normalizedFileName === normalizedScene ||
                   normalizedFileName.includes(normalizedScene) ||
                   normalizedScene.includes(normalizedFileName);
        });
        if (sceneFile && fileReferences[sceneFile.path]) {
            references[scene] = fileReferences[sceneFile.path].ref;
            log.info(`引用映射: "${scene}" -> "${references[scene]}"`);
        }
    });

    // 道具引用
    parsed.props.forEach(prop => {
        const normalizedProp = normalizeName(prop);
        const propFile = matchedFiles.find(f => {
            if (f.category !== 'prop') return false;
            const nameWithoutExt = f.name.replace(/\.[^.]+$/i, '');
            const normalizedFileName = normalizeName(nameWithoutExt);
            return normalizedFileName === normalizedProp ||
                   normalizedFileName.includes(normalizedProp) ||
                   normalizedProp.includes(normalizedFileName);
        });
        if (propFile && fileReferences[propFile.path]) {
            references[prop] = fileReferences[propFile.path].ref;
            log.info(`引用映射: "${prop}" -> "${references[prop]}"`);
        }
    });

    // 人物引用（图片+音频）
    // 人物名称可能包含多个关键词，用顿号分隔，如 "阿俊、助理"
    parsed.characters.forEach(character => {
        // 拆分人物名称
        const charNames = character.split(/[、，,]/).map(s => s.trim()).filter(s => s);

        charNames.forEach(charName => {
            const normalizedCharName = normalizeName(charName);

            // 查找人物图片
            const charImageFile = matchedFiles.find(f => {
                if (f.category !== 'character') return false;
                const nameWithoutExt = f.name.replace(/\.[^.]+$/i, '');
                const normalizedFileName = normalizeName(nameWithoutExt);
                return normalizedFileName === normalizedCharName ||
                       normalizedFileName.includes(normalizedCharName) ||
                       normalizedCharName.includes(normalizedFileName);
            });

            // 查找人物音频
            const charAudioFile = matchedFiles.find(f => {
                if (f.category !== 'character_audio') return false;
                const nameWithoutExt = f.name.replace(/\.[^.]+$/i, '');
                const normalizedFileName = normalizeName(nameWithoutExt);
                return normalizedFileName === normalizedCharName ||
                       normalizedFileName.includes(normalizedCharName) ||
                       normalizedCharName.includes(normalizedFileName);
            });

            // 人物引用拆分为图片和音频两个部分
            if (charImageFile && fileReferences[charImageFile.path]) {
                const imgRef = fileReferences[charImageFile.path].ref;
                references[charName + '_image'] = imgRef;
                log.info(`引用映射: "${charName}_image" -> "${imgRef}"`);
            }
            if (charAudioFile && fileReferences[charAudioFile.path]) {
                const audioRef = fileReferences[charAudioFile.path].ref;
                // 音频引用格式：(@Audio1声音)，需要在人物名称后面插入
                references[charName + '_audio'] = '(' + audioRef + '声音)';
                log.info(`引用映射: "${charName}_audio" -> "(${audioRef}声音)"`);
            }
        });
    });

    log.info('生成的引用映射:', references);

    return {
        originalText: originalText,
        references: references
    };
}

/**
 * 转义正则特殊字符
 */
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    loadAccountsFile,
    loadAccountsFromPath,
    saveLastFilePath,
    getLastFilePath,
    parseAccounts,
    autoLoadAccounts,
    getAccounts,
    getAccount,
    selectMaterialsFolder,
    saveLastMaterialsFolder,
    loadLastMaterialsFolder,
    parsePromptText,
    matchMaterialsFromPrompt
};
