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

        // 并行配置
        this.parallelConfig = {
            enabled: true, // 默认启用并行，除非明确设置为false
            maxConcurrent: 2, // 最大并发漫画数
            retryAttempts:  2,
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
            totalErrors: 0
        };

        console.log(`🔧 漫画下载器初始化完成 - 并行模式: ${this.parallelConfig.enabled ? '启用' : '禁用'}, 最大并发: ${this.parallelConfig.maxConcurrent}`);
    }

    /**
     * 初始化浏览器实例池
     */
    async init() {
        console.log('🚀 初始化浏览器实例池...');

        // 确保输出目录存在
        await fs.ensureDir(this.outputDir);

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
            headless: false,
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
                        } catch (e) {}
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
        const mangaList = await fs.readJson(mangaListFile);
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

            // 检查章节是否已完成
            if (await this.isChapterComplete(chapterDir)) {
                console.log(`✅ [浏览器 ${currentBrowser.id}] 章节已完整下载，跳过重复下载`);
                return true;
            }

            // 核心下载流程：滚动页面 -> 等待图片加载 -> 下载图片
            console.log(`🆕 [浏览器 ${currentBrowser.id}] 开始下载章节`);
            return await this.downloadChapterImages(chapterDir, 2, currentBrowser);

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
     * 检查章节是否已完成下载
     */
    async isChapterComplete(chapterDir) {
        try {
            // 检查目录是否存在
            if (!(await fs.pathExists(chapterDir))) {
                return false;
            }

            // 检查是否有图片文件
            const files = await fs.readdir(chapterDir);
            const imageFiles = files.filter(file =>
                /\.(png|jpg|jpeg|webp)$/i.test(file)
            );

            // 如果有10张以上图片，认为章节基本完成
            return imageFiles.length >= 10;
        } catch (error) {
            console.log(`⚠️ 检查章节完整性失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 下载章节图片 - 核心流程，支持重试
     */
    async downloadChapterImages(chapterDir, maxRetries = 2, browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();

        try {
            for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
                try {
                    if (attempt > 1) {
                        console.log(`🔄 [浏览器 ${currentBrowser.id}] 第 ${attempt - 1} 次重试下载章节图片...`);
                    }

                    console.log(`🔄 [浏览器 ${currentBrowser.id}] 开始章节图片下载流程 (尝试 ${attempt}/${maxRetries + 1})`);

                    // 1. 等待页面内容加载
                    await currentBrowser.page.waitForSelector('.mh_comicpic', { timeout: 15000 });

                    // 2. 滚动页面，触发所有懒加载
                    console.log(`📜 [浏览器 ${currentBrowser.id}] 开始滚动页面，触发懒加载...`);
                    await this.scrollPageToLoadImages(currentBrowser);

                    // 3. 等待所有图片加载完成（内置重试机制，支持blob和http）
                    console.log(`⏳ [浏览器 ${currentBrowser.id}] 等待图片加载完成...`);
                    const loadResult = await this.waitForBlobImagesLoaded(30000, 1, currentBrowser); // 30秒超时，1次重试

                    if (!loadResult.success) {
                        console.log(`❌ [浏览器 ${currentBrowser.id}] 图片加载失败或不完整`);
                        if (attempt <= maxRetries) {
                            console.log(`🔄 [浏览器 ${currentBrowser.id}] 准备重试整个下载流程...`);
                            await new Promise(resolve => setTimeout(resolve, 3000)); // 等待3秒后重试
                            continue;
                        } else {
                            return false;
                        }
                    }

                    console.log(`✅ [浏览器 ${currentBrowser.id}] 检测到 ${loadResult.imageCount} 张可下载图片`);

                    // 4. 下载所有图片（blob和http）
                    console.log(`💾 [浏览器 ${currentBrowser.id}] 开始下载图片...`);
                    const downloadedCount = await this.downloadBlobImages(chapterDir, currentBrowser);

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
     * 滚动页面以触发所有懒加载，修复版本
     */
    async scrollPageToLoadImages(browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`📜 [浏览器 ${currentBrowser.id}] 开始持续滚动直到所有图片加载...`);

        try {
            let lastImageCount = 0;
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

                console.log(`📊 [浏览器 ${currentBrowser.id}] 滚动第${scrollAttempts + 1}次 (步长1500px): 发现 ${currentImageCount} 张图片 (滚动位置: ${scrollInfo.currentScroll})`);

                // 检查是否有新图片出现
                if (currentImageCount > lastImageCount) {
                    const newImages = currentImageCount - lastImageCount;
                    console.log(`📈 [浏览器 ${currentBrowser.id}] 新增 ${newImages} 张图片`);
                    noNewImagesCount = 0; // 重置计数器
                    lastImageCount = currentImageCount;
                } else {
                    noNewImagesCount++;
                    console.log(`⏳ [浏览器 ${currentBrowser.id}] 连续 ${noNewImagesCount}/${noNewImagesThreshold} 次没有新图片`);

                    // 如果连续多次没有新图片，且已经滚动到底部，认为完成
                    if (noNewImagesCount >= noNewImagesThreshold) {
                        console.log(`✅ [浏览器 ${currentBrowser.id}] 连续${noNewImagesThreshold}次没有新图片，滚动完成`);
                        console.log(`📊 [浏览器 ${currentBrowser.id}] 最终发现 ${currentImageCount} 张图片`);
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

        console.log(`📋 前5个 .mh_comicpic 元素:`);
        pageStatus.sampleElements.forEach(el => {
            const status = el.isLoading ? '[加载中]' : el.hasError ? '[失败]' : '[正常]';
            console.log(`     ${el.index+1}. p=${el.pValue}, hasImg=${el.hasImg}, ${status}, src="${el.imgSrc}", complete=${el.imgComplete}`);
        });

            console.log(`📋 前5个 img 元素:`);
            pageStatus.sampleImgs.forEach(img => {
                console.log(`     ${img.index+1}. src="${img.src}", complete=${img.complete}, isBlob=${img.isBlob}`);
            });

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
                                debugInfo.push(`图片${i+1}(p=${pValue}): 正在加载中(.mh_loading显示)`);
                                continue;
                            }
                        }

                        // 检查是否有错误元素显示
                        if (errorElement) {
                            const errorStyle = window.getComputedStyle(errorElement);
                            if (errorStyle.display !== 'none') {
                                failedImages++;
                                totalImages++; // 失败的也算入总数
                                debugInfo.push(`图片${i+1}(p=${pValue}): 加载失败(.mh_loaderr显示)`);
                                continue;
                            }
                        }

                        // 检查img元素
                        if (img) {
                            totalImages++;
                            const srcValue = img.src || '';
                            allSrc.push(srcValue);

                            debugInfo.push(`图片${i+1}(p=${pValue}): src="${srcValue.substring(0, 50)}..." complete=${img.complete}`);

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
                            debugInfo.push(`图片${i+1}(p=${pValue}): 特殊结构，无img元素`);
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
                        console.log(`     ${i+1}. ${src.substring(0, 80)}...`);
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
     * 下载所有图片（支持blob和http）
     */
    async downloadBlobImages(chapterDir, browserInstance = null) {
        const currentBrowser = browserInstance || await this.acquireBrowserInstance();
        console.log(`💾 [浏览器 ${currentBrowser.id}] 开始下载图片（支持blob和http）...`);

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

        for (const imageInfo of downloadableImages) {
            try {
                // 生成文件名
                const fileName = `${imageInfo.order}.png`;
                const filePath = path.join(chapterDir, fileName);

                // 检查文件是否已存在
                if (await fs.pathExists(filePath)) {
                    console.log(`⏭️ 文件已存在，跳过: ${fileName}`);
                    skippedCount++;
                    continue;
                }

                const imageType = imageInfo.isBlob ? 'blob' : 'http';
                console.log(`📸 下载${imageType}图片: ${fileName}`);

                // 使用元素截图方式下载（对blob和http都有效）
                const imgSelector = `.mh_comicpic[p="${imageInfo.order}"] img`;
                const imgElement = await currentBrowser.page.$(imgSelector);

                if (imgElement) {
                    const buffer = await imgElement.screenshot({
                        type: 'png',
                        omitBackground: false
                    });

                    await fs.writeFile(filePath, buffer);
                    console.log(`💾 保存成功: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB, ${imageType})`);
                    downloadedCount++;
                } else {
                    console.error(`❌ 未找到图片元素: p=${imageInfo.order}`);
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
}

module.exports = { MangaContentDownloader };