const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');

/**
 * 漫画内容下载器 - 支持并行处理
 * 核心功能：
 * 1. 支持多浏览器实例并行处理多个漫画
 * 2. 核心流程：获取简介 -> 进入章节 -> 滚动页面 -> 等待图片加载 -> 下载图片
 * 3. 智能状态检测和重试机制
 */
class MangaContentDownloader {
    constructor(options = {}) {
        this.outputDir = '/Users/likaixuan/Documents/manga';

        // 章节总页数数据文件路径
        this.chapterTotalPagesFile = options.chapterTotalPagesFile || '/Users/likaixuan/Documents/manga/manga-chapter-total-pages.json';
        this.chapterTotalPagesData = null; // 将在init中加载

        // 并行配置
        this.parallelConfig = {
            enabled: true, // 默认启用并行，除非明确设置为false
            maxConcurrent: 5, // 最大并发漫画数
            retryAttempts: 6,
            retryDelay: options.retryDelay || 1000
        };

        // 浏览器实例管理
        this.browserInstances = []; // 所有浏览器实例
        this.availableInstances = []; // 空闲实例
        this.busyInstances = new Set(); // 忙碌实例ID

        // 统计信息
        this.stats = {
            totalMangasProcessed: 0,
            totalChaptersDownloaded: 0,
            totalImagesDownloaded: 0,
            totalErrors: 0,
            skippedChapters: 0 // 新增：跳过的章节数
        };

        console.log(`🔧 漫画下载器初始化完成 - 并行模式: ${this.parallelConfig.enabled ? '启用' : '禁用'}, 最大并发: ${this.parallelConfig.maxConcurrent}`);
    }

    /**
     * 加载章节总页数数据
     */
    async loadChapterTotalPagesData() {
        try {
            if (await fs.pathExists(this.chapterTotalPagesFile)) {
                console.log(`📊 加载章节总页数数据: ${this.chapterTotalPagesFile}`);
                const data = await fs.readJson(this.chapterTotalPagesFile);
                this.chapterTotalPagesData = data.results || [];
                console.log(`✅ 已加载 ${this.chapterTotalPagesData.length} 个漫画的章节页数数据`);
            } else {
                console.log(`⚠️ 章节总页数数据文件不存在: ${this.chapterTotalPagesFile}`);
                console.log(`💡 提示: 可以先运行 get-chapter-total-pages.js 来生成此文件`);
                this.chapterTotalPagesData = [];
            }
        } catch (error) {
            console.error(`❌ 加载章节总页数数据失败: ${error.message}`);
            this.chapterTotalPagesData = [];
        }
    }

    /**
     * 获取指定漫画章节的总页数
     */
    getChapterTotalPages(mangaId, chapter) {
        if (!this.chapterTotalPagesData || this.chapterTotalPagesData.length === 0) {
            return null;
        }

        // 查找对应的漫画数据
        const mangaData = this.chapterTotalPagesData.find(manga => manga.id === mangaId);
        if (!mangaData || !mangaData.chapters) {
            return null;
        }

        // 查找对应的章节数据
        const chapterData = mangaData.chapters.find(ch => ch.chapter === chapter);
        if (!chapterData || chapterData.totalPage === 'fail' || chapterData.totalPage === null) {
            return null;
        }

        return parseInt(chapterData.totalPage);
    }

    /**
     * 初始化浏览器实例池
     */
    async init() {
        console.log('🚀 初始化浏览器实例池...');

        // 确保输出目录存在
        await fs.ensureDir(this.outputDir);

        // 加载章节总页数数据
        await this.loadChapterTotalPagesData();

        if (this.parallelConfig.enabled) {
            // 并行模式：创建多个浏览器实例
            console.log(`🌐 创建 ${this.parallelConfig.maxConcurrent} 个浏览器实例...`);

            for (let i = 0; i < this.parallelConfig.maxConcurrent; i++) {
                try {
                    const instance = await this.createBrowserInstance(`instance-${i}`);
                    this.browserInstances.push(instance);
                    this.availableInstances.push(instance);
                    console.log(`✅ 浏览器实例 ${instance.id} 创建完成`);
                } catch (error) {
                    console.error(`❌ 创建浏览器实例 ${i} 失败: ${error.message}`);
                }
            }

            console.log(`✅ 浏览器池初始化完成 - 共 ${this.browserInstances.length} 个实例`);
        } else {
            // 串行模式：创建单个浏览器实例
            console.log(`📚 串行模式，创建单个浏览器实例...`);

            const instance = await this.createBrowserInstance('main');
            this.browserInstances.push(instance);
            this.availableInstances.push(instance);

            // 为兼容性保留这些属性
            this.context = instance.context;
            this.page = instance.page;

            console.log('✅ 单浏览器实例初始化完成');
        }
    }

    /**
     * 创建单个浏览器实例
     */
    async createBrowserInstance(instanceId) {
        const context = await chromium.launchPersistentContext('', {
            headless: true,
            channel: 'chrome',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',

            ],
            // ignoreDefaultArgs: [
            //     '--enable-automation',
            //     '--disable-extensions',
            //     '--disable-component-extensions-with-background-pages'
            // ]
        });

        const page = await context.newPage();

