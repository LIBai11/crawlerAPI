const fs = require('fs-extra');
const path = require('path');
const { MangaContentDownloader } = require('./download-manga-content');

/**
 * 漫画缺失内容补充器
 * 功能：
 * 1. 扫描现有漫画目录结构，识别已下载的章节和图片
 * 2. 读取 manga-chapter-total-pages.json 文件，获取完整章节信息
 * 3. 对比现有文件与完整信息，识别缺失的章节和图片
 * 4. 下载缺失的内容来补齐漫画
 */
class MangaGapFiller {
    constructor(options = {}) {
        // 使用相对路径或环境变量，避免硬编码
        this.outputDir = options.outputDir || process.env.MANGA_OUTPUT_DIR || path.join('/Users/likaixuan/Documents/manga');
        this.chapterTotalPagesFile = options.chapterTotalPagesFile || path.join(this.outputDir, 'manga-chapter-total-pages.json');

        // 初始化下载器
        this.downloader = new MangaContentDownloader({
            chapterTotalPagesFile: this.chapterTotalPagesFile
        });

        // 数据存储
        this.existingContent = new Map(); // 现有内容映射
        this.completeInfo = new Map();    // 完整信息映射
        this.missingContent = [];         // 缺失内容清单

        // 统计信息
        this.stats = {
            totalMangas: 0,
            scannedMangas: 0,
            mangasWithMissingContent: 0,
            missingChapters: 0,
            incompleteChapters: 0,
            totalMissingImages: 0
        };
    }

    /**
     * 初始化
     */
    async init() {
        console.log('🚀 初始化漫画缺失内容补充器...');

        // 确保输出目录存在
        await fs.ensureDir(this.outputDir);
        console.log(`📁 输出目录: ${this.outputDir}`);

        // 初始化下载器
        await this.downloader.init();

        console.log('✅ 初始化完成');
    }

