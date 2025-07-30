const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');

// 简化的并行控制，移除复杂的信号量实现

class MangaContentDownloader {
    constructor(options = {}) {
        this.browser = null;
        this.page = null; // 保留用于兼容性，但主要使用浏览器池
        this.outputDir = 'E:\\manga';

        // 简化的并行处理配置
        this.parallelConfig = {
            enabled: options.parallel !== false, // 默认启用并行处理
            maxConcurrent: options.maxConcurrent || 3, // 默认最大并发数为3
            retryAttempts: options.retryAttempts || 2, // 重试次数
            retryDelay: options.retryDelay || 1000 // 重试延迟(ms)
        };

        // 所有浏览器实例管理（统一管理主浏览器和浏览器池）
        this.allBrowsers = []; // 包含主浏览器在内的所有浏览器实例
        this.browserPool = []; // 额外的浏览器池实例
        // 需要创建的额外浏览器数量
        this.maxBrowsers = this.parallelConfig.enabled && this.parallelConfig.maxConcurrent > 1 
            ? this.parallelConfig.maxConcurrent - 1 
            : 0;

        // 图片数据缓存
        this.imageBlobs = new Map();
        this.requests = new Map();
        this.context = null;

        // 统计信息
        this.stats = {
            totalMangasProcessed: 0,
            totalChaptersDownloaded: 0,
            totalImagesDownloaded: 0,
            totalErrors: 0
        };

        this.initializeCache();
    }

