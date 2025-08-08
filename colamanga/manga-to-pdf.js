const fs = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const archiver = require('archiver');

/**
 * 漫画转PDF工具 - 简化版本
 *
 * 主要功能：
 * 1. 按章节组织 - 每话生成独立PDF文件
 * 2. 输出结构 - 漫画名/章节名.pdf
 * 3. 使用PDFKit直接生成PDF，无需浏览器
 * 4. 使用sharp处理图片优化
 * 5. 智能章节处理 - 基于chapter-completion-report.json
 * 6. 只处理完成的章节，转换后删除原图片
 *
 * 核心特性：
 * - 基于章节完成报告的精准处理
 * - 长页面模式，提供连续阅读体验
 * - 图片质量可调节（默认80%）
 * - 完全原生Node.js实现
 * - 支持断点续传
 *
 * 输出示例：
 * manga-pdf/
 * ├── 鬼刀/
 * │   ├── 第1章.pdf
 * │   ├── 第2章.pdf
 * │   └── ...
 * └── 其他漫画/
 *     └── ...
 */


class ProgressTracker {
    constructor(total) {
        this.total = total;
        this.completed = 0;
        this.success = 0;
        this.skipped = 0;
        this.failed = 0;
        this.startTime = Date.now();
        this.lastUpdateTime = Date.now();
    }

    update(result) {
        this.completed++;
        if (result.success) {
            if (result.skipped) {
                this.skipped++;
            } else {
                this.success++;
            }
        } else {
            this.failed++;
        }

        const now = Date.now();
        // 每2秒或处理完成时显示进度
        if (now - this.lastUpdateTime > 2000 || this.completed === this.total) {
            this.showProgress();
            this.lastUpdateTime = now;
        }
    }

    showProgress() {
        const elapsed = (Date.now() - this.startTime) / 1000;
        const avgTime = elapsed / this.completed;
        const remaining = this.total - this.completed;
        const eta = remaining * avgTime;

        const progress = (this.completed / this.total * 100).toFixed(1);

        console.log(`\n📊 进度更新: ${this.completed}/${this.total} (${progress}%)`);
        console.log(`   ✅ 成功: ${this.success} | ⏭️ 跳过: ${this.skipped} | ❌ 失败: ${this.failed}`);
        console.log(`   ⏱️ 已耗时: ${elapsed.toFixed(1)}秒 | 🕒 预计剩余: ${eta.toFixed(1)}秒`);
        console.log(`   ⚡ 平均速度: ${avgTime.toFixed(2)}秒/个`);
    }

    getFinalStats() {
        const totalTime = (Date.now() - this.startTime) / 1000;
        const avgTime = totalTime / this.total;

        return {
            success: this.success,
            skipped: this.skipped,
            failed: this.failed,
            totalTime: totalTime,
            avgTime: avgTime
        };
    }
}

class MangaToPdfConverter {
    constructor() {
        this.mangaDir = '/Users/likaixuan/Documents/manga';
        this.outputDir = '/Users/likaixuan/Documents/manga-pdf';
        this.maxImageSize = 10 * 1024 * 1024; // 支持高质量漫画图片，10MB限制
        this.memoryThreshold = 0.7; // 内存使用阈值70%，保守策略
        this.maxBatchConcurrency = 10; // 章节并行处理数量 - 固定10
        this.maxConcurrency = 10; // 漫画并行处理数量 - 固定10

        // 图片处理配置 - 简化版本
        this.imageQuality = 80; // JPEG压缩质量80%，平衡质量和文件大小
        this.maxImageWidth = 1200; // 最大图片宽度
        this.singlePageMode = true; // 默认启用长页面模式

        // 简化配置
        this.memoryCheckInterval = 3; // 每处理3个章节检查一次内存
        this.maxRetryAttempts = 2; // 重试次数
        this.compressCompletedChapters = false; // 是否处理完成章节
        this.statusReportPath = '/Users/likaixuan/work/crawlerAPI/chapter-completion-report.json'; // 章节完成报告文件路径
        this.statusReport = null; // 缓存的状态报告数据
    }

    /**
     * 检测最优并发数量 - 固定高并发版本
     */
    detectOptimalConcurrency() {
        const cpuCount = require('os').cpus().length;
        const memoryGB = require('os').totalmem() / (1024 * 1024 * 1024);

        // 固定高并发策略
        let mangaConcurrency = 10; // 固定10个漫画并行
        let chapterConcurrency = 10; // 固定10个章节并行

        console.log(`🔧 系统配置: ${cpuCount} 核 CPU, ${memoryGB.toFixed(1)}GB 内存`);
        console.log(`⚡ 固定高并发配置: ${mangaConcurrency} 个漫画并行, ${chapterConcurrency} 个章节并行`);

        // 设置章节并行数
        this.maxBatchConcurrency = chapterConcurrency;

        return mangaConcurrency;
    }

    /**
     * 设置并发数量 - 固定高并发版本
     */
    setConcurrency(concurrency) {
        // 忽略输入参数，固定使用10
        this.maxConcurrency = 10;
        console.log(`🔧 漫画并发数: 10 (固定值)`);
    }

    /**
     * 设置章节并发数量 - 固定高并发版本
     */
    setBatchConcurrency(chapterConcurrency) {
        // 忽略输入参数，固定使用10
        this.maxBatchConcurrency = 10;
        console.log(`🔧 章节并发数: 10 (固定值)`);
    }

    /**
     * 设置图片质量 - 简化版本
     */
    setImageQuality(quality) {
        if (quality < 50 || quality > 100) {
            console.log('⚠️ 图片质量应在50-100之间');
            return;
        }
        this.imageQuality = quality;
        console.log(`🔧 图片质量: ${quality}%`);
    }

    /**
     * 设置单页面模式（消除页面间隙）
     */
    setSinglePageMode(enabled) {
        this.singlePageMode = enabled;
        console.log(`🔧 ${enabled ? '长页面模式已启用：所有图片将合并到一个长页面，消除页面间隙' : '多页面模式已启用：每张图片独立页面'}`);
    }

    /**
     * 设置压缩完成章节选项
     */
    setCompressCompletedChapters(enabled) {
        this.compressCompletedChapters = enabled;
        console.log(`🔧 ${enabled ? '已启用：PDF生成成功后自动压缩完成章节的图片' : '已禁用：不压缩章节图片'}`);
    }

    /**
     * 设置完成章节的最小页数阈值
     */
    setMinPagesForComplete(pages) {
        if (pages < 1 || pages > 100) {
            console.log('⚠️ 最小页数应在1-100之间');
            return;
        }
        this.minPagesForComplete = pages;
        console.log(`🔧 完成章节最小页数已设置为: ${pages}`);
    }