    /**
     * 扫描现有漫画内容
     */
    async scanExistingContent() {
        console.log('\n🔍 开始扫描现有漫画内容...');

        try {
            const entries = await fs.readdir(this.outputDir);
            const mangaDirs = [];

            // 过滤出漫画目录（排除文件）
            for (const entry of entries) {
                const entryPath = path.join(this.outputDir, entry);
                const stat = await fs.stat(entryPath);
                if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
                    mangaDirs.push(entry);
                }
            }

            console.log(`📚 发现 ${mangaDirs.length} 个漫画目录`);

            // 扫描每个漫画目录
            for (const mangaDir of mangaDirs) {
                await this.scanSingleManga(mangaDir);
                this.stats.scannedMangas++;
            }

            console.log(`✅ 扫描完成: ${this.stats.scannedMangas} 个漫画`);

        } catch (error) {
            console.error(`❌ 扫描现有内容失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 扫描单个漫画目录
     */
    async scanSingleManga(mangaDirName) {
        const mangaPath = path.join(this.outputDir, mangaDirName);

        try {
            const entries = await fs.readdir(mangaPath);
            const chapterDirs = entries.filter(entry =>
                entry.startsWith('第') && entry.includes('章')
            );

            const mangaContent = {
                name: mangaDirName,
                chapters: new Map()
            };

            // 扫描每个章节目录
            for (const chapterDir of chapterDirs) {
                const chapterMatch = chapterDir.match(/第(\d+)章/);
                if (chapterMatch) {
                    const chapterNum = parseInt(chapterMatch[1]);
                    const imageCount = await this.countValidImages(path.join(mangaPath, chapterDir));
                    mangaContent.chapters.set(chapterNum, imageCount);
                }
            }

            // 尝试从漫画信息文件中获取漫画ID
            const mangaId = await this.getMangaIdFromInfo(mangaPath, mangaDirName);
            if (mangaId) {
                this.existingContent.set(mangaId, mangaContent);
                console.log(`📖 扫描漫画: ${mangaDirName} (ID: ${mangaId}) - ${mangaContent.chapters.size} 个章节`);
            } else {
                console.log(`⚠️ 无法获取漫画ID: ${mangaDirName}`);
            }

        } catch (error) {
            console.log(`⚠️ 扫描漫画目录失败: ${mangaDirName} - ${error.message}`);
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
     * 统计目录中的有效图片数量
     */
    async countValidImages(chapterPath) {
        try {
            if (!(await fs.pathExists(chapterPath))) {
                return 0;
            }

            const files = await fs.readdir(chapterPath);
            const imageFiles = files.filter(file =>
                /\.(png|jpg|jpeg|webp)$/i.test(file)
            );

            let validCount = 0;
            for (const file of imageFiles) {
                const filePath = path.join(chapterPath, file);
                if (await this.downloader.isImageSizeValid(filePath, 5)) {
                    validCount++;
                }
            }

            return validCount;

        } catch (error) {
            console.log(`⚠️ 统计图片失败: ${chapterPath} - ${error.message}`);
            return 0;
        }
    }

    /**
     * 从漫画信息文件中获取漫画ID
     */
    async getMangaIdFromInfo(mangaPath, mangaDirName) {
        try {
            // 首先尝试从漫画目录下的 manga-info.json 文件获取ID
            // const infoFile = path.join(mangaPath, 'manga-info.json');
            // if (await fs.pathExists(infoFile)) {
            //     const info = await fs.readJson(infoFile);
            //     if (info.id) {
            //         return info.id;
            //     }
            // }

            // 如果没有 manga-info.json，尝试从全局的 manga-ids.json 文件查找
            const globalIdsFile = path.join(this.outputDir, 'manga-ids.json');
            if (await fs.pathExists(globalIdsFile)) {
                const mangaList = await fs.readJson(globalIdsFile);
                const manga = mangaList.find(m => m.name === mangaDirName);
                if (manga && manga.id) {
                    return manga.id;
                }
            }

            // 如果都没有找到，返回null
            return null;

        } catch (error) {
            console.log(`⚠️ 读取漫画信息失败: ${mangaDirName} - ${error.message}`);
            return null;
        }
    }

    /**
     * 加载完整的章节信息
     */
    async loadCompleteInfo() {
        console.log('\n📊 加载完整章节信息...');

        try {
            if (!(await fs.pathExists(this.chapterTotalPagesFile))) {
                throw new Error(`章节信息文件不存在: ${this.chapterTotalPagesFile}`);
            }

            const data = await fs.readJson(this.chapterTotalPagesFile);
            const results = data.results || [];

            for (const manga of results) {
                this.completeInfo.set(manga.id, {
                    name: manga.name,
                    maxChapter: manga.maxChapter || 0,
                    chapters: manga.chapters || []
                });
            }

            this.stats.totalMangas = this.completeInfo.size;
            console.log(`✅ 加载完成: ${this.stats.totalMangas} 个漫画的完整信息`);

        } catch (error) {
            console.error(`❌ 加载完整信息失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 查找缺失的内容
     */
    async findMissingContent() {
        console.log('\n🔍 分析缺失内容...');

        this.missingContent = [];

        for (const [mangaId, completeInfo] of this.completeInfo) {
            const existingInfo = this.existingContent.get(mangaId);
            const missingChapters = [];
            const incompleteChapters = [];

            // 检查每个章节
            for (const chapterInfo of completeInfo.chapters) {
                const chapterNum = chapterInfo.chapter;
                const expectedPages = chapterInfo.totalPage;

                // 跳过失败的章节
                if (expectedPages === 'fail' || expectedPages === null || expectedPages <= 0) {
                    continue;
                }

                // 首先检查是否有PDF文件存在，如果有PDF则认为章节已完成
                const pdfExists = await this.isChapterPdfExists(completeInfo.name, chapterNum);
                if (pdfExists) {
                    console.log(`📄 [漫画${mangaId}-章节${chapterNum}] PDF文件已存在，章节已完成`);
                    continue; // 跳过此章节，认为已完成
                }

                if (!existingInfo || !existingInfo.chapters.has(chapterNum)) {
                    // 完全缺失的章节
                    missingChapters.push({
                        chapter: chapterNum,
                        expectedPages: expectedPages,
                        actualPages: 0,
                        type: 'missing'
                    });
                    this.stats.missingChapters++;
                } else {
                    // 检查图片数量是否完整（图片数量大于等于预期数量即认为完成）
                    const actualPages = existingInfo.chapters.get(chapterNum);
                    if (actualPages < expectedPages) {
                        incompleteChapters.push({
                            chapter: chapterNum,
                            expectedPages: expectedPages,
                            actualPages: actualPages,
                            type: 'incomplete'
                        });
                        this.stats.incompleteChapters++;
                        this.stats.totalMissingImages += (expectedPages - actualPages);
                    }
                }
            }

            // 如果有缺失内容，添加到清单
            if (missingChapters.length > 0 || incompleteChapters.length > 0) {
                this.missingContent.push({
                    mangaId: mangaId,
                    mangaName: completeInfo.name,
                    missingChapters: missingChapters,
                    incompleteChapters: incompleteChapters
                });
                this.stats.mangasWithMissingContent++;
            }
        }

        console.log(`📊 分析完成:`);
        console.log(`   📚 有缺失内容的漫画: ${this.stats.mangasWithMissingContent}`);
        console.log(`   📄 完全缺失的章节: ${this.stats.missingChapters}`);
        console.log(`   📄 不完整的章节: ${this.stats.incompleteChapters}`);
        console.log(`   🖼️ 缺失的图片总数: ${this.stats.totalMissingImages}`);
    }

    /**
     * 生成详细报告
     */
    generateReport() {
        console.log('\n📋 缺失内容详细报告:');
        console.log('='.repeat(50));

        if (this.missingContent.length === 0) {
            console.log('🎉 所有漫画内容都是完整的！');
            return;
        }

        for (const manga of this.missingContent) {
            console.log(`\n📖 漫画: ${manga.mangaName} (ID: ${manga.mangaId})`);

            if (manga.missingChapters.length > 0) {
                console.log(`   ❌ 完全缺失的章节 (${manga.missingChapters.length}个):`);
                for (const chapter of manga.missingChapters) {
                    console.log(`      第${chapter.chapter}章 (预期${chapter.expectedPages}页)`);
                }
            }

            if (manga.incompleteChapters.length > 0) {
                console.log(`   ⚠️ 不完整的章节 (${manga.incompleteChapters.length}个):`);
                for (const chapter of manga.incompleteChapters) {
                    console.log(`      第${chapter.chapter}章 (${chapter.actualPages}/${chapter.expectedPages}页)`);
                }
            }
        }

        console.log('\n' + '='.repeat(50));
    }

    /**
     * 补充缺失的内容 - 支持并行处理
     */
    async fillMissingContent(dryRun = false, enableParallel = true) {
        if (this.missingContent.length === 0) {
            console.log('\n🎉 没有缺失的内容需要补充！');
            return;
        }

        if (dryRun) {
            console.log('\n🔍 预览模式 - 不会实际下载内容');
            this.generateReport();
            return;
        }

        if (enableParallel && this.missingContent.length > 1) {
            console.log('\n📥 开始并行补充缺失内容...');
            return await this.fillMissingContentInParallel();
        } else {
            console.log('\n📥 开始按顺序补充缺失内容...');
            return await this.fillMissingContentSequentially();
        }
    }

    /**
     * 串行补充缺失内容（原逻辑）
     */
    async fillMissingContentSequentially() {
        let processedMangas = 0;
        let successfulChapters = 0;
        let failedChapters = 0;

        for (const manga of this.missingContent) {
            const result = await this.processSingleMangaMissing(manga);
            processedMangas++;
            successfulChapters += result.successfulChapters;
            failedChapters += result.failedChapters;
            console.log(`📊 漫画处理进度: ${processedMangas}/${this.missingContent.length}`);
        }

        this.logFinalStats(processedMangas, successfulChapters, failedChapters);
        return { processedMangas, successfulChapters, failedChapters };
    }

    /**
     * 并行补充缺失内容 - 漫画级别并行
     */
    async fillMissingContentInParallel() {
        console.log(`🚀 开始并行处理 ${this.missingContent.length} 个漫画...`);
        
        // 显示浏览器实例池状态
        this.downloader.logBrowserInstanceStatus();
        
        const results = [];
        let mangaIndex = 0;
        const maxConcurrent = this.downloader.parallelConfig.maxConcurrent;

        // 创建工作器函数处理单个漫画
        const createWorker = async (workerId) => {
            console.log(`👷 启动工作器 ${workerId}`);
            let workerStats = { processedMangas: 0, successfulChapters: 0, failedChapters: 0 };

            while (mangaIndex < this.missingContent.length) {
                // 获取下一个漫画任务
                const currentIndex = mangaIndex++;
                const manga = this.missingContent[currentIndex];

                if (!manga) break;

                const startTime = Date.now();
                console.log(`🔄 [${currentIndex + 1}] [工作器 ${workerId}] 开始处理漫画: ${manga.mangaName} (ID: ${manga.mangaId})`);

                try {
                    const result = await this.processSingleMangaMissing(manga);
                    const duration = Date.now() - startTime;

                    console.log(`${result.success ? '✅' : '⚠️'} [${currentIndex + 1}] [工作器 ${workerId}] 漫画 "${manga.mangaName}" 处理完成 (耗时: ${(duration / 1000).toFixed(1)}秒)`);
                    console.log(`    成功章节: ${result.successfulChapters}, 失败章节: ${result.failedChapters}`);

                    workerStats.processedMangas++;
                    workerStats.successfulChapters += result.successfulChapters;
                    workerStats.failedChapters += result.failedChapters;

                    results[currentIndex] = {
                        manga,
                        result,
                        success: result.success,
                        mangaIndex: currentIndex + 1,
                        duration
                    };

                } catch (error) {
                    console.error(`❌ [${currentIndex + 1}] [工作器 ${workerId}] 处理漫画 "${manga.mangaName}" 失败: ${error.message}`);
                    results[currentIndex] = {
                        manga,
                        result: { success: false, error: error.message, successfulChapters: 0, failedChapters: 0 },
                        success: false,
                        mangaIndex: currentIndex + 1,
                        duration: Date.now() - startTime
                    };
                }

                // 显示进度
                const completedCount = results.filter(r => r !== undefined).length;
                const remainingCount = this.missingContent.length - mangaIndex;
                console.log(`📊 [工作器 ${workerId}] 进度: ${completedCount}/${this.missingContent.length} 完成，剩余: ${remainingCount}`);
            }

            console.log(`👷 工作器 ${workerId} 完成，处理了 ${workerStats.processedMangas} 个漫画`);
            return workerStats;
        };

        // 启动多个工作器并行处理
        const maxWorkers = Math.min(maxConcurrent, this.missingContent.length);
        console.log(`⚡ 启动 ${maxWorkers} 个工作器并行处理漫画...`);

        const workers = [];
        for (let i = 0; i < maxWorkers; i++) {
            workers.push(createWorker(i + 1));
        }

        // 等待所有工作器完成
        console.log(`⏳ 等待所有工作器完成...`);
        const workerResults = await Promise.allSettled(workers);

        // 统计最终结果
        let totalProcessedMangas = 0;
        let totalSuccessfulChapters = 0;
        let totalFailedChapters = 0;

        workerResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                totalProcessedMangas += result.value.processedMangas;
                totalSuccessfulChapters += result.value.successfulChapters;
                totalFailedChapters += result.value.failedChapters;
            } else {
                console.error(`❌ 工作器 ${index + 1} 执行失败: ${result.reason}`);
            }
        });