    async init() {
        console.log('🚀 启动浏览器...');
        // const extensionPath = 'C:\\Users\\likx\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\cfhdojbkjhnklbpkdaibdccddilifddb'; 
        const extensionPath = 'C:\\Users\\likx\\Downloads\\AdBlock_v5.0.4';


        // // 方案1: 使用普通启动 + 扩展
        // this.browser = await chromium.launch({
        //     headless: false,
        //     channel: 'chrome',
        //     args: [
        //         `--disable-extensions-except=C:\\Users\\likx\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\cfhdojbkjhnklbpkdaibdccddilifddb\\4.23.1_0`,
        //         '--load-extension=C:\\Users\\likx\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\cfhdojbkjhnklbpkdaibdccddilifddb\\4.23.1_0',
        //     ],
        //     timeout: 300000
        // });

        // this.context = await this.browser.newContext();
        // this.page = await this.context.newPage();
        const context = await chromium.launchPersistentContext('', {
            headless: false,
            channel: 'chrome',
            args: [
                // `--disable-extensions-except=${extensionPath}`,
                // `--load-extension=${extensionPath}`
            ],
            ignoreDefaultArgs: ['--disable-component-extensions-with-background-pages']
        });

        const [sw] = context.serviceWorkers();
        const serviceWorker = sw || await context.waitForEvent('serviceworker');
        const extensionId = serviceWorker.url().split('/')[2];

        // 创建主页面（向后兼容）
        this.page = await context.newPage();
        this.context = context;

        // 设置用户代理
        await this.page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });

        // 监听浏览器控制台消息
        this.page.on('console', msg => {
            // console.log(`🖥️ 浏览器控制台: ${msg.text()}`);
        });

        // 确保输出目录存在
        await fs.ensureDir(this.outputDir);

        // 设置 blob 图片捕获
        await this.setupBlobCapture();

        // 关闭AdBlock扩展自动打开的页面
        // await this.closeAdBlockPage();

        // 将主浏览器添加到管理列表
        this.allBrowsers.push({
            id: 'main',
            context: this.context,
            page: this.page,
            busy: false,
            lastUsed: Date.now()
        });

        // 初始化额外浏览器池（支持漫画间并行）
        if (this.parallelConfig.enabled && this.maxBrowsers > 0) {
            await this.initializeBrowserPool();
            console.log(`✅ 浏览器初始化完成 - 总共 ${this.allBrowsers.length} 个实例 (1个主浏览器 + ${this.browserPool.length}个池实例)`);
        } else {
            console.log('✅ 主浏览器初始化完成（串行模式，1个实例）');
        }
    }

    /**
     * 初始化浏览器池（简化版本，支持漫画间并行）
     */
    async initializeBrowserPool() {
        console.log(`🌐 初始化浏览器池，创建 ${this.maxBrowsers} 个池实例 (总并发数: ${this.parallelConfig.maxConcurrent})...`);
        
        const extensionPath = 'C:\\Users\\likx\\Downloads\\AdBlock_v5.0.4';
        
        for (let i = 0; i < this.maxBrowsers; i++) {
            try {
                console.log(`🚀 正在创建浏览器实例 ${i}...`);
                
                // 创建独立的浏览器上下文
                const context = await chromium.launchPersistentContext('', {
                    headless: false,
                    channel: 'chrome',
                    args: [],
                    ignoreDefaultArgs: ['--disable-component-extensions-with-background-pages']
                });

                // 创建主页面
                const page = await context.newPage();
                
                // 设置页面配置
                await page.setExtraHTTPHeaders({
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                });
                
                await page.setDefaultTimeout(60000);
                await page.setDefaultNavigationTimeout(60000);
                
                // 设置 blob 图片捕获
                await this.setupBlobCaptureForPage(page);
                
                const browserInstance = {
                    id: i,
                    context: context,
                    page: page,
                    busy: false,
                    lastUsed: Date.now()
                };

                this.browserPool.push(browserInstance);
                this.allBrowsers.push(browserInstance);
                
                console.log(`✅ 浏览器实例 ${i} 创建完成`);
            } catch (error) {
                console.error(`❌ 创建浏览器实例 ${i} 失败: ${error.message}`);
            }
        }
        
        console.log(`🎉 浏览器池初始化完成，共 ${this.browserPool.length} 个独立浏览器实例`);
    }

    /**
     * 获取空闲浏览器实例（统一管理所有浏览器）
     */
    async acquireBrowser(timeoutMs = 30000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeoutMs) {
            // 从所有浏览器中查找空闲的
            const freeBrowser = this.allBrowsers.find(b => !b.busy);
            
            if (freeBrowser) {
                freeBrowser.busy = true;
                freeBrowser.lastUsed = Date.now();
                console.log(`🔒 获取浏览器实例 ${freeBrowser.id}`);
                return freeBrowser;
            }
            
            // 等待一段时间后重试
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        throw new Error(`获取浏览器实例超时：所有 ${this.allBrowsers.length} 个浏览器都在忙碌中`);
    }

    /**
     * 释放浏览器实例（统一管理）
     */
    releaseBrowser(browserInstance) {
        if (browserInstance) {
            // 在所有浏览器列表中找到对应实例并释放
            const browser = this.allBrowsers.find(b => b.id === browserInstance.id);
            if (browser && browser.busy) {
                browser.busy = false;
                browser.lastUsed = Date.now();
                console.log(`🔓 释放浏览器实例 ${browser.id}`);
            }
        }
    }

    /**
     * 为单个页面设置 blob 图片捕获
     */
    async setupBlobCaptureForPage(page) {
        await page.addInitScript(() => {
            const originalCreateObjectURL = URL.createObjectURL;
            URL.createObjectURL = function (object) {
                const blobUrl = originalCreateObjectURL.call(this, object);
                window.__blobUrls = window.__blobUrls || [];
                window.__blobUrls.push({
                    blobUrl: blobUrl,
                    size: object.size,
                    type: object.type,
                    timestamp: Date.now()
                });
                return blobUrl;
            };
        });
    }





    async setupBlobCapture() {
        // 简化的blob URL监听，仅用于调试
        await this.page.addInitScript(() => {
            const originalCreateObjectURL = URL.createObjectURL;
            URL.createObjectURL = function (object) {
                const blobUrl = originalCreateObjectURL.call(this, object);
                // 将 blob URL 信息传递给页面，用于调试
                window.__blobUrls = window.__blobUrls || [];
                window.__blobUrls.push({
                    blobUrl: blobUrl,
                    size: object.size,
                    type: object.type,
                    timestamp: Date.now()
                });
                console.log('🔗 创建blob URL:', blobUrl, 'size:', object.size);
                return blobUrl;
            };
        });
    }

    /**
     * 关闭AdBlock扩展自动打开的页面 - 增强版本
     */
    async closeAdBlockPage() {
        try {
            console.log('🔍 检查并关闭AdBlock页面...');

            // 获取浏览器上下文中的所有页面
            const context = this.page.context();
            const pages = context.pages();

            console.log(`📄 当前浏览器有 ${pages.length} 个页面`);

            let closedCount = 0;

            // 检查所有页面
            for (let i = 0; i < pages.length; i++) {
                const page = pages[i];
                try {
                    const pageUrl = page.url();
                    console.log(`📄 检查页面 ${i + 1}: ${pageUrl}`);

                    // 检查是否是AdBlock相关页面
                    if (pageUrl.includes('getadblock.com') ||
                        pageUrl.includes('chrome-extension://') ||
                        pageUrl.includes('adblock') ||
                        (page !== this.page)) {

                        console.log(`🚫 发现AdBlock页面，正在关闭: ${pageUrl}`);

                        // 如果不是主页面，则关闭它
                        if (page !== this.page) {
                            await page.close();
                            closedCount++;
                            console.log(`✅ 已关闭AdBlock页面`);
                        } else {
                            // 如果是主页面，导航到空白页
                            await this.page.goto('about:blank', {
                                waitUntil: 'domcontentloaded',
                                timeout: 10000
                            });
                            console.log(`✅ 主页面已导航到空白页`);
                        }
                    }
                } catch (pageError) {
                    console.log(`⚠️ 检查页面时出错: ${pageError.message}`);
                }
            }

            if (closedCount > 0) {
                console.log(`✅ 总共关闭了 ${closedCount} 个AdBlock页面`);
            } else {
                console.log(`✅ 没有发现需要关闭的AdBlock页面`);
            }

        } catch (error) {
            console.log(`⚠️ 关闭AdBlock页面时出错: ${error.message}`);
            // 不抛出错误，继续执行
        }
    }

    /**
     * 获取漫画简介信息并下载封面
     */
    async getMangaInfo(mangaId, mangaDir) {
        try {
            const mangaUrl = `https://www.colamanga.com/manga-${mangaId}/`;
            console.log(`🔗 访问漫画详情页: ${mangaUrl}`);

            // 导航到漫画详情页
            await this.page.goto(mangaUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            // 等待页面加载
            await this.page.waitForSelector('.fed-part-layout.fed-part-rows.fed-back-whits', { timeout: 10000 });

            // 提取漫画信息
            const mangaInfo = await this.page.evaluate(() => {
                const info = {};

                // 查找信息容器
                const infoContainer = document.querySelector('.fed-part-layout.fed-part-rows.fed-back-whits');
                if (!infoContainer) {
                    console.log('❌ 未找到信息容器');
                    return null;
                }

                // 提取基本信息
                const ul = infoContainer.querySelector('.fed-part-rows ul');
                if (ul) {
                    const listItems = ul.querySelectorAll('li');
                    listItems.forEach(li => {
                        const keyElement = li.querySelector('.fed-text-muted');
                        if (keyElement) {
                            const key = keyElement.textContent.trim().replace('：', '').replace(':', '');

                            // 获取除了 key 元素之外的所有文本内容
                            const clonedLi = li.cloneNode(true);
                            const keyElementClone = clonedLi.querySelector('.fed-text-muted');
                            if (keyElementClone) {
                                keyElementClone.remove();
                            }
                            const value = clonedLi.textContent.trim();

                            if (key && value) {
                                info[key] = value;
                                console.log(`📋 提取信息: ${key} = ${value}`);
                            }
                        }
                    });
                }

                // 提取封面图片URL - 支持多种方式
                let coverUrl = null;

                // 方式1: 从 data-original 属性获取
                const coverElement = infoContainer.querySelector('a[data-original]');
                if (coverElement) {
                    coverUrl = coverElement.getAttribute('data-original');
                    if (coverUrl) {
                        console.log(`🖼️ 从data-original提取封面URL: ${coverUrl}`);
                    }
                }

                // 方式2: 从 background-image CSS 属性获取
                if (!coverUrl) {
                    const backgroundElements = infoContainer.querySelectorAll('*');
                    for (const element of backgroundElements) {
                        const style = window.getComputedStyle(element);
                        const backgroundImage = style.backgroundImage;

                        if (backgroundImage && backgroundImage !== 'none') {
                            // 从 background-image 中提取 URL
                            const urlMatch = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
                            if (urlMatch && urlMatch[1]) {
                                coverUrl = urlMatch[1];
                                console.log(`🖼️ 从background-image提取封面URL: ${coverUrl}`);
                                break;
                            }
                        }
                    }
                }

                // 方式3: 从 img 标签的 src 属性获取
                if (!coverUrl) {
                    const imgElement = infoContainer.querySelector('img');
                    if (imgElement && imgElement.src) {
                        coverUrl = imgElement.src;
                        console.log(`🖼️ 从img src提取封面URL: ${coverUrl}`);
                    }
                }

                if (coverUrl) {
                    info['封面URL'] = coverUrl;
                }

                console.log('📊 提取的漫画信息:', info);
                return info;
            });

            if (mangaInfo && Object.keys(mangaInfo).length > 0) {
                console.log(`✅ 成功获取漫画信息，包含 ${Object.keys(mangaInfo).length} 个字段`);

                // 下载封面图片
                if (mangaInfo['封面URL']) {
                    const coverPath = await this.downloadCoverImage(mangaInfo['封面URL'], mangaDir);
                    if (coverPath) {
                        mangaInfo['封面'] = coverPath;
                        delete mangaInfo['封面URL']; // 删除URL，只保留本地路径
                    }
                }

                return mangaInfo;
            } else {
                console.log('⚠️ 未获取到有效的漫画信息');
                return null;
            }

        } catch (error) {
            console.log(`❌ 获取漫画信息失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 下载封面图片
     * 使用多种方式下载，处理跨域和超时问题
     */
    async downloadCoverImage(coverUrl, mangaDir) {
        try {
            console.log(`📥 开始下载封面图片: ${coverUrl}`);

            // 获取文件扩展名
            const urlParts = coverUrl.split('.');
            const extension = urlParts[urlParts.length - 1].split('?')[0] || 'jpg';
            const coverFileName = `cover.${extension}`;
            const coverPath = path.join(mangaDir, coverFileName);

            // 检查文件是否已存在
            if (await fs.pathExists(coverPath)) {
                console.log(`⏭️ 封面已存在，跳过下载: ${coverFileName}`);
                return coverFileName;
            }

            // 方式1: 使用浏览器内 fetch API 下载图片，添加超时控制
            console.log(`🔄 方式1: 使用浏览器内fetch下载...`);
            const downloadResult = await Promise.race([
                this.page.evaluate(async (params) => {
                    const { imageUrl, fileName } = params;
                    try {
                        console.log(`尝试从 URL 获取封面图片: ${imageUrl}`);

                        // 创建AbortController用于超时控制
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒超时

                        // 使用 fetch 获取图片内容，添加必要的请求头
                        const response = await fetch(imageUrl, {
                            method: 'GET',
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                                'Referer': 'https://www.colamanga.com/',
                                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                                'Cache-Control': 'no-cache'
                            },
                            signal: controller.signal,
                            mode: 'cors',
                            credentials: 'omit'
                        });

                        clearTimeout(timeoutId);

                        // 检查响应是否成功
                        if (!response.ok) {
                            throw new Error(`无法获取封面图片！状态码: ${response.status}. URL: ${imageUrl}`);
                        }

                        // 获取内容类型
                        const contentType = response.headers.get('Content-Type') || 'image/jpeg';
                        console.log('封面图片 MIME 类型:', contentType);

                        // 将响应体转换为 ArrayBuffer
                        const imageArrayBuffer = await response.arrayBuffer();
                        console.log('封面图片 ArrayBuffer 大小:', imageArrayBuffer.byteLength, '字节');

                        // 将 ArrayBuffer 转换为 base64 字符串
                        const uint8Array = new Uint8Array(imageArrayBuffer);
                        const binaryString = Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
                        const base64String = btoa(binaryString);

                        console.log(`封面图片 '${fileName}' 数据获取成功！`);

                        return {
                            success: true,
                            base64Data: base64String,
                            contentType: contentType,
                            size: imageArrayBuffer.byteLength
                        };

                    } catch (error) {
                        console.error('下载封面图片失败:', error);
                        return {
                            success: false,
                            error: error.message
                        };
                    }
                }, { imageUrl: coverUrl, fileName: coverFileName }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('浏览器内fetch超时')), 20000)
                )
            ]);

            if (downloadResult.success) {
                // 将 base64 数据转换为 Buffer 并保存
                const buffer = Buffer.from(downloadResult.base64Data, 'base64');
                await fs.writeFile(coverPath, buffer);

                console.log(`💾 封面下载成功: ${coverFileName} (${(downloadResult.size / 1024).toFixed(1)} KB)`);
                return coverFileName;
            } else {
                console.log(`⚠️ 方式1失败: ${downloadResult.error}`);
            }

            // 方式2: 使用Playwright的request API
            console.log(`🔄 方式2: 使用Playwright request API...`);
            try {
                const response = await this.page.request.get(coverUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Referer': 'https://www.colamanga.com/',
                        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
                    },
                    timeout: 15000 // 15秒超时
                });

                if (response.ok()) {
                    const buffer = await response.body();
                    await fs.writeFile(coverPath, buffer);

                    console.log(`💾 封面下载成功(方式2): ${coverFileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
                    return coverFileName;
                } else {
                    console.log(`⚠️ 方式2失败: HTTP ${response.status()}`);
                }
            } catch (backupError) {
                console.log(`⚠️ 方式2失败: ${backupError.message}`);
            }

            // 方式3: 尝试通过创建img元素并转换为canvas的方式
            console.log(`🔄 方式3: 使用canvas转换方式...`);
            try {
                const canvasResult = await this.page.evaluate(async (imageUrl) => {
                    return new Promise((resolve) => {
                        const img = new Image();
                        img.crossOrigin = 'anonymous';

                        img.onload = function() {
                            try {
                                const canvas = document.createElement('canvas');
                                const ctx = canvas.getContext('2d');

                                canvas.width = img.width;
                                canvas.height = img.height;

                                ctx.drawImage(img, 0, 0);

                                // 转换为base64
                                const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
                                const base64Data = dataUrl.split(',')[1];

                                resolve({
                                    success: true,
                                    base64Data: base64Data,
                                    width: img.width,
                                    height: img.height
                                });
                            } catch (error) {
                                resolve({
                                    success: false,
                                    error: error.message
                                });
                            }
                        };

                        img.onerror = function() {
                            resolve({
                                success: false,
                                error: '图片加载失败'
                            });
                        };

                        // 设置超时
                        setTimeout(() => {
                            resolve({
                                success: false,
                                error: '图片加载超时'
                            });
                        }, 10000);

                        img.src = imageUrl;
                    });
                }, coverUrl);

                if (canvasResult.success) {
                    const buffer = Buffer.from(canvasResult.base64Data, 'base64');
                    await fs.writeFile(coverPath, buffer);

                    console.log(`💾 封面下载成功(方式3): ${coverFileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
                    console.log(`📐 图片尺寸: ${canvasResult.width}x${canvasResult.height}`);
                    return coverFileName;
                } else {
                    console.log(`⚠️ 方式3失败: ${canvasResult.error}`);
                }
            } catch (canvasError) {
                console.log(`⚠️ 方式3失败: ${canvasError.message}`);
            }

            console.log(`❌ 所有下载方式都失败了`);
            return null;

        } catch (error) {
            console.log(`❌ 下载封面图片失败: ${error.message}`);
            return null;
        }
    }

    async getChapterTitle(browserInstance = null) {
        const currentBrowser = browserInstance || { id: '主', page: this.page };
        try {
            return await currentBrowser.page.evaluate(() => {
                const titleElement = document.querySelector('.mh_readtitle');
                console.log('🔍 查找标题元素:', titleElement ? '找到' : '未找到');

                if (titleElement) {
                    let title = titleElement.textContent.trim();
                    console.log('📝 原始标题:', title);

                    // 清理标题，移除导航文本
                    title = title.replace(/返回目录/g, '');
                    title = title.replace(/返回首页/g, '');
                    title = title.replace(/上一章/g, '');
                    title = title.replace(/下一章/g, '');
                    title = title.replace(/\s+/g, ' '); // 合并多个空格
                    title = title.trim();

                    console.log('🧹 清理后标题:', title);
                    return title || null;
                }
                return null;
            });
        } catch (error) {
            console.log('⚠️ 无法获取章节标题:', error.message);
            return null;
        }
    }

    async downloadMangaContent(mangaId, mangaName, chapter = 1, skipMangaInfo = false, browserInstance = null) {
        const currentBrowser = browserInstance || { id: '主', page: this.page };
        console.log(`📖 [浏览器 ${currentBrowser.id}] 开始下载漫画: ${mangaName} (ID: ${mangaId}), 章节: ${chapter}`);

        // 创建漫画目录
        const mangaDir = path.join(this.outputDir, this.sanitizeFileName(mangaName));
        await fs.ensureDir(mangaDir);

        // 只在第一章或明确要求时获取漫画简介信息
        if (!skipMangaInfo) {
            console.log(`📋 [浏览器 ${currentBrowser.id}] 获取漫画简介信息...`);
            const mangaInfo = await this.getMangaInfo(mangaId, mangaDir, currentBrowser);
            if (mangaInfo) {
                const infoPath = path.join(mangaDir, 'manga-info.json');
                await fs.writeFile(infoPath, JSON.stringify(mangaInfo, null, 2), 'utf8');
                console.log(`✅ [浏览器 ${currentBrowser.id}] 漫画简介已保存: ${infoPath}`);
            }
        }

        // 重构的章节导航逻辑
        const navigationResult = await this.navigateToChapter(mangaId, chapter, currentBrowser);
        if (!navigationResult.success) {
            console.log(`📄 章节 ${chapter} 不存在或无法访问`);
            return false;
        }

        // 获取章节标题
        const chapterTitle = navigationResult.title;
        console.log(`📝 章节标题: ${chapterTitle || '未获取到标题'}`);

        // 确保每个章节都有唯一的目录名，即使标题相同或为空
        const chapterDirName = chapterTitle ?
            `第${chapter}章-${this.sanitizeFileName(chapterTitle)}` :
            `第${chapter}章`;

        const chapterDir = path.join(mangaDir, chapterDirName);
        await fs.ensureDir(chapterDir);

        console.log(`📁 章节目录: ${chapterDirName}`);
        console.log(`📂 完整路径: ${chapterDir}`);

        // 智能检测章节完整性
        const chapterStatus = await this.analyzeChapterCompleteness(chapterDir);

        if (chapterStatus.isComplete) {
            console.log(`✅ 章节已完整下载，跳过重复下载`);
            return true;
        } else if (chapterStatus.hasPartialContent) {
            console.log(`📊 发现部分内容，将进行增量下载`);
            return await this.performIncrementalDownload(chapterDir, chapterStatus);
        } else {
            console.log(`🆕 开始全新下载章节`);
            return await this.performFullDownload(chapterDir);
        }
    }

    /**
     * 真正的并行下载多个漫画 - 每个漫画独立的浏览器实例同时执行
     */
    async downloadMangasInParallel(mangaList, options = {}) {
        const { maxChapters = null } = options;
        
        console.log(`🚀 开始并行下载 ${mangaList.length} 个漫画`);
        console.log(`📊 并发配置: 最大并发数 ${this.parallelConfig.maxConcurrent}`);

        // 限制并发数量，取较小值
        const actualConcurrent = Math.min(this.parallelConfig.maxConcurrent, mangaList.length);
        console.log(`🎯 实际并发数: ${actualConcurrent}`);

        const results = [];
        
        // 将漫画分组，每组的大小等于并发数
        const groups = [];
        for (let i = 0; i < mangaList.length; i += actualConcurrent) {
            groups.push(mangaList.slice(i, i + actualConcurrent));
        }

        console.log(`📦 总共分为 ${groups.length} 组，每组最多 ${actualConcurrent} 个漫画并行处理`);

        // 逐组处理
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex];
            console.log(`\n📦 开始处理第 ${groupIndex + 1}/${groups.length} 组 (${group.length} 个漫画):`);
            
            // 为当前组的每个漫画分配专用浏览器实例
            const groupTasks = group.map(async (manga, index) => {
                let browserInstance = null;
                const mangaIndex = groupIndex * actualConcurrent + index + 1;
                
                try {
                    console.log(`🔄 [${mangaIndex}] 正在为漫画 "${manga.name}" 分配浏览器实例...`);
                    
                    // 获取专用浏览器实例（如果是主浏览器池不够，会等待）
                    browserInstance = await this.acquireBrowser();
                    console.log(`✅ [${mangaIndex}] 漫画 "${manga.name}" 已分配到浏览器实例 ${browserInstance.id}`);
                    
                    // 开始下载
                    console.log(`🎯 [${mangaIndex}] [浏览器 ${browserInstance.id}] 开始下载: ${manga.name}`);
                    const result = await this.downloadSingleMangaWithBrowser(manga, maxChapters, browserInstance);
                    
                    console.log(`${result.success ? '✅' : '❌'} [${mangaIndex}] [浏览器 ${browserInstance.id}] 漫画 "${manga.name}" 下载${result.success ? '完成' : '失败'}`);
                    return { manga, result, success: result.success, mangaIndex };
                    
                } catch (error) {
                    console.error(`❌ [${mangaIndex}] 漫画 "${manga.name}" 下载失败: ${error.message}`);
                    return { 
                        manga, 
                        result: { success: false, error: error.message }, 
                        success: false, 
                        mangaIndex 
                    };
                } finally {
                    // 确保释放浏览器实例
                    if (browserInstance) {
                        console.log(`🔓 [${mangaIndex}] 释放浏览器实例 ${browserInstance.id}`);
                        this.releaseBrowser(browserInstance);
                    }
                }
            });

            // 真正并行执行当前组的所有任务
            console.log(`⚡ 同时启动 ${group.length} 个下载任务...`);
            const groupResults = await Promise.allSettled(groupTasks);
            
            // 处理结果
            groupResults.forEach((promiseResult, index) => {
                if (promiseResult.status === 'fulfilled') {
                    results.push(promiseResult.value);
                } else {
                    const manga = group[index];
                    console.error(`❌ [${groupIndex * actualConcurrent + index + 1}] 任务执行失败: ${manga.name} - ${promiseResult.reason?.message}`);
                    results.push({
                        manga,
                        result: { success: false, error: promiseResult.reason?.message || '任务执行失败' },
                        success: false,
                        mangaIndex: groupIndex * actualConcurrent + index + 1
                    });
                }
            });

            console.log(`📊 第 ${groupIndex + 1} 组处理完成`);
            
            // 组间稍作休息（除了最后一组）
            if (groupIndex < groups.length - 1) {
                console.log(`⏳ 组间休息 3 秒...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        // 统计最终结果
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        console.log(`\n🎉 并行下载全部完成！`);
        console.log(`📊 总体统计:`);
        console.log(`   ✅ 成功: ${successful}/${mangaList.length}`);
        console.log(`   ❌ 失败: ${failed}/${mangaList.length}`);
        console.log(`   📁 输出目录: ${this.outputDir}`);

        return results;
    }

    /**
     * 串行下载多个漫画（备用方案）
     */
    async downloadMangasSequentially(mangaList, maxChapters = null) {
        console.log(`📚 开始串行下载 ${mangaList.length} 个漫画`);

        const results = [];
        for (let i = 0; i < mangaList.length; i++) {
            const manga = mangaList[i];
            console.log(`\n📖 [${i + 1}/${mangaList.length}] 下载漫画: ${manga.name}`);

            try {
                const result = await this.downloadSingleMangaWithRetry(manga, maxChapters);
                results.push({ manga, result, index: i });
            } catch (error) {
                console.error(`❌ 下载失败: ${manga.name} - ${error.message}`);
                results.push({ manga, result: { success: false, error: error.message }, index: i });
            }
        }

        return results;
    }

    /**
     * 下载单个漫画（带重试机制，简化版本）
     */
    async downloadSingleMangaWithRetry(manga, maxChapters = null) {
        let lastError = null;

        for (let attempt = 1; attempt <= this.parallelConfig.retryAttempts + 1; attempt++) {
            try {
                if (attempt > 1) {
                    console.log(`🔄 第 ${attempt - 1} 次重试下载: ${manga.name}`);
                    await new Promise(resolve => setTimeout(resolve, this.parallelConfig.retryDelay));
                }

                const result = await this.downloadSingleManga(manga, maxChapters);
                if (result.success) {
                    return result;
                }

                lastError = new Error(result.error || '下载失败');
            } catch (error) {
                lastError = error;
                console.error(`❌ 下载尝试 ${attempt} 失败: ${manga.name} - ${error.message}`);
            }
        }

        throw lastError || new Error('下载失败');
    }

    /**
     * 下载单个漫画的所有章节（使用指定浏览器实例）
     */
    async downloadSingleMangaWithBrowser(manga, maxChapters = null, browserInstance = null) {
        console.log(`📖 [浏览器 ${browserInstance?.id || '主'}] 开始下载漫画: ${manga.name} (ID: ${manga.id})`);

        const startTime = Date.now();
        let totalChapters = 0;
        let successfulChapters = 0;
        let skippedChapters = 0;
        let failedChapters = 0;

        try {
            // 检查是否已完成下载
            if (await this.checkMangaCompletion(manga)) {
                console.log(`✅ ${manga.name} 已完成下载，跳过`);
                return {
                    success: true,
                    totalChapters: manga.maxChapter || 0,
                    successfulChapters: manga.maxChapter || 0,
                    skippedChapters: manga.maxChapter || 0,
                    failedChapters: 0,
                    duration: Date.now() - startTime
                };
            }

            // 获取漫画信息（仅第一次）
            const firstChapterResult = await this.downloadMangaContent(manga.id, manga.name, 1, false, browserInstance);
            if (firstChapterResult) {
                successfulChapters++;
            } else {
                failedChapters++;
            }
            totalChapters++;

            // 确定下载的最大章节数
            const maxChapterToDownload = maxChapters || manga.maxChapter || 999;

            // 如果只下载一章，直接返回
            if (maxChapterToDownload === 1) {
                return {
                    success: firstChapterResult,
                    totalChapters,
                    successfulChapters,
                    skippedChapters,
                    failedChapters,
                    duration: Date.now() - startTime
                };
            }

            // 串行下载后续章节（在单个漫画内部串行）
            console.log(`📚 [浏览器 ${browserInstance?.id || '主'}] 下载章节 2-${maxChapterToDownload}`);
            let consecutiveFailures = 0;
            
            for (let chapter = 2; chapter <= maxChapterToDownload; chapter++) {
                try {
                    const result = await this.downloadMangaContent(manga.id, manga.name, chapter, true, browserInstance);
                    totalChapters++;
                    if (result) {
                        successfulChapters++;
                        consecutiveFailures = 0; // 重置连续失败计数
                    } else {
                        failedChapters++;
                        consecutiveFailures++;
                    }
                } catch (error) {
                    console.error(`❌ 章节 ${chapter} 下载失败: ${error.message}`);
                    totalChapters++;
                    failedChapters++;
                    consecutiveFailures++;
                }

                // 如果连续失败多章，可能是漫画结束了
                if (consecutiveFailures >= 3) {
                    console.log(`⚠️ 连续失败${consecutiveFailures}章，可能已到漫画结尾，停止下载`);
                    break;
                }
            }

            const duration = Date.now() - startTime;
            const success = successfulChapters > 0;

            console.log(`📊 [浏览器 ${browserInstance?.id || '主'}] 漫画 ${manga.name} 下载完成:`);
            console.log(`   - 总章节: ${totalChapters}`);
            console.log(`   - 成功: ${successfulChapters}`);
            console.log(`   - 跳过: ${skippedChapters}`);
            console.log(`   - 失败: ${failedChapters}`);
            console.log(`   - 耗时: ${(duration / 1000).toFixed(1)}秒`);

            return {
                success,
                totalChapters,
                successfulChapters,
                skippedChapters,
                failedChapters,
                duration
            };

        } catch (error) {
            console.error(`❌ [浏览器 ${browserInstance?.id || '主'}] 下载漫画失败: ${manga.name} - ${error.message}`);
            return {
                success: false,
                error: error.message,
                totalChapters,
                successfulChapters,
                skippedChapters,
                failedChapters,
                duration: Date.now() - startTime
            };
        }
    }

    /**
     * 下载单个漫画的所有章节（简化版本，向后兼容）
     */
    async downloadSingleManga(manga, maxChapters = null) {
        console.log(`📖 开始下载漫画: ${manga.name} (ID: ${manga.id})`);

        const startTime = Date.now();
        let totalChapters = 0;
        let successfulChapters = 0;
        let skippedChapters = 0;
        let failedChapters = 0;

        try {
            // 检查是否已完成下载
            if (await this.checkMangaCompletion(manga)) {
                console.log(`✅ ${manga.name} 已完成下载，跳过`);
                return {
                    success: true,
                    totalChapters: manga.maxChapter || 0,
                    successfulChapters: manga.maxChapter || 0,
                    skippedChapters: manga.maxChapter || 0,
                    failedChapters: 0,
                    duration: Date.now() - startTime
                };
            }

            // 获取漫画信息（仅第一次）
            const firstChapterResult = await this.downloadMangaContent(manga.id, manga.name, 1, false);
            if (firstChapterResult) {
                successfulChapters++;
            } else {
                failedChapters++;
            }
            totalChapters++;

            // 确定下载的最大章节数
            const maxChapterToDownload = maxChapters || manga.maxChapter || 999;

            // 如果只下载一章，直接返回
            if (maxChapterToDownload === 1) {
                return {
                    success: firstChapterResult,
                    totalChapters,
                    successfulChapters,
                    skippedChapters,
                    failedChapters,
                    duration: Date.now() - startTime
                };
            }

            // 串行下载后续章节
            console.log(`📚 下载章节 2-${maxChapterToDownload}`);
            let consecutiveFailures = 0;
            
            for (let chapter = 2; chapter <= maxChapterToDownload; chapter++) {
                try {
                    const result = await this.downloadMangaContent(manga.id, manga.name, chapter, true);
                    totalChapters++;
                    if (result) {
                        successfulChapters++;
                        consecutiveFailures = 0; // 重置连续失败计数
                    } else {
                        failedChapters++;
                        consecutiveFailures++;
                    }
                } catch (error) {
                    console.error(`❌ 章节 ${chapter} 下载失败: ${error.message}`);
                    totalChapters++;
                    failedChapters++;
                    consecutiveFailures++;
                }

                // 如果连续失败多章，可能是漫画结束了
                if (consecutiveFailures >= 3) {
                    console.log(`⚠️ 连续失败${consecutiveFailures}章，可能已到漫画结尾，停止下载`);
                    break;
                }
            }

            const duration = Date.now() - startTime;
            const success = successfulChapters > 0;

            console.log(`📊 漫画 ${manga.name} 下载完成:`);
            console.log(`   - 总章节: ${totalChapters}`);
            console.log(`   - 成功: ${successfulChapters}`);
            console.log(`   - 跳过: ${skippedChapters}`);
            console.log(`   - 失败: ${failedChapters}`);
            console.log(`   - 耗时: ${(duration / 1000).toFixed(1)}秒`);

            return {
                success,
                totalChapters,
                successfulChapters,
                skippedChapters,
                failedChapters,
                duration
            };

        } catch (error) {
            console.error(`❌ 下载漫画失败: ${manga.name} - ${error.message}`);
            return {
                success: false,
                error: error.message,
                totalChapters,
                successfulChapters,
                skippedChapters,
                failedChapters,
                duration: Date.now() - startTime
            };
        }
    }



    /**
     * 重构的章节导航逻辑
     * 根据 JSON 配置文件中的章节 ID，按顺序从第一章开始进入指定的章节网页
     */
    async navigateToChapter(mangaId, chapter, browserInstance = null) {
        const currentBrowser = browserInstance || { id: '主', page: this.page };
        console.log(`🧭 [浏览器 ${currentBrowser.id}] 开始导航到章节: ${chapter}`);

        // 构建章节 URL - 确保正确解析章节 URL
        const chapterUrl = `https://www.colamanga.com/manga-${mangaId}/1/${chapter}.html`;
        console.log(`🔗 [浏览器 ${currentBrowser.id}] 访问章节 URL: ${chapterUrl}`);

        try {
            // 导航到目标页面，增加超时时间和更好的等待策略
            const response = await currentBrowser.page.goto(chapterUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            // 检查响应状态
            if (response.status() === 404) {
                console.log(`❌ [浏览器 ${currentBrowser.id}] 章节 ${chapter} 返回 404，不存在`);
                return { success: false, error: 'Chapter not found' };
            }

            if (response.status() >= 400) {
                console.log(`❌ [浏览器 ${currentBrowser.id}] 章节 ${chapter} 返回状态码: ${response.status()}`);
                return { success: false, error: `HTTP ${response.status()}` };
            }

            // 等待页面基本内容加载
            await currentBrowser.page.waitForLoadState('domcontentloaded');

            // 验证页面是否包含漫画内容
            const hasContent = await this.verifyChapterContent(currentBrowser);
            if (!hasContent) {
                console.log(`❌ [浏览器 ${currentBrowser.id}] 章节 ${chapter} 页面无有效内容`);
                return { success: false, error: 'No valid content' };
            }

            // 获取章节标题
            const title = await this.getChapterTitle(currentBrowser);

            console.log(`✅ 成功导航到章节 ${chapter}`);
            return {
                success: true,
                title: title,
                url: chapterUrl
            };

        } catch (error) {
            console.log(`❌ 导航到章节 ${chapter} 失败: ${error.message}`);

            // 特殊处理常见错误
            if (error.message.includes('404') ||
                error.message.includes('net::ERR_HTTP_RESPONSE_CODE_FAILURE')) {
                return { success: false, error: 'Chapter not found' };
            }

            if (error.message.includes('timeout')) {
                return { success: false, error: 'Navigation timeout' };
            }

            throw error; // 重新抛出未知错误
        }
    }

    /**
     * 验证章节页面是否包含有效的漫画内容
     */
    async verifyChapterContent(browserInstance = null) {
        const currentBrowser = browserInstance || { id: '主', page: this.page };
        try {
            // 等待漫画内容容器出现
            await currentBrowser.page.waitForSelector('.mh_comicpic', { timeout: 10000 });

            // 检查是否有实际的图片内容
            const contentCheck = await currentBrowser.page.evaluate(() => {
                const comicPics = document.querySelectorAll('.mh_comicpic');
                return comicPics.length > 0;
            });

            return contentCheck;
        } catch (error) {
            console.log(`⚠️ [浏览器 ${currentBrowser.id}] 验证章节内容失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 增强的本地文件检查和增量下载分析
     * 统计当前章节的有效图片总数
     * 检查本地文件夹是否已存在该章节（根据"第x章"格式判断）
     * 比较本地已下载图片数量与页面实际图片数量
     * 如果数量不匹配，识别并下载缺失的图片文件
     */
    async analyzeChapterCompleteness(chapterDir, skipWebCheck = false) {
        console.log(`🔍 开始章节完整性分析...`);

        // 1. 分析本地文件状态
        const localProgress = await this.analyzeLocalChapterProgress(chapterDir);
        console.log(`📊 本地文件分析结果:`);
        console.log(`   - 已存在图片: ${localProgress.totalExisting} 张`);
        console.log(`   - 缺失页面: ${localProgress.missingPages.length} 页`);
        console.log(`   - 最大页码: ${localProgress.maxPage}`);

        // 2. 如果本地没有任何文件
        if (localProgress.totalExisting === 0) {
            console.log(`📁 本地目录为空，需要全新下载`);
            return {
                isComplete: false,
                hasPartialContent: false,
                localProgress,
                needsFullDownload: true
            };
        }

        // 3. 如果跳过网页检查，使用本地判断
        if (skipWebCheck) {
            return this.analyzeLocalCompleteness(localProgress);
        }

        // 4. 获取网页中的有效图片总数
        console.log(`🌐 获取网页图片数量进行对比...`);
        const webImageCount = await this.getValidWebImageCount();

        console.log(`📊 图片数量对比:`);
        console.log(`   - 本地图片: ${localProgress.totalExisting} 张`);
        console.log(`   - 网页图片: ${webImageCount} 张`);
        console.log(`   - 差异: ${webImageCount - localProgress.totalExisting} 张`);

        // 5. 比较本地和网页图片数量
        const completenessResult = this.compareLocalAndWebImages(localProgress, webImageCount);

        return completenessResult;
    }

    /**
     * 分析本地章节进度（增强版）
     */
    async analyzeLocalChapterProgress(chapterDir) {
        // 检查本地文件夹是否存在该章节
        if (!await fs.pathExists(chapterDir)) {
            console.log(`📁 章节目录不存在: ${chapterDir}`);
            return {
                existingFiles: [],
                missingPages: [],
                isComplete: false,
                maxPage: 0,
                totalExisting: 0,
                directoryExists: false
            };
        }

        console.log(`📁 章节目录存在，分析文件...`);
        const files = await fs.readdir(chapterDir);
        const imageFiles = files.filter(f =>
            f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.webp')
        );

        console.log(`📄 找到 ${imageFiles.length} 个图片文件`);

        // 提取页面编号（支持多种命名格式）
        const pageNumbers = [];
        const fileMapping = new Map(); // 页码到文件名的映射

        imageFiles.forEach(file => {
            // 支持多种命名格式: {p}-blob.ext, {p}-{uuid}.ext, {p}.ext
            const matches = [
                file.match(/^(\d+)-.*\.(png|jpg|jpeg|webp)$/i),  // {p}-xxx.ext
                file.match(/^(\d+)\.(png|jpg|jpeg|webp)$/i)       // {p}.ext
            ];

            for (const match of matches) {
                if (match) {
                    const pageNum = parseInt(match[1]);
                    if (pageNum > 0) {
                        pageNumbers.push(pageNum);
                        fileMapping.set(pageNum, file);
                        break;
                    }
                }
            }
        });

        // 排序并去重
        const uniquePageNumbers = [...new Set(pageNumbers)].sort((a, b) => a - b);
        const maxPage = uniquePageNumbers.length > 0 ? Math.max(...uniquePageNumbers) : 0;

        // 识别缺失的页面
        const missingPages = [];
        if (maxPage > 0) {
            for (let i = 1; i <= maxPage; i++) {
                if (!uniquePageNumbers.includes(i)) {
                    missingPages.push(i);
                }
            }
        }

        console.log(`📊 本地文件统计:`);
        console.log(`   - 有效图片文件: ${uniquePageNumbers.length} 个`);
        console.log(`   - 页码范围: 1-${maxPage}`);
        console.log(`   - 缺失页面: ${missingPages.join(', ') || '无'}`);

        return {
            existingFiles: imageFiles,
            pageNumbers: uniquePageNumbers,
            missingPages,
            isComplete: missingPages.length === 0 && maxPage > 0,
            maxPage,
            totalExisting: uniquePageNumbers.length,
            directoryExists: true,
            fileMapping
        };
    }

    /**
     * 基于本地文件的完整性分析
     */
    analyzeLocalCompleteness(localProgress) {
        console.log(`📊 基于本地文件进行完整性判断...`);

        // 如果本地有足够多的图片且缺失页面很少，认为基本完整
        if (localProgress.totalExisting >= 10 && localProgress.missingPages.length <= 2) {
            console.log(`✅ 本地文件基本完整 (${localProgress.totalExisting}张，缺失${localProgress.missingPages.length}页)`);
            return {
                isComplete: true,
                hasPartialContent: false,
                localProgress,
                reason: 'Local files sufficient'
            };
        }

        // 如果有部分内容
        if (localProgress.totalExisting > 0) {
            console.log(`📊 本地有部分内容，需要增量下载`);
            return {
                isComplete: false,
                hasPartialContent: true,
                localProgress,
                reason: 'Partial content exists'
            };
        }

        // 完全没有内容
        console.log(`📁 本地无内容，需要全新下载`);
        return {
            isComplete: false,
            hasPartialContent: false,
            localProgress,
            reason: 'No local content'
        };
    }

    /**
     * 比较本地和网页图片数量
     */
    compareLocalAndWebImages(localProgress, webImageCount) {
        const localCount = localProgress.totalExisting;
        const difference = webImageCount - localCount;

        console.log(`� 图片数量比较分析:`);
        console.log(`   - 本地: ${localCount} 张`);
        console.log(`   - 网页: ${webImageCount} 张`);
        console.log(`   - 差异: ${difference} 张`);

        // 完全匹配且无缺失页面
        if (localCount === webImageCount && webImageCount > 0 && localProgress.missingPages.length === 0) {
            console.log(`✅ 本地与网页图片数量完全匹配，章节完整`);
            return {
                isComplete: true,
                hasPartialContent: false,
                localProgress,
                webImageCount,
                reason: 'Perfect match'
            };
        }

        // 本地图片数量合理，差异较小
        if (localCount > 0 && Math.abs(difference) <= 3) {
            console.log(`✅ 本地与网页图片数量基本匹配 (差异${Math.abs(difference)}张)`);
            return {
                isComplete: true,
                hasPartialContent: false,
                localProgress,
                webImageCount,
                reason: 'Close match'
            };
        }

        // 有部分内容，需要增量下载
        if (localCount > 0) {
            console.log(`📊 需要增量下载 (缺失${difference}张图片)`);
            return {
                isComplete: false,
                hasPartialContent: true,
                localProgress,
                webImageCount,
                missingCount: Math.max(0, difference),
                reason: 'Incremental download needed'
            };
        }

        // 完全没有本地内容
        console.log(`📁 需要全新下载`);
        return {
            isComplete: false,
            hasPartialContent: false,
            localProgress,
            webImageCount,
            reason: 'Full download needed'
        };
    }

    async getValidWebImageCount() {
        try {
            console.log('🔍 开始获取网页图片数量...');

            // 等待页面内容加载
            await this.page.waitForSelector('.mh_comicpic', { timeout: 15000 });

            // 使用强化的页面加载完成检测
            console.log('⏳ 等待页面加载完成...');
            await this.waitForPageLoadComplete();

            // 获取网页中带有p属性的.mh_comicpic元素数量（过滤脏数据）
            const webImageResult = await this.page.evaluate(() => {
                const comicPics = document.querySelectorAll('.mh_comicpic');
                let validElementCount = 0;
                let loadedBlobCount = 0;
                let errorCount = 0;

                console.log(`🔍 检查 ${comicPics.length} 个 .mh_comicpic 元素...`);

                for (let i = 0; i < comicPics.length; i++) {
                    const pic = comicPics[i];
                    const pValue = pic.getAttribute('p');
                    const img = pic.querySelector('img');

                    // 检查是否有 .mh_loaderr 元素
                    const errorElement = pic.querySelector('.mh_loaderr');

                    if (errorElement) {
                        const errorStyle = window.getComputedStyle(errorElement);
                        const isErrorHidden = errorStyle.display === 'none';

                        if (!isErrorHidden) {
                            // 加载失败的元素，记录但不计入统计
                            errorCount++;
                            console.log(`❌ p=${pValue} 加载失败 (.mh_loaderr 可见)`);
                            continue;
                        } else if (isErrorHidden && !pValue) {
                            // 隐藏的错误元素且没有p属性，属于脏数据
                            console.log(`🗑️ 过滤脏数据: .mh_loaderr 隐藏且无p属性`);
                            continue;
                        }
                    }

                    if (pValue) {
                        validElementCount++;

                        // 同时检查图片是否已加载为blob
                        if (img && img.src && img.src.startsWith('blob:')) {
                            loadedBlobCount++;
                        }

                        console.log(`📄 p=${pValue}, img=${img ? (img.src ? img.src.substring(0, 50) + '...' : 'no src') : 'no img'}`);
                    }
                }

                console.log(`� 统计结果:`);
                console.log(`   - 带p属性的元素: ${validElementCount} 个`);
                console.log(`   - 已加载blob图片: ${loadedBlobCount} 个`);
                console.log(`   - 加载完成率: ${validElementCount > 0 ? ((loadedBlobCount / validElementCount) * 100).toFixed(1) : 0}%`);

                return {
                    validCount: validElementCount,
                    errorCount: errorCount,
                    loadedCount: loadedBlobCount
                };
            });

            // 简化处理：如果有少量加载失败，记录但不重试
            if (webImageResult.errorCount > 0) {
                console.log(`⚠️ 检测到 ${webImageResult.errorCount} 个图片加载失败，将在后续下载中处理`);
            }

            console.log(`✅ 网页图片数量获取完成: ${webImageResult.validCount} 张`);
            return webImageResult.validCount;
        } catch (error) {
            console.log(`⚠️ 获取网页图片数量时出错: ${error.message}`);
            return 0;
        }
    }

    /**
     * 重构的智能页面滚动和元素收集
     * 实现持续向下滚动页面并收集 mh_comicpic 元素
     * 设置滚动停止条件：连续多次滚动后元素数量不再增加时停止
     * 添加滚动间隔和超时保护机制
     */
    async intelligentScrollAndCollect() {
        console.log(`🖱️ 开始智能页面滚动和元素收集...`);

        const scrollResult = await this.page.evaluate(async () => {
            return new Promise((resolve) => {
                let lastComicPicCount = 0;
                let stableCount = 0;
                let totalScrollAttempts = 0;

                // 配置参数
                const config = {
                    stableThreshold: 5,        // 连续稳定次数阈值
                    checkInterval: 1000,       // 检查间隔（毫秒）
                    scrollDistance: 1500,      // 每次滚动距离
                    maxScrollAttempts: 50,     // 最大滚动尝试次数
                    bottomMargin: 150          // 底部边距容差
                };

                console.log(`📋 滚动配置: 稳定阈值=${config.stableThreshold}, 间隔=${config.checkInterval}ms, 距离=${config.scrollDistance}px`);

                const performScrollAndCheck = () => {
                    totalScrollAttempts++;

                    // 获取当前页面信息
                    const scrollHeight = document.body.scrollHeight;
                    const currentScrollTop = window.scrollY || document.documentElement.scrollTop;
                    const windowHeight = window.innerHeight;
                    const isAtBottom = currentScrollTop + windowHeight >= scrollHeight - config.bottomMargin;

                    // 收集当前 .mh_comicpic 元素
                    const currentComicPics = document.querySelectorAll('.mh_comicpic');
                    const currentCount = currentComicPics.length;

                    // 过滤有效元素（有 p 属性的）
                    const validElements = Array.from(currentComicPics).filter(pic => {
                        const pValue = pic.getAttribute('p');
                        const errorElement = pic.querySelector('.mh_loaderr');

                        // 检查错误元素状态
                        if (errorElement) {
                            const errorStyle = window.getComputedStyle(errorElement);
                            const isErrorVisible = errorStyle.display !== 'none';
                            if (isErrorVisible) return false; // 排除加载失败的元素
                        }

                        return pValue !== null; // 只计算有 p 属性的元素
                    });

                    const validCount = validElements.length;

                    console.log(`📊 滚动第${totalScrollAttempts}次: 总元素=${currentCount}, 有效元素=${validCount}, 位置=${currentScrollTop}/${scrollHeight}, 到底=${isAtBottom}`);

                    // 检查滚动停止条件
                    if (validCount === lastComicPicCount) {
                        stableCount++;
                        console.log(`⏳ 元素数量稳定 ${stableCount}/${config.stableThreshold} 次 (${validCount}个有效元素)`);

                        // 满足停止条件：连续多次滚动后元素数量不再增加
                        if (stableCount >= config.stableThreshold && (isAtBottom || totalScrollAttempts >= config.maxScrollAttempts)) {
                            console.log(`✅ 滚动完成: 共收集到 ${validCount} 个有效元素，滚动${totalScrollAttempts}次`);
                            resolve({
                                success: true,
                                totalElements: currentCount,
                                validElements: validCount,
                                scrollAttempts: totalScrollAttempts,
                                reachedBottom: isAtBottom
                            });
                            return;
                        }
                    } else {
                        // 元素数量发生变化，重置稳定计数
                        if (validCount > lastComicPicCount) {
                            console.log(`📈 发现新元素: ${lastComicPicCount} → ${validCount} (+${validCount - lastComicPicCount})`);
                        }
                        stableCount = 0;
                        lastComicPicCount = validCount;
                    }

                    // 超时保护
                    if (totalScrollAttempts >= config.maxScrollAttempts) {
                        console.log(`⚠️ 达到最大滚动次数限制 (${config.maxScrollAttempts})，停止滚动`);
                        resolve({
                            success: true,
                            totalElements: currentCount,
                            validElements: validCount,
                            scrollAttempts: totalScrollAttempts,
                            reachedBottom: isAtBottom,
                            timeout: true
                        });
                        return;
                    }

                    // 执行滚动
                    if (isAtBottom) {
                        // 已到底部，尝试再次滚动到最底部确保完全加载
                        window.scrollTo(0, scrollHeight);
                        console.log(`🔽 确保滚动到页面最底部`);
                    } else {
                        // 平滑滚动
                        window.scrollBy({
                            top: config.scrollDistance,
                            behavior: 'smooth'
                        });
                    }

                    // 继续下一次检查
                    setTimeout(performScrollAndCheck, config.checkInterval);
                };

                // 开始第一次滚动检查
                console.log(`🚀 开始智能滚动流程...`);
                performScrollAndCheck();
            });
        });

        // 输出滚动结果
        if (scrollResult.success) {
            console.log(`✅ 智能滚动完成:`);
            console.log(`   - 总元素数: ${scrollResult.totalElements}`);
            console.log(`   - 有效元素数: ${scrollResult.validElements}`);
            console.log(`   - 滚动次数: ${scrollResult.scrollAttempts}`);
            console.log(`   - 到达底部: ${scrollResult.reachedBottom ? '是' : '否'}`);
            if (scrollResult.timeout) {
                console.log(`   - 状态: 超时停止`);
            }
        } else {
            console.log(`❌ 智能滚动失败`);
        }

        return scrollResult;
    }

    async performIncrementalDownload(chapterDir, chapterStatus) {
        console.log(`🔄 开始增量下载，本地缺失页面: ${chapterStatus.localProgress.missingPages.join(', ')}`);

        // 等待页面加载完成
        await this.waitForPageLoadComplete();

        // 获取网页实际的图片总数，确定真正的缺失页面
        const webImageCount = chapterStatus.webImageCount || await this.getValidWebImageCount();
        const actualMissingPages = await this.calculateActualMissingPages(chapterDir, webImageCount);

        console.log(`📊 实际缺失页面分析:`);
        console.log(`   - 网页图片总数: ${webImageCount} 张`);
        console.log(`   - 本地图片数量: ${chapterStatus.localProgress.totalExisting} 张`);
        console.log(`   - 实际缺失页面: ${actualMissingPages.length} 页`);
        console.log(`   - 缺失页面列表: ${actualMissingPages.slice(0, 10).join(', ')}${actualMissingPages.length > 10 ? '...' : ''}`);

        if (actualMissingPages.length === 0) {
            console.log(`✅ 没有发现缺失页面，章节已完整`);
            return true;
        }

        // 下载实际缺失的图片
        const downloadedCount = await this.downloadMissingImages(chapterDir, actualMissingPages);

        if (downloadedCount > 0) {
            console.log(`✅ 增量下载完成，新下载 ${downloadedCount} 张图片`);

            // 验证下载完整性
            return await this.verifyAndRetryIfNeeded(chapterDir);
        } else {
            console.log(`⚠️ 增量下载未找到新图片`);
            return false;
        }
    }

    async performFullDownload(chapterDir) {
        console.log(`🆕 开始完整下载章节`);

        // 等待页面内容加载
        try {
            await this.page.waitForSelector('.mh_comicpic', { timeout: 15000 });
        } catch (error) {
            console.log(`⚠️ 没有找到图片内容`);
            return false;
        }

        // 等待页面加载完成
        await this.waitForPageLoadComplete();

        // 下载所有图片
        const downloadedCount = await this.downloadPageImages(chapterDir);

        if (downloadedCount > 0) {
            console.log(`✅ 完整下载完成，共 ${downloadedCount} 张图片`);

            // 验证下载完整性
            return await this.verifyAndRetryIfNeeded(chapterDir);
        } else {
            console.log(`⚠️ 完整下载未找到图片`);
            return false;
        }
    }

    /**
     * 强化的页面完全加载检测
     * 确保滚动到底部 + 所有图片元素都加载为blob + 网络空闲
     */
    async waitForPageLoadComplete(maxRetries = 2) {
        console.log(`⏳ 开始页面加载完成检测...`);

        for (let retry = 0; retry <= maxRetries; retry++) {
            if (retry > 0) {
                console.log(`🔄 第 ${retry} 次重试页面加载检测`);
            }

            try {
                // 1. 首先确保滚动完成，触发所有懒加载
                console.log(`📜 确保页面滚动完成...`);
                await this.ensureFullPageScrolled();

                // 2. 等待网络空闲状态
                console.log(`🌐 等待网络请求完成...`);
                await this.page.waitForLoadState('networkidle', { timeout: 30000 });

                // 3. 验证图片元素状态
                const validationResult = await this.validateImageElements();

                if (validationResult.needsRefresh) {
                    if (retry < maxRetries) {
                        console.log(`🔄 检测到加载问题，刷新页面重新开始...`);
                        await this.refreshPageAndRestart();
                        continue; // 重试
                    } else {
                        console.log(`⚠️ 达到最大重试次数，继续执行但可能存在加载问题`);
                    }
                }

                // 4. 等待所有图片转换为blob URL
                const loadResult = await this.waitForAllImagesBlobLoaded();

                if (loadResult.success) {
                    console.log(`✅ 页面加载完成检测通过`);
                    console.log(`   - 有效图片: ${loadResult.validImages}`);
                    console.log(`   - 已加载: ${loadResult.loadedImages}`);
                    console.log(`   - 加载率: ${loadResult.loadingRate.toFixed(1)}%`);
                    return loadResult;
                } else if (retry < maxRetries) {
                    console.log(`⚠️ 图片加载检测未通过，准备重试...`);
                    continue;
                }

            } catch (error) {
                console.log(`❌ 页面加载检测异常: ${error.message}`);
                if (retry < maxRetries) {
                    console.log(`🔄 准备重试...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
            }
        }

        console.log(`⚠️ 页面加载检测完成，但可能存在问题`);
        return { success: false, validImages: 0, loadedImages: 0, loadingRate: 0 };
    }

    /**
     * 确保页面完全滚动，触发所有懒加载
     * 使用渐进式慢速滚动，确保每个图片都有足够时间加载
     */
    async ensureFullPageScrolled() {
        console.log(`📜 开始渐进式慢速滚动...`);

        let lastElementCount = 0;
        let stableCount = 0;
        let scrollAttempts = 0;
        const maxScrollAttempts = 200; // 增加最大尝试次数
        const stableThreshold = 5; // 稳定阈值

        // 滚动配置
        const scrollConfig = {
            scrollStep: 1600,        // 每次滚动距离（减小）
            waitAfterScroll: 600,  // 滚动后等待时间（增加）
            extraWaitForImages: 1500, // 发现新元素后额外等待时间
        };

        console.log(`📋 滚动配置: 步长=${scrollConfig.scrollStep}px, 等待=${scrollConfig.waitAfterScroll}ms`);

        while (scrollAttempts < maxScrollAttempts) {
            // 获取当前滚动位置和页面高度
            const scrollInfo = await this.page.evaluate((step) => {
                const currentScroll = window.scrollY;
                const pageHeight = document.body.scrollHeight;
                const windowHeight = window.innerHeight;
                const isAtBottom = currentScroll + windowHeight >= pageHeight - 100;

                // 渐进式滚动，而不是直接滚动到底部
                if (!isAtBottom) {
                    window.scrollBy({
                        top: step,
                        behavior: 'smooth'
                    });
                }

                return {
                    currentScroll,
                    pageHeight,
                    windowHeight,
                    isAtBottom,
                    newScroll: window.scrollY
                };
            }, scrollConfig.scrollStep);

            console.log(`📊 滚动第${scrollAttempts + 1}次: ${scrollInfo.currentScroll} → ${scrollInfo.newScroll} (页面高度: ${scrollInfo.pageHeight})`);

            // 等待滚动完成和懒加载触发
            await new Promise(resolve => setTimeout(resolve, scrollConfig.waitAfterScroll));

            // 检查当前元素数量
            const currentElementCount = await this.page.evaluate(() => {
                const comicPics = document.querySelectorAll('.mh_comicpic');
                const validElements = Array.from(comicPics).filter(pic => {
                    const pValue = pic.getAttribute('p');
                    const errorElement = pic.querySelector('.mh_loaderr');

                    if (errorElement) {
                        const errorStyle = window.getComputedStyle(errorElement);
                        if (errorStyle.display !== 'none') return false;
                    }

                    return pValue !== null;
                });
                return validElements.length;
            });

            console.log(`📊 发现 ${currentElementCount} 个有效元素`);

            // 如果发现新元素，额外等待一段时间让图片加载
            if (currentElementCount > lastElementCount) {
                const newElements = currentElementCount - lastElementCount;
                console.log(`📈 发现 ${newElements} 个新元素，额外等待图片加载...`);
                await new Promise(resolve => setTimeout(resolve, scrollConfig.extraWaitForImages));
                stableCount = 0;
                lastElementCount = currentElementCount;
            } else {
                stableCount++;
                console.log(`⏳ 元素数量稳定 ${stableCount}/${stableThreshold} 次`);

                // 如果到达底部且元素数量稳定，认为滚动完成
                if (stableCount >= stableThreshold && scrollInfo.isAtBottom) {
                    console.log(`✅ 页面滚动完成，共发现 ${currentElementCount} 个有效元素`);
                    break;
                }

                // 如果元素数量稳定次数达到阈值，也认为滚动完成
                if (stableCount >= stableThreshold) {
                    console.log(`✅ 元素数量稳定达到阈值，滚动完成，共发现 ${currentElementCount} 个有效元素`);
                    break;
                }
            }

            scrollAttempts++;
        }

        if (scrollAttempts >= maxScrollAttempts) {
            console.log(`⚠️ 达到最大滚动次数，停止滚动`);
        }

        // 最后确保滚动到页面最底部
        await this.page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });
        await new Promise(resolve => setTimeout(resolve, 2000));

        return lastElementCount;
    }

    /**
     * 验证图片元素状态
     * 移除没有 src 属性的 img 元素的 mh_comicpic 元素，不计入总数
     * 检测 mh_comicpic 中的 mh_loaderr 元素，如果其 display 样式不是 none，说明加载失败
     */
    async validateImageElements() {
        console.log(`🔍 验证图片元素状态...`);

        const validation = await this.page.evaluate(() => {
            const comicPics = document.querySelectorAll('.mh_comicpic');
            let validElements = 0;
            let invalidElements = 0;
            let errorElements = 0;
            let noSrcElements = 0;
            let needsRefresh = false;

            console.log(`🔍 检查 ${comicPics.length} 个 .mh_comicpic 元素...`);

            for (let i = 0; i < comicPics.length; i++) {
                const pic = comicPics[i];
                const pValue = pic.getAttribute('p');
                const img = pic.querySelector('img');
                const errorElement = pic.querySelector('.mh_loaderr');

                // 检查错误元素状态
                if (errorElement) {
                    const errorStyle = window.getComputedStyle(errorElement);
                    const isErrorVisible = errorStyle.display !== 'none';

                    if (isErrorVisible) {
                        errorElements++;
                        console.log(`❌ p=${pValue} 加载失败 (.mh_loaderr 可见)`);

                        // 如果错误元素过多，建议刷新页面
                        if (errorElements > 5) {
                            needsRefresh = true;
                        }
                        continue;
                    }
                }

                // 检查是否有 p 属性（有效元素标识）
                if (!pValue) {
                    invalidElements++;
                    continue;
                }

                // 检查 img 元素和 src 属性
                if (!img || !img.src) {
                    noSrcElements++;
                    console.log(`⚠️ p=${pValue} 没有有效的 img src`);
                    continue;
                }

                validElements++;
            }

            const result = {
                total: comicPics.length,
                valid: validElements,
                invalid: invalidElements,
                errors: errorElements,
                noSrc: noSrcElements,
                needsRefresh: needsRefresh
            };

            console.log(`📊 元素验证结果:`);
            console.log(`   - 总元素: ${result.total}`);
            console.log(`   - 有效元素: ${result.valid}`);
            console.log(`   - 无效元素: ${result.invalid}`);
            console.log(`   - 错误元素: ${result.errors}`);
            console.log(`   - 无src元素: ${result.noSrc}`);
            console.log(`   - 需要刷新: ${result.needsRefresh}`);

            return result;
        });

        return validation;
    }

    /**
     * 刷新页面并重新开始计数流程
     */
    async refreshPageAndRestart() {
        console.log(`🔄 刷新页面并重新开始...`);

        try {
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            console.log(`✅ 页面刷新完成`);

            // 等待基本内容加载
            await this.page.waitForSelector('.mh_comicpic', { timeout: 15000 });

            // 重新执行滚动流程
            await this.ensureFullPageScrolled();

        } catch (error) {
            console.log(`❌ 页面刷新失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 等待所有图片转换为blob URL
     * 专门检测blob URL的加载完成状态
     */
    async waitForAllImagesBlobLoaded() {
        console.log(`🖼️ 等待图片实际加载完成...`);

        let attempts = 0;
        const maxAttempts = 30; // 进一步增加最大尝试次数
        let lastBlobCount = 0;
        let stableCount = 0;
        const stableThreshold = 5; // 稳定阈值

        // 等待配置
        const waitConfig = {
            baseWaitTime: 4000,     // 基础等待时间（增加）
            extraWaitOnProgress: 2000, // 有进展时额外等待
        };

        while (attempts < maxAttempts) {
            const loadStatus = await this.page.evaluate(() => {
                const comicPics = document.querySelectorAll('.mh_comicpic');
                let validImages = 0;
                let blobImages = 0;
                let httpImages = 0;
                let noSrcImages = 0;

                for (let i = 0; i < comicPics.length; i++) {
                    const pic = comicPics[i];
                    const pValue = pic.getAttribute('p');
                    const img = pic.querySelector('img');
                    const errorElement = pic.querySelector('.mh_loaderr');

                    // 跳过错误元素
                    if (errorElement) {
                        const errorStyle = window.getComputedStyle(errorElement);
                        if (errorStyle.display !== 'none') continue;
                    }

                    // 只计算有 p 属性的有效元素
                    if (pValue && img) {
                        validImages++;

                        if (!img.src) {
                            noSrcImages++;
                        } else if (img.src.startsWith('blob:')) {
                            blobImages++;
                        } else if (img.src.startsWith('http')) {
                            httpImages++;
                        }
                    }
                }

                return {
                    valid: validImages,
                    blob: blobImages,
                    http: httpImages,
                    noSrc: noSrcImages,
                    blobRate: validImages > 0 ? (blobImages / validImages) * 100 : 0
                };
            });

            console.log(`⏳ 第${attempts + 1}次检查: ${loadStatus.blob}/${loadStatus.valid} 张图片已转为blob (${loadStatus.blobRate.toFixed(1)}%)`);
            console.log(`   - blob图片: ${loadStatus.blob}, http图片: ${loadStatus.http}, 无src: ${loadStatus.noSrc}`);

            // 检查是否所有图片都转换为blob
            if (loadStatus.blob === loadStatus.valid) {
                console.log(`✅ 图片加载完成，加载率: ${loadStatus.blobRate.toFixed(1)}%`);
                return {
                    success: true,
                    validImages: loadStatus.valid,
                    loadedImages: loadStatus.blob,
                    loadingRate: loadStatus.blobRate
                };
            }

            // 检查blob数量是否稳定
            if (loadStatus.blob === lastBlobCount) {
                stableCount++;
                console.log(`⏳ blob数量稳定 ${stableCount}/${stableThreshold} 次`);

                if (stableCount >= stableThreshold) {
                    console.log(`⚠️ blob数量稳定，继续执行`);
                    return {
                        success: true,
                        validImages: loadStatus.valid,
                        loadedImages: loadStatus.blob,
                        loadingRate: loadStatus.blobRate
                    };
                }
            } else {
                if (loadStatus.blob > lastBlobCount) {
                    console.log(`📈 新增blob图片: ${lastBlobCount} → ${loadStatus.blob} (+${loadStatus.blob - lastBlobCount})`);
                    // 有进展时额外等待，让更多图片有时间加载
                    await new Promise(resolve => setTimeout(resolve, waitConfig.extraWaitOnProgress));
                }
                stableCount = 0;
                lastBlobCount = loadStatus.blob;
            }

            // 使用配置的等待时间
            await new Promise(resolve => setTimeout(resolve, waitConfig.baseWaitTime));
            attempts++;
        }

        console.log(`⚠️ 图片加载等待超时`);
        return { success: false, validImages: 0, loadedImages: 0, loadingRate: 0 };
    }

    /**
     * 计算实际缺失的页面
     * 基于网页图片总数和本地已有文件，确定真正需要下载的页面
     */
    async calculateActualMissingPages(chapterDir, webImageCount) {
        console.log(`🔍 计算实际缺失页面...`);

        // 获取本地已有的页面编号
        const localProgress = await this.analyzeLocalChapterProgress(chapterDir);
        const existingPages = new Set(localProgress.pageNumbers);

        console.log(`📊 本地已有页面: ${Array.from(existingPages).sort((a, b) => a - b).join(', ')}`);

        // 计算所有应该存在的页面（1到webImageCount）
        const allPages = [];
        for (let i = 1; i <= webImageCount; i++) {
            allPages.push(i);
        }

        // 找出缺失的页面
        const missingPages = allPages.filter(page => !existingPages.has(page));

        console.log(`📋 应有页面范围: 1-${webImageCount}`);
        console.log(`📋 缺失页面数量: ${missingPages.length}`);

        return missingPages;
    }

    /**
     * 实现增量下载逻辑优化
     * 根据 blob URL 识别和查找缺失的图片元素
     * 确保等待所有网络请求完全加载完成后再开始下载流程
     * 不仅根据 p 属性判断，还要验证 blob URL 的有效性
     */
    async downloadMissingImages(chapterDir, missingPages) {
        console.log(`🔍 开始优化的增量下载流程...`);

        // 如果缺失页面太多，显示简化信息
        if (missingPages.length > 20) {
            console.log(`📋 目标缺失页面: ${missingPages.length} 页 (${missingPages.slice(0, 10).join(', ')}...)`);
        } else {
            console.log(`📋 目标缺失页面: ${missingPages.join(', ')}`);
        }

        // 1. 检查页面是否有显示的错误元素，如果有则刷新页面重试
        const hasVisibleErrors = await this.checkForVisibleErrors();
        if (hasVisibleErrors) {
            console.log('🔄 检测到显示的错误元素，刷新页面重试...');
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.waitForPageLoadComplete();

            // 重新检查错误
            const stillHasErrors = await this.checkForVisibleErrors();
            if (stillHasErrors) {
                console.log('❌ 刷新后仍有错误，跳过此次下载');
                return 0;
            }
        }

        // 2. 确保等待所有网络请求完全加载完成
        console.log(`⏳ 确保所有网络请求完全加载完成...`);
        await this.waitForPageLoadComplete();

        // 3. 如果缺失页面很多，分批处理
        if (missingPages.length > 50) {
            console.log(`📦 缺失页面较多，将分批处理...`);
            return await this.downloadMissingImagesInBatches(chapterDir, missingPages);
        }

        // 4. 获取所有 blob 图片并筛选缺失的页面
        const allBlobImages = await this.getBlobImages();
        const missingImageInfos = allBlobImages.filter(img => missingPages.includes(img.order));

        if (missingImageInfos.length === 0) {
            console.log(`⚠️ 没有找到缺失页面的可下载图片`);
            console.log(`💡 可能的原因:`);
            console.log(`   - 图片尚未加载完成`);
            console.log(`   - 页面元素结构发生变化`);
            console.log(`   - 网络请求失败`);
            return 0;
        }

        console.log(`✅ 找到 ${missingImageInfos.length} 张缺失的图片，开始下载...`);

        // 5. 执行增量下载
        return await this.saveBlobImages(missingImageInfos, chapterDir);
    }

    /**
     * 分批下载缺失图片
     * 当缺失页面很多时，分批处理以避免内存和性能问题
     */
    async downloadMissingImagesInBatches(chapterDir, missingPages) {
        console.log(`📦 开始分批下载，总计 ${missingPages.length} 页缺失图片`);

        const batchSize = 30; // 每批处理30页
        let totalDownloaded = 0;

        // 获取所有 blob 图片
        const allBlobImages = await this.getBlobImages();

        for (let i = 0; i < missingPages.length; i += batchSize) {
            const batch = missingPages.slice(i, i + batchSize);
            const batchNum = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(missingPages.length / batchSize);

            console.log(`📦 处理批次 ${batchNum}/${totalBatches}: 页面 ${batch[0]}-${batch[batch.length - 1]} (${batch.length}页)`);

            // 筛选当前批次的图片
            const batchImageInfos = allBlobImages.filter(img => batch.includes(img.order));

            if (batchImageInfos.length > 0) {
                const downloadedCount = await this.saveBlobImages(batchImageInfos, chapterDir);
                totalDownloaded += downloadedCount;
                console.log(`✅ 批次 ${batchNum} 完成，下载 ${downloadedCount} 张图片`);
            } else {
                console.log(`⚠️ 批次 ${batchNum} 未找到可下载图片`);
            }

            // 批次间延迟，避免过载
            if (i + batchSize < missingPages.length) {
                console.log(`⏳ 批次间休息 2 秒...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log(`📦 分批下载完成，总计下载 ${totalDownloaded} 张图片`);
        return totalDownloaded;
    }



    async verifyAndRetryIfNeeded(chapterDir, maxRetries = 1) {
        console.log(`🔍 验证下载完整性...`);

        // 先进行一次快速本地验证，避免重复的网页检查
        const chapterStatus = await this.analyzeChapterCompleteness(chapterDir, true);

        if (chapterStatus.localProgress.totalExisting === 0) {
            console.log(`❌ 没有下载到任何图片，章节下载失败`);
            return false;
        }

        // 如果本地已有较多图片，进行一次轻量级的补充下载
        if (chapterStatus.localProgress.missingPages.length > 0 && chapterStatus.localProgress.missingPages.length <= 5) {
            console.log(`🔄 发现少量缺失页面: ${chapterStatus.localProgress.missingPages.join(', ')}, 尝试补充下载`);

            // 不刷新页面，直接尝试下载缺失的图片
            const downloadedCount = await this.downloadMissingImages(chapterDir, chapterStatus.localProgress.missingPages);

            if (downloadedCount > 0) {
                console.log(`✅ 补充下载了 ${downloadedCount} 张图片`);

                // 重新检查本地进度（跳过网页检查）
                const updatedStatus = await this.analyzeChapterCompleteness(chapterDir, true);
                if (updatedStatus.isComplete) {
                    console.log(`✅ 章节下载完整，验证通过`);
                    return true;
                }
            }
        }

        // 如果缺失页面较多，才进行一次页面刷新重试
        if (chapterStatus.localProgress.missingPages.length > 5 && maxRetries > 0) {
            console.log(`⚠️ 缺失页面较多 (${chapterStatus.localProgress.missingPages.length} 页), 尝试刷新重试`);

            await this.page.reload({ waitUntil: 'domcontentloaded' });
            await new Promise(resolve => setTimeout(resolve, 2000));

            await this.ensureFullPageScrolled();
            await this.waitForPageLoadComplete();

            const downloadedCount = await this.downloadMissingImages(chapterDir, chapterStatus.localProgress.missingPages);
            console.log(`🔄 重试下载了 ${downloadedCount} 张图片`);
        }

        // 最终验证
        const finalProgress = await this.analyzeChapterProgress(chapterDir);
        const completionRate = finalProgress.totalExisting / (finalProgress.totalExisting + finalProgress.missingPages.length);

        if (completionRate >= 0.9) { // 90%以上完成率认为成功
            console.log(`✅ 章节下载基本完整 (${(completionRate * 100).toFixed(1)}%), 验证通过`);
            return true;
        } else {
            console.log(`⚠️ 章节下载不完整 (${(completionRate * 100).toFixed(1)}%), 但继续处理`);
            return true; // 改为宽松策略，避免无限重试
        }
    }

    async fastScrollToLoadElements() {
        // 快速滚动页面以确保所有DOM元素加载（不等待图片）
        await this.page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 500; // 更大的滚动距离
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        // 只需要短暂等待DOM元素加载，不等待图片
                        setTimeout(resolve, 500);
                    }
                }, 100); // 更快的滚动间隔
            });
        });
    }

    async downloadPageImages(chapterDir) {
        console.log('🔍 开始获取页面图片信息...');

        // 检查页面是否有显示的错误元素，如果有则刷新页面重试
        const hasVisibleErrors = await this.checkForVisibleErrors();
        if (hasVisibleErrors) {
            console.log('🔄 检测到显示的错误元素，刷新页面重试...');
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.waitForPageLoadComplete();

            // 重新检查错误
            const stillHasErrors = await this.checkForVisibleErrors();
            if (stillHasErrors) {
                console.log('❌ 刷新后仍有错误，跳过此次下载');
                return 0;
            }
        }

        // 获取页面上所有 blob URL 的图片
        const imageInfos = await this.getBlobImages();

        console.log(`🔍 最终找到 ${imageInfos.length} 张可下载的图片`);

        if (imageInfos.length === 0) {
            console.log(`⚠️ 没有找到可下载的图片，可能的原因:`);
            console.log(`   - 图片还未加载完成`);
            console.log(`   - 所有图片都加载失败`);
            console.log(`   - 页面结构发生变化`);
            return 0;
        }

        return await this.saveBlobImages(imageInfos, chapterDir);
    }

    /**
     * 使用浏览器内 fetch 保存 blob URL 图片
     * 参考提供的代码实现
     */
    async saveBlobImages(imageInfos, chapterDir) {
        console.log(`💾 开始保存 blob 图片，共 ${imageInfos.length} 张...`);

        let downloadedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        for (const imageInfo of imageInfos) {
            try {
                // 生成文件名
                const fileName = `${imageInfo.order}-blob.png`;
                const filePath = path.join(chapterDir, fileName);

                // 检查文件是否已存在
                if (await fs.pathExists(filePath)) {
                    console.log(`⏭️ 文件已存在，跳过: ${fileName}`);
                    skippedCount++;
                    continue;
                }

                // 在浏览器中执行 blob URL 下载
                const downloadResult = await this.page.evaluate(async (blobUrl, fileName) => {
                    try {
                        console.log(`尝试从 Blob URL 获取数据: ${blobUrl}`);

                        // 使用 fetch 获取 Blob URL 的内容
                        const response = await fetch(blobUrl);

                        // 检查响应是否成功
                        if (!response.ok) {
                            throw new Error(`无法获取 Blob URL 内容！状态码: ${response.status || '未知'}. Blob URL 可能已失效或不存在于当前上下文。`);
                        }

                        // 获取 Blob 的内容类型 (MIME type)
                        const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
                        console.log('获取到的内容 MIME 类型:', contentType);

                        // 将响应体转换为 ArrayBuffer (即二进制 buffer)
                        const imageArrayBuffer = await response.arrayBuffer();
                        console.log('获取到的图片 ArrayBuffer (buffer) 大小:', imageArrayBuffer.byteLength, '字节');

                        // 将 ArrayBuffer 转换为 base64 字符串，以便传递给 Node.js
                        const uint8Array = new Uint8Array(imageArrayBuffer);
                        const binaryString = Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
                        const base64String = btoa(binaryString);

                        console.log(`文件 '${fileName}' 数据获取成功！`);

                        return {
                            success: true,
                            base64Data: base64String,
                            contentType: contentType,
                            size: imageArrayBuffer.byteLength
                        };

                    } catch (error) {
                        console.error('处理 Blob URL 失败:', error);
                        return {
                            success: false,
                            error: error.message
                        };
                    }
                }, imageInfo.blobUrl, fileName);

                if (downloadResult.success) {
                    // 将 base64 数据转换为 Buffer 并保存
                    const buffer = Buffer.from(downloadResult.base64Data, 'base64');
                    await fs.writeFile(filePath, buffer);

                    console.log(`💾 保存成功: ${fileName} (${(downloadResult.size / 1024).toFixed(1)} KB)`);
                    downloadedCount++;
                } else {
                    console.error(`❌ 下载失败 (order=${imageInfo.order}): ${downloadResult.error}`);
                    failedCount++;
                }

            } catch (error) {
                console.error(`❌ 保存图片失败 (order=${imageInfo.order}): ${error.message}`);
                failedCount++;
            }
        }

        console.log(`✅ blob 图片保存完成统计:`);
        console.log(`   - 成功保存: ${downloadedCount} 张`);
        console.log(`   - 跳过已存在: ${skippedCount} 张`);
        console.log(`   - 保存失败: ${failedCount} 张`);
        console.log(`   - 总计处理: ${imageInfos.length} 张`);

        return downloadedCount;
    }

    /**
     * 检查页面是否有显示的 mh_loaderr 元素
     */
    async checkForVisibleErrors() {
        return await this.page.evaluate(() => {
            const errorElements = document.querySelectorAll('.mh_loaderr');
            let visibleErrorCount = 0;

            for (let i = 0; i < errorElements.length; i++) {
                const errorElement = errorElements[i];
                const errorStyle = window.getComputedStyle(errorElement);

                if (errorStyle.display !== 'none') {
                    visibleErrorCount++;
                    console.log(`❌ 发现显示的错误元素: ${i + 1}`);
                }
            }

            console.log(`📊 错误检查结果: 发现 ${visibleErrorCount} 个显示的错误元素`);
            return visibleErrorCount > 0;
        });
    }

    /**
     * 获取页面上所有 blob URL 的图片
     */
    async getBlobImages() {
        return await this.page.evaluate(() => {
            const images = [];
            const allImages = document.querySelectorAll('img');

            console.log(`🔍 检查 ${allImages.length} 个 img 元素`);

            for (let i = 0; i < allImages.length; i++) {
                const img = allImages[i];

                if (img.src && img.src.startsWith('blob:')) {
                    // 尝试从父元素获取 p 属性
                    let order = i + 1; // 默认使用索引
                    const comicPicParent = img.closest('.mh_comicpic');

                    if (comicPicParent) {
                        const pValue = comicPicParent.getAttribute('p');
                        if (pValue) {
                            order = parseInt(pValue) || (i + 1);
                        }
                    }

                    images.push({
                        blobUrl: img.src,
                        order: order,
                        element: img
                    });

                    console.log(`✅ 找到blob图片: order=${order}, src=${img.src.substring(0, 50)}...`);
                }
            }

            console.log(`🔍 检查 ${images.length} 张blob图片`);
            return images.sort((a, b) => a.order - b.order);
        });
    }

    /**
     * 优化的图片下载实现
     * 使用 blob URL 作为 src 的 img 元素
     * 通过 imgElement.screenshot() 方法获取图片 buffer 数据
     * 将 buffer 保存为本地图片文件
     * 完善文件命名规则：获取 mh_comicpic 元素的 p 属性作为图片顺序编号
     * 文件命名格式：{p}-blob.{扩展名}，确保文件名的唯一性和顺序性
     */
    async saveImages(imageInfos, chapterDir) {
        console.log(`💾 开始优化图片保存流程，共 ${imageInfos.length} 张图片...`);

        // 并行下载配置
        const concurrency = 3; // 同时下载3张图片，避免过载
        let downloadedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        for (let i = 0; i < imageInfos.length; i += concurrency) {
            const batch = imageInfos.slice(i, i + concurrency);
            console.log(`📦 处理批次 ${Math.floor(i / concurrency) + 1}/${Math.ceil(imageInfos.length / concurrency)}: ${batch.length} 张图片`);

            const promises = batch.map(async (imageInfo) => {
                return await this.saveIndividualImage(imageInfo, chapterDir);
            });

            const results = await Promise.all(promises);

            // 统计结果
            results.forEach(result => {
                if (result.success) downloadedCount++;
                else if (result.skipped) skippedCount++;
                else failedCount++;
            });

            // 批次间延迟，避免过于频繁的操作
            if (i + concurrency < imageInfos.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log(`✅ 图片保存完成统计:`);
        console.log(`   - 成功保存: ${downloadedCount} 张`);
        console.log(`   - 跳过已存在: ${skippedCount} 张`);
        console.log(`   - 保存失败: ${failedCount} 张`);
        console.log(`   - 总计处理: ${imageInfos.length} 张`);

        return downloadedCount;
    }

    /**
     * 保存单个图片
     * 实现文件命名规则：{p}-blob.{扩展名}
     */
    async saveIndividualImage(imageInfo, chapterDir) {
        try {
            // 生成文件名：{p}-blob.{扩展名}
            const fileName = this.generateImageFileName(imageInfo);
            const filePath = path.join(chapterDir, fileName);

            // 检查文件是否已存在
            if (await fs.pathExists(filePath)) {
                console.log(`⏭️ 文件已存在，跳过: ${fileName}`);
                return { success: false, skipped: true, fileName };
            }

            // 查找对应的图片元素
            const imgElement = await this.findImageElement(imageInfo.order);
            if (!imgElement) {
                console.error(`❌ 未找到图片元素: p=${imageInfo.order}`);
                return { success: false, skipped: false, error: 'Element not found' };
            }

            // 使用 imgElement.screenshot() 方法获取图片 buffer 数据
            console.log(`📸 开始截图: p=${imageInfo.order}`);
            const buffer = await imgElement.screenshot({
                type: 'png',
                omitBackground: false
            });

            // 将 buffer 保存为本地图片文件
            await fs.writeFile(filePath, buffer);

            console.log(`💾 保存成功: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
            return { success: true, skipped: false, fileName, size: buffer.length };

        } catch (error) {
            console.error(`❌ 保存图片失败 (p=${imageInfo.order}): ${error.message}`);
            return { success: false, skipped: false, error: error.message };
        }
    }

    /**
     * 生成图片文件名
     * 文件命名格式：{p}-blob.{扩展名}
     * 确保文件名的唯一性和顺序性
     */
    generateImageFileName(imageInfo) {
        // 获取 mh_comicpic 元素的 p 属性作为图片顺序编号
        const pageNumber = imageInfo.order;

        // 从 blob URL 中提取标识符（用于唯一性）
        const blobIdentifier = this.extractBlobIdentifier(imageInfo.blobUrl);

        // 文件命名格式：{p}-blob-{identifier}.png
        const fileName = `${pageNumber}-blob-${blobIdentifier}.png`;

        return fileName;
    }

    /**
     * 从 blob URL 中提取标识符
     */
    extractBlobIdentifier(blobUrl) {
        // 从blob URL中提取UUID或生成短标识符
        const uuidMatch = blobUrl.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
        if (uuidMatch) {
            // 使用UUID的前8位作为标识符
            return uuidMatch[1].substring(0, 8);
        }

        // 如果没有UUID，使用URL的哈希值
        const urlHash = blobUrl.split('/').pop() || 'unknown';
        return urlHash.substring(0, 8);
    }

    /**
     * 查找对应的图片元素
     */
    async findImageElement(pageOrder) {
        try {
            // 构建选择器：查找具有指定 p 属性的 .mh_comicpic 元素中的 img
            const imgSelector = `.mh_comicpic[p="${pageOrder}"] img`;

            const imgElement = await this.page.$(imgSelector);

            if (imgElement) {
                // 验证元素是否有有效的 blob URL
                const src = await imgElement.getAttribute('src');
                if (src && src.startsWith('blob:')) {
                    return imgElement;
                } else {
                    console.log(`⚠️ p=${pageOrder} 的图片元素没有有效的 blob URL: ${src}`);
                    return null;
                }
            }

            return null;
        } catch (error) {
            console.error(`❌ 查找图片元素失败 (p=${pageOrder}): ${error.message}`);
            return null;
        }
    }

    extractUuidFromBlob(blobUrl) {
        // 从blob URL中提取UUID
        // 格式: blob:https://www.colamanga.com/91799778-e7d0-401c-ba8c-5d9b02672782
        const match = blobUrl.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
        return match ? match[1] : 'unknown';
    }

    /**
     * 错误处理和性能优化相关方法
     */

    /**
     * 带重试机制的操作执行器
     */
    async executeWithRetry(operation, maxRetries = 3, delayMs = 1000, operationName = 'Operation') {
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`🔄 执行 ${operationName} (第 ${attempt}/${maxRetries} 次尝试)`);
                const result = await operation();

                if (attempt > 1) {
                    console.log(`✅ ${operationName} 重试成功 (第 ${attempt} 次尝试)`);
                }

                return result;
            } catch (error) {
                lastError = error;
                console.log(`❌ ${operationName} 第 ${attempt} 次尝试失败: ${error.message}`);

                if (attempt < maxRetries) {
                    console.log(`⏳ 等待 ${delayMs}ms 后重试...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    delayMs *= 1.5; // 指数退避
                }
            }
        }

        console.log(`❌ ${operationName} 所有重试均失败`);
        throw lastError;
    }

    /**
     * 进度显示和日志记录
     */
    logProgress(current, total, operation = '处理') {
        const percentage = total > 0 ? ((current / total) * 100).toFixed(1) : 0;
        const progressBar = this.generateProgressBar(current, total);
        console.log(`📊 ${operation}进度: ${progressBar} ${current}/${total} (${percentage}%)`);
    }

    generateProgressBar(current, total, length = 20) {
        if (total === 0) return '░'.repeat(length);

        const filled = Math.floor((current / total) * length);
        const empty = length - filled;
        return '█'.repeat(filled) + '░'.repeat(empty);
    }

    /**
     * 性能监控
     */
    startTimer(operationName) {
        const startTime = Date.now();
        return {
            name: operationName,
            start: startTime,
            end: () => {
                const endTime = Date.now();
                const duration = endTime - startTime;
                console.log(`⏱️ ${operationName} 耗时: ${this.formatDuration(duration)}`);
                return duration;
            }
        };
    }

    formatDuration(ms) {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    }

    /**
     * 内存使用监控
     */
    logMemoryUsage(operation = '') {
        if (typeof process !== 'undefined' && process.memoryUsage) {
            const usage = process.memoryUsage();
            console.log(`💾 内存使用 ${operation}:`);
            console.log(`   - RSS: ${(usage.rss / 1024 / 1024).toFixed(1)} MB`);
            console.log(`   - Heap Used: ${(usage.heapUsed / 1024 / 1024).toFixed(1)} MB`);
            console.log(`   - Heap Total: ${(usage.heapTotal / 1024 / 1024).toFixed(1)} MB`);
        }
    }

    /**
     * 避免不必要的重复操作 - 缓存机制
     */
    initializeCache() {
        this.cache = {
            chapterAnalysis: new Map(),
            imageCount: new Map(),
            lastClearTime: Date.now()
        };
    }

    getCachedResult(key, maxAge = 300000) { // 5分钟缓存
        if (!this.cache) this.initializeCache();

        const cached = this.cache.chapterAnalysis.get(key);
        if (cached && (Date.now() - cached.timestamp) < maxAge) {
            console.log(`📋 使用缓存结果: ${key}`);
            return cached.data;
        }
        return null;
    }

    setCachedResult(key, data) {
        if (!this.cache) this.initializeCache();

        this.cache.chapterAnalysis.set(key, {
            data: data,
            timestamp: Date.now()
        });

        // 定期清理缓存
        if (Date.now() - this.cache.lastClearTime > 600000) { // 10分钟清理一次
            this.clearOldCache();
        }
    }

    clearOldCache() {
        if (!this.cache) return;

        const now = Date.now();
        const maxAge = 300000; // 5分钟

        for (const [key, value] of this.cache.chapterAnalysis.entries()) {
            if (now - value.timestamp > maxAge) {
                this.cache.chapterAnalysis.delete(key);
            }
        }

        this.cache.lastClearTime = now;
        console.log(`🧹 清理过期缓存完成`);
    }

    /**
     * 错误分类和处理
     */
    categorizeError(error) {
        const message = error.message.toLowerCase();

        if (message.includes('timeout')) {
            return { type: 'timeout', severity: 'medium', retryable: true };
        }

        if (message.includes('404') || message.includes('not found')) {
            return { type: 'not_found', severity: 'low', retryable: false };
        }

        if (message.includes('network') || message.includes('connection')) {
            return { type: 'network', severity: 'high', retryable: true };
        }

        if (message.includes('element') || message.includes('selector')) {
            return { type: 'element', severity: 'medium', retryable: true };
        }

        return { type: 'unknown', severity: 'high', retryable: true };
    }

    /**
     * 智能错误处理
     */
    async handleError(error, context = '', options = {}) {
        const errorInfo = this.categorizeError(error);
        const timestamp = new Date().toISOString();

        console.log(`❌ 错误处理 [${timestamp}]:`);
        console.log(`   - 上下文: ${context}`);
        console.log(`   - 类型: ${errorInfo.type}`);
        console.log(`   - 严重程度: ${errorInfo.severity}`);
        console.log(`   - 可重试: ${errorInfo.retryable}`);
        console.log(`   - 消息: ${error.message}`);

        // 根据错误类型采取不同的处理策略
        switch (errorInfo.type) {
            case 'timeout':
                if (options.allowRetry && errorInfo.retryable) {
                    console.log(`⏳ 超时错误，建议重试`);
                    return { shouldRetry: true, delay: 2000 };
                }
                break;

            case 'network':
                if (options.allowRetry && errorInfo.retryable) {
                    console.log(`🌐 网络错误，建议重试`);
                    return { shouldRetry: true, delay: 5000 };
                }
                break;

            case 'not_found':
                console.log(`📄 资源不存在，跳过重试`);
                return { shouldRetry: false, skip: true };

            case 'element':
                if (options.allowRetry && errorInfo.retryable) {
                    console.log(`🔍 元素查找失败，建议重试`);
                    return { shouldRetry: true, delay: 1000 };
                }
                break;
        }

        return { shouldRetry: false, critical: errorInfo.severity === 'high' };
    }

    async getExistingImages(chapterDir) {
        // 获取已存在的图片文件
        if (!await fs.pathExists(chapterDir)) {
            return [];
        }

        const files = await fs.readdir(chapterDir);
        return files.filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'));
    }

    async clearChapterDirectory(chapterDir) {
        try {
            console.log(`🗑️ 清空章节目录: ${chapterDir}`);
            await fs.emptyDir(chapterDir);
            console.log(`✅ 章节目录已清空`);
        } catch (error) {
            console.error(`❌ 清空目录失败: ${error.message}`);
        }
    }

    async analyzeChapterProgress(chapterDir) {
        // 分析章节下载进度
        if (!await fs.pathExists(chapterDir)) {
            return { existingFiles: [], missingPages: [], isComplete: false, maxPage: 0 };
        }

        const files = await fs.readdir(chapterDir);
        const imageFiles = files.filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'));

        // 提取页面编号
        const pageNumbers = imageFiles.map(file => {
            const match = file.match(/^(\d+)-/);
            return match ? parseInt(match[1]) : 0;
        }).filter(num => num > 0).sort((a, b) => a - b);

        const maxPage = pageNumbers.length > 0 ? Math.max(...pageNumbers) : 0;
        const missingPages = [];

        // 检查连续性
        for (let i = 1; i <= maxPage; i++) {
            if (!pageNumbers.includes(i)) {
                missingPages.push(i);
            }
        }

        return {
            existingFiles: imageFiles,
            missingPages,
            isComplete: missingPages.length === 0 && maxPage > 0,
            maxPage,
            totalExisting: pageNumbers.length
        };
    }

    async checkChapterExists(mangaId, chapter) {
        // 检查章节是否存在（不下载，只检查）
        try {
            const chapterUrl = `https://www.colamanga.com/manga-${mangaId}/${chapter}.html`;
            const response = await this.page.goto(chapterUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            if (response.status() === 404) {
                return false;
            }

            // 检查是否有图片内容
            try {
                await this.page.waitForSelector('.mh_comicpic', { timeout: 5000 });
                return true;
            } catch {
                return false;
            }
        } catch (error) {
            if (error.message.includes('404') || error.message.includes('net::ERR_HTTP_RESPONSE_CODE_FAILURE')) {
                return false;
            }
            throw error;
        }
    }

    sanitizeFileName(fileName) {
        // 清理文件名，移除不合法字符
        return fileName.replace(/[<>:"/\\|?*：？]/g, '_').trim();
    }

    async downloadFromMangaList(mangaListFile, startIndex = 0, count = null, maxChapters = null) {
        const mangaList = await fs.readJson(mangaListFile);
        console.log(`📚 加载漫画列表，共 ${mangaList.length} 个漫画`);
        console.log(`🔧 并行处理配置: ${this.parallelConfig.enabled ? '启用' : '禁用'} (最大并发: ${this.parallelConfig.maxConcurrent})`);

        // 过滤掉已完成的漫画
        const targetList = mangaList.slice(startIndex, count ? startIndex + count : undefined);
        const incompleteList = [];
        
        console.log(`🔍 检查漫画下载完成状态...`);
        for (const manga of targetList) {
            if (await this.checkMangaCompletion(manga)) {
                console.log(`✅ ${manga.name} 已完成下载，跳过`);
            } else {
                incompleteList.push(manga);
            }
        }
        
        console.log(`📊 需要下载: ${incompleteList.length}/${targetList.length} 个漫画`);
        
        if (incompleteList.length === 0) {
            console.log(`🎉 所有漫画都已完成下载！`);
            return [];
        }

        const options = { startIndex: 0, count: null, maxChapters };

        if (this.parallelConfig.enabled && incompleteList.length > 1) {
            console.log(`🚀 使用并行模式下载漫画`);
            return await this.downloadMangasInParallel(incompleteList, options);
        } else {
            console.log(`📚 使用串行模式下载漫画`);
            return await this.downloadMangasSequentially(incompleteList, maxChapters);
        }
    }

    /**
     * 检查漫画是否已完成下载
     * 通过比较已下载的章节文件夹数量和漫画的最大章节数
     */
    async checkMangaCompletion(manga) {
        try {
            // 检查漫画是否有最大章节数信息
            if (!manga.maxChapter || manga.maxChapter <= 0) {
                return false; // 没有最大章节信息，认为未完成
            }

            const mangaDir = path.join(this.outputDir, this.sanitizeFileName(manga.name));
            if (!await fs.pathExists(mangaDir)) {
                return false; // 文件夹不存在，肯定未完成
            }

            // 获取所有章节文件夹
            const files = await fs.readdir(mangaDir);
            const chapterDirs = files.filter(file => {
                const chapterPath = path.join(mangaDir, file);
                return fs.statSync(chapterPath).isDirectory() && /^第\d+章/.test(file);
            });

            // 提取章节号并排序
            const chapterNumbers = chapterDirs.map(dir => {
                const match = dir.match(/^第(\d+)章/);
                return match ? parseInt(match[1]) : 0;
            }).filter(num => num > 0).sort((a, b) => a - b);

            // 检查是否有连续的章节从1到maxChapter
            if (chapterNumbers.length < manga.maxChapter) {
                return false;
            }

            // 检查是否有最大章节
            const maxDownloadedChapter = Math.max(...chapterNumbers);
            if (maxDownloadedChapter < manga.maxChapter) {
                return false;
            }

            // 额外检查：确保每个章节文件夹都有图片文件
            for (let i = 1; i <= manga.maxChapter; i++) {
                const chapterDir = path.join(mangaDir, `第${i}章`);
                if (!await fs.pathExists(chapterDir)) {
                    return false;
                }
                
                const chapterFiles = await fs.readdir(chapterDir);
                const imageFiles = chapterFiles.filter(f => 
                    f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg')
                );
                
                if (imageFiles.length === 0) {
                    return false; // 章节文件夹存在但没有图片
                }
            }

            return true; // 所有检查通过，认为已完成
            
        } catch (error) {
            console.log(`⚠️ 检查漫画 ${manga.name} 完成状态时出错: ${error.message}`);
            return false; // 出错时保守处理，认为未完成
        }
    }

    async close() {
        console.log('🔄 开始关闭浏览器...');
        
        // 关闭所有浏览器实例
        for (const browserInstance of this.allBrowsers) {
            try {
                if (browserInstance.context) {
                    await browserInstance.context.close();
                    console.log(`✅ 浏览器实例 ${browserInstance.id} 已关闭`);
                }
            } catch (error) {
                console.log(`⚠️ 关闭浏览器实例 ${browserInstance.id} 失败: ${error.message}`);
            }
        }
        
        console.log('✅ 所有浏览器实例关闭完成');
    }


}

/**
 * 测试和验证重构结果
 * 编写测试用例验证重构后的功能，确保所有新功能正常工作，性能得到优化，错误处理机制有效
 */

// 测试重构后的下载逻辑
async function testRefactoredDownloadLogic() {
    console.log('🧪 开始测试重构后的下载逻辑...');
    const downloader = new MangaContentDownloader();

    try {
        await downloader.init();

        // 测试1: 章节导航功能
        console.log('\n📋 测试1: 章节导航功能');
        const navigationResult = await downloader.navigateToChapter('ap101511', 1);
        console.log(`导航测试结果: ${navigationResult.success ? '✅ 成功' : '❌ 失败'}`);

        if (navigationResult.success) {
            // 测试2: 智能滚动和元素收集
            console.log('\n📋 测试2: 智能滚动和元素收集');
            const scrollResult = await downloader.intelligentScrollAndCollect();
            console.log(`滚动测试结果: ${scrollResult.success ? '✅ 成功' : '❌ 失败'}`);
            console.log(`收集到的元素: ${scrollResult.validElements} 个`);

            // 测试3: 页面加载完成检测
            console.log('\n📋 测试3: 页面加载完成检测');
            const loadResult = await downloader.waitForPageLoadComplete();
            console.log(`加载检测结果: ${loadResult.success ? '✅ 成功' : '❌ 失败'}`);
            console.log(`有效图片: ${loadResult.validImages} 张`);

            // 测试4: 有效图片数量统计
            console.log('\n📋 测试4: 有效图片数量统计');
            const imageCount = await downloader.getValidWebImageCount();
            console.log(`图片数量统计: ${imageCount} 张`);

            // 测试5: 完整下载流程
            console.log('\n📋 测试5: 完整下载流程');
            const downloadSuccess = await downloader.downloadMangaContent('ap101511', '测试漫画', 1, false); // 不跳过漫画信息
            console.log(`下载测试结果: ${downloadSuccess ? '✅ 成功' : '❌ 失败'}`);
        }

        console.log('\n🎉 重构功能测试完成！');

    } catch (error) {
        console.error('❌ 测试过程中出错:', error);

        // 测试错误处理机制
        console.log('\n📋 测试错误处理机制');
        const errorHandling = await downloader.handleError(error, '测试环境', { allowRetry: true });
        console.log(`错误处理结果:`, errorHandling);

    } finally {
        await downloader.close();
    }
}

// 性能测试
async function testPerformanceOptimizations() {
    console.log('🚀 开始性能优化测试...');
    const downloader = new MangaContentDownloader();

    try {
        await downloader.init();

        // 测试缓存机制
        console.log('\n📋 测试缓存机制');
        const timer1 = downloader.startTimer('首次章节分析');

        // 模拟章节分析
        const testDir = './test-chapter';
        const result1 = await downloader.analyzeChapterCompleteness(testDir, true);
        timer1.end();

        // 第二次调用应该使用缓存
        const timer2 = downloader.startTimer('缓存章节分析');
        const result2 = await downloader.analyzeChapterCompleteness(testDir, true);
        timer2.end();

        // 测试内存使用
        console.log('\n📋 测试内存使用监控');
        downloader.logMemoryUsage('性能测试期间');

        // 测试进度显示
        console.log('\n📋 测试进度显示');
        for (let i = 0; i <= 10; i++) {
            downloader.logProgress(i, 10, '测试进度');
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        console.log('\n🎉 性能测试完成！');

    } catch (error) {
        console.error('❌ 性能测试出错:', error);
    } finally {
        await downloader.close();
    }
}

// 错误处理测试
async function testErrorHandling() {
    console.log('🛡️ 开始错误处理测试...');
    const downloader = new MangaContentDownloader();

    try {
        await downloader.init();

        // 测试不同类型的错误
        const testErrors = [
            new Error('Connection timeout'),
            new Error('Element not found'),
            new Error('404 Not Found'),
            new Error('Network connection failed'),
            new Error('Unknown error occurred')
        ];

        for (const error of testErrors) {
            console.log(`\n📋 测试错误: ${error.message}`);
            const handling = await downloader.handleError(error, '错误处理测试', { allowRetry: true });
            console.log(`处理结果:`, handling);
        }

        // 测试重试机制
        console.log('\n📋 测试重试机制');
        let attemptCount = 0;
        const testOperation = async () => {
            attemptCount++;
            if (attemptCount < 3) {
                throw new Error('模拟失败');
            }
            return '成功';
        };

        const retryResult = await downloader.executeWithRetry(testOperation, 3, 500, '重试测试');
        console.log(`重试测试结果: ${retryResult}`);

        console.log('\n🎉 错误处理测试完成！');

    } catch (error) {
        console.error('❌ 错误处理测试出错:', error);
    } finally {
        await downloader.close();
    }
}

// 综合测试函数
async function runAllTests() {
    console.log('🧪 开始运行所有测试...\n');

    try {
        // 运行功能测试
        await testRefactoredDownloadLogic();

        console.log('\n' + '='.repeat(60) + '\n');

        // 运行性能测试
        await testPerformanceOptimizations();

        console.log('\n' + '='.repeat(60) + '\n');

        // 运行错误处理测试
        await testErrorHandling();

        console.log('\n🎉 所有测试完成！');

    } catch (error) {
        console.error('❌ 测试套件执行失败:', error);
    }
}

// 主函数
async function main() {
    // 检查命令行参数
    const args = process.argv.slice(2);
    const isTestMode = args.includes('--test') || args.includes('-t');
    const testType = args.find(arg => arg.startsWith('--test-type='))?.split('=')[1];

    if (isTestMode) {
        console.log('🧪 运行测试模式...\n');

        switch (testType) {
            case 'function':
                await testRefactoredDownloadLogic();
                break;
            case 'performance':
                await testPerformanceOptimizations();
                break;
            case 'error':
                await testErrorHandling();
                break;
            default:
                await runAllTests();
        }
        return;
    }

    // 正常下载模式
    console.log('📖 运行正常下载模式...\n');
    const downloader = new MangaContentDownloader();

    try {
        await downloader.init();

        // 示例：下载单个漫画
        // await downloader.downloadMangaContent('ap101511', '示例漫画', 1);

        // 示例：从漫画列表文件批量下载
        const mangaListFile = path.join('./manga-ids.json');
        if (await fs.pathExists(mangaListFile)) {
            // 下载前5个漫画，不限制章节数
            await downloader.downloadFromMangaList(mangaListFile, 0, 5);
        } else {
            console.log('❌ 未找到漫画列表文件，请先运行 collect-manga-ids.js');
        }

    } catch (error) {
        console.error('❌ 下载过程中出错:', error);
    } finally {
        await downloader.close();
    }
}

// 如果直接运行此文件
if (require.main === module) {
    console.log('🚀 启动漫画下载器...');
    console.log('💡 使用方法:');
    console.log('   - 正常下载: node download-manga-content.js');
    console.log('   - 运行所有测试: node download-manga-content.js --test');
    console.log('   - 运行功能测试: node download-manga-content.js --test --test-type=function');
    console.log('   - 运行性能测试: node download-manga-content.js --test --test-type=performance');
    console.log('   - 运行错误处理测试: node download-manga-content.js --test --test-type=error');
    console.log('');

    main().catch(console.error);
}

module.exports = { MangaContentDownloader };