        // 设置页面配置
        await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });

        page.setDefaultTimeout(60000);
        page.setDefaultNavigationTimeout(60000);
        await page.setViewportSize({ width: 1280, height: 720 });

        // 设置资源拦截
        await this.setupResourceInterception(page);

        // 设置blob图片捕获
        await this.setupBlobCapture(page);

        // 设置图片拦截器
        await this.setupImageInterceptor(page);

        // 确认拦截器启动状态
        const interceptorStarted = await page.evaluate(() => window.__imageInterceptorStarted);
        if (interceptorStarted) {
            console.log(`🎯 [浏览器 ${instanceId}] 图片拦截器已启动（支持立即数据获取）`);
        }

        return {
            id: instanceId,
            context: context,
            page: page,
            busy: false,
            createdAt: Date.now(),
            lastUsed: Date.now()
        };
    }

    /**
     * 设置资源拦截以优化性能
     */
    async setupResourceInterception(page) {
        await page.route('**/*', (route) => {
            try {
                const request = route.request();
                const resourceType = request.resourceType();
                const url = request.url();

                // 拦截不必要的资源
                if (url.includes('google-analytics') ||
                    url.includes('googletagmanager') ||
                    url.includes('doubleclick.net') ||
                    url.includes('googlesyndication') ||
                    url.includes('facebook.com/tr')) {
                    route.abort();
                } else if (resourceType === 'font' && !url.includes('colamanga.com')) {
                    route.abort();
                } else {
                    route.continue();
                }
            } catch (error) {
                route.continue();
            }
        });
    }

    /**
     * 设置blob图片捕获
     */
    async setupBlobCapture(page) {
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

    /**
     * 设置图片拦截器 - 拦截所有 .mh_comicpic 的 img src 子元素并立即获取数据
     */
    async setupImageInterceptor(page) {
        await page.addInitScript(() => {
            window.__interceptedImages = [];

            // 使用 canvas 获取图片数据 - 避免 fetch 消耗流量，直接从已加载的图片获取
            const getImageDataFromCanvas = async (imgElement, order, retries = 3) => {
                for (let attempt = 1; attempt <= retries; attempt++) {
                    try {
                        // 检查图片是否完全加载
                        if (!imgElement.complete || imgElement.naturalWidth === 0) {
                            if (attempt < retries) {
                                // 等待图片加载完成
                                await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                                continue;
                            } else {
                                throw new Error('图片未完全加载');
                            }
                        }

                        // 滚动到图片位置确保可见
                        imgElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        await new Promise(resolve => setTimeout(resolve, 200));

                        // 对于跨域图片，尝试使用 fetch + canvas 方法
                        if (imgElement.src.startsWith('http') && !imgElement.src.includes(window.location.hostname)) {
                            // 跨域 HTTP 图片，使用 fetch 方法避免 canvas 污染
                            const response = await fetch(imgElement.src);
                            if (!response.ok) {
                                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                            }

                            const arrayBuffer = await response.arrayBuffer();
                            const uint8Array = new Uint8Array(arrayBuffer);
                            let binary = '';
                            for (let i = 0; i < uint8Array.length; i++) {
                                binary += String.fromCharCode(uint8Array[i]);
                            }
                            const base64Data = btoa(binary);

                            return {
                                success: true,
                                data: base64Data,
                                size: arrayBuffer.byteLength,
                                contentType: response.headers.get('Content-Type') || 'image/jpeg',
                                attempts: attempt,
                                method: 'fetch'
                            };
                        } else {
                            // 同域或 blob 图片，使用 canvas 方法
                            const canvas = document.createElement('canvas');
                            canvas.width = imgElement.naturalWidth;
                            canvas.height = imgElement.naturalHeight;
                            const ctx = canvas.getContext('2d');

                            // 绘制图片到 canvas
                            ctx.drawImage(imgElement, 0, 0);

                            // 获取 base64 数据
                            const base64DataUrl = canvas.toDataURL('image/png');
                            const base64Data = base64DataUrl.split(',')[1]; // 移除 data:image/png;base64, 前缀

                            // 估算数据大小（base64 编码后的大小约为原始数据的 4/3）
                            const estimatedSize = Math.floor(base64Data.length * 3 / 4);

                            return {
                                success: true,
                                data: base64Data,
                                size: estimatedSize,
                                contentType: 'image/png',
                                attempts: attempt,
                                method: 'canvas'
                            };
                        }
                    } catch (error) {
                        if (attempt === retries) {
                            return {
                                success: false,
                                error: error.message,
                                order: order,
                                attempts: attempt,
                                method: error.message.includes('Tainted') ? 'canvas-tainted' : 'canvas'
                            };
                        }
                        // 继续重试
                        await new Promise(resolve => setTimeout(resolve, 300 * attempt));
                    }
                }
            };

            // 串行获取所有图片数据的函数 - 使用 canvas 方法
            const fetchAllImageData = async () => {
                const images = window.__interceptedImages || [];
                let successCount = 0;
                let failCount = 0;
                const logs = []; // 收集日志信息

                for (let i = 0; i < images.length; i++) {
                    const imageInfo = images[i];

                    // 跳过已经获取数据的图片
                    if (imageInfo.dataFetched) {
                        continue;
                    }

                    // 跳过非图片URL
                    if (!imageInfo.src || (!imageInfo.isBase64 && !imageInfo.isBlob && !imageInfo.isHttp)) {
                        continue;
                    }

                    // 找到对应的 img 元素
                    const imgElement = imageInfo.element ? imageInfo.element.querySelector('img') : null;

                    if (imageInfo.isBase64) {
                        // base64 图片直接处理
                        imageInfo.dataFetched = true;
                        imageInfo.imageData = {
                            success: true,
                            data: imageInfo.src.split(',')[1],
                            contentType: imageInfo.src.split(';')[0].split(':')[1] || 'image/jpeg',
                            method: 'base64'
                        };
                        const logMsg = `🎯 处理base64图片: order=${imageInfo.order}`;
                        imageInfo.logMessage = logMsg;
                        logs.push(logMsg);
                        successCount++;
                    } else if (imgElement) {
                        // 使用 canvas 方法获取图片数据
                        const logMsg = `🎯 开始canvas获取图片: order=${imageInfo.order} (${imageInfo.isBlob ? 'blob' : 'http'})`;
                        logs.push(logMsg);

                        const imageData = await getImageDataFromCanvas(imgElement, imageInfo.order);
                        imageInfo.dataFetched = true;
                        imageInfo.imageData = imageData;

                        if (imageData.success) {
                            const successMsg = ` -> ✅ 成功 (${(imageData.size / 1024).toFixed(1)}KB, ${imageData.attempts}次尝试, canvas方法)`;
                            imageInfo.logMessage = logMsg + successMsg;
                            logs.push(logMsg + successMsg);
                            successCount++;
                        } else {
                            const failMsg = ` -> ❌ 失败: ${imageData.error} (${imageData.attempts}次尝试, canvas方法)`;
                            imageInfo.logMessage = logMsg + failMsg;
                            logs.push(logMsg + failMsg);
                            failCount++;
                        }
                    } else {
                        // 找不到对应的 img 元素
                        const errorMsg = `❌ 找不到对应的img元素: order=${imageInfo.order}`;
                        imageInfo.logMessage = errorMsg;
                        logs.push(errorMsg);
                        imageInfo.dataFetched = true;
                        imageInfo.imageData = { success: false, error: '找不到img元素' };
                        failCount++;
                    }
                }

                return {
                    successCount,
                    failCount,
                    totalProcessed: successCount + failCount,
                    logs: logs // 返回日志信息
                };
            };

            // 暴露串行获取函数供外部调用
            window.__fetchAllImageData = fetchAllImageData;

            // 定期检查 .mh_comicpic 内的 img 元素
            const checkImages = async () => {
                const comicPics = document.querySelectorAll('.mh_comicpic');

                for (let index = 0; index < comicPics.length; index++) {
                    const pic = comicPics[index];
                    const img = pic.querySelector('img');

                    if (img && img.src) {
                        const pValue = pic.getAttribute('p') || (index + 1);
                        const order = parseInt(pValue);

                        // 检查是否已经拦截过这张图片
                        const existingIndex = window.__interceptedImages.findIndex(item => item.order === order);

                        if (existingIndex === -1) {
                            // 支持 base64、blob 和 http URL
                            if (img.src.startsWith('data:image/') || img.src.startsWith('blob:') || img.src.startsWith('http')) {
                                const imageInfo = {
                                    order: order,
                                    src: img.src,
                                    isBase64: img.src.startsWith('data:image/'),
                                    isBlob: img.src.startsWith('blob:'),
                                    isHttp: img.src.startsWith('http'),
                                    timestamp: Date.now(),
                                    element: pic,
                                    dataFetched: false,
                                    imageData: null
                                };

                                // 第一阶段：只收集图片信息，不立即获取数据
                                imageInfo.dataFetched = false;
                                imageInfo.imageData = null;

                                if (imageInfo.isBase64) {
                                    imageInfo.logMessage = `🎯 发现base64图片: order=${order}`;
                                } else {
                                    imageInfo.logMessage = `🎯 发现${imageInfo.isBlob ? 'blob' : 'http'}图片: order=${order}`;
                                }

                                window.__interceptedImages.push(imageInfo);
                            }
                        } else {
                            // 更新已存在的图片信息（可能从 placeholder 变为实际图片）
                            const existing = window.__interceptedImages[existingIndex];
                            if (!existing.dataFetched &&
                                (img.src.startsWith('data:image/') || img.src.startsWith('blob:') || img.src.startsWith('http'))) {

                                existing.src = img.src;
                                existing.isBase64 = img.src.startsWith('data:image/');
                                existing.isBlob = img.src.startsWith('blob:');
                                existing.isHttp = img.src.startsWith('http');
                                existing.timestamp = Date.now();

                                // 第一阶段：只更新图片信息，不立即获取数据
                                existing.dataFetched = false;
                                existing.imageData = null;

                                if (existing.isBase64) {
                                    existing.logMessage = `🔄 更新为base64图片: order=${order}`;
                                } else {
                                    existing.logMessage = `🔄 更新为${existing.isBlob ? 'blob' : 'http'}图片: order=${order}`;
                                }
                            }
                        }
                    }
                }
            };

            // 每500ms检查一次
            const intervalId = setInterval(checkImages, 500);

            // 保存 interval ID 以便后续清理
            window.__imageInterceptorInterval = intervalId;

            // 标记拦截器已启动（不使用 console.log，因为在 evaluate 中不会显示在终端）
            window.__imageInterceptorStarted = true;
        });
    }

    /**
     * 获取空闲的浏览器实例
     */
    async acquireBrowserInstance(timeoutMs = 30000) {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            // 查找空闲实例
            const availableInstance = this.availableInstances.find(instance => !instance.busy);

            if (availableInstance) {
                availableInstance.busy = true;
                availableInstance.lastUsed = Date.now();
                this.busyInstances.add(availableInstance.id);
                console.log(`� 获取浏览器实例: ${availableInstance.id}`);
                return availableInstance;
            }

            // 等待一段时间后重试
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        throw new Error(`获取浏览器实例超时：所有 ${this.browserInstances.length} 个浏览器都在忙碌中`);
    }

    /**
     * 释放浏览器实例
     */
    releaseBrowserInstance(browserInstance) {
        if (browserInstance && this.busyInstances.has(browserInstance.id)) {
            browserInstance.busy = false;
            browserInstance.lastUsed = Date.now();
            this.busyInstances.delete(browserInstance.id);
            console.log(`🔓 释放浏览器实例: ${browserInstance.id}`);
        }
    }

    /**
     * 清理浏览器实例
     */
    async cleanupBrowserInstance(browserInstance) {
        try {
            console.log(`🧹 清理浏览器实例: ${browserInstance.id}`);

            // 导航到空白页释放资源
            await browserInstance.page.goto('about:blank');

            // 清理页面内存
            await browserInstance.page.evaluate(() => {
                if (window.__blobUrls) {
                    window.__blobUrls.forEach(item => {
                        try {
                            URL.revokeObjectURL(item.blobUrl);
                        } catch (e) { }
                    });
                    window.__blobUrls = [];
                }

                if (window.gc) {
                    window.gc();
                }
            });

            console.log(`✅ 浏览器实例 ${browserInstance.id} 清理完成`);
        } catch (error) {
            console.log(`⚠️ 清理浏览器实例 ${browserInstance.id} 失败: ${error.message}`);
        }
    }

    /**
     * 关闭所有浏览器实例
     */
    async close() {
        console.log('🔄 关闭所有浏览器实例...');

        for (const instance of this.browserInstances) {
            try {
                await instance.context.close();
                console.log(`✅ 浏览器实例 ${instance.id} 已关闭`);
            } catch (error) {
                console.error(`❌ 关闭浏览器实例 ${instance.id} 失败: ${error.message}`);
            }
        }

        this.browserInstances.length = 0;
        this.availableInstances.length = 0;
        this.busyInstances.clear();

        console.log('✅ 所有浏览器实例已关闭');
    }

    // ==================== 核心下载方法 ====================

    /**
     * 从漫画列表文件下载漫画
     */
    async downloadFromMangaList(mangaListFile, startIndex = 0, count = null, maxChapters = null) {
        console.log(`📚 开始从漫画列表下载: ${mangaListFile}`);

        // 读取漫画列表
        const mangaListData = await fs.readJson(mangaListFile);

        // 处理不同的数据结构
        let mangaList;
        if (Array.isArray(mangaListData)) {
            // 如果是直接的数组格式（如 manga-ids.json）
            mangaList = mangaListData;
        } else if (mangaListData.results && Array.isArray(mangaListData.results)) {
            // 如果是包含 results 字段的对象格式（如 manga-chapter-total-pages.json）
            mangaList = mangaListData.results;
        } else {
            throw new Error('不支持的漫画列表文件格式，期望数组或包含 results 字段的对象');
        }

        console.log(`📖 漫画列表包含 ${mangaList.length} 个漫画`);

        // 应用范围限制
        const targetList = count ? mangaList.slice(startIndex, startIndex + count) : mangaList.slice(startIndex);
        console.log(`🎯 目标下载 ${targetList.length} 个漫画 (从索引 ${startIndex} 开始)`);

        // 根据配置选择下载模式
        if (this.parallelConfig.enabled && targetList.length > 1) {
            console.log(`� 使用并行模式下载漫画`);
            return await this.downloadMangasInParallel(targetList, { maxChapters });
        } else {
            console.log(`📚 使用串行模式下载漫画`);
            return await this.downloadMangasSequentially(targetList, maxChapters);
        }
    }

    /**
     * 检查漫画是否已完成下载
     */
    async checkMangaCompletion(manga) {
        const mangaDir = path.join(this.outputDir, this.sanitizeFileName(manga.name));

        // 检查漫画目录是否存在
        if (!(await fs.pathExists(mangaDir))) {
            return false;
        }

        // 检查是否有漫画信息文件
        const infoFile = path.join(mangaDir, 'manga-info.json');
        if (!(await fs.pathExists(infoFile))) {
            return false;
        }

        // 检查章节目录数量
        const entries = await fs.readdir(mangaDir);
        const chapterDirs = entries.filter(entry => entry.startsWith('第') && entry.includes('章'));

        // 判断漫画完成的唯一标准：章节文件夹数量等于maxChapter
        const maxChapter = manga.maxChapter || 999;
        const isComplete = chapterDirs.length >= maxChapter;

        console.log(`📊 漫画完成检查: ${manga.name}`);
        console.log(`   已下载章节: ${chapterDirs.length}`);
        console.log(`   最大章节: ${maxChapter}`);
        console.log(`   完成状态: ${isComplete ? '已完成' : '未完成'}`);

        return isComplete;
    }

    /**
     * 并行下载多个漫画 - 动态任务分配
     */
    async downloadMangasInParallel(mangaList, options = {}) {
        const { maxChapters = null } = options;

        console.log(`🚀 开始动态并行下载 ${mangaList.length} 个漫画`);
        console.log(`📊 并发配置: 最大并发数 ${this.parallelConfig.maxConcurrent}`);

        const results = [];
        let mangaIndex = 0;

        // 创建工作器函数
        const createWorker = async (workerId) => {
            console.log(`👷 启动工作器 ${workerId}`);

            while (mangaIndex < mangaList.length) {
                // 获取下一个漫画任务
                const currentIndex = mangaIndex++;
                const manga = mangaList[currentIndex];

                if (!manga) break;

                let browserInstance = null;
                const startTime = Date.now();

                try {
                    // 获取浏览器实例
                    browserInstance = await this.acquireBrowserInstance();
                    console.log(`🔄 [${currentIndex + 1}] [工作器 ${workerId}] 为漫画 "${manga.name}" 分配浏览器实例 ${browserInstance.id}`);

                    // 开始下载
                    console.log(`🎯 [${currentIndex + 1}] [浏览器 ${browserInstance.id}] 开始下载: ${manga.name}`);
                    const result = await this.downloadSingleManga(manga, maxChapters, browserInstance);

                    const duration = Date.now() - startTime;
                    console.log(`${result.success ? '✅' : '❌'} [${currentIndex + 1}] [浏览器 ${browserInstance.id}] 漫画 "${manga.name}" 下载${result.success ? '完成' : '失败'} (耗时: ${(duration / 1000).toFixed(1)}秒)`);

                    // 保存结果
                    results[currentIndex] = {
                        manga,
                        result,
                        success: result.success,
                        mangaIndex: currentIndex + 1,
                        duration
                    };

                } catch (error) {
                    console.error(`❌ [${currentIndex + 1}] [工作器 ${workerId}] 漫画 "${manga.name}" 下载失败: ${error.message}`);
                    results[currentIndex] = {
                        manga,
                        result: { success: false, error: error.message },
                        success: false,
                        mangaIndex: currentIndex + 1,
                        duration: Date.now() - startTime
                    };
                } finally {
                    // 清理和释放浏览器实例
                    if (browserInstance) {
                        await this.cleanupBrowserInstance(browserInstance);
                        this.releaseBrowserInstance(browserInstance);
                        console.log(`🔓 [${currentIndex + 1}] [工作器 ${workerId}] 释放浏览器实例 ${browserInstance.id}`);
                    }

                    // 显示进度
                    const completedCount = results.filter(r => r !== undefined).length;
                    const remainingCount = mangaList.length - mangaIndex;
                    console.log(`📊 [工作器 ${workerId}] 进度: ${completedCount}/${mangaList.length} 完成，剩余: ${remainingCount}`);

                    // 如果还有任务，立即继续下一个
                    if (mangaIndex < mangaList.length) {
                        console.log(`⚡ [工作器 ${workerId}] 立即开始下一个任务...`);
                    }
                }
            }

            console.log(`👷 工作器 ${workerId} 完成所有任务`);
        };

        // 启动多个工作器并行处理
        const maxWorkers = Math.min(this.parallelConfig.maxConcurrent, mangaList.length);
        console.log(`⚡ 启动 ${maxWorkers} 个工作器并行处理...`);

        const workers = [];
        for (let i = 0; i < maxWorkers; i++) {
            workers.push(createWorker(i + 1));
        }

        // 等待所有工作器完成
        console.log(`⏳ 等待所有工作器完成...`);
        await Promise.allSettled(workers);

        // 确保results数组没有空洞
        const finalResults = results.filter(r => r !== undefined);

        // 统计最终结果
        const successful = finalResults.filter(r => r.success).length;
        const failed = finalResults.filter(r => !r.success).length;
        const totalDuration = finalResults.reduce((sum, r) => sum + (r.duration || 0), 0);

        console.log(`\n🎉 动态并行下载全部完成！`);
        console.log(`📊 总体统计:`);
        console.log(`   ✅ 成功: ${successful}/${mangaList.length}`);
        console.log(`   ❌ 失败: ${failed}/${mangaList.length}`);
        console.log(`   ⏭️ 跳过章节: ${this.stats.skippedChapters} (已完整)`);
        console.log(`   ⏱️ 累计耗时: ${(totalDuration / 1000).toFixed(1)}秒`);
        console.log(`   ⚡ 平均每个漫画: ${(totalDuration / mangaList.length / 1000).toFixed(1)}秒`);
        console.log(`   📁 输出目录: ${this.outputDir}`);

        return finalResults;
    }

    /**
     * 串行下载多个漫画
     */
    async downloadMangasSequentially(mangaList, maxChapters = null) {
        console.log(`📚 开始串行下载 ${mangaList.length} 个漫画`);

        const results = [];
        for (let i = 0; i < mangaList.length; i++) {
            const manga = mangaList[i];
            console.log(`\n📖 [${i + 1}/${mangaList.length}] 下载漫画: ${manga.name}`);

            let browserInstance = null;
            try {
                // 获取浏览器实例
                browserInstance = await this.acquireBrowserInstance();

                const result = await this.downloadSingleManga(manga, maxChapters, browserInstance);
                results.push({ manga, result, index: i });

            } catch (error) {
                console.error(`❌ 下载失败: ${manga.name} - ${error.message}`);
                results.push({ manga, result: { success: false, error: error.message }, index: i });
            } finally {
                if (browserInstance) {
                    await this.cleanupBrowserInstance(browserInstance);
                    this.releaseBrowserInstance(browserInstance);
                }
            }
        }

        return results;
    }

    /**
     * 下载单个漫画的所有章节
     */
    async downloadSingleManga(manga, maxChapters = null, browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`📖 [浏览器 ${currentBrowser.id}] 开始下载漫画: ${manga.name} (ID: ${manga.id})`);

        const startTime = Date.now();
        let totalChapters = 0;
        let successfulChapters = 0;
        let failedChapters = 0;

        try {
            // 检查是否已完成下载
            if (await this.checkMangaCompletion(manga)) {
                console.log(`✅ [浏览器 ${currentBrowser.id}] ${manga.name} 已完成下载，跳过`);
                return {
                    success: true,
                    totalChapters: manga.maxChapter || 0,
                    successfulChapters: manga.maxChapter || 0,
                    failedChapters: 0,
                    duration: Date.now() - startTime
                };
            }

            // 确定下载的最大章节数
            const maxChapterToDownload = maxChapters || manga.maxChapter || 999;
            console.log(`📚 [浏览器 ${currentBrowser.id}] 计划下载章节 1-${maxChapterToDownload}`);

            // 串行下载章节（在单个漫画内部串行）
            let consecutiveFailures = 0;

            for (let chapter = 1; chapter <= maxChapterToDownload; chapter++) {
                try {
                    const skipMangaInfo = chapter > 1; // 只在第一章获取漫画信息
                    const result = await this.downloadMangaContent(manga.id, manga.name, chapter, skipMangaInfo, currentBrowser);

                    totalChapters++;
                    if (result) {
                        successfulChapters++;
                        consecutiveFailures = 0; // 重置连续失败计数
                        console.log(`✅ [浏览器 ${currentBrowser.id}] 章节 ${chapter} 下载成功`);
                    } else {
                        failedChapters++;
                        consecutiveFailures++;
                        console.log(`❌ [浏览器 ${currentBrowser.id}] 章节 ${chapter} 下载失败`);
                    }
                } catch (error) {
                    console.error(`❌ [浏览器 ${currentBrowser.id}] 章节 ${chapter} 下载异常: ${error.message}`);
                    totalChapters++;
                    failedChapters++;
                    consecutiveFailures++;
                }

                // 如果连续失败多章，可能是漫画结束了
                if (consecutiveFailures >= 3) {
                    console.log(`⚠️ [浏览器 ${currentBrowser.id}] 连续失败${consecutiveFailures}章，可能已到漫画结尾，停止下载`);
                    break;
                }
            }

            const duration = Date.now() - startTime;
            const success = successfulChapters > 0;

            console.log(`📊 [浏览器 ${currentBrowser.id}] 漫画 ${manga.name} 下载完成:`);
            console.log(`   - 总章节: ${totalChapters}`);
            console.log(`   - 成功: ${successfulChapters}`);
            console.log(`   - 失败: ${failedChapters}`);
            console.log(`   - 跳过: ${this.stats.skippedChapters} (已完整)`);
            console.log(`   - 耗时: ${(duration / 1000).toFixed(1)}秒`);

            return {
                success,
                totalChapters,
                successfulChapters,
                failedChapters,
                duration
            };

        } catch (error) {
            console.error(`❌ [浏览器 ${currentBrowser.id}] 下载漫画失败: ${manga.name} - ${error.message}`);
            return {
                success: false,
                error: error.message,
                totalChapters,
                successfulChapters,
                failedChapters,
                duration: Date.now() - startTime
            };
        } finally {
            // 如果没有传入browserInstance（即我们临时获取的），需要释放
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [downloadSingleManga] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    // ==================== 章节下载核心方法 ====================

    /**
     * 下载单个章节的内容
     */
    async downloadMangaContent(mangaId, mangaName, chapter = 1, skipMangaInfo = false, browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`📖 [浏览器 ${currentBrowser.id}] 开始下载漫画: ${mangaName} (ID: ${mangaId}), 章节: ${chapter}`);

        try {
            // 创建漫画目录
            const mangaDir = path.join(this.outputDir, this.sanitizeFileName(mangaName));
            await fs.ensureDir(mangaDir);

            // 只在第一章获取漫画简介信息
            if (!skipMangaInfo) {
                console.log(`📋 [浏览器 ${currentBrowser.id}] 获取漫画简介信息...`);
                const mangaInfo = await this.getMangaInfo(mangaId, mangaDir, currentBrowser);
                if (mangaInfo) {
                    const infoPath = path.join(mangaDir, 'manga-info.json');
                    await fs.writeFile(infoPath, JSON.stringify(mangaInfo, null, 2), 'utf8');
                    console.log(`✅ [浏览器 ${currentBrowser.id}] 漫画简介已保存: ${infoPath}`);
                }
            }

            // 导航到章节页面
            const navigationResult = await this.navigateToChapter(mangaId, chapter, currentBrowser);
            if (!navigationResult.success) {
                console.log(`📄 [浏览器 ${currentBrowser.id}] 章节 ${chapter} 不存在或无法访问`);
                return false;
            }

            // 获取章节标题
            const chapterTitle = navigationResult.title;
            console.log(`📝 [浏览器 ${currentBrowser.id}] 章节标题: ${chapterTitle || '未获取到标题'}`);

            // 创建章节目录
            const chapterDirName = chapterTitle ?
                `第${chapter}章-${this.sanitizeFileName(chapterTitle)}` :
                `第${chapter}章`;

            const chapterDir = path.join(mangaDir, chapterDirName);
            await fs.ensureDir(chapterDir);

            console.log(`📁 [浏览器 ${currentBrowser.id}] 章节目录: ${chapterDirName}`);

            // 检查章节是否已完成 - 传入漫画ID和章节号进行精确检查
            if (await this.isChapterComplete(chapterDir, mangaId, chapter)) {
                console.log(`✅ [浏览器 ${currentBrowser.id}] 章节已完整下载，跳过重复下载`);
                this.stats.skippedChapters++; // 统计跳过的章节数
                return true;
            }

            // 在重新下载前，先清理不合格的图片和标准化文件名
            console.log(`🧹 [浏览器 ${currentBrowser.id}] 清理章节目录...`);
            await this.cleanupSmallImages(chapterDir, 5);
            await this.normalizeImageFileNames(chapterDir);

            // 核心下载流程：滚动页面 -> 等待图片加载 -> 下载图片
            console.log(`🆕 [浏览器 ${currentBrowser.id}] 开始下载章节`);
            return await this.downloadChapterImages(chapterDir, 2, currentBrowser, mangaId, chapter);

        } finally {
            // 如果没有传入browserInstance（即我们临时获取的），需要释放
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [downloadMangaContent] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    /**
     * 导航到指定章节
     */
    async navigateToChapter(mangaId, chapter, browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`🧭 [浏览器 ${currentBrowser.id}] 导航到章节: ${chapter}`);

        const chapterUrl = `https://www.colamanga.com/manga-${mangaId}/1/${chapter}.html`;
        console.log(`🔗 [浏览器 ${currentBrowser.id}] 访问章节 URL: ${chapterUrl}`);

        try {
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

            console.log(`✅ [浏览器 ${currentBrowser.id}] 成功导航到章节 ${chapter}`);
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
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();

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
        } finally {
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [verifyChapterContent] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    /**
     * 获取章节标题
     */
    async getChapterTitle(browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();

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

    /**
     * 检查章节PDF是否存在
     */
    async isChapterPdfExists(mangaName, chapter) {
        try {
            // PDF目录位于漫画输出目录的同级目录 manga-pdf
            const pdfDir = path.join(path.dirname(this.outputDir), 'manga-pdf', mangaName);

            if (!(await fs.pathExists(pdfDir))) {
                return false;
            }

            // 读取目录中的所有文件
            const files = await fs.readdir(pdfDir);

            // 查找以 "第x章" 开头的 PDF 文件
            const chapterPattern = `第${chapter}章`;
            for (const file of files) {
                if (file.startsWith(chapterPattern) && file.endsWith('.pdf')) {
                    console.log(`📄 找到PDF文件: ${path.join(pdfDir, file)}`);
                    return true;
                }
            }

            return false;
        } catch (error) {
            console.log(`⚠️ 检查PDF文件失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 检查章节是否已完成下载 - 优化版本，支持基于总页数的精确检查和PDF文件检查
     */
    async isChapterComplete(chapterDir, mangaId = null, chapter = null) {
        try {
            // 检查目录是否存在
            if (!(await fs.pathExists(chapterDir))) {
                return false;
            }

            // 首先检查是否有对应的PDF文件存在，如果有PDF则认为章节已完成
            if (mangaId && chapter) {
                // 从章节目录路径中提取漫画名称
                const mangaName = path.basename(path.dirname(chapterDir));
                const pdfExists = await this.isChapterPdfExists(mangaName, chapter);
                if (pdfExists) {
                    console.log(`📄 [漫画${mangaId}-章节${chapter}] PDF文件已存在，章节已完成`);
                    return true;
                }
            }

            // 检查是否有图片文件，并过滤掉小于5KB的图片
            const files = await fs.readdir(chapterDir);
            const imageFiles = files.filter(file =>
                /\.(png|jpg|jpeg|webp)$/i.test(file)
            );

            // 统计有效图片数量（大于等于5KB）
            let validImageCount = 0;
            let smallImageCount = 0;

            for (const file of imageFiles) {
                const filePath = path.join(chapterDir, file);
                if (await this.isImageSizeValid(filePath, 5)) {
                    validImageCount++;
                } else {
                    smallImageCount++;
                }
            }

            const actualImageCount = validImageCount;

            if (smallImageCount > 0) {
                console.log(`📊 图片统计: 总计${imageFiles.length}张, 有效${validImageCount}张, 小图片${smallImageCount}张 (< 5KB)`);
            }

            // 如果提供了漫画ID和章节号，尝试获取精确的总页数
            if (mangaId && chapter) {
                const expectedTotalPages = this.getChapterTotalPages(mangaId, chapter);

                if (expectedTotalPages !== null) {
                    // 有精确的总页数数据，进行精确比较（图片数量大于等于预期数量即认为完成）
                    const isComplete = actualImageCount >= expectedTotalPages;
                    console.log(`📊 章节完整性检查 [漫画${mangaId}-章节${chapter}]: 实际图片${actualImageCount}张, 预期${expectedTotalPages}张, ${isComplete ? '✅完整' : '❌不完整'}`);

                    if (isComplete) {
                        return true;
                    } else {
                        console.log(`🔄 实际图片数量(${actualImageCount})少于预期(${expectedTotalPages})，需要重新下载`);
                        return false;
                    }
                } else {
                    console.log(`⚠️ 无法获取章节${chapter}的总页数数据，使用默认检查方式`);
                }
            }

            // 没有精确总页数数据时，使用原来的逻辑：10张以上图片认为基本完成
            const isBasicComplete = actualImageCount >= 10;
            console.log(`📊 章节基础完整性检查: 实际图片${actualImageCount}张, ${isBasicComplete ? '✅基本完整' : '❌不完整'} (阈值:10张)`);
            return isBasicComplete;

        } catch (error) {
            console.log(`⚠️ 检查章节完整性失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 下载章节图片 - 核心流程，支持重试
     */
    async downloadChapterImages(chapterDir, maxRetries = 2, browserInstance = null, mangaId = null, chapter = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();

        try {
            // 获取目标图片数量
            const targetImageCount = this.getChapterTotalPages(mangaId, chapter);
            if (targetImageCount) {
                console.log(`🎯 [浏览器 ${currentBrowser.id}] 目标图片数量: ${targetImageCount} 张`);
            } else {
                console.log(`⚠️ [浏览器 ${currentBrowser.id}] 无法获取目标图片数量，使用默认逻辑`);
            }

            for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
                try {
                    if (attempt > 1) {
                        console.log(`🔄 [浏览器 ${currentBrowser.id}] 第 ${attempt - 1} 次重试下载章节图片...`);
                    }

                    console.log(`🔄 [浏览器 ${currentBrowser.id}] 开始章节图片下载流程 (尝试 ${attempt}/${maxRetries + 1})`);

                    // 1. 等待页面内容加载
                    await currentBrowser.page.waitForSelector('.mh_comicpic', { timeout: 15000 });

                    // 2. 滚动页面，触发所有懒加载，直到达到目标图片数
                    console.log(`📜 [浏览器 ${currentBrowser.id}] 开始滚动页面，触发懒加载...`);
                    await this.scrollPageToLoadImages(currentBrowser, targetImageCount);

                    // 3. 等待图片拦截完成
                    console.log(`⏳ [浏览器 ${currentBrowser.id}] 等待图片拦截完成...`);
                    const interceptResult = await this.waitForImageInterception(30000, currentBrowser, targetImageCount);

                    if (!interceptResult.success) {
                        console.log(`❌ [浏览器 ${currentBrowser.id}] 图片拦截失败或不完整`);
                        if (attempt <= maxRetries) {
                            console.log(`🔄 [浏览器 ${currentBrowser.id}] 准备重试整个下载流程...`);
                            await new Promise(resolve => setTimeout(resolve, 3000)); // 等待3秒后重试
                            continue;
                        } else {
                            return false;
                        }
                    }

                    console.log(`✅ [浏览器 ${currentBrowser.id}] 拦截到 ${interceptResult.imageCount} 张图片`);

                    // 4. 下载拦截到的图片
                    console.log(`💾 [浏览器 ${currentBrowser.id}] 开始下载拦截到的图片...`);
                    const downloadedCount = await this.downloadInterceptedImages(chapterDir, currentBrowser);

                    if (downloadedCount > 0) {
                        console.log(`✅ [浏览器 ${currentBrowser.id}] 章节下载完成，共 ${downloadedCount} 张图片`);
                        return true;
                    } else {
                        console.log(`⚠️ [浏览器 ${currentBrowser.id}] 未下载到任何图片`);
                        if (attempt <= maxRetries) {
                            console.log(`🔄 [浏览器 ${currentBrowser.id}] 准备重试整个下载流程...`);
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            continue;
                        } else {
                            return false;
                        }
                    }

                } catch (error) {
                    console.error(`❌ [浏览器 ${currentBrowser.id}] 下载章节图片失败 (尝试 ${attempt}): ${error.message}`);
                    if (attempt <= maxRetries) {
                        console.log(`🔄 [浏览器 ${currentBrowser.id}] 准备重试整个下载流程...`);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue;
                    } else {
                        return false;
                    }
                }
            }

            return false;
        } finally {
            // 如果没有传入browserInstance（即我们临时获取的），需要释放
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [downloadChapterImages] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    /**
     * 滚动页面以触发所有懒加载，支持基于目标图片数的停止条件
     */
    async scrollPageToLoadImages(browserInstance = null, targetImageCount = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`📜 [浏览器 ${currentBrowser.id}] 开始持续滚动直到所有图片加载...`);
        if (targetImageCount) {
            console.log(`🎯 [浏览器 ${currentBrowser.id}] 目标图片数量: ${targetImageCount} 张`);
        }

        try {
            let lastImageCount = 0;
            let lastInterceptedCount = 0;
            let noNewImagesCount = 0;
            let scrollAttempts = 0;
            const maxScrollAttempts = 100; // 减少最大滚动次数
            const noNewImagesThreshold = 5; // 减少连续无新图片的阈值

            while (scrollAttempts < maxScrollAttempts) {
                // 先滚动页面
                const scrollInfo = await currentBrowser.page.evaluate(() => {
                    const currentScroll = window.scrollY;
                    const pageHeight = document.body.scrollHeight;
                    const windowHeight = window.innerHeight;
                    const isAtBottom = currentScroll + windowHeight >= pageHeight - 100;

                    // 持续向下滚动，增大滚动幅度
                    window.scrollBy({
                        top: 1500, // 增加滚动幅度从800到1500
                        behavior: 'smooth'
                    });

                    return {
                        currentScroll,
                        pageHeight,
                        windowHeight,
                        isAtBottom,
                        newScroll: window.scrollY
                    };
                });

                // 等待滚动和图片加载，减少等待时间以加快滚动速度
                await new Promise(resolve => setTimeout(resolve, 500));

                // 检查当前图片数量（直接检查img元素）
                const currentImageCount = await currentBrowser.page.evaluate(() => {
                    const comicPics = document.querySelectorAll('.mh_comicpic');
                    let imageCount = 0;

                    for (const pic of comicPics) {
                        const img = pic.querySelector('img');
                        if (img && img.src) {
                            imageCount++;
                        }
                    }

                    return imageCount;
                });

                // 检查拦截到的图片数量（已成功获取数据的）
                const interceptedResult = await currentBrowser.page.evaluate(() => {
                    const interceptedImages = window.__interceptedImages || [];
                    let totalCount = interceptedImages.length;
                    let successfulCount = 0;

                    for (const img of interceptedImages) {
                        if (img.dataFetched && img.imageData && img.imageData.success) {
                            successfulCount++;
                        }
                    }

                    return { totalCount, successfulCount };
                });

                // console.log(`📊 [浏览器 ${currentBrowser.id}] 滚动第${scrollAttempts + 1}次 (步长1500px): 发现 ${currentImageCount} 张图片，拦截 ${interceptedResult.totalCount} 张，成功获取数据 ${interceptedResult.successfulCount} 张 (滚动位置: ${scrollInfo.currentScroll})`);

                // 如果有目标图片数量，检查是否已达到（基于成功获取数据的图片）
                if (targetImageCount && interceptedResult.successfulCount >= targetImageCount) {
                    console.log(`✅ [浏览器 ${currentBrowser.id}] 已达到目标图片数量: ${interceptedResult.successfulCount}/${targetImageCount}`);
                    break;
                }

                // 检查是否有新图片出现
                if (currentImageCount > lastImageCount || interceptedResult.successfulCount > lastInterceptedCount) {
                    const newImages = currentImageCount - lastImageCount;
                    const newIntercepted = interceptedResult.successfulCount - lastInterceptedCount;
                    // console.log(`📈 [浏览器 ${currentBrowser.id}] 新增 ${newImages} 张图片，新拦截 ${newIntercepted} 张`);
                    noNewImagesCount = 0; // 重置计数器
                    lastImageCount = currentImageCount;
                    lastInterceptedCount = interceptedResult.successfulCount;
                } else {
                    noNewImagesCount++;
                    // console.log(`⏳ [浏览器 ${currentBrowser.id}] 连续 ${noNewImagesCount}/${noNewImagesThreshold} 次没有新图片`);

                    // 如果连续多次没有新图片，且已经滚动到底部，认为完成
                    if (noNewImagesCount >= noNewImagesThreshold) {
                        // console.log(`✅ [浏览器 ${currentBrowser.id}] 连续${noNewImagesThreshold}次没有新图片，滚动完成`);
                        console.log(`📊 [浏览器 ${currentBrowser.id}] 最终发现 ${currentImageCount} 张图片，拦截 ${interceptedResult.totalCount} 张，成功获取数据 ${interceptedResult.successfulCount} 张`);
                        break;
                    }
                }

                scrollAttempts++;

                // 如果滚动位置没有变化，说明已经到底部了，但还要继续等待图片加载
                if (scrollInfo.currentScroll === scrollInfo.newScroll && scrollInfo.isAtBottom) {
                    console.log(`📍 [浏览器 ${currentBrowser.id}] 已到达页面底部，继续等待图片加载...`);
                    // 到底部后尝试更大幅度的滚动，确保触发所有懒加载
                    await currentBrowser.page.evaluate(() => {
                        window.scrollBy({ top: 2000, behavior: 'smooth' });
                    });
                    await new Promise(resolve => setTimeout(resolve, 800));
                }
            }

            if (scrollAttempts >= maxScrollAttempts) {
                console.log(`⚠️ [浏览器 ${currentBrowser.id}] 达到最大滚动次数，停止滚动`);
            }

            // 最后进行彻底的滚动，确保所有内容都被触发
            console.log(`🔄 [浏览器 ${currentBrowser.id}] 最后进行彻底滚动确保所有图片加载...`);
            await currentBrowser.page.evaluate(() => {
                // 先滚动到顶部
                window.scrollTo(0, 0);
            });
            await new Promise(resolve => setTimeout(resolve, 300));

            // 然后快速滚动到底部
            await currentBrowser.page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });
            await new Promise(resolve => setTimeout(resolve, 500));

            // 再进行少量大幅度滚动确保触发所有懒加载
            for (let i = 0; i < 2; i++) {
                await currentBrowser.page.evaluate(() => {
                    window.scrollBy({ top: 3000, behavior: 'smooth' });
                });
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // 最终统计
            const finalImageCount = await currentBrowser.page.evaluate(() => {
                const comicPics = document.querySelectorAll('.mh_comicpic');
                let imageCount = 0;

                for (const pic of comicPics) {
                    const img = pic.querySelector('img');
                    if (img && img.src) {
                        imageCount++;
                    }
                }

                return imageCount;
            });

            console.log(`✅ [浏览器 ${currentBrowser.id}] 页面滚动完成，最终发现 ${finalImageCount} 张图片`);

            // 调试：检查页面状态
            await this.debugPageStatus(currentBrowser);
        } finally {
            // 如果没有传入browserInstance（即我们临时获取的），需要释放
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [scrollPageToLoadImages] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    /**
     * 调试：检查页面当前状态
     */
    async debugPageStatus(browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`🔍 [浏览器 ${currentBrowser.id}] 调试：检查页面当前状态...`);

        try {
            const pageStatus = await currentBrowser.page.evaluate(() => {
                const comicPics = document.querySelectorAll('.mh_comicpic');
                const allImgs = document.querySelectorAll('img');
                const blobUrls = window.__blobUrls || [];

                let status = {
                    comicPicsCount: comicPics.length,
                    allImgsCount: allImgs.length,
                    blobUrlsCount: blobUrls.length,
                    sampleElements: [],
                    sampleImgs: []
                };

                // 检查前5个.mh_comicpic元素
                for (let i = 0; i < Math.min(5, comicPics.length); i++) {
                    const pic = comicPics[i];
                    const img = pic.querySelector('img');
                    const loadingElement = pic.querySelector('.mh_loading');
                    const errorElement = pic.querySelector('.mh_loaderr');
                    const pValue = pic.getAttribute('p');

                    status.sampleElements.push({
                        index: i,
                        pValue: pValue,
                        hasImg: !!img,
                        imgSrc: img ? img.src.substring(0, 100) : null,
                        imgComplete: img ? img.complete : null,
                        isLoading: loadingElement ? window.getComputedStyle(loadingElement).display !== 'none' : false,
                        hasError: errorElement ? window.getComputedStyle(errorElement).display !== 'none' : false
                    });
                }

                // 检查前5个img元素
                for (let i = 0; i < Math.min(5, allImgs.length); i++) {
                    const img = allImgs[i];
                    status.sampleImgs.push({
                        index: i,
                        src: img.src.substring(0, 100),
                        complete: img.complete,
                        isBlob: img.src.startsWith('blob:')
                    });
                }

                return status;
            });

            console.log(`📊 页面状态:`);
            console.log(`   .mh_comicpic 元素数量: ${pageStatus.comicPicsCount}`);
            console.log(`   所有 img 元素数量: ${pageStatus.allImgsCount}`);
            console.log(`   window.__blobUrls 数量: ${pageStatus.blobUrlsCount}`);

            // console.log(`📋 前5个 .mh_comicpic 元素:`);
            // pageStatus.sampleElements.forEach(el => {
            //     const status = el.isLoading ? '[加载中]' : el.hasError ? '[失败]' : '[正常]';
            //     console.log(`     ${el.index + 1}. p=${el.pValue}, hasImg=${el.hasImg}, ${status}, src="${el.imgSrc}", complete=${el.imgComplete}`);
            // });

            // console.log(`📋 前5个 img 元素:`);
            // pageStatus.sampleImgs.forEach(img => {
            //     console.log(`     ${img.index + 1}. src="${img.src}", complete=${img.complete}, isBlob=${img.isBlob}`);
            // });

            return pageStatus;
        } finally {
            // 如果没有传入browserInstance（即我们临时获取的），需要释放
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [debugPageStatus] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    /**
     * 等待图片拦截完成
     */
    async waitForImageInterception(maxWaitTime = 30000, browserInstance = null, targetImageCount = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`⏳ [浏览器 ${currentBrowser.id}] 等待图片拦截完成，最大等待时间: ${maxWaitTime / 1000}秒`);
        if (targetImageCount) {
            console.log(`🎯 [浏览器 ${currentBrowser.id}] 目标图片数量: ${targetImageCount} 张`);
        }

        try {
            const startTime = Date.now();
            let lastInterceptedCount = 0;
            let stableCount = 0;
            const stableThreshold = 3;

            while (Date.now() - startTime < maxWaitTime) {
                // 检查当前拦截到的图片数量和数据获取状态
                const interceptResult = await currentBrowser.page.evaluate(() => {
                    const interceptedImages = window.__interceptedImages || [];
                    let base64Count = 0;
                    let blobCount = 0;
                    let httpCount = 0;
                    let validCount = 0;
                    let dataFetchedCount = 0;
                    let successfulDataCount = 0;

                    for (const img of interceptedImages) {
                        if (img.isBase64) base64Count++;
                        else if (img.isBlob) blobCount++;
                        else if (img.isHttp) httpCount++;

                        if (img.isBase64 || img.isBlob || img.isHttp) {
                            validCount++;
                        }

                        if (img.dataFetched) {
                            dataFetchedCount++;
                            if (img.imageData && img.imageData.success) {
                                successfulDataCount++;
                            }
                        }
                    }

                    return {
                        totalCount: interceptedImages.length,
                        validCount: validCount,
                        dataFetchedCount: dataFetchedCount,
                        successfulDataCount: successfulDataCount,
                        base64Count: base64Count,
                        blobCount: blobCount,
                        httpCount: httpCount
                    };
                });

                console.log(`🔍 [浏览器 ${currentBrowser.id}] 拦截进度: 总计${interceptResult.totalCount}张, 有效${interceptResult.validCount}张, 已获取数据${interceptResult.dataFetchedCount}张, 成功${interceptResult.successfulDataCount}张`);
                console.log(`📊 类型分布: base64:${interceptResult.base64Count}, blob:${interceptResult.blobCount}, http:${interceptResult.httpCount}`);

                // 检查图片发现数量是否稳定（第一阶段完成）
                if (interceptResult.validCount === lastInterceptedCount) {
                    stableCount++;
                } else {
                    stableCount = 0;
                    lastInterceptedCount = interceptResult.validCount;
                }

                // 如果图片发现数量稳定，开始第二阶段：等待图片加载并获取数据
                if (stableCount >= stableThreshold && interceptResult.validCount > 0) {
                    console.log(`✅ [浏览器 ${currentBrowser.id}] 图片发现阶段完成: ${interceptResult.validCount}张`);

                    // 检查是否达到目标数量，如果达到则开始等待图片完全加载
                    if (targetImageCount && interceptResult.validCount >= targetImageCount) {
                        console.log(`🎯 [浏览器 ${currentBrowser.id}] 已达到目标图片数量: ${interceptResult.validCount}/${targetImageCount}，开始等待图片完全加载...`);

                        // 等待图片完全加载
                        await this.waitForImagesFullyLoaded(currentBrowser);
                    } else {
                        console.log(`⏳ [浏览器 ${currentBrowser.id}] 开始等待图片完全加载...`);
                        await this.waitForImagesFullyLoaded(currentBrowser);
                    }

                    console.log(`🎨 [浏览器 ${currentBrowser.id}] 开始canvas数据获取阶段...`);

                    // 第二阶段：串行获取所有图片数据
                    const fetchResult = await currentBrowser.page.evaluate(async () => {
                        if (window.__fetchAllImageData) {
                            return await window.__fetchAllImageData();
                        }
                        return { successCount: 0, failCount: 0, totalProcessed: 0, logs: [] };
                    });

                    // 显示浏览器端的日志
                    if (fetchResult.logs && fetchResult.logs.length > 0) {
                        // console.log(`📝 [浏览器 ${currentBrowser.id}] 浏览器端日志:`);
                        // for (const log of fetchResult.logs) {
                        //     console.log(`   ${log}`);
                        // }
                    }

                    console.log(`📊 [浏览器 ${currentBrowser.id}] 数据获取完成: 成功${fetchResult.successCount}张, 失败${fetchResult.failCount}张`);

                    // 检查是否达到目标数量
                    if (targetImageCount && fetchResult.successCount >= targetImageCount) {
                        console.log(`✅ [浏览器 ${currentBrowser.id}] 已达到目标图片数量: ${fetchResult.successCount}/${targetImageCount}`);
                    } else if (fetchResult.successCount > 0) {
                        console.log(`✅ [浏览器 ${currentBrowser.id}] 数据获取完成: ${fetchResult.successCount}张`);
                    }

                    return {
                        success: fetchResult.successCount > 0,
                        imageCount: fetchResult.successCount,
                        totalImages: interceptResult.totalCount,
                        dataFetchedCount: fetchResult.totalProcessed,
                        base64Count: interceptResult.base64Count,
                        blobCount: interceptResult.blobCount,
                        httpCount: interceptResult.httpCount
                    };
                }

                // 等待一段时间后重新检查
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // 超时，返回当前状态
            const finalResult = await currentBrowser.page.evaluate(() => {
                const interceptedImages = window.__interceptedImages || [];
                let validCount = 0;
                for (const img of interceptedImages) {
                    if (img.isBase64 || img.isBlob || img.isHttp) {
                        validCount++;
                    }
                }
                return { totalCount: interceptedImages.length, validCount: validCount };
            });

            if (finalResult.validCount > 0) {
                console.log(`⚠️ [浏览器 ${currentBrowser.id}] 等待超时但有部分图片拦截成功: ${finalResult.validCount}张`);
                return {
                    success: true,
                    imageCount: finalResult.validCount,
                    totalImages: finalResult.totalCount
                };
            } else {
                console.log(`❌ [浏览器 ${currentBrowser.id}] 等待超时且无有效图片拦截`);
                return { success: false, imageCount: 0 };
            }

        } finally {
            // 如果没有传入browserInstance（即我们临时获取的），需要释放
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [waitForImageInterception] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    /**
     * 等待所有图片加载完成（支持blob和http），支持刷新重试
     */
    async waitForBlobImagesLoaded(maxWaitTime = 30000, maxRetries = 1, browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`⏳ [浏览器 ${currentBrowser.id}] 等待图片加载（blob+http），最大等待时间: ${maxWaitTime / 1000}秒，最大重试次数: ${maxRetries}`);

        try {
            for (let retry = 0; retry <= maxRetries; retry++) {
                if (retry > 0) {
                    console.log(`🔄 [浏览器 ${currentBrowser.id}] 第 ${retry} 次重试，刷新页面重新加载...`);
                    await currentBrowser.page.reload({ waitUntil: 'domcontentloaded' });

                    // 重新滚动页面
                    console.log(`📜 [浏览器 ${currentBrowser.id}] 重新滚动页面...`);
                    await this.scrollPageToLoadImages(currentBrowser);
                }

                const startTime = Date.now();
                let lastBlobCount = 0;
                let stableCount = 0;
                const stableThreshold = 3; // 减少稳定检查次数
                let hasFailedImages = false;

                while (Date.now() - startTime < maxWaitTime) {
                    // 检查当前图片加载状态 - 只考虑.mh_loading显示的情况
                    const blobResult = await currentBrowser.page.evaluate(() => {
                        const comicPics = document.querySelectorAll('.mh_comicpic');
                        let totalImages = 0;
                        let blobImages = 0;
                        let failedImages = 0;
                        let loadingImages = 0; // 只统计.mh_loading显示的图片
                        let allSrc = []; // 收集所有图片的src
                        let blobSrc = []; // 收集blob图片的src
                        let debugInfo = []; // 调试信息

                        for (let i = 0; i < comicPics.length; i++) {
                            const pic = comicPics[i];
                            const img = pic.querySelector('img');
                            const loadingElement = pic.querySelector('.mh_loading');
                            const errorElement = pic.querySelector('.mh_loaderr');
                            const pValue = pic.getAttribute('p');

                            // 检查是否有加载中元素显示 - 这是唯一的加载中判断标准
                            if (loadingElement) {
                                const loadingStyle = window.getComputedStyle(loadingElement);
                                if (loadingStyle.display !== 'none') {
                                    loadingImages++;
                                    totalImages++; // 加载中的也算入总数
                                    debugInfo.push(`图片${i + 1}(p=${pValue}): 正在加载中(.mh_loading显示)`);
                                    continue;
                                }
                            }

                            // 检查是否有错误元素显示
                            if (errorElement) {
                                const errorStyle = window.getComputedStyle(errorElement);
                                if (errorStyle.display !== 'none') {
                                    failedImages++;
                                    totalImages++; // 失败的也算入总数
                                    debugInfo.push(`图片${i + 1}(p=${pValue}): 加载失败(.mh_loaderr显示)`);
                                    continue;
                                }
                            }

                            // 检查img元素
                            if (img) {
                                totalImages++;
                                const srcValue = img.src || '';
                                allSrc.push(srcValue);

                                debugInfo.push(`图片${i + 1}(p=${pValue}): src="${srcValue.substring(0, 50)}..." complete=${img.complete}`);

                                if (srcValue) {
                                    if (srcValue.startsWith('blob:') || srcValue.startsWith('http')) {
                                        blobImages++; // 现在包括blob和http图片
                                        blobSrc.push(srcValue);
                                    } else if (srcValue.includes('data:') || !img.complete) {
                                        // 只有data:或未完成的图片才算加载中
                                        debugInfo[debugInfo.length - 1] += ' (数据加载中)';
                                    } else {
                                        // 其他类型的图片src
                                        debugInfo[debugInfo.length - 1] += ' (其他类型)';
                                    }
                                } else {
                                    // 无src不算加载中，可能是正常状态
                                    debugInfo[debugInfo.length - 1] += ' (无src-正常)';
                                }
                            } else {
                                // 如果没有img元素，但有.mh_comicpic容器，可能是特殊结构
                                totalImages++;
                                debugInfo.push(`图片${i + 1}(p=${pValue}): 特殊结构，无img元素`);
                                // 无img元素不算加载中
                            }
                        }

                        return {
                            totalImages,
                            blobImages,
                            failedImages,
                            loadingImages,
                            allSrc,
                            blobSrc,
                            debugInfo: debugInfo.slice(0, 10), // 只返回前10个调试信息
                            loadingRate: totalImages > 0 ? (blobImages / totalImages * 100) : 0
                        };
                    });

                    // 输出详细调试信息
                    console.log(`🔍 [浏览器 ${currentBrowser.id}] 图片检测详情:`);
                    console.log(`   总图片: ${blobResult.totalImages}`);
                    console.log(`   可下载图片: ${blobResult.blobImages}`);
                    console.log(`   失败图片: ${blobResult.failedImages}`);
                    console.log(`   加载中: ${blobResult.loadingImages} (仅统计.mh_loading显示)`);
                    console.log(`   所有src数量: ${blobResult.allSrc.length}`);
                    console.log(`   可下载src数量: ${blobResult.blobSrc.length}`);

                    if (blobResult.debugInfo.length > 0) {
                        console.log(`📋 前10张图片详情:`);
                        blobResult.debugInfo.forEach(info => console.log(`     ${info}`));
                    }

                    if (blobResult.blobSrc.length > 0) {
                        console.log(`🔗 blob URLs示例:`);
                        blobResult.blobSrc.slice(0, 3).forEach((src, i) => {
                            console.log(`     ${i + 1}. ${src.substring(0, 80)}...`);
                        });
                    }

                    console.log(`📊 [浏览器 ${currentBrowser.id}] 图片加载进度: ${blobResult.blobImages}/${blobResult.totalImages} (${blobResult.loadingRate.toFixed(1)}%) [.mh_loading显示:${blobResult.loadingImages}, 失败:${blobResult.failedImages}]`);

                    // 如果有加载失败的图片，立即触发重试
                    if (blobResult.failedImages > 0) {
                        console.log(`⚠️ 检测到 ${blobResult.failedImages} 张图片加载失败（.mh_loaderr显示）`);
                        hasFailedImages = true;
                        break; // 跳出当前等待循环，进入重试
                    }

                    // 如果有太多图片还在加载中（只考虑.mh_loading显示），也可能需要刷新
                    if (blobResult.loadingImages > blobResult.totalImages * 0.3) { // 超过30%的图片还在加载
                        console.log(`⚠️ 检测到 ${blobResult.loadingImages} 张图片还在加载中（.mh_loading显示），可能需要刷新`);
                        // 等待更长时间，如果持续太久则触发重试
                        if (Date.now() - startTime > maxWaitTime * 0.7) { // 超过70%的等待时间
                            console.log(`⚠️ 等待时间过长，触发刷新重试`);
                            hasFailedImages = true;
                            break;
                        }
                    }

                    // 检查blob数量是否稳定
                    if (blobResult.blobImages === lastBlobCount) {
                        stableCount++;
                    } else {
                        stableCount = 0;
                        lastBlobCount = blobResult.blobImages;
                    }

                    // 如果所有图片都加载完成，或者数量稳定且加载率较高
                    if (blobResult.loadingRate >= 95 && stableCount >= stableThreshold) {
                        console.log(`✅ 图片加载完成: ${blobResult.blobImages}张 (blob+http)`);
                        return {
                            success: true,
                            imageCount: blobResult.blobImages,
                            totalImages: blobResult.totalImages,
                            loadingRate: blobResult.loadingRate
                        };
                    }

                    // 如果没有正在加载的图片，且有可下载图片，也认为完成
                    if (blobResult.loadingImages === 0 && blobResult.blobImages > 0 && stableCount >= stableThreshold) {
                        console.log(`✅ 所有图片加载完成: ${blobResult.blobImages}张 (无正在加载的图片)`);
                        return {
                            success: true,
                            imageCount: blobResult.blobImages,
                            totalImages: blobResult.totalImages,
                            loadingRate: blobResult.loadingRate
                        };
                    }

                    // 等待一段时间后重新检查
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                // 如果没有失败图片但超时了，也可以尝试重试
                if (!hasFailedImages) {
                    console.log(`⚠️ 等待blob加载超时，但无失败图片`);
                    if (retry === maxRetries) {
                        // 最后一次重试也超时，返回当前状态
                        const finalResult = await currentBrowser.page.evaluate(() => {
                            const comicPics = document.querySelectorAll('.mh_comicpic');
                            let totalImages = 0;
                            let blobImages = 0;

                            for (const pic of comicPics) {
                                const img = pic.querySelector('img');
                                const loadingElement = pic.querySelector('.mh_loading');
                                const errorElement = pic.querySelector('.mh_loaderr');

                                // 跳过正在加载或失败的图片
                                if (loadingElement) {
                                    const loadingStyle = window.getComputedStyle(loadingElement);
                                    if (loadingStyle.display !== 'none') continue;
                                }

                                if (errorElement) {
                                    const errorStyle = window.getComputedStyle(errorElement);
                                    if (errorStyle.display !== 'none') continue;
                                }

                                totalImages++;
                                if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('http'))) {
                                    blobImages++;
                                }
                            }

                            return { totalImages, blobImages };
                        });

                        if (finalResult.blobImages > 0) {
                            console.log(`⚠️ 超时但有部分图片加载成功，继续下载: ${finalResult.blobImages}张`);
                            return {
                                success: true,
                                imageCount: finalResult.blobImages,
                                totalImages: finalResult.totalImages,
                                loadingRate: (finalResult.blobImages / finalResult.totalImages * 100)
                            };
                        }
                    }
                }
            }

            console.log(`❌ [浏览器 ${currentBrowser.id}] 所有重试都失败了`);
            return { success: false, imageCount: 0 };
        } finally {
            // 如果没有传入browserInstance（即我们临时获取的），需要释放
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [waitForBlobImagesLoaded] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    /**
     * 等待图片完全加载 - 新版本：智能等待有高度的图片元素加载
     */
    async waitForImagesFullyLoaded(browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`⏳ [浏览器 ${currentBrowser.id}] 等待图片完全加载...`);

        try {
            const maxRetries = 3; // 最多重试3次
            let retryCount = 0;

            while (retryCount <= maxRetries) {
                if (retryCount > 0) {
                    console.log(`🔄 [浏览器 ${currentBrowser.id}] 第 ${retryCount} 次重试，刷新页面...`);
                    await currentBrowser.page.reload({ waitUntil: 'domcontentloaded' });
                    await new Promise(resolve => setTimeout(resolve, 2000)); // 等待页面稳定
                }

                // 获取页面状态：统计有高度的 mh_comicpic 元素数量
                const pageStatus = await currentBrowser.page.evaluate(() => {
                    const comicPics = document.querySelectorAll('.mh_comicpic');
                    let totalWithHeight = 0;
                    let loadedImages = 0;
                    let elementsInfo = [];

                    for (let i = 0; i < comicPics.length; i++) {
                        const pic = comicPics[i];
                        const rect = pic.getBoundingClientRect();
                        const hasHeight = rect.height > 0;

                        if (hasHeight) {
                            totalWithHeight++;
                            const img = pic.querySelector('img');
                            const hasSrc = img && img.src && !img.src.includes('placeholder') &&
                                (img.src.startsWith('blob:') || img.src.startsWith('http') || img.src.startsWith('data:'));

                            if (hasSrc) {
                                loadedImages++;
                            }

                            elementsInfo.push({
                                index: i,
                                hasHeight: true,
                                hasSrc: hasSrc,
                                src: img ? img.src.substring(0, 50) : 'no-img',
                                rect: { top: rect.top, height: rect.height }
                            });
                        }
                    }

                    return {
                        totalWithHeight,
                        loadedImages,
                        elementsInfo: elementsInfo.slice(0, 10) // 只返回前10个用于调试
                    };
                });

                console.log(`📊 [浏览器 ${currentBrowser.id}] 页面状态:`);
                console.log(`   .mh_comicpic 元素数量: ${pageStatus.totalWithHeight}`);
                console.log(`   已加载图片数量: ${pageStatus.loadedImages}`);

                // 如果已经全部加载完成，直接返回
                if (pageStatus.loadedImages >= pageStatus.totalWithHeight && pageStatus.totalWithHeight > 0) {
                    console.log(`✅ [浏览器 ${currentBrowser.id}] 所有图片已加载完成: ${pageStatus.loadedImages}/${pageStatus.totalWithHeight}`);
                    return;
                }

                // 逐个处理未加载的图片元素
                const success = await this.waitForIndividualImages(currentBrowser, pageStatus.totalWithHeight);

                if (success) {
                    console.log(`✅ [浏览器 ${currentBrowser.id}] 图片加载完成`);
                    return;
                } else {
                    retryCount++;
                    if (retryCount <= maxRetries) {
                        console.log(`❌ [浏览器 ${currentBrowser.id}] 图片加载失败，准备重试 ${retryCount}/${maxRetries}`);
                    }
                }
            }

            console.log(`⚠️ [浏览器 ${currentBrowser.id}] 达到最大重试次数，图片加载可能不完整`);
        } finally {
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [waitForImagesFullyLoaded] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    /**
     * 逐个等待图片加载 - 滚动到未加载图片位置并等待
     */
    async waitForIndividualImages(browserInstance, totalExpected) {
        const currentBrowser = browserInstance;
        console.log(`🎯 [浏览器 ${currentBrowser.id}] 开始逐个等待图片加载，预期总数: ${totalExpected}`);

        let consecutiveFailures = 0;
        const maxConsecutiveFailures = 3;

        while (consecutiveFailures < maxConsecutiveFailures) {
            // 查找下一个需要加载的图片
            const nextUnloadedImage = await currentBrowser.page.evaluate(() => {
                const comicPics = document.querySelectorAll('.mh_comicpic');

                for (let i = 0; i < comicPics.length; i++) {
                    const pic = comicPics[i];
                    const rect = pic.getBoundingClientRect();

                    // 只处理有高度的元素
                    if (rect.height > 0) {
                        const img = pic.querySelector('img');
                        const hasSrc = img && img.src && !img.src.includes('placeholder') &&
                            (img.src.startsWith('blob:') || img.src.startsWith('http') || img.src.startsWith('data:'));

                        if (!hasSrc) {
                            return {
                                index: i,
                                top: rect.top + window.scrollY,
                                height: rect.height,
                                hasImg: !!img,
                                currentSrc: img ? img.src : 'no-img'
                            };
                        }
                    }
                }
                return null;
            });

            if (!nextUnloadedImage) {
                // 没有找到未加载的图片，检查总体完成情况
                const finalStatus = await currentBrowser.page.evaluate(() => {
                    const comicPics = document.querySelectorAll('.mh_comicpic');
                    let totalWithHeight = 0;
                    let loadedImages = 0;

                    for (const pic of comicPics) {
                        const rect = pic.getBoundingClientRect();
                        if (rect.height > 0) {
                            totalWithHeight++;
                            const img = pic.querySelector('img');
                            const hasSrc = img && img.src && !img.src.includes('placeholder') &&
                                (img.src.startsWith('blob:') || img.src.startsWith('http') || img.src.startsWith('data:'));
                            if (hasSrc) {
                                loadedImages++;
                            }
                        }
                    }

                    return { totalWithHeight, loadedImages };
                });

                console.log(`✅ [浏览器 ${currentBrowser.id}] 所有图片处理完成: ${finalStatus.loadedImages}/${finalStatus.totalWithHeight}`);
                return finalStatus.loadedImages >= finalStatus.totalWithHeight;
            }

            console.log(`🎯 [浏览器 ${currentBrowser.id}] 发现未加载图片 ${nextUnloadedImage.index + 1}，滚动到位置: ${nextUnloadedImage.top}`);

            // 滚动到该图片位置
            await currentBrowser.page.evaluate((top) => {
                window.scrollTo({
                    top: top - window.innerHeight / 2, // 滚动到屏幕中央
                    behavior: 'smooth'
                });
            }, nextUnloadedImage.top);

            // 等待滚动完成
            await new Promise(resolve => setTimeout(resolve, 1000));

            // 等待图片加载，每3秒检查一次，最多等待3次（9秒）
            let imageLoaded = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`⏳ [浏览器 ${currentBrowser.id}] 等待图片 ${nextUnloadedImage.index + 1} 加载... (${attempt}/3)`);

                await new Promise(resolve => setTimeout(resolve, 3000)); // 等待3秒

                // 检查图片是否已加载
                const loadResult = await currentBrowser.page.evaluate((index) => {
                    const comicPics = document.querySelectorAll('.mh_comicpic');
                    if (index < comicPics.length) {
                        const pic = comicPics[index];
                        const img = pic.querySelector('img');
                        const hasSrc = img && img.src && !img.src.includes('placeholder') &&
                            (img.src.startsWith('blob:') || img.src.startsWith('http') || img.src.startsWith('data:'));

                        return {
                            loaded: hasSrc,
                            src: img ? img.src.substring(0, 50) : 'no-img'
                        };
                    }
                    return { loaded: false, src: 'not-found' };
                }, nextUnloadedImage.index);

                if (loadResult.loaded) {
                    console.log(`✅ [浏览器 ${currentBrowser.id}] 图片 ${nextUnloadedImage.index + 1} 加载成功`);
                    imageLoaded = true;
                    consecutiveFailures = 0; // 重置连续失败计数
                    break;
                } else {
                    console.log(`⏳ [浏览器 ${currentBrowser.id}] 图片 ${nextUnloadedImage.index + 1} 尚未加载，继续等待...`);
                }
            }

            if (!imageLoaded) {
                consecutiveFailures++;
                console.log(`❌ [浏览器 ${currentBrowser.id}] 图片 ${nextUnloadedImage.index + 1} 加载失败，连续失败次数: ${consecutiveFailures}/${maxConsecutiveFailures}`);

                if (consecutiveFailures >= maxConsecutiveFailures) {
                    console.log(`❌ [浏览器 ${currentBrowser.id}] 连续失败次数过多，停止等待`);
                    return false;
                }
            }
        }

        return false;
    }

    /**
     * 下载拦截到的图片（使用拦截到的 base64/blob/http 数据）
     */
    async downloadInterceptedImages(chapterDir, browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`💾 [浏览器 ${currentBrowser.id}] 开始下载拦截到的图片...`);

        try {
            // 获取所有拦截到的图片信息（包括日志信息）
            const interceptedImages = await currentBrowser.page.evaluate(() => {
                const images = window.__interceptedImages || [];
                return images.filter(img => img.dataFetched && img.imageData && img.imageData.success)
                    .sort((a, b) => a.order - b.order);
            });

            console.log(`🔍 [浏览器 ${currentBrowser.id}] 找到 ${interceptedImages.length} 张已获取数据的图片`);

            // 显示从浏览器端传递过来的日志信息
            if (interceptedImages.length > 0) {
                // console.log(`📝 [浏览器 ${currentBrowser.id}] 浏览器端日志:`);
                // for (const imageInfo of interceptedImages) {
                //     if (imageInfo.logMessage) {
                //         console.log(`   ${imageInfo.logMessage}`);
                //     }
                // }
            }

            if (interceptedImages.length === 0) {
                console.log(`⚠️ 未找到任何已获取数据的图片`);
                return 0;
            }

            // 统计图片类型
            const base64Count = interceptedImages.filter(img => img.isBase64).length;
            const blobCount = interceptedImages.filter(img => img.isBlob).length;
            const httpCount = interceptedImages.filter(img => img.isHttp).length;
            console.log(`📊 图片类型统计: base64=${base64Count}, blob=${blobCount}, http=${httpCount}`);

            // 下载图片
            let downloadedCount = 0;
            let skippedCount = 0;
            let failedCount = 0;
            let smallImageCount = 0;

            for (const imageInfo of interceptedImages) {
                try {
                    // 生成文件名，保存为 PNG 格式
                    const fileName = `${imageInfo.order}.png`;
                    const filePath = path.join(chapterDir, fileName);

                    // 检查文件是否已存在且大小合格
                    if (await fs.pathExists(filePath)) {
                        if (await this.isImageSizeValid(filePath, 5)) {
                            console.log(`⏭️ 文件已存在且合格，跳过: ${fileName}`);
                            skippedCount++;
                            continue;
                        } else {
                            // 文件存在但太小，删除后重新下载
                            await fs.remove(filePath);
                            console.log(`🗑️ 删除小图片文件，准备重新下载: ${fileName}`);
                        }
                    }

                    const imageType = imageInfo.isBase64 ? 'base64' : imageInfo.isBlob ? 'blob' : 'http';
                    console.log(`📸 下载${imageType}图片: ${fileName}`);

                    let buffer = null;

                    // 直接使用已获取的图片数据
                    try {
                        if (imageInfo.imageData && imageInfo.imageData.success) {
                            buffer = Buffer.from(imageInfo.imageData.data, 'base64');
                            console.log(`📦 使用已获取的数据: ${fileName} (${(buffer.length / 1024).toFixed(1)}KB)`);
                        } else {
                            console.error(`❌ 图片数据无效: ${fileName}`);
                            failedCount++;
                            continue;
                        }
                    } catch (error) {
                        console.error(`❌ 处理图片数据失败: ${fileName} - ${error.message}`);
                        failedCount++;
                        continue;
                    }

                    if (buffer && buffer.length > 0) {
                        const sizeKB = buffer.length / 1024;

                        // 检查下载的图片大小
                        if (sizeKB < 0) {
                            console.log(`⚠️ 图片太小，跳过保存: ${fileName} (${sizeKB.toFixed(1)} KB < 5KB)`);
                            smallImageCount++;
                            continue;
                        }

                        await fs.writeFile(filePath, buffer);
                        console.log(`💾 保存成功: ${fileName} (${sizeKB.toFixed(1)} KB, ${imageType})`);
                        downloadedCount++;
                    } else {
                        console.error(`❌ 下载失败，数据为空: ${fileName}`);
                        failedCount++;
                    }

                } catch (error) {
                    console.error(`❌ 下载图片失败 (order=${imageInfo.order}): ${error.message}`);
                    failedCount++;
                }
            }

            console.log(`✅ [浏览器 ${currentBrowser.id}] 拦截图片下载完成统计:`);
            console.log(`   - 成功下载: ${downloadedCount} 张`);
            console.log(`   - 跳过已存在: ${skippedCount} 张`);
            console.log(`   - 下载失败: ${failedCount} 张`);
            console.log(`   - 跳过小图片: ${smallImageCount} 张 (< 5KB)`);
            console.log(`   - 总计处理: ${interceptedImages.length} 张 (base64=${base64Count}, blob=${blobCount}, http=${httpCount})`);

            return downloadedCount;
        } finally {
            // 如果没有传入browserInstance（即我们临时获取的），需要释放
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [downloadInterceptedImages] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    /**
     * 下载所有图片（使用浏览器内HTTP下载）
     */
    async downloadBlobImages(chapterDir, browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`💾 [浏览器 ${currentBrowser.id}] 开始下载图片（使用浏览器内HTTP下载）...`);

        try {
            // 获取所有可下载图片信息 - 支持blob和http，排除加载中和失败的
            const downloadableImages = await currentBrowser.page.evaluate(() => {
                const comicPics = document.querySelectorAll('.mh_comicpic');
                const images = [];

                for (let i = 0; i < comicPics.length; i++) {
                    const pic = comicPics[i];
                    const img = pic.querySelector('img');
                    const loadingElement = pic.querySelector('.mh_loading');
                    const errorElement = pic.querySelector('.mh_loaderr');
                    const pValue = pic.getAttribute('p');

                    // 跳过正在加载的图片
                    if (loadingElement) {
                        const loadingStyle = window.getComputedStyle(loadingElement);
                        if (loadingStyle.display !== 'none') {
                            console.log(`跳过加载中的图片: p=${pValue}`);
                            continue;
                        }
                    }

                    // 跳过加载失败的图片
                    if (errorElement) {
                        const errorStyle = window.getComputedStyle(errorElement);
                        if (errorStyle.display !== 'none') {
                            console.log(`跳过加载失败的图片: p=${pValue}`);
                            continue;
                        }
                    }

                    if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('http'))) {
                        // 优先使用p属性作为顺序，如果没有则使用索引+1
                        const order = pValue ? parseInt(pValue) : (i + 1);

                        if (order > 0) {
                            images.push({
                                imageUrl: img.src,
                                order: order,
                                element: pic,
                                isBlob: img.src.startsWith('blob:'),
                                isHttp: img.src.startsWith('http')
                            });
                        }
                    }
                }

                return images.sort((a, b) => a.order - b.order);
            });

            console.log(`🔍 找到 ${downloadableImages.length} 张可下载图片`);

            if (downloadableImages.length === 0) {
                console.log(`⚠️ 未找到任何可下载图片`);
                return 0;
            }

            // 统计图片类型
            const blobCount = downloadableImages.filter(img => img.isBlob).length;
            const httpCount = downloadableImages.filter(img => img.isHttp).length;
            console.log(`📊 图片类型统计: blob=${blobCount}, http=${httpCount}`);

            // 下载图片
            let downloadedCount = 0;
            let skippedCount = 0;
            let failedCount = 0;
            let smallImageCount = 0; // 小图片计数

            for (const imageInfo of downloadableImages) {
                try {
                    // 生成文件名，统一使用 PNG 格式
                    const originalExtension = this.getImageExtension();
                    const fileName = `${imageInfo.order}.${originalExtension}`;
                    const filePath = path.join(chapterDir, fileName);

                    // 检查文件是否已存在且大小合格
                    if (await fs.pathExists(filePath)) {
                        if (await this.isImageSizeValid(filePath, 5)) {
                            console.log(`⏭️ 文件已存在且合格，跳过: ${fileName}`);
                            skippedCount++;
                            continue;
                        } else {
                            // 文件存在但太小，删除后重新下载
                            await fs.remove(filePath);
                            console.log(`🗑️ 删除小图片文件，准备重新下载: ${fileName}`);
                        }
                    }

                    const imageType = imageInfo.isBlob ? 'blob' : 'http';
                    // console.log(`📸 下载${imageType}图片: ${fileName}`);

                    // 使用浏览器内HTTP下载
                    const buffer = await this.downloadImageInBrowser(imageInfo, currentBrowser);

                    if (buffer && buffer.length > 0) {
                        const sizeKB = buffer.length / 1024;

                        // 检查下载的图片大小
                        if (sizeKB < 0) {
                            console.log(`⚠️ 图片太小，跳过保存: ${fileName} (${sizeKB.toFixed(1)} KB < 5KB)`);
                            smallImageCount++;
                            continue;
                        }

                        await fs.writeFile(filePath, buffer);
                        console.log(`💾 保存成功: ${fileName} (${sizeKB.toFixed(1)} KB, ${imageType})`);
                        downloadedCount++;
                    } else {
                        console.error(`❌ 下载失败，数据为空: ${fileName}`);
                        failedCount++;
                    }

                } catch (error) {
                    console.error(`❌ 下载图片失败 (order=${imageInfo.order}): ${error.message}`);
                    failedCount++;
                }
            }

            console.log(`✅ [浏览器 ${currentBrowser.id}] 图片下载完成统计:`);
            console.log(`   - 成功下载: ${downloadedCount} 张`);
            console.log(`   - 跳过已存在: ${skippedCount} 张`);
            console.log(`   - 下载失败: ${failedCount} 张`);
            console.log(`   - 跳过小图片: ${smallImageCount} 张 (< 5KB)`);
            console.log(`   - 总计处理: ${downloadableImages.length} 张 (blob=${blobCount}, http=${httpCount})`);

            return downloadedCount;
        } finally {
            // 如果没有传入browserInstance（即我们临时获取的），需要释放
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [downloadBlobImages] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    // ==================== 漫画信息获取 ====================

    /**
     * 获取漫画简介信息
     */
    async getMangaInfo(mangaId, mangaDir, browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();

        try {
            const mangaUrl = `https://www.colamanga.com/manga-${mangaId}/`;
            console.log(`🔗 [浏览器 ${currentBrowser.id}] 访问漫画详情页: ${mangaUrl}`);

            // 导航到漫画详情页
            await currentBrowser.page.goto(mangaUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            // 等待页面加载
            await currentBrowser.page.waitForSelector('.fed-part-layout.fed-part-rows.fed-back-whits', { timeout: 10000 });

            // 提取漫画信息
            const mangaInfo = await currentBrowser.page.evaluate(() => {
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

                // 提取封面图片URL
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
            console.log(`❌ [浏览器 ${currentBrowser.id}] 获取漫画信息失败: ${error.message}`);
            return null;
        } finally {
            // 如果没有传入browserInstance（即我们临时获取的），需要释放
            if (!browserInstance && currentBrowser) {
                this.releaseBrowserInstance(currentBrowser);
                console.log(`🔓 [getMangaInfo] 释放临时获取的浏览器实例: ${currentBrowser.id}`);
            }
        }
    }

    /**
     * 下载封面图片
     */
    async downloadCoverImage(coverUrl, mangaDir) {
        try {
            console.log(`📥 开始下载封面图片: ${coverUrl}`);

            // 统一使用 PNG 格式保存封面
            const coverFileName = `cover.png`;
            const coverPath = path.join(mangaDir, coverFileName);

            // 检查文件是否已存在
            if (await fs.pathExists(coverPath)) {
                console.log(`⏭️ 封面已存在，跳过下载: ${coverFileName}`);
                return coverFileName;
            }

            // 使用Playwright的request API下载
            try {
                // 使用第一个可用的浏览器实例进行请求
                const browserInstance = this.browserInstances[0] || await this.acquireBrowserInstance();
                const response = await browserInstance.page.request.get(coverUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Referer': 'https://www.colamanga.com/',
                        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
                    },
                    timeout: 15000
                });

                if (response.ok()) {
                    const buffer = await response.body();
                    await fs.writeFile(coverPath, buffer);

                    console.log(`💾 封面下载成功: ${coverFileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
                    return coverFileName;
                } else {
                    console.log(`⚠️ 封面下载失败: HTTP ${response.status()}`);
                }
            } catch (downloadError) {
                console.log(`⚠️ 封面下载失败: ${downloadError.message}`);
            }

            return null;

        } catch (error) {
            console.log(`❌ 下载封面图片失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 文件名清理工具
     */
    sanitizeFileName(fileName) {
        return fileName.replace(/[<>:"/\\|?*]/g, '_').trim();
    }

    /**
     * 检查图片文件大小是否合格（大于等于5KB）
     */
    async isImageSizeValid(filePath, minSizeKB = 0) {
        try {
            if (!(await fs.pathExists(filePath))) {
                return false;
            }
            const stats = await fs.stat(filePath);
            const sizeKB = stats.size / 1024;
            return sizeKB >= minSizeKB;
        } catch (error) {
            console.log(`⚠️ 检查文件大小失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 清理章节目录中的小图片文件（小于5KB）
     */
    async cleanupSmallImages(chapterDir, minSizeKB = 0) {
        try {
            if (!(await fs.pathExists(chapterDir))) {
                return { deletedCount: 0, totalChecked: 0 };
            }

            const files = await fs.readdir(chapterDir);
            const imageFiles = files.filter(file =>
                /\.(png|jpg|jpeg|webp)$/i.test(file)
            );

            let deletedCount = 0;
            let totalChecked = imageFiles.length;

            console.log(`🧹 开始清理小图片文件 (< ${minSizeKB}KB): 检查 ${totalChecked} 个文件`);

            for (const file of imageFiles) {
                const filePath = path.join(chapterDir, file);
                const stats = await fs.stat(filePath);
                const sizeKB = stats.size / 1024;

                if (sizeKB < minSizeKB) {
                    await fs.remove(filePath);
                    console.log(`🗑️ 删除小图片: ${file} (${sizeKB.toFixed(1)}KB < ${minSizeKB}KB)`);
                    deletedCount++;
                }
            }

            console.log(`✅ 清理完成: 删除 ${deletedCount}/${totalChecked} 个小图片文件`);
            return { deletedCount, totalChecked };

        } catch (error) {
            console.error(`❌ 清理小图片失败: ${error.message}`);
            return { deletedCount: 0, totalChecked: 0 };
        }
    }

    /**
     * 标准化图片文件名（处理 1-xxxx.png 格式，重命名为 1.png）
     */
    async normalizeImageFileNames(chapterDir) {
        try {
            if (!(await fs.pathExists(chapterDir))) {
                return { renamedCount: 0, totalChecked: 0 };
            }

            const files = await fs.readdir(chapterDir);
            const imageFiles = files.filter(file =>
                /\.(png|jpg|jpeg|webp)$/i.test(file)
            );

            let renamedCount = 0;
            let totalChecked = imageFiles.length;

            console.log(`📝 开始标准化文件名: 检查 ${totalChecked} 个文件`);

            for (const file of imageFiles) {
                // 匹配 数字-任意字符.扩展名 的格式
                const match = file.match(/^(\d+)-.*\.([^.]+)$/i);
                if (match) {
                    const pageNumber = match[1];
                    const extension = match[2];
                    const newFileName = `${pageNumber}.${extension}`;

                    const oldPath = path.join(chapterDir, file);
                    const newPath = path.join(chapterDir, newFileName);

                    // 检查新文件名是否已存在
                    if (!(await fs.pathExists(newPath))) {
                        await fs.move(oldPath, newPath);
                        console.log(`📝 重命名: ${file} → ${newFileName}`);
                        renamedCount++;
                    } else {
                        console.log(`⚠️ 目标文件已存在，跳过重命名: ${file} → ${newFileName}`);
                    }
                }
            }

            console.log(`✅ 文件名标准化完成: 重命名 ${renamedCount}/${totalChecked} 个文件`);
            return { renamedCount, totalChecked };

        } catch (error) {
            console.error(`❌ 标准化文件名失败: ${error.message}`);
            return { renamedCount: 0, totalChecked: 0 };
        }
    }

    /**
     * 获取图片URL的扩展名
     */
    getImageExtension() {
        // 统一使用 PNG 格式，忽略原始格式
        return 'png';
    }

    /**
     * 在浏览器内下载图片（支持blob和http）
     */
    async downloadImageInBrowser(imageInfo, browserInstance) {
        try {
            const { imageUrl, order, isBlob } = imageInfo;

            // 在浏览器内执行下载
            const imageData = await browserInstance.page.evaluate(async (params) => {
                const { url, isBlob } = params;
                try {
                    let response;

                    if (isBlob) {
                        // 对于blob URL，直接fetch
                        response = await fetch(url);
                    } else {
                        // 对于http URL，使用fetch并设置适当的headers
                        response = await fetch(url, {
                            method: 'GET',
                            headers: {
                                'Accept': 'image/*,*/*;q=0.8',
                                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                                'Cache-Control': 'no-cache',
                                'Pragma': 'no-cache',
                                'Sec-Fetch-Dest': 'image',
                                'Sec-Fetch-Mode': 'no-cors',
                                'Sec-Fetch-Site': 'cross-site'
                            },
                            mode: 'cors',
                            credentials: 'omit'
                        });
                    }

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }

                    // 获取图片数据
                    const arrayBuffer = await response.arrayBuffer();

                    // 转换为base64以便传输
                    const uint8Array = new Uint8Array(arrayBuffer);
                    let binary = '';
                    for (let i = 0; i < uint8Array.length; i++) {
                        binary += String.fromCharCode(uint8Array[i]);
                    }
                    const base64 = btoa(binary);

                    return {
                        success: true,
                        data: base64,
                        size: arrayBuffer.byteLength,
                        contentType: response.headers.get('content-type') || 'image/jpeg'
                    };

                } catch (error) {
                    console.error(`浏览器内下载失败: ${error.message}`);
                    return {
                        success: false,
                        error: error.message
                    };
                }
            }, { url: imageUrl, isBlob });

            if (imageData.success) {
                // 将base64转换回buffer
                const buffer = Buffer.from(imageData.data, 'base64');
                console.log(`✅ 浏览器内下载成功: order=${order}, size=${(buffer.length / 1024).toFixed(1)}KB, type=${imageData.contentType}`);
                return buffer;
            } else {
                console.error(`❌ 浏览器内下载失败: order=${order}, error=${imageData.error}`);
                return null;
            }

        } catch (error) {
            console.error(`❌ 下载图片异常 (order=${imageInfo.order}): ${error.message}`);
            return null;
        }
    }
}

module.exports = { MangaContentDownloader };