        this.logFinalStats(totalProcessedMangas, totalSuccessfulChapters, totalFailedChapters);
        return { processedMangas: totalProcessedMangas, successfulChapters: totalSuccessfulChapters, failedChapters: totalFailedChapters };
    }

    /**
     * 处理单个漫画的缺失章节
     */
    async processSingleMangaMissing(manga) {
        console.log(`\n📖 处理漫画: ${manga.mangaName} (ID: ${manga.mangaId})`);

        // 获取该漫画的完整章节信息，按章节号排序
        const completeInfo = this.completeInfo.get(manga.mangaId);
        if (!completeInfo) {
            console.log(`⚠️ 未找到漫画 ${manga.mangaName} 的完整信息，跳过`);
            return { success: false, successfulChapters: 0, failedChapters: 0 };
        }

        // 按章节号排序
        const sortedChapters = completeInfo.chapters.sort((a, b) => a.chapter - b.chapter);
        console.log(`📋 开始按顺序处理章节 (共${sortedChapters.length}章)...`);

        let successfulChapters = 0;
        let failedChapters = 0;

        // 按顺序处理每个章节
        for (const chapterInfo of sortedChapters) {
            const chapterNum = chapterInfo.chapter;
            const expectedPages = chapterInfo.totalPage;

            // 跳过失败的章节
            if (expectedPages === 'fail' || expectedPages === null || expectedPages <= 0) {
                console.log(`⏭️ 跳过失败章节: 第${chapterNum}章`);
                continue;
            }

            // 首先检查是否有PDF文件存在，如果有PDF则认为章节已完成
            const pdfExists = await this.isChapterPdfExists(manga.mangaName, chapterNum);
            if (pdfExists) {
                console.log(`📄 第${chapterNum}章PDF文件已存在，跳过下载`);
                continue;
            }

            // 检查当前章节状态
            const existingInfo = this.existingContent.get(manga.mangaId);
            let needsDownload = false;
            let downloadReason = '';

            if (!existingInfo || !existingInfo.chapters.has(chapterNum)) {
                // 完全缺失的章节
                needsDownload = true;
                downloadReason = '章节缺失';
            } else {
                // 检查是否不完整（图片数量大于等于预期数量即认为完成）
                const actualPages = existingInfo.chapters.get(chapterNum);
                if (actualPages < expectedPages) {
                    needsDownload = true;
                    downloadReason = `不完整 (${actualPages}/${expectedPages}页)`;
                } else {
                    console.log(`✅ 第${chapterNum}章已完整 (${actualPages}页)，跳过`);
                    continue;
                }
            }

            // 需要下载的章节
            if (needsDownload) {
                try {
                    console.log(`📥 下载第${chapterNum}章 - ${downloadReason}`);
                    const success = await this.downloader.downloadMangaContent(
                        manga.mangaId,
                        manga.mangaName,
                        chapterNum
                    );

                    if (success) {
                        successfulChapters++;
                        console.log(`✅ 第${chapterNum}章下载成功`);
                    } else {
                        failedChapters++;
                        console.log(`❌ 第${chapterNum}章下载失败`);
                    }
                } catch (error) {
                    failedChapters++;
                    console.error(`❌ 下载第${chapterNum}章时出错: ${error.message}`);
                }
            }
        }

        const success = successfulChapters > 0 || failedChapters === 0;
        return { success, successfulChapters, failedChapters };
    }

    /**
     * 输出最终统计信息
     */
    logFinalStats(processedMangas, successfulChapters, failedChapters) {
        console.log('\n📊 补充完成统计:');
        console.log(`   📚 处理的漫画: ${processedMangas}`);
        console.log(`   ✅ 成功的章节: ${successfulChapters}`);
        console.log(`   ❌ 失败的章节: ${failedChapters}`);
        console.log(`   📈 成功率: ${successfulChapters + failedChapters > 0 ? ((successfulChapters / (successfulChapters + failedChapters)) * 100).toFixed(2) : 0}%`);
    }

    /**
     * 关闭资源
     */
    async close() {
        if (this.downloader) {
            await this.downloader.close();
        }
    }

    /**
     * 处理指定的单个漫画
     */
    async processSingleManga(mangaId, options = {}) {
        try {
            await this.init();
            await this.scanExistingContent();
            await this.loadCompleteInfo();

            // 检查指定的漫画ID是否存在
            if (!this.completeInfo.has(mangaId)) {
                console.log(`❌ 未找到漫画ID: ${mangaId}`);
                return;
            }

            const completeInfo = this.completeInfo.get(mangaId);
            console.log(`🎯 目标漫画: ${completeInfo.name} (ID: ${mangaId})`);

            // 只分析指定漫画的缺失内容
            await this.findMissingContent();

            // 过滤出指定漫画的缺失内容
            this.missingContent = this.missingContent.filter(manga => manga.mangaId === mangaId);

            if (this.missingContent.length === 0) {
                console.log(`🎉 漫画 "${completeInfo.name}" 没有缺失的内容！`);
                return;
            }

            if (options.reportOnly) {
                this.generateReport();
            } else {
                await this.fillMissingContent(options.dryRun);
            }

        } catch (error) {
            console.error(`❌ 处理漫画 ${mangaId} 时出错: ${error.message}`);
            throw error;
        } finally {
            await this.close();
        }
    }

    /**
     * 运行完整的补充流程
     */
    async run(options = {}) {
        try {
            await this.init();
            await this.scanExistingContent();
            await this.loadCompleteInfo();
            await this.findMissingContent();

            if (options.reportOnly) {
                this.generateReport();
            } else {
                await this.fillMissingContent(options.dryRun);
            }

        } catch (error) {
            console.error(`❌ 运行过程中出错: ${error.message}`);
            throw error;
        } finally {
            await this.close();
        }
    }
}