    /**
     * 加载漫画状态报告
     */
    async loadStatusReport() {
        try {
            if (!await fs.pathExists(this.statusReportPath)) {
                console.log(`⚠️ 章节完成报告文件不存在: ${this.statusReportPath}`);
                console.log(`💡 请确保 chapter-completion-report.json 文件存在`);
                return false;
            }

            console.log(`📊 正在加载章节完成报告: ${this.statusReportPath}`);
            const reportData = await fs.readJson(this.statusReportPath);
            this.statusReport = reportData;

            const { summary } = reportData;
            console.log(`✅ 章节完成报告已加载:`);
            console.log(`   📚 总漫画数: ${summary.totalMangasInData}`);
            console.log(`   📖 总章节数: ${summary.totalChapters}`);
            console.log(`   ✅ 完成章节: ${summary.completedChapters}`);
            console.log(`   📊 完成率: ${summary.completionRate}`);
            console.log(`   🖼️ 预计有效页面: ${summary.estimatedValidPages}`);
            
            return true;
        } catch (error) {
            console.error(`❌ 加载状态报告失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 从章节完成报告中获取漫画信息
     */
    getMangaFromStatusReport(mangaName) {
        if (!this.statusReport || !this.statusReport.results) {
            return null;
        }

        // 直接从 results 对象中获取漫画数据
        return this.statusReport.results[mangaName] || null;
    }

    /**
     * 从章节完成报告中获取章节完成状态
     */
    getChapterStatusFromReport(mangaName, chapterName) {
        const mangaReport = this.getMangaFromStatusReport(mangaName);
        if (!mangaReport) {
            return null;
        }

        // 提取章节号进行匹配
        const chapterNumber = this.extractChapterNumber(chapterName);
        const chapterData = mangaReport[chapterNumber.toString()];

        if (chapterData) {
            return {
                completed: chapterData.completed,
                isComplete: chapterData.completed,
                expectedPages: chapterData.expectedPages,
                actualPages: chapterData.actualPages,
                status: chapterData.status
            };
        }

        return null;
    }

    /**
     * 检查内存使用情况
     */
    checkMemoryUsage() {
        const used = process.memoryUsage();
        const totalMemory = require('os').totalmem();
        const usedMemory = used.heapUsed;
        const memoryUsagePercent = usedMemory / totalMemory;

        return {
            heapUsed: (used.heapUsed / 1024 / 1024).toFixed(2), // MB
            heapTotal: (used.heapTotal / 1024 / 1024).toFixed(2), // MB
            rss: (used.rss / 1024 / 1024).toFixed(2), // MB
            usagePercent: (memoryUsagePercent * 100).toFixed(1)
        };
    }

    /**
     * 强制垃圾回收和内存清理
     */
    async forceGarbageCollection() {
        if (global.gc) {
            global.gc();
        }
        // 短暂延迟让垃圾回收完成
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    /**
     * 检查是否需要等待内存释放
     */
    async waitForMemoryRelease() {
        const memory = this.checkMemoryUsage();
        if (parseFloat(memory.usagePercent) > this.memoryThreshold * 100) {
            console.log(`⚠️ 内存使用率过高 (${memory.usagePercent}%)，等待释放...`);
            await this.forceGarbageCollection();

            // 等待一段时间让内存释放
            await new Promise(resolve => setTimeout(resolve, 2000));

            const newMemory = this.checkMemoryUsage();
            console.log(`🔄 内存释放后: ${newMemory.usagePercent}% 使用中`);
        }
    }

    /**
     * 紧急内存清理 - 当内存使用过高时的激进清理
     */
    async emergencyMemoryCleanup() {
        console.log(`🚨 执行紧急内存清理...`);

        // 多次垃圾回收
        for (let i = 0; i < 3; i++) {
            if (global.gc) {
                global.gc();
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // 检查清理效果
        const afterMemory = this.checkMemoryUsage();
        const afterPercent = parseFloat(afterMemory.usagePercent);
        const threshold = this.emergencyMemoryThreshold * 100;

        console.log(`🔄 紧急清理后内存: ${afterMemory.heapUsed}MB (${afterMemory.usagePercent}%)`);
        console.log(`🔍 清理效果检查: ${afterPercent}% vs 阈值 ${threshold}%`);

        // 如果内存仍然很高，建议停止处理
        if (afterPercent > threshold) {
            console.log(`⚠️ 紧急清理后内存仍然过高: ${afterPercent}% > ${threshold}%，建议停止当前处理`);
            return false;
        } else {
            console.log(`✅ 紧急清理效果良好: ${afterPercent}% <= ${threshold}%`);
        }

        return true;
    }

    /**
     * 检查是否需要紧急内存清理
     */
    async checkEmergencyMemory(context = '') {
        const memory = this.checkMemoryUsage();
        const memoryPercent = parseFloat(memory.usagePercent);
        const threshold = this.emergencyMemoryThreshold * 100; // 转换为百分比

        console.log(`🔍 ${context}内存检查: ${memory.usagePercent}% (阈值: ${threshold}%)`);

        if (memoryPercent > threshold) {
            console.log(`🚨 ${context}检测到紧急内存状况: ${memory.usagePercent}% > ${threshold}%`);
            const cleanupSuccess = await this.emergencyMemoryCleanup();

            if (!cleanupSuccess) {
                throw new Error(`内存不足，无法继续处理 (${memory.usagePercent}%)`);
            }
        } else {
            // console.log(`✅ ${context}内存状态正常: ${memory.usagePercent}% <= ${threshold}%`);
        }

        return memoryPercent;
    }

    async init() {
        console.log('🚀 初始化PDF转换器...');

        // 确保输出目录存在
        await fs.ensureDir(this.outputDir);

        // 如果启用了压缩完成章节，加载章节完成报告
        if (this.compressCompletedChapters) {
            console.log('📊 压缩完成章节功能已启用，正在加载章节完成报告...');
            const reportLoaded = await this.loadStatusReport();
            if (!reportLoaded) {
                console.log('⚠️ 无法加载章节完成报告，将使用本地检测方式');
            }
        }

        console.log(`📄 原生PDF处理模式启用`);
        console.log(`🔧 高并发配置: 漫画并行=${this.maxConcurrency}, 章节并行=${this.maxBatchConcurrency}`);
        console.log(`🖼️ 图片压缩质量: ${this.imageQuality}%`);
        console.log(`📏 最大图片宽度: ${this.maxImageWidth}px`);
        console.log(`📄 页面模式: ${this.singlePageMode ? '长页面模式（消除页面间隙）' : '多页面模式（每张图片独立页面）'}`);
        console.log(`🗜️ 压缩完成章节: ${this.compressCompletedChapters ? '已启用' : '已禁用'}`);

        console.log(`✅ PDF转换器初始化完成`);
    }

    async close() {
        // 原生PDF处理无需清理外部资源
        console.log('🔒 PDF转换器已关闭');
    }

    /**
     * 处理单张图片 - 优化压缩
     */
    async processImage(imagePath) {
        try {
            // 读取图片
            const imageBuffer = await fs.readFile(imagePath);

            // 使用sharp处理图片
            const image = sharp(imageBuffer);
            const metadata = await image.metadata();

            // 检查是否需要调整大小
            let processedImage = image;
            if (metadata.width > this.maxImageWidth) {
                processedImage = image.resize(this.maxImageWidth, null, {
                    withoutEnlargement: true,
                    fit: 'inside'
                });
            }

            // 转换为JPEG格式并压缩
            const optimizedBuffer = await processedImage
                .jpeg({
                    quality: this.imageQuality,
                    progressive: true,
                    mozjpeg: true
                })
                .toBuffer();

            // 获取处理后的元数据
            const optimizedMetadata = await sharp(optimizedBuffer).metadata();

            return {
                buffer: optimizedBuffer,
                width: optimizedMetadata.width,
                height: optimizedMetadata.height,
                originalSize: imageBuffer.length,
                optimizedSize: optimizedBuffer.length,
                compressionRatio: ((imageBuffer.length - optimizedBuffer.length) / imageBuffer.length * 100).toFixed(1)
            };
        } catch (error) {
            console.error(`❌ 图片处理失败: ${path.basename(imagePath)} - ${error.message}`);
            throw error;
        }
    }

    /**
     * 扫描漫画目录，获取所有漫画列表
     */
    async scanMangaDirectory() {
        console.log(`📁 扫描漫画目录: ${this.mangaDir}`);

        if (!await fs.pathExists(this.mangaDir)) {
            throw new Error(`漫画目录不存在: ${this.mangaDir}`);
        }

        const items = await fs.readdir(this.mangaDir);
        const mangaList = [];

        for (const item of items) {
            const itemPath = path.join(this.mangaDir, item);
            const stat = await fs.stat(itemPath);

            if (stat.isDirectory()) {
                // 检查是否包含章节目录
                const chapters = await this.getChaptersInManga(itemPath);
                if (chapters.length > 0) {
                    mangaList.push({
                        name: item,
                        path: itemPath,
                        chapters: chapters
                    });
                }
            }
        }

        console.log(`📚 找到 ${mangaList.length} 个漫画`);
        return mangaList;
    }

    /**
     * 获取漫画中的所有章节
     */
    async getChaptersInManga(mangaPath) {
        const items = await fs.readdir(mangaPath);
        const chapters = [];

        for (const item of items) {
            const itemPath = path.join(mangaPath, item);
            const stat = await fs.stat(itemPath);

            if (stat.isDirectory() && item.startsWith('第') && item.includes('章')) {
                // 提取章节号
                const chapterMatch = item.match(/第(\d+)章/);
                const chapterNumber = chapterMatch ? parseInt(chapterMatch[1]) : 0;

                // 检查是否包含图片文件
                const images = await this.getImagesInChapter(itemPath);
                if (images.length > 0) {
                    chapters.push({
                        name: item,
                        path: itemPath,
                        number: chapterNumber,
                        images: images
                    });
                }
            }
        }

        // 按章节号排序
        chapters.sort((a, b) => a.number - b.number);
        return chapters;
    }

    /**
     * 获取章节中的所有图片文件
     */
    async getImagesInChapter(chapterPath) {
        const files = await fs.readdir(chapterPath);
        const imageFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
        });

        // 按页码排序
        const images = imageFiles.map(file => {
            // 提取页码：支持 {页码}-xxx.ext 格式
            const pageMatch = file.match(/^(\d+)/);
            const pageNumber = pageMatch ? parseInt(pageMatch[1]) : 0;

            return {
                filename: file,
                path: path.join(chapterPath, file),
                page: pageNumber
            };
        }).filter(img => img.page > 0);

        // 按页码排序
        images.sort((a, b) => a.page - b.page);
        return images;
    }

    /**
     * 检测章节是否应该处理 - 基于新的逻辑
     */
    shouldProcessChapter(chapter, mangaName = null) {
        // 首先检查章节是否完成（根据状态报告）
        if (!this.isChapterCompleteFromReport(chapter, mangaName)) {
            console.log(`⚠️ 章节 ${chapter.name} 根据状态报告未完成，跳过处理`);
            return false;
        }

        // 检查章节目录下是否有zip文件
        const zipPattern = path.join(chapter.path, '*_images.zip');
        const zipFiles = require('glob').sync(zipPattern);
        
        if (zipFiles.length > 0) {
            console.log(`📦 章节 ${chapter.name} 目录下存在zip文件，删除并跳过处理`);
            // 删除zip文件
            for (const zipFile of zipFiles) {
                try {
                    require('fs').unlinkSync(zipFile);
                    console.log(`🗑️ 已删除: ${path.basename(zipFile)}`);
                } catch (error) {
                    console.warn(`⚠️ 删除zip文件失败: ${zipFile} - ${error.message}`);
                }
            }
            return false;
        }

        // 检查是否有图片文件
        const images = chapter.images;
        if (!images || images.length === 0) {
            console.log(`⚠️ 章节 ${chapter.name} 没有图片文件，跳过处理`);
            return false;
        }

        console.log(`✅ 章节 ${chapter.name} 已完成且有图片文件 (${images.length}张)，需要处理`);
        return true;
    }

    /**
     * 从章节完成报告判断章节是否完成
     */
    isChapterCompleteFromReport(chapter, mangaName = null) {
        // 优先使用章节完成报告
        if (this.statusReport && mangaName) {
            const chapterStatus = this.getChapterStatusFromReport(mangaName, chapter.name);
            if (chapterStatus) {
                const isCompleteFromReport = chapterStatus.completed;

                if (isCompleteFromReport) {
                    console.log(`✅ 章节 ${chapter.name} 根据完成报告确认完成 (预期: ${chapterStatus.expectedPages}页, 实际: ${chapterStatus.actualPages}页)`);
                    return true;
                } else {
                    console.log(`⚠️ 章节 ${chapter.name} 根据完成报告未完成 (预期: ${chapterStatus.expectedPages}页, 实际: ${chapterStatus.actualPages}页)`);
                    return false;
                }
            } else {
                console.log(`📊 章节 ${chapter.name} 在完成报告中未找到，视为未完成`);
                return false;
            }
        }

        // 如果没有完成报告，默认视为未完成
        console.log(`⚠️ 没有完成报告，章节 ${chapter.name} 视为未完成`);
        return false;
    }

    /**
     * 检测章节是否完成 - 基于状态报告和图片序列（保留向后兼容）
     */
    isChapterComplete(chapter, mangaName = null) {
        return this.shouldProcessChapter(chapter, mangaName);
    }

    /**
     * 删除章节原图片文件
     */
    async deleteChapterImages(chapter, mangaOutputDir, mangaName) {
        if (!this.compressCompletedChapters) {
            return { success: false, skipped: true };
        }

        console.log(`🗑️ 开始删除章节原图片: ${chapter.name} (${chapter.images.length}张图片)`);
        
        let deletedCount = 0;
        let deleteErrors = [];
        let totalOriginalSize = 0;

        // 计算原始文件总大小
        for (const image of chapter.images) {
            try {
                if (fs.existsSync(image.path)) {
                    const imageStats = await fs.stat(image.path);
                    totalOriginalSize += imageStats.size;
                }
            } catch (error) {
                console.warn(`⚠️ 无法获取图片大小: ${image.filename}`);
            }
        }

        // 删除所有原图片文件
        for (const image of chapter.images) {
            try {
                if (fs.existsSync(image.path)) {
                    await fs.remove(image.path);
                    deletedCount++;
                    console.log(`   ✅ 已删除: ${image.filename}`);
                } else {
                    console.log(`   ⚠️ 文件不存在: ${image.filename}`);
                }
            } catch (deleteError) {
                deleteErrors.push(`${image.filename}: ${deleteError.message}`);
                console.error(`   ❌ 删除失败: ${image.filename} - ${deleteError.message}`);
            }
        }

        const totalSizeMB = (totalOriginalSize / (1024 * 1024)).toFixed(2);
        console.log(`🗑️ 图片删除完成: ${deletedCount}/${chapter.images.length} 张`);
        console.log(`   💾 释放空间: ${totalSizeMB}MB`);
        
        if (deleteErrors.length > 0) {
            console.warn(`⚠️ ${deleteErrors.length} 个文件删除失败`);
        }

        return { 
            success: true, 
            skipped: false, 
            deletedCount: deletedCount,
            deleteErrors: deleteErrors,
            freedSpace: totalOriginalSize
        };
    }

    /**
     * 将单个漫画转换为PDF - 新策略：每话一个PDF，存储在章节文件夹中
     */
    async convertMangaToPdf(manga) {
        const startTime = Date.now();

        try {
            console.log(`📖 开始转换漫画: ${manga.name}`);
            console.log(`📊 漫画统计: ${manga.chapters.length}章`);

            // 创建漫画主目录
            const mangaOutputDir = path.join(this.outputDir, this.sanitizeFileName(manga.name));
            await fs.ensureDir(mangaOutputDir);

            // 使用新策略：按章节文件夹处理
            const result = await this.convertMangaByChapterFolders(manga, mangaOutputDir);

            const duration = (Date.now() - startTime) / 1000;
            console.log(`⏱️ 转换耗时: ${duration.toFixed(2)}秒`);

            return result;

        } catch (error) {
            console.error(`❌ 转换失败: ${manga.name} - ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 按章节文件夹转换漫画 - 每话一个PDF，存储在独立的章节文件夹中
     */
    async convertMangaByChapterFolders(manga, mangaOutputDir) {
        console.log(`📁 按章节文件夹处理模式: ${manga.name}`);
        console.log(`📍 输出目录: ${mangaOutputDir}`);

        try {
            // 筛选需要处理的章节（如果启用了压缩完成章节选项）
            let chaptersToProcess = manga.chapters;
            if (this.compressCompletedChapters) {
                const shouldProcessChapters = manga.chapters.filter(chapter => this.shouldProcessChapter(chapter, manga.name));
                console.log(`🔍 章节处理检测: ${shouldProcessChapters.length}/${manga.chapters.length} 个章节需要处理`);
                chaptersToProcess = shouldProcessChapters;
                
                if (shouldProcessChapters.length === 0) {
                    console.log(`⚠️ 没有找到需要处理的章节（可能都有zip文件或图片不完整）`);
                    return {
                        success: false,
                        error: '没有找到需要处理的章节',
                        successCount: 0,
                        skippedCount: 0,
                        failedCount: 0
                    };
                }
            }

            let totalChapters = chaptersToProcess.length;
            let successCount = 0;
            let skippedCount = 0;
            let failedCount = 0;
            let compressedCount = 0;

            console.log(`🚀 开始处理 ${totalChapters} 个章节，章节并发数: ${this.maxBatchConcurrency}`);

            let activePromises = [];
            let completedCount = 0;

            // 为每个章节创建处理任务
            for (let i = 0; i < chaptersToProcess.length; i++) {
                const chapter = chaptersToProcess[i];
                const chapterIndex = i + 1;

                // 定期检查内存状态
                if (i > 0 && i % this.memoryCheckInterval === 0) {
                    try {
                        await this.checkEmergencyMemory(`章节${i}处理前`);
                    } catch (error) {
                        console.error(`❌ 内存检查失败，停止处理: ${error.message}`);
                        break;
                    }
                }

                // 创建章节处理Promise
                const processPromise = this.processChapterToIndependentPdf(
                    chapter,
                    mangaOutputDir,
                    manga.name,
                    chapterIndex,
                    totalChapters
                ).then(result => {
                    completedCount++;
                    if (result.success) {
                        if (result.skipped) {
                            skippedCount++;
                            console.log(`⏭️ 章节 ${chapterIndex}/${totalChapters} 跳过: ${chapter.name}`);
                        } else {
                            successCount++;
                            console.log(`✅ 章节 ${chapterIndex}/${totalChapters} 完成: ${chapter.name}`);
                        }
                    } else {
                        failedCount++;
                        console.log(`❌ 章节 ${chapterIndex}/${totalChapters} 失败: ${result.error}`);
                    }

                    return {
                        success: result.success,
                        skipped: result.skipped,
                        chapterIndex: chapterIndex,
                        chapterName: chapter.name,
                        path: result.path
                    };
                }).catch(error => {
                    completedCount++;
                    failedCount++;
                    console.error(`❌ 章节 ${chapterIndex}/${totalChapters} 异常: ${error.message}`);
                    return {
                        success: false,
                        error: error.message,
                        chapterIndex: chapterIndex
                    };
                });

                activePromises.push(processPromise);

                // 当达到最大并发数或处理完所有章节时，等待部分完成
                if (activePromises.length >= this.maxBatchConcurrency || i === manga.chapters.length - 1) {
                    console.log(`⏳ 等待 ${activePromises.length} 个章节并行处理完成...`);

                    // 等待当前批次完成
                    await Promise.allSettled(activePromises);

                    // 检查内存使用和进度
                    const memory = this.checkMemoryUsage();
                    console.log(`📊 章节处理进度: ${completedCount}/${totalChapters}, 内存: ${memory.heapUsed}MB (${memory.usagePercent}%)`);

                    // 强制垃圾回收
                    await this.forceGarbageCollection();

                    // 如果内存使用过高，等待释放
                    if (parseFloat(memory.usagePercent) > this.memoryThreshold * 100) {
                        console.log(`⏸️ 内存使用过高，休息2秒...`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                    // 清空已完成的Promise数组，准备下一轮
                    activePromises = [];
                }
            }

            console.log(`\n📋 漫画 "${manga.name}" 章节处理完成:`);
            console.log(`   ✅ 成功: ${successCount}/${totalChapters} 个章节`);
            console.log(`   ⏭️ 跳过: ${skippedCount}/${totalChapters} 个章节`);
            console.log(`   ❌ 失败: ${failedCount}/${totalChapters} 个章节`);
            console.log(`   📁 输出目录: ${mangaOutputDir}`);

            if (successCount > 0 || skippedCount > 0) {
                console.log(`✅ 漫画转换成功，文件结构: ${manga.name}/章节/pdf`);
                return {
                    success: true,
                    skipped: skippedCount === totalChapters,
                    path: mangaOutputDir,
                    successCount: successCount,
                    skippedCount: skippedCount,
                    failedCount: failedCount
                };
            } else {
                return {
                    success: false,
                    error: `所有章节都处理失败了`,
                    successCount: successCount,
                    skippedCount: skippedCount,
                    failedCount: failedCount
                };
            }

        } catch (error) {
            console.error(`❌ 按章节文件夹处理失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 处理单个章节生成独立PDF并保存到漫画目录
     */
    async processChapterToIndependentPdf(chapter, mangaOutputDir, mangaName, chapterIndex, totalChapters) {
        const maxRetries = this.maxRetryAttempts;
        let retryCount = 0;

        // 章节PDF文件名，直接保存在漫画目录下
        const chapterPdfName = `${this.sanitizeFileName(chapter.name)}.pdf`;
        const chapterPdfPath = path.join(mangaOutputDir, chapterPdfName);

        // 如果启用智能处理模式，不管PDF是否存在都要重新处理（因为有图片就要转换并删除）
        if (await fs.pathExists(chapterPdfPath)) {
            if (this.compressCompletedChapters) {
                console.log(`📄 章节PDF已存在，但有图片需要处理，将重新转换: ${chapterPdfName}`);
            } else {
                console.log(`⏭️ 章节PDF已存在，跳过: ${chapterPdfName}`);
                return { success: true, skipped: true, path: chapterPdfPath };
            }
        }

        console.log(`📍 章节输出路径: ${chapterPdfPath}`);

        while (retryCount < maxRetries) {
            try {
                console.log(`🚀 [原生PDF] 开始处理章节 ${chapterIndex}/${totalChapters}: ${chapter.name} (${chapter.images.length}张图片) ${retryCount > 0 ? `(重试${retryCount})` : ''}`);

                // 准备章节数据
                const chapterData = {
                    chapterName: chapter.name,
                    chapterNumber: this.extractChapterNumber(chapter.name),
                    images: chapter.images
                };

                // 使用已定义的章节PDF路径

                // 创建章节PDF
                const success = await this.createChapterPdf(chapterData, chapterPdfPath, mangaName, chapterIndex);

                if (success) {
                    console.log(`✅ [原生PDF] 章节PDF保存成功: ${chapterPdfName}`);
                    
                    // 如果启用了压缩完成章节，删除原图片文件
                    let deleteResult = { success: false, skipped: true };
                    if (this.compressCompletedChapters) {
                        try {
                            deleteResult = await this.deleteChapterImages(chapter, mangaOutputDir, mangaName);
                            if (deleteResult.success && !deleteResult.skipped) {
                                console.log(`✅ 章节图片清理完成`);
                                console.log(`   🗑️ 已删除: ${deleteResult.deletedCount}张原图片`);
                                console.log(`   💾 释放空间: ${(deleteResult.freedSpace / (1024 * 1024)).toFixed(2)}MB`);
                                if (deleteResult.deleteErrors && deleteResult.deleteErrors.length > 0) {
                                    console.warn(`   ⚠️ ${deleteResult.deleteErrors.length}个文件删除失败`);
                                }
                            }
                        } catch (deleteError) {
                            console.warn(`⚠️ 章节图片删除失败: ${deleteError.message}`);
                        }
                    }
                    
                    return { 
                        success: true, 
                        skipped: false, 
                        path: chapterPdfPath,
                        deleteResult: deleteResult
                    };
                } else {
                    throw new Error('章节PDF创建失败');
                }

            } catch (error) {
                console.error(`❌ [原生PDF] 章节 ${chapterIndex} 处理失败 (尝试${retryCount + 1}/${maxRetries}): ${error.message}`);

                retryCount++;

                if (retryCount >= maxRetries) {
                    return { success: false, error: `章节处理失败，已重试${maxRetries}次: ${error.message}` };
                }

                // 短暂延迟后重试
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }

        return { success: false, error: '章节处理失败：超过最大重试次数' };
    }

    /**
     * 新策略转换漫画为PDF - 按章节组织
     */
    async convertMangaWithNewStrategy(allImages, finalPdfPath, mangaName) {
        console.log(`📦 开始按章节处理漫画: ${mangaName}`);

        // 创建临时目录
        const tempDir = path.join(this.outputDir, 'temp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
        await fs.ensureDir(tempDir);

        try {
            // 按章节组织图片
            const chapterGroups = this.organizeImagesByChapter(allImages);
            const totalChapters = chapterGroups.length;

            console.log(`📊 按章节处理策略: ${totalChapters} 章，总计 ${allImages.length} 张图片`);
            console.log(`🚀 章节并行处理，最大并发数: ${this.maxBatchConcurrency}`);

            const chapterPdfPaths = [];
            let activePromises = [];
            let completedCount = 0;

            // 为每个章节创建处理任务
            for (let i = 0; i < chapterGroups.length; i++) {
                const chapterData = chapterGroups[i];
                const chapterIndex = i;

                // 定期检查内存状态
                if (i > 0 && i % this.memoryCheckInterval === 0) {
                    try {
                        await this.checkEmergencyMemory(`章节${i}处理前`);
                    } catch (error) {
                        console.error(`❌ 内存检查失败，停止处理: ${error.message}`);
                        break;
                    }
                }

                const chapterPdfName = `chapter_${String(chapterData.chapterNumber).padStart(3, '0')}_${chapterData.chapterName.replace(/[<>:"/\\|?*：？]/g, '_')}.pdf`;
                const chapterPdfPath = path.join(tempDir, chapterPdfName);

                // 创建章节PDF处理Promise
                const processPromise = this.processChapterToPdf(
                    chapterData,
                    chapterPdfPath,
                    mangaName,
                    chapterIndex + 1,
                    totalChapters
                ).then(result => {
                    completedCount++;
                    if (result.success) {
                        console.log(`✅ 章节PDF ${chapterIndex + 1}/${totalChapters} 完成: ${chapterData.chapterName}`);
                        return {
                            success: true,
                            path: chapterPdfPath,
                            chapterIndex: chapterIndex + 1,
                            chapterNumber: chapterData.chapterNumber,
                            chapterName: chapterData.chapterName,
                            originalIndex: i
                        };
                    } else {
                        console.log(`❌ 章节PDF ${chapterIndex + 1}/${totalChapters} 失败: ${result.error}`);
                        return { success: false, error: result.error, chapterIndex: chapterIndex + 1 };
                    }
                }).catch(error => {
                    completedCount++;
                    console.error(`❌ 章节PDF ${chapterIndex + 1}/${totalChapters} 异常: ${error.message}`);
                    return { success: false, error: error.message, chapterIndex: chapterIndex + 1 };
                });

                activePromises.push(processPromise);

                // 当达到最大并发数或处理完所有章节时，等待部分完成
                if (activePromises.length >= this.maxBatchConcurrency || i === chapterGroups.length - 1) {
                    console.log(`⏳ 等待 ${activePromises.length} 个章节并行处理完成...`);

                    // 等待当前批次完成
                    const results = await Promise.allSettled(activePromises);

                    // 收集成功的PDF文件
                    for (const result of results) {
                        if (result.status === 'fulfilled' && result.value.success) {
                            chapterPdfPaths.push({
                                path: result.value.path,
                                chapterNumber: result.value.chapterNumber,
                                chapterName: result.value.chapterName,
                                chapterIndex: result.value.chapterIndex,
                                originalIndex: result.value.originalIndex
                            });
                        }
                    }

                    // 检查内存使用和进度
                    const memory = this.checkMemoryUsage();
                    console.log(`📊 章节处理进度: ${completedCount}/${totalChapters}, 内存: ${memory.heapUsed}MB (${memory.usagePercent}%)`);

                    // 强制垃圾回收
                    await this.forceGarbageCollection();

                    // 如果内存使用过高，等待释放
                    if (parseFloat(memory.usagePercent) > this.memoryThreshold * 100) {
                        console.log(`⏸️ 内存使用过高，休息2秒...`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                    // 清空已完成的Promise数组，准备下一轮
                    activePromises = [];
                }
            }

            // 按照章节顺序排序PDF文件（非常重要！）
            chapterPdfPaths.sort((a, b) => {
                // 按章节号排序
                if (a.chapterNumber !== b.chapterNumber) {
                    return a.chapterNumber - b.chapterNumber;
                }
                return a.originalIndex - b.originalIndex;
            });

            const sortedPdfPaths = chapterPdfPaths.map(item => item.path);

            console.log(`📚 章节处理完成: ${sortedPdfPaths.length}/${totalChapters} 个章节PDF成功`);
            console.log(`📋 PDF排序: 按章节 ${chapterPdfPaths[0]?.chapterNumber}-${chapterPdfPaths[chapterPdfPaths.length-1]?.chapterNumber}`);

            if (sortedPdfPaths.length === 0) {
                throw new Error('所有章节PDF处理都失败了');
            }

            // 临时：直接生成章节分片文件，不进行合并
            console.log(`📁 生成章节分片文件模式（测试）...`);
            await this.saveChapterParts(chapterPdfPaths, finalPdfPath);

            console.log(`✅ 漫画PDF生成成功: ${path.basename(finalPdfPath)}`);
            return { success: true, skipped: false, path: finalPdfPath };

        } catch (error) {
            console.error(`❌ 章节策略处理失败: ${error.message}`);
            return { success: false, error: error.message };
        } finally {
            // 清理临时文件
            try {
                await fs.remove(tempDir);
                console.log(`🗑️ 临时文件已清理`);
            } catch (cleanupError) {
                console.log(`⚠️ 清理临时文件失败: ${cleanupError.message}`);
            }
        }
    }

    /**
     * 处理单个章节生成PDF
     */
    async processChapterToPdf(chapterData, pdfPath, mangaName, chapterIndex, totalChapters) {
        let dynamicPage = null;
        const maxRetries = this.maxRetryAttempts;
        let retryCount = 0;

        while (retryCount < maxRetries) {
            try {
                // 动态创建新页面
                console.log(`🆕 创建新页面处理章节 ${chapterIndex}/${totalChapters}: ${chapterData.chapterName}`);
                dynamicPage = await this.browser.newPage();

                // 配置页面设置
                await dynamicPage.setDefaultTimeout(300000); // 5分钟超时
                await dynamicPage.setDefaultNavigationTimeout(300000);

                // 禁用图片懒加载
                await dynamicPage.addInitScript(() => {
                    delete HTMLImageElement.prototype.loading;
                });

                // 设置视口
                await dynamicPage.setViewportSize({ width: 1200, height: 1600 });

                console.log(`🚀 [章节页面] 开始处理章节 ${chapterIndex}/${totalChapters}: ${chapterData.chapterName} (${chapterData.images.length}张图片) ${retryCount > 0 ? `(重试${retryCount})` : ''}`);

                // 创建章节PDF
                const success = await this.createChapterPdf(chapterData, pdfPath, mangaName, chapterIndex, dynamicPage);

                if (success) {
                    return { success: true, path: pdfPath };
                } else {
                    throw new Error('章节PDF创建失败');
                }

            } catch (error) {
                console.error(`❌ [章节页面] 章节 ${chapterIndex} 处理失败 (尝试${retryCount + 1}/${maxRetries}): ${error.message}`);

                retryCount++;

                if (retryCount >= maxRetries) {
                    return { success: false, error: `章节处理失败，已重试${maxRetries}次: ${error.message}` };
                }

                // 短暂延迟后重试
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));

            } finally {
                // 立即关闭动态页面释放资源
                if (dynamicPage) {
                    try {
                        await dynamicPage.close();
                        console.log(`🔒 [章节页面] 章节 ${chapterIndex} 处理完成，页面已关闭`);
                    } catch (closeError) {
                        console.log(`⚠️ [章节页面] 关闭页面失败: ${closeError.message}`);
                    }
                    dynamicPage = null;
                }
            }
        }

        return { success: false, error: '章节处理失败：超过最大重试次数' };
    }

    /**
     * 创建单个章节的PDF - 使用PDFKit原生生成
     */
    async createChapterPdf(chapterData, pdfPath, mangaName, chapterIndex) {
        try {
            console.log(`📄 [原生PDF] 开始创建章节PDF: ${chapterData.chapterName} (${chapterData.images.length}张图片)`);

            // 检查章节是否有图片
            if (!chapterData.images || chapterData.images.length === 0) {
                console.log(`❌ [原生PDF] 章节中没有图片: ${chapterData.chapterName}`);
                return false;
            }

            // 检查紧急内存状况
            try {
                await this.checkEmergencyMemory(`章节${chapterIndex}处理前`);
            } catch (error) {
                console.error(`❌ 章节 ${chapterIndex} 内存检查失败: ${error.message}`);
                return false;
            }

            if (this.singlePageMode) {
                // 单页面模式：预处理所有图片，计算总尺寸
                console.log(`🖼️ [长页面模式] 预处理图片以计算总尺寸...`);
                const imageDataArray = [];
                let maxWidth = 0;
                let totalHeight = 0;
                let totalOriginalSize = 0;
                let totalOptimizedSize = 0;

                // 预处理所有图片
                for (let i = 0; i < chapterData.images.length; i++) {
                    const image = chapterData.images[i];

                    try {
                        if (!await fs.pathExists(image.path)) {
                            console.log(`⚠️ [长页面模式] 图片不存在: ${image.filename}`);
                            continue;
                        }

                        const processedImageData = await this.processImage(image.path);
                        imageDataArray.push({
                            ...processedImageData,
                            filename: image.filename
                        });

                        maxWidth = Math.max(maxWidth, processedImageData.width);
                        totalHeight += processedImageData.height;
                        totalOriginalSize += processedImageData.originalSize;
                        totalOptimizedSize += processedImageData.optimizedSize;

                        // console.log(`✅ [长页面模式] 预处理图片 ${i + 1}/${chapterData.images.length}: ${image.filename} (${processedImageData.width}x${processedImageData.height}px)`);

                        if (i % 5 === 0 && global.gc) {
                            global.gc();
                        }
                    } catch (error) {
                        console.log(`❌ [长页面模式] 预处理图片失败: ${image.filename} - ${error.message}`);
                    }
                }

                if (imageDataArray.length === 0) {
                    console.log(`❌ [长页面模式] 没有有效图片`);
                    return false;
                }

                // 创建超长页面的PDF
                const pageWidth = maxWidth * 0.75; // 像素转点
                const pageHeight = totalHeight * 0.75;

                console.log(`📏 [长页面模式] 创建长页面: ${maxWidth}x${totalHeight}px (${pageWidth.toFixed(1)}x${pageHeight.toFixed(1)}pt)`);

                const doc = new PDFDocument({
                    size: [pageWidth, pageHeight],
                    margin: 0,
                    info: {
                        Title: `${mangaName} - ${chapterData.chapterName}`,
                        Author: 'Manga to PDF Converter',
                        Subject: chapterData.chapterName,
                        Creator: 'Node.js PDF Generator'
                    }
                });

                const stream = fs.createWriteStream(pdfPath);
                doc.pipe(stream);

                // 按顺序添加所有图片到同一页面
                let currentY = 0;
                for (let i = 0; i < imageDataArray.length; i++) {
                    const imageData = imageDataArray[i];
                    const imgWidth = imageData.width * 0.75;
                    const imgHeight = imageData.height * 0.75;

                    // 居中对齐图片（如果图片宽度小于最大宽度）
                    const x = (pageWidth - imgWidth) / 2;

                    doc.image(imageData.buffer, x, currentY, {
                        width: imgWidth,
                        height: imgHeight
                    });

                    currentY += imgHeight;
                    console.log(`✅ [长页面模式] 添加图片 ${i + 1}/${imageDataArray.length}: ${imageData.filename} (Y位置: ${currentY.toFixed(1)}pt)`);
                }

                // 完成PDF文档
                doc.end();

                // 等待文件写入完成
                await new Promise((resolve, reject) => {
                    stream.on('finish', resolve);
                    stream.on('error', reject);
                });

                const processedImages = imageDataArray.length;
                const skippedImages = chapterData.images.length - processedImages;

                console.log(`📄 [长页面模式] PDF文档生成完成`);
                console.log(`🗜️ [长页面模式] 图片压缩统计:`);
                console.log(`   原始总大小: ${(totalOriginalSize / 1024 / 1024).toFixed(2)}MB`);
                console.log(`   优化后大小: ${(totalOptimizedSize / 1024 / 1024).toFixed(2)}MB`);
                console.log(`   总压缩率: ${((totalOriginalSize - totalOptimizedSize) / totalOriginalSize * 100).toFixed(1)}%`);

                const stats = await fs.stat(pdfPath);
                const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

                console.log(`✅ [长页面模式] 章节PDF创建完成:`);
                console.log(`   📄 文件大小: ${fileSizeMB}MB`);
                console.log(`   🖼️ 图片数量: ${processedImages}张 (跳过: ${skippedImages}张)`);
                console.log(`   📏 页面尺寸: ${maxWidth}x${totalHeight}px`);
                console.log(`   📊 平均每张: ${(stats.size / processedImages / 1024).toFixed(2)}KB`);
                console.log(`   🔗 长页面模式: 所有图片连续无缝显示`);

                return true;

            } else {
                // 多页面模式：原有逻辑
                let doc = null;
                let stream = null;
                let processedImages = 0;
                let skippedImages = 0;
                let totalOriginalSize = 0;
                let totalOptimizedSize = 0;

                console.log(`🖼️ [多页面模式] 开始处理章节图片: ${chapterData.images.length}张`);

                for (let i = 0; i < chapterData.images.length; i++) {
                    const image = chapterData.images[i];

                    try {
                        if (!await fs.pathExists(image.path)) {
                            console.log(`⚠️ [多页面模式] 图片不存在: ${image.filename}`);
                            skippedImages++;
                            continue;
                        }

                        const processedImageData = await this.processImage(image.path);
                        const pageWidth = processedImageData.width * 0.75;
                        const pageHeight = processedImageData.height * 0.75;

                        if (i === 0) {
                            doc = new PDFDocument({
                                size: [pageWidth, pageHeight],
                                margin: 0,
                                info: {
                                    Title: `${mangaName} - ${chapterData.chapterName}`,
                                    Author: 'Manga to PDF Converter',
                                    Subject: chapterData.chapterName,
                                    Creator: 'Node.js PDF Generator'
                                }
                            });

                            stream = fs.createWriteStream(pdfPath);
                            doc.pipe(stream);
                        } else {
                            doc.addPage({
                                size: [pageWidth, pageHeight],
                                margin: 0
                            });
                        }

                        doc.image(processedImageData.buffer, 0, 0, {
                            width: pageWidth,
                            height: pageHeight
                        });

                        processedImages++;
                        totalOriginalSize += processedImageData.originalSize;
                        totalOptimizedSize += processedImageData.optimizedSize;

                        console.log(`✅ [多页面模式] 添加图片 ${i + 1}/${chapterData.images.length}: ${image.filename} (${processedImageData.width}x${processedImageData.height}px, 压缩率: ${processedImageData.compressionRatio}%)`);

                        if (i % 5 === 0 && global.gc) {
                            global.gc();
                        }

                    } catch (error) {
                        console.log(`❌ [多页面模式] 处理图片失败: ${image.filename} - ${error.message}`);
                        skippedImages++;
                    }
                }

                if (processedImages === 0) {
                    console.log(`❌ [多页面模式] 章节中没有有效图片`);
                    doc.end();
                    return false;
                }

                doc.end();

                await new Promise((resolve, reject) => {
                    stream.on('finish', resolve);
                    stream.on('error', reject);
                });

                console.log(`📄 [多页面模式] PDF文档生成完成`);
                const totalCompressionRatio = ((totalOriginalSize - totalOptimizedSize) / totalOriginalSize * 100).toFixed(1);
                console.log(`🗜️ [多页面模式] 图片压缩统计:`);
                console.log(`   原始总大小: ${(totalOriginalSize / 1024 / 1024).toFixed(2)}MB`);
                console.log(`   优化后大小: ${(totalOptimizedSize / 1024 / 1024).toFixed(2)}MB`);
                console.log(`   总压缩率: ${totalCompressionRatio}%`);
            }

            // 验证PDF文件
            const stats = await fs.stat(pdfPath);
            const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

            console.log(`✅ [原生PDF] 章节PDF创建完成:`);
            console.log(`   📄 文件大小: ${fileSizeMB}MB`);
            console.log(`   🖼️ 处理模式: ${this.singlePageMode ? '长页面模式（无缝连续）' : '多页面模式'}`);

            // 检查PDF文件健康度
            if (stats.size < 100 * 1024) {
                console.log(`   ⚠️ PDF文件较小 (${fileSizeMB}MB)，请检查图片质量设置`);
            } else if (stats.size > 50 * 1024 * 1024) {
                console.log(`   ⚠️ PDF文件较大 (${fileSizeMB}MB)，可考虑降低图片质量`);
            } else {
                console.log(`   ✅ PDF文件大小正常`);
            }

            console.log(`\n🔧 [原生PDF] 处理优势:`);
            console.log(`   1. ✅ 无浏览器开销，内存使用更稳定`);
            console.log(`   2. ✅ 图片自动压缩优化，减小文件体积`);
            console.log(`   3. ✅ ${this.singlePageMode ? '长页面模式，完全无页面间隙' : '每页按图片尺寸动态生成，完全无空白'}`);
            console.log(`   4. ✅ 支持多种图片格式自动转换`);
            console.log(`   5. ✅ 流式处理，适合大量图片`);

            return true;

        } catch (error) {
            console.error(`❌ [原生PDF] 创建章节PDF失败: ${error.message}`);
            return false;
        }
    }



    /**
     * 合并PDF文件 - 优化内存使用，防止Array buffer allocation failed
     */
    async mergePdfFiles(batchPdfs, outputPath) {
        if (batchPdfs.length === 0) {
            throw new Error('没有PDF文件需要合并');
        }

        // 如果只有一个批次文件，直接复制
        if (batchPdfs.length === 1) {
            await fs.copy(batchPdfs[0], outputPath);
            console.log(`📄 单个PDF文件: ${path.basename(outputPath)}`);
            return;
        }

        console.log(`🔗 开始超保守合并 ${batchPdfs.length} 个PDF文件...`);

        try {
            // 检查内存状态
            const initialMemory = this.checkMemoryUsage();
            console.log(`🔄 合并前内存使用: ${initialMemory.heapUsed}MB (${initialMemory.usagePercent}%)`);

            // 如果文件很多或内存使用率高，使用超小分组
            if (batchPdfs.length > 10 || parseFloat(initialMemory.usagePercent) > 60) {
                console.log(`📦 文件较多或内存紧张，使用超小分组合并策略...`);
                await this.mergeInUltraSmallGroups(batchPdfs, outputPath);
                return;
            }

            // 小于等于3个文件，尝试直接合并
            if (batchPdfs.length <= 3) {
                console.log(`📄 文件较少，尝试直接合并...`);
                try {
                    await this.mergeSmallGroup(batchPdfs, outputPath);
                    return;
                } catch (error) {
                    console.log(`⚠️ 直接合并失败，降级到分组: ${error.message}`);
                }
            }

            // 使用小分组合并
            await this.mergeInUltraSmallGroups(batchPdfs, outputPath);

        } catch (error) {
            console.error(`❌ PDF合并失败: ${error.message}`);

            // 强制垃圾回收后再尝试回退
            await this.forceGarbageCollection();

            // 如果合并失败，回退到分片模式
            console.log(`🔄 回退到分片模式...`);
            await this.fallbackToMultipleFiles(batchPdfs, outputPath);
        }
    }

    /**
     * 超小分组合并PDF文件，每组只有2个文件
     */
    async mergeInUltraSmallGroups(batchPdfs, outputPath) {
        const groupSize = 2; // 每组只有2个文件，最大程度减少内存使用
        const tempMergedFiles = [];

        console.log(`📦 将 ${batchPdfs.length} 个文件分为 ${Math.ceil(batchPdfs.length / groupSize)} 组处理（每组${groupSize}个）`);

        try {
            // 第一轮：将文件分组合并
            for (let i = 0; i < batchPdfs.length; i += groupSize) {
                const group = batchPdfs.slice(i, i + groupSize);
                const groupIndex = Math.floor(i / groupSize) + 1;
                const tempPath = path.join(path.dirname(outputPath), `temp_merge_${groupIndex}_${Date.now()}.pdf`);

                console.log(`🔄 处理第 ${groupIndex} 组: ${group.length} 个文件`);

                // 检查内存使用
                const memory = this.checkMemoryUsage();
                if (parseFloat(memory.usagePercent) > 70) {
                    console.log(`⚠️ 内存使用过高 (${memory.usagePercent}%)，强制清理...`);
                    await this.forceGarbageCollection();
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                try {
                    // 合并当前组
                    await this.mergeSmallGroup(group, tempPath);
                    tempMergedFiles.push(tempPath);

                    console.log(`✅ 第 ${groupIndex} 组合并完成`);
                } catch (error) {
                    console.error(`❌ 第 ${groupIndex} 组合并失败: ${error.message}`);
                    // 如果组合并失败，使用第一个文件作为备份
                    if (group.length > 0) {
                        await fs.copy(group[0], tempPath);
                        tempMergedFiles.push(tempPath);
                        console.log(`⚠️ 第 ${groupIndex} 组降级处理，仅保留第一个文件`);
                    }
                }

                // 组间强制垃圾回收和等待
                await this.forceGarbageCollection();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // 第二轮：递归合并临时文件
            if (tempMergedFiles.length > 1) {
                console.log(`🔗 递归合并 ${tempMergedFiles.length} 个临时文件...`);

                // 递归调用，直到只剩一个文件
                const finalTempPath = path.join(path.dirname(outputPath), `final_temp_${Date.now()}.pdf`);
                await this.mergeInUltraSmallGroups(tempMergedFiles, finalTempPath);

                // 移动最终文件
                await fs.move(finalTempPath, outputPath);

                // 清理所有临时文件
                for (const tempFile of tempMergedFiles) {
                    try {
                        await fs.remove(tempFile);
                    } catch (error) {
                        console.warn(`⚠️ 清理临时文件失败: ${tempFile}`);
                    }
                }
            } else if (tempMergedFiles.length === 1) {
                // 只有一个文件，直接移动
                await fs.move(tempMergedFiles[0], outputPath);
            } else {
                throw new Error('没有成功的合并文件');
            }

        } catch (error) {
            console.error(`❌ 超小分组合并失败: ${error.message}`);

            // 清理临时文件
            for (const tempFile of tempMergedFiles) {
                try {
                    await fs.remove(tempFile);
                } catch {}
            }

            throw error;
        }
    }

    /**
     * 合并一个小组的PDF文件 - 增强内存管理
     */
    async mergeSmallGroup(files, outputPath) {
        console.log(`🔗 开始合并小组: ${files.length} 个文件`);

        // 预检查内存
        const preMemory = this.checkMemoryUsage();
        if (parseFloat(preMemory.usagePercent) > 75) {
            throw new Error(`内存使用过高 (${preMemory.usagePercent}%)，跳过合并`);
        }

        let mergedPdf = null;
        const loadedPdfs = []; // 跟踪已加载的PDF

        try {
            mergedPdf = await PDFDocument.create();
            let totalPages = 0;

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                console.log(`📖 处理文件 ${i + 1}/${files.length}: ${path.basename(file)}`);

                try {
                    // 检查文件大小
                    const stats = await fs.stat(file);
                    const fileSizeMB = stats.size / (1024 * 1024);
                    if (fileSizeMB > 10) {
                        console.warn(`⚠️ 跳过大文件: ${path.basename(file)} (${fileSizeMB.toFixed(2)}MB)`);
                        continue;
                    }

                    // 读取PDF文件
                    const pdfBytes = await fs.readFile(file);
                    const pdf = await PDFDocument.load(pdfBytes);
                    loadedPdfs.push({ pdf, bytes: pdfBytes });

                    // 获取页面并复制
                    const pageIndices = pdf.getPageIndices();
                    console.log(`   📄 添加 ${pageIndices.length} 页`);

                    // 分批复制页面，避免一次性复制太多
                    const batchSize = 3;
                    for (let j = 0; j < pageIndices.length; j += batchSize) {
                        const batch = pageIndices.slice(j, j + batchSize);
                        const copiedPages = await mergedPdf.copyPages(pdf, batch);
                        copiedPages.forEach((page) => {
                            mergedPdf.addPage(page);
                        });

                        // 检查内存
                        const memory = this.checkMemoryUsage();
                        if (parseFloat(memory.usagePercent) > 80) {
                            console.log(`⚠️ 内存压力过大 (${memory.usagePercent}%)，提前结束`);
                            break;
                        }
                    }

                    totalPages += pageIndices.length;

                    // 清理字节数组
                    pdfBytes.fill(0);

                } catch (error) {
                    console.warn(`⚠️ 跳过损坏的PDF文件: ${path.basename(file)} - ${error.message}`);
                }

                // 每处理一个文件后检查内存
                const memory = this.checkMemoryUsage();
                if (parseFloat(memory.usagePercent) > 75) {
                    console.log(`⚠️ 内存使用过高 (${memory.usagePercent}%)，强制垃圾回收`);
                    await this.forceGarbageCollection();
                }
            }

            if (totalPages === 0) {
                throw new Error('没有有效的页面可以合并');
            }

            console.log(`📚 小组合并完成，总计 ${totalPages} 页`);

            // 保存合并后的PDF
            console.log(`💾 保存PDF: ${path.basename(outputPath)}`);
            const finalPdfBytes = await mergedPdf.save();
            await fs.writeFile(outputPath, finalPdfBytes);

            // 清理内存
            finalPdfBytes.fill(0);

            const stats = await fs.stat(outputPath);
            const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            console.log(`✅ 小组PDF合并成功: ${fileSizeMB}MB, ${totalPages}页`);

        } catch (error) {
            console.error(`❌ 小组合并失败: ${error.message}`);
            throw error;
        } finally {
            // 清理所有已加载的PDF
            for (const loadedPdf of loadedPdfs) {
                try {
                    if (loadedPdf.bytes) {
                        loadedPdf.bytes.fill(0);
                    }
                } catch {}
            }

            // 强制垃圾回收
            await this.forceGarbageCollection();
        }
    }

    /**
     * 回退处理：保存为多个分片文件 - 增强版本
     */
    async fallbackToMultipleFiles(batchPdfs, outputPath) {
        console.log(`📁 生成分片PDF文件（内存保护模式）...`);

        if (batchPdfs.length > 0) {
            try {
                // 尝试至少保证第一个文件能成功
                await fs.copy(batchPdfs[0], outputPath);
                console.log(`📄 主PDF文件: ${path.basename(outputPath)}`);

                // 分片文件
                if (batchPdfs.length > 1) {
                    const mangaName = path.basename(outputPath, '.pdf');
                    let successCount = 1; // 已有主文件

                    for (let i = 1; i < batchPdfs.length; i++) {
                        try {
                            const partOutputPath = path.join(path.dirname(outputPath), `${mangaName}_part${i + 1}.pdf`);
                            await fs.copy(batchPdfs[i], partOutputPath);
                            console.log(`📄 分片文件: ${path.basename(partOutputPath)}`);
                            successCount++;
                        } catch (error) {
                            console.warn(`⚠️ 分片文件 ${i + 1} 复制失败: ${error.message}`);
                        }
                    }

                    console.log(`📋 分片模式完成: 成功保存 ${successCount}/${batchPdfs.length} 个PDF文件`);
                    console.log(`💡 建议：使用外部PDF合并工具（如PDFtk、Adobe Acrobat）手动合并`);

                    // 生成合并命令提示
                    const cmd = `pdftk "${mangaName}.pdf"`;
                    for (let i = 1; i < successCount; i++) {
                        cmd += ` "${mangaName}_part${i + 1}.pdf"`;
                    }
                    console.log(`🔧 PDFtk合并命令: ${cmd} cat output "${mangaName}_merged.pdf"`);
                }
            } catch (error) {
                console.error(`❌ 分片保存也失败了: ${error.message}`);
                throw new Error('所有PDF保存方式都失败了');
            }
        } else {
            throw new Error('没有可用的PDF文件');
        }
    }

    /**
     * 回退处理：保存为章节分片文件
     */
    async fallbackToChapterFiles(chapterPdfs, outputPath) {
        console.log(`📁 生成分章节PDF文件（内存保护模式）...`);

        if (chapterPdfs.length > 0) {
            try {
                // 尝试至少保证第一个文件能成功
                const firstChapterPdf = chapterPdfs[0];
                await fs.copy(firstChapterPdf.path, outputPath);
                console.log(`📄 主章节PDF文件: ${path.basename(outputPath)}`);

                // 分片文件
                if (chapterPdfs.length > 1) {
                    const mangaName = path.basename(outputPath, '.pdf');
                    let successCount = 1; // 已有主文件

                    for (let i = 1; i < chapterPdfs.length; i++) {
                        try {
                            const chapterPdf = chapterPdfs[i];
                            const partOutputPath = path.join(path.dirname(outputPath), `${mangaName}_part${i + 1}.pdf`);
                            await fs.copy(chapterPdf.path, partOutputPath);
                            console.log(`📄 分片文件: ${path.basename(partOutputPath)}`);
                            successCount++;
                        } catch (error) {
                            console.warn(`⚠️ 分片文件 ${i + 1} 复制失败: ${error.message}`);
                        }
                    }

                    console.log(`📋 章节分片模式完成: 成功保存 ${successCount}/${chapterPdfs.length} 个章节PDF文件`);
                    console.log(`💡 建议：使用外部PDF合并工具（如PDFtk、Adobe Acrobat）手动合并`);

                    // 生成合并命令提示
                    let cmd = `pdftk "${mangaName}.pdf"`;
                    for (let i = 1; i < successCount; i++) {
                        cmd += ` "${mangaName}_part${i + 1}.pdf"`;
                    }
                    cmd += ` cat output "${mangaName}_merged.pdf"`;
                    console.log(`🔧 PDFtk合并命令: ${cmd}`);
                }
            } catch (error) {
                console.error(`❌ 章节分片保存也失败了: ${error.message}`);
                throw new Error('所有章节PDF保存方式都失败了');
            }
        } else {
            throw new Error('没有可用的章节PDF文件');
        }
    }

    /**
     * 检查内存状态并决定处理策略
     */
    async checkMemoryAndDecideStrategy(fileCount) {
        const memory = this.checkMemoryUsage();
        const memoryPercent = parseFloat(memory.usagePercent);

        console.log(`🔍 内存状态检查: ${memory.heapUsed}MB使用中 (${memory.usagePercent}%)`);

        if (memoryPercent > 80) {
            console.log(`⚠️ 内存压力极高，建议降级为分片模式`);
            return 'split';
        } else if (memoryPercent > 60 || fileCount > 20) {
            console.log(`⚠️ 内存压力较高，使用超保守合并策略`);
            return 'ultra-conservative';
        } else if (fileCount > 10) {
            console.log(`📦 文件较多，使用小分组策略`);
            return 'small-groups';
        } else {
            console.log(`✅ 内存状态良好，可以尝试直接合并`);
            return 'direct';
        }
    }

    /**
     * 智能合并PDF文件 - 根据内存状态自动选择策略
     */
    async smartMergePdfFiles(batchPdfs, outputPath) {
        if (batchPdfs.length === 0) {
            throw new Error('没有PDF文件需要合并');
        }

        // 如果只有一个批次文件，直接复制
        if (batchPdfs.length === 1) {
            await fs.copy(batchPdfs[0], outputPath);
            console.log(`📄 单个PDF文件: ${path.basename(outputPath)}`);
            return;
        }

        console.log(`🧠 智能合并开始: ${batchPdfs.length} 个PDF文件`);

        // 检查内存状态并决定策略
        const strategy = await this.checkMemoryAndDecideStrategy(batchPdfs.length);

        try {
            switch (strategy) {
                case 'split':
                    console.log(`📁 执行分片策略...`);
                    await this.fallbackToMultipleFiles(batchPdfs, outputPath);
                    break;

                case 'ultra-conservative':
                    console.log(`🐌 执行超保守合并策略...`);
                    await this.mergeInUltraSmallGroups(batchPdfs, outputPath);
                    break;

                case 'small-groups':
                    console.log(`📦 执行小分组策略...`);
                    await this.mergeInUltraSmallGroups(batchPdfs, outputPath);
                    break;

                case 'direct':
                    console.log(`⚡ 尝试直接合并...`);
                    try {
                        if (batchPdfs.length <= 3) {
                            await this.mergeSmallGroup(batchPdfs, outputPath);
                        } else {
                            await this.mergeInUltraSmallGroups(batchPdfs, outputPath);
                        }
                    } catch (error) {
                        console.log(`⚠️ 直接合并失败，降级到超保守策略: ${error.message}`);
                        await this.mergeInUltraSmallGroups(batchPdfs, outputPath);
                    }
                    break;

                default:
                    await this.mergeInUltraSmallGroups(batchPdfs, outputPath);
            }

            // 验证结果
            if (await fs.pathExists(outputPath)) {
                const stats = await fs.stat(outputPath);
                const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                console.log(`✅ 智能合并成功: ${path.basename(outputPath)} (${fileSizeMB}MB)`);
            } else {
                throw new Error('合并后的文件不存在');
            }

        } catch (error) {
            console.error(`❌ 智能合并失败: ${error.message}`);
            console.log(`🔄 最后尝试：分片模式保存...`);

            try {
                await this.fallbackToMultipleFiles(batchPdfs, outputPath);
            } catch (fallbackError) {
                console.error(`❌ 分片模式也失败: ${fallbackError.message}`);
                throw new Error(`所有合并策略都失败了: ${error.message}`);
            }
        }
    }





    /**
     * 清理文件名
     */
    sanitizeFileName(fileName) {
        return fileName.replace(/[<>:"/\\|?*：？]/g, '_').trim();
    }

    /**
     * 转换所有漫画 - 使用并行处理
     */
    async convertAllMangas() {
        console.log('🔄 开始并行转换所有漫画为PDF...');

        const mangaList = await this.scanMangaDirectory();

        if (mangaList.length === 0) {
            console.log('⚠️ 没有找到任何漫画');
            return;
        }

        console.log(`📚 找到 ${mangaList.length} 个漫画，使用 ${this.maxConcurrency} 个并发进程处理`);

        // 创建进度跟踪器
        const progress = new ProgressTracker(mangaList.length);

        // 真正的并行处理 - 同时启动多个漫画转换
        let activePromises = [];
        let completed = 0;

        for (let i = 0; i < mangaList.length; i++) {
            const manga = mangaList[i];
            const globalIndex = i + 1;

            console.log(`🚀 [${globalIndex}/${mangaList.length}] 启动处理: ${manga.name} (${manga.chapters.length}章)`);

            // 创建转换Promise
            const convertPromise = this.convertMangaToPdf(manga).then(result => {
                const status = result.success ? (result.skipped ? '跳过' : '成功') : '失败';
                console.log(`${result.success ? (result.skipped ? '⏭️' : '✅') : '❌'} [${globalIndex}/${mangaList.length}] ${manga.name} - ${status}`);

                // 更新进度
                progress.update(result);
                completed++;

                return { manga, result, index: globalIndex };
            }).catch(error => {
                console.error(`❌ [${globalIndex}/${mangaList.length}] ${manga.name} - 异常: ${error.message}`);
                const errorResult = { success: false, error: error.message };
                progress.update(errorResult);
                completed++;

                return { manga, result: errorResult, index: globalIndex };
            });

            activePromises.push(convertPromise);

            // 当达到最大并发数或处理完所有漫画时，等待部分完成
            if (activePromises.length >= this.maxConcurrency || i === mangaList.length - 1) {
                console.log(`⏳ 等待 ${activePromises.length} 个并发任务完成...`);

                // 等待至少一个任务完成
                const finishedPromises = await Promise.allSettled(activePromises);

                // 检查内存使用
                const memory = this.checkMemoryUsage();
                console.log(`📊 并发批次完成: ${completed}/${mangaList.length}, 内存: ${memory.heapUsed}MB (${memory.usagePercent}%)`);

                // 强制垃圾回收
                await this.forceGarbageCollection();

                // 清空已完成的Promise数组
                activePromises = [];

                // 如果内存使用过高，等待释放
                if (parseFloat(memory.usagePercent) > 70) {
                    console.log(`⏸️ 内存使用较高，休息1秒...`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        // 等待所有剩余任务完成
        if (activePromises.length > 0) {
            console.log(`⏳ 等待最后 ${activePromises.length} 个任务完成...`);
            await Promise.allSettled(activePromises);
        }

        // 获取最终统计
        const stats = progress.getFinalStats();

        console.log('\n🎉 并行转换完成统计:');
        console.log(`   ✅ 成功: ${stats.success}`);
        console.log(`   ⏭️ 跳过: ${stats.skipped}`);
        console.log(`   ❌ 失败: ${stats.failed}`);
        console.log(`   ⏱️ 总耗时: ${stats.totalTime.toFixed(2)}秒`);
        console.log(`   ⚡ 平均耗时: ${stats.avgTime.toFixed(2)}秒/个`);
        console.log(`   🚀 并发数: ${this.maxConcurrency}`);
        console.log(`   📁 输出目录: ${this.outputDir}`);

        // 效率对比
        const sequentialTime = stats.avgTime * mangaList.length;
        const efficiency = ((sequentialTime - stats.totalTime) / sequentialTime * 100).toFixed(1);
        console.log(`   🔥 并行效率提升: ~${efficiency}% (相比顺序处理节省 ${(sequentialTime - stats.totalTime).toFixed(1)}秒)`);
    }

    /**
     * 转换指定的漫画
     */
    async convertSpecificManga(mangaName) {
        console.log(`🔍 查找漫画: ${mangaName}`);

        const mangaList = await this.scanMangaDirectory();
        const manga = mangaList.find(m => m.name === mangaName || m.name.includes(mangaName));

        if (!manga) {
            console.log(`❌ 未找到漫画: ${mangaName}`);
            console.log('📚 可用的漫画:');
            mangaList.forEach((m, i) => {
                console.log(`   ${i + 1}. ${m.name} (${m.chapters.length}章)`);
            });
            return;
        }

        console.log(`📖 找到漫画: ${manga.name} (${manga.chapters.length}章)`);

        const startTime = Date.now();
        const result = await this.convertMangaToPdf(manga);
        const duration = (Date.now() - startTime) / 1000;

        if (result.success) {
            if (result.skipped) {
                console.log(`⏭️ PDF已存在: ${result.path}`);
            } else {
                console.log(`✅ PDF生成成功: ${result.path}`);
            }
            console.log(`⏱️ 转换耗时: ${duration.toFixed(2)}秒`);
        } else {
            console.log(`❌ 转换失败: ${result.error}`);
        }
    }

    /**
     * 按章节组织图片
     */
    organizeImagesByChapter(allImages) {
        const chapterMap = new Map();

        // 按章节分组图片
        for (const image of allImages) {
            const chapterKey = image.chapterName;
            if (!chapterMap.has(chapterKey)) {
                chapterMap.set(chapterKey, {
                    chapterName: image.chapterName,
                    chapterNumber: this.extractChapterNumber(image.chapterName),
                    images: []
                });
            }
            chapterMap.get(chapterKey).images.push(image);
        }

        // 转换为数组并排序
        const chapters = Array.from(chapterMap.values());
        chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);

        // 每个章节内的图片也按页码排序
        for (const chapter of chapters) {
            chapter.images.sort((a, b) => a.page - b.page);
        }

        console.log(`📋 章节组织完成: ${chapters.length} 章`);
        chapters.forEach((chapter, index) => {
            console.log(`   第${chapter.chapterNumber}章: ${chapter.chapterName} (${chapter.images.length}张图片)`);
        });

        return chapters;
    }

    /**
     * 从章节名称中提取章节号
     */
    extractChapterNumber(chapterName) {
        const match = chapterName.match(/第(\d+)章/);
        return match ? parseInt(match[1]) : 0;
    }

    /**
     * 保存章节分片文件（测试模式）
     */
    async saveChapterParts(chapterPdfs, finalPdfPath) {
        console.log(`📁 开始保存章节分片文件...`);

        if (chapterPdfs.length === 0) {
            throw new Error('没有可用的章节PDF文件');
        }

        const mangaName = path.basename(finalPdfPath, '.pdf');
        const outputDir = path.dirname(finalPdfPath);
        let successCount = 0;

        console.log(`📚 总共 ${chapterPdfs.length} 个章节需要保存:`);

        // 保存每个章节为独立的part文件
        for (let i = 0; i < chapterPdfs.length; i++) {
            try {
                const chapterPdf = chapterPdfs[i];
                let partFileName;

                if (i === 0) {
                    // 第一个章节作为主文件
                    partFileName = `${mangaName}.pdf`;
                } else {
                    // 其他章节作为part文件
                    partFileName = `${mangaName}_part${i + 1}.pdf`;
                }

                const partOutputPath = path.join(outputDir, partFileName);

                console.log(`📄 保存第${chapterPdf.chapterNumber}章: ${chapterPdf.chapterName}`);
                console.log(`   输出文件: ${partFileName}`);

                await fs.copy(chapterPdf.path, partOutputPath);

                // 获取文件大小
                const stats = await fs.stat(partOutputPath);
                const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                console.log(`   ✅ 已保存: ${fileSizeMB}MB`);

                successCount++;

            } catch (error) {
                console.error(`❌ 保存章节 ${i + 1} 失败: ${error.message}`);
            }
        }

        console.log(`\n📋 章节分片保存完成:`);
        console.log(`   ✅ 成功: ${successCount}/${chapterPdfs.length} 个章节`);
        console.log(`   📁 输出目录: ${outputDir}`);

        if (successCount > 1) {
            // 生成合并命令提示
            let cmd = `pdftk "${mangaName}.pdf"`;
            for (let i = 1; i < successCount; i++) {
                cmd += ` "${mangaName}_part${i + 1}.pdf"`;
            }
            cmd += ` cat output "${mangaName}_merged.pdf"`;
            console.log(`\n🔧 需要合并时可使用: ${cmd}`);
        }

        // 列出所有生成的文件
        console.log(`\n📄 生成的文件列表:`);
        for (let i = 0; i < successCount; i++) {
            const fileName = i === 0 ? `${mangaName}.pdf` : `${mangaName}_part${i + 1}.pdf`;
            console.log(`   ${i + 1}. ${fileName}`);
        }

        return successCount;
    }
}

module.exports = MangaToPdfConverter;

// 如果直接运行此文件
if (require.main === module) {
    async function main() {
        const converter = new MangaToPdfConverter();

        try {
            // 检查命令行参数
            const args = process.argv.slice(2);

            // 解析参数
            let mangaName = null;
            let concurrency = null;
            let chapterConcurrency = null;
            let imageQuality = null;
            let singlePageMode = null;
            let compressCompleted = null;
            let minPagesForComplete = null;

            for (let i = 0; i < args.length; i++) {
                if (args[i] === '--concurrency' || args[i] === '-c') {
                    concurrency = parseInt(args[i + 1]);
                    i++; // 跳过下一个参数
                } else if (args[i] === '--batch-concurrency' || args[i] === '-b') {
                    chapterConcurrency = parseInt(args[i + 1]);
                    i++; // 跳过下一个参数
                } else if (args[i] === '--quality' || args[i] === '-q') {
                    imageQuality = parseInt(args[i + 1]);
                    i++; // 跳过下一个参数
                } else if (args[i] === '--single-page' || args[i] === '-s') {
                    singlePageMode = true;
                } else if (args[i] === '--multi-page' || args[i] === '-m') {
                    singlePageMode = false;
                } else if (args[i] === '--compress-completed' || args[i] === '-z') {
                    compressCompleted = true;
                } else if (args[i] === '--min-pages' || args[i] === '-p') {
                    minPagesForComplete = parseInt(args[i + 1]);
                    i++; // 跳过下一个参数
                } else if (!mangaName && !args[i].startsWith('-')) {
                    mangaName = args[i];
                }
            }

            // 显示帮助信息
            if (args.includes('--help') || args.includes('-h')) {
                console.log(`
📖 漫画转PDF工具使用说明 (简化版):

基本用法:
  node manga-to-pdf.js                    # 转换所有漫画
  node manga-to-pdf.js "漫画名"           # 转换指定漫画

选项:
  -c, --concurrency <数量>                # 漫画并发数量 (固定为10)
  -b, --batch-concurrency <数量>          # 章节并发数量 (固定为10)
  -q, --quality <质量>                    # 设置图片质量 (50-100, 默认80)
  -z, --compress-completed                # 只处理完成的章节，并删除原图片
  -h, --help                              # 显示此帮助信息

输出结构:
  - 每话生成独立的PDF文件
  - 文件结构: 漫画名/章节名.pdf

智能章节处理模式 (-z):
  - 只处理已完成的章节（根据chapter-completion-report.json判断）
  - 如果章节目录有zip文件：删除zip并跳过处理
  - 如果章节目录有图片：转换为PDF并删除原图片
  - 基于完成报告的精准处理，避免处理未完成章节
示例:
  node manga-to-pdf.js                    # 转换所有漫画
  node manga-to-pdf.js "鬼刀"             # 转换指定漫画
  node manga-to-pdf.js -z                 # 只处理完成章节并删除图片
  node manga-to-pdf.js "鬼刀" -z -q 90    # 指定漫画，质量90%
  node manga-to-pdf.js -z -c 1 -b 2       # 保守处理完成章节

智能章节处理模式说明:
  -z 参数会启用以下功能：
  1. 自动加载chapter-completion-report.json完成报告
  2. 只处理报告中标记为完成(completed: true)的章节
  3. 检查章节目录：如果有zip文件则删除zip并跳过处理
  4. 如果章节目录有图片：转换为PDF并删除原图片文件
  5. 精准处理完成章节，避免浪费时间处理未完成内容
`);
                return;
            }

            // 设置并发数量
            if (concurrency) {
                converter.setConcurrency(concurrency);
            }

            // 设置章节并发数量
            if (chapterConcurrency) {
                converter.setBatchConcurrency(chapterConcurrency);
            }

            // 设置图片压缩质量
            if (imageQuality) {
                converter.setImageQuality(imageQuality);
            } else {
                converter.setImageQuality(80); // 默认高质量
            }

            // 设置页面模式
            if (singlePageMode !== null) {
                converter.setSinglePageMode(singlePageMode);
            }

            // 设置压缩完成章节选项
            if (compressCompleted) {
                converter.setCompressCompletedChapters(true);
            }

            // 设置完成章节最小页数
            if (minPagesForComplete) {
                converter.setMinPagesForComplete(minPagesForComplete);
            }

            await converter.init();

            // 显示内存优化信息
            const hasGC = typeof global.gc === 'function';
            const initialMemory = converter.checkMemoryUsage();
            console.log(`💾 内存状态: ${initialMemory.heapUsed}MB使用中, 垃圾回收${hasGC ? '已启用' : '未启用'}`);

            if (!hasGC) {
                console.log(`⚠️ 建议使用 --expose-gc 参数启动以获得更好的内存管理`);
                console.log(`💡 示例: node --expose-gc --max-old-space-size=4096 manga-to-pdf.js`);
            }

            if (mangaName) {
                // 转换指定漫画
                console.log(`🎯 指定转换模式: ${mangaName}`);
                console.log(`🔧 配置: 漫画并发=${converter.maxConcurrency}, 章节并发=${converter.maxBatchConcurrency}`);
                console.log(`🖼️ 图片质量: ${converter.imageQuality}%, 最大宽度: ${converter.maxImageWidth}px`);
                console.log(`📄 页面模式: ${converter.singlePageMode ? '长页面（无缝连续）' : '多页面（每张图片独立页面）'}`);
                console.log(`📁 输出结构: 漫画/章节.pdf (每话独立PDF文件)`);
                console.log(`⚡ 原生PDF处理，无浏览器开销`);
                await converter.convertSpecificManga(mangaName);
            } else {
                // 转换所有漫画
                console.log(`🚀 批量转换模式`);
                console.log(`🔧 配置: 漫画并发=${converter.maxConcurrency}, 章节并发=${converter.maxBatchConcurrency}`);
                console.log(`🖼️ 图片质量: ${converter.imageQuality}%, 最大宽度: ${converter.maxImageWidth}px`);
                console.log(`📄 页面模式: ${converter.singlePageMode ? '长页面（无缝连续）' : '多页面（每张图片独立页面）'}`);
                console.log(`📁 输出结构: 漫画/章节.pdf (每话独立PDF文件)`);
                console.log(`⚡ 原生PDF处理，无浏览器开销`);
                await converter.convertAllMangas();
            }

        } catch (error) {
            console.error('❌ 转换过程中出错:', error);
        } finally {
            await converter.close();
        }
    }

    main();
}