/**
 * 解析命令行参数
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        mangaId: null,
        dryRun: false,
        reportOnly: false,
        outputDir: null,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--manga-id':
                options.mangaId = args[++i];
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--report-only':
                options.reportOnly = true;
                break;
            case '--output-dir':
                options.outputDir = args[++i];
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                if (arg.startsWith('--')) {
                    console.log(`⚠️ 未知参数: ${arg}`);
                }
        }
    }

    return options;
}

/**
 * 显示使用说明
 */
function printUsage() {
    console.log(`
📚 漫画缺失内容补充工具

用法:
  node fill-missing-manga.js [选项]

选项:
  --manga-id <id>     指定要补充的漫画ID（可选，默认处理所有漫画）
  --dry-run          预览模式，显示缺失内容但不实际下载
  --report-only      仅生成缺失内容报告，不进行下载
  --output-dir <dir> 指定漫画输出目录（可选）
  --help, -h         显示此帮助信息

示例:
  node fill-missing-manga.js                    # 补充所有漫画的缺失内容
  node fill-missing-manga.js --dry-run          # 预览所有缺失内容
  node fill-missing-manga.js --report-only      # 仅生成报告
  node fill-missing-manga.js --manga-id 12345   # 仅补充指定漫画

环境变量:
  MANGA_OUTPUT_DIR   设置漫画输出目录路径
`);
}

/**
 * 主函数
 */
async function main() {
    const options = parseArgs();

    if (options.help) {
        printUsage();
        return;
    }

    console.log('🚀 漫画缺失内容补充工具启动...\n');

    try {
        const filler = new MangaGapFiller({
            outputDir: options.outputDir
        });

        if (options.mangaId) {
            console.log(`🎯 目标漫画ID: ${options.mangaId}`);
            await filler.processSingleManga(options.mangaId, options);
        } else {
            await filler.run(options);
        }

        console.log('\n🎉 处理完成！');

    } catch (error) {
        console.error(`\n❌ 处理失败: ${error.message}`);
        process.exit(1);
    }
}

// 如果直接运行此文件
if (require.main === module) {
    main().catch(console.error);
}

module.exports = MangaGapFiller;
