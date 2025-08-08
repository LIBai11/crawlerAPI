const fs = require('fs-extra');
const path = require('path');

/**
 * 章节完成状态检查器
 * 功能：
 * 1. 读取 total-page.json 中每个漫画的每个章节的最大图片数量
 * 2. 扫描本地漫画目录，统计每个章节的有效图片数量（size > 4KB）
 * 3. 对比两者，判断章节是否完成
 * 4. 输出简洁的 JSON 格式结果
 */
class ChapterCompletionChecker {
    constructor(options = {}) {
        // 配置文件路径
        this.totalPagesFile = options.totalPagesFile || '/Users/likaixuan/Documents/manga/manga-chapter-total-pages.json';
        this.mangaDir = options.mangaDir || '/Users/likaixuan/Documents/manga';
        this.minImageSizeKB = options.minImageSizeKB || 4;
        
        // 数据存储
        this.totalPagesData = null;
        this.completionResults = {};
    }

    /**
     * 初始化 - 加载总页数数据
     */
    async init() {
        console.log('🚀 初始化章节完成状态检查器...');

        // 检查指定的文件是否存在
        if (!(await fs.pathExists(this.totalPagesFile))) {
            throw new Error(`❌ 未找到总页数文件: ${this.totalPagesFile}`);
        }

        console.log(`📊 加载总页数数据: ${this.totalPagesFile}`);
        const data = await fs.readJson(this.totalPagesFile);
        this.totalPagesData = data.results || data;

        if (!Array.isArray(this.totalPagesData)) {
            throw new Error('❌ 总页数数据格式错误，应该是包含 results 数组的对象');
        }

        console.log(`✅ 已加载 ${this.totalPagesData.length} 个漫画的章节页数数据`);
    }

    /**
     * 检查图片文件大小是否有效
     */
    async isImageSizeValid(filePath, minSizeKB = this.minImageSizeKB) {
        try {
            const stats = await fs.stat(filePath);
            return stats.size >= (minSizeKB * 1024);
        } catch (error) {
            return false;
        }
    }

    /**
     * 获取章节目录中的有效图片数量
     */
    async getValidImageCount(chapterDir) {
        try {
            if (!(await fs.pathExists(chapterDir))) {
                return 0;
            }

            const files = await fs.readdir(chapterDir);
            const imageFiles = files.filter(file => 
                /\.(png|jpg|jpeg|webp)$/i.test(file)
            );

            let validCount = 0;
            for (const file of imageFiles) {
                const filePath = path.join(chapterDir, file);
                if (await this.isImageSizeValid(filePath)) {
                    validCount++;
                }
            }

            return validCount;
        } catch (error) {
            console.warn(`⚠️ 检查章节目录失败: ${chapterDir} - ${error.message}`);
            return 0;
        }
    }

    /**
     * 查找漫画目录
     */
    async findMangaDirectory(mangaName) {
        try {
            const items = await fs.readdir(this.mangaDir);
            
            // 精确匹配
            if (items.includes(mangaName)) {
                return path.join(this.mangaDir, mangaName);
            }

            // 模糊匹配
            const fuzzyMatch = items.find(item => 
                item.includes(mangaName) || mangaName.includes(item)
            );

            if (fuzzyMatch) {
                return path.join(this.mangaDir, fuzzyMatch);
            }

            return null;
        } catch (error) {
            console.warn(`⚠️ 查找漫画目录失败: ${mangaName} - ${error.message}`);
            return null;
        }
    }

    /**
     * 查找章节目录
     */
    async findChapterDirectory(mangaDir, chapterNumber) {
        try {
            const items = await fs.readdir(mangaDir);
            
            // 查找以 "第{章节号}章" 开头的目录
            const chapterPattern = `第${chapterNumber}章`;
            const chapterDir = items.find(item => item.startsWith(chapterPattern));

            if (chapterDir) {
                return path.join(mangaDir, chapterDir);
            }

            return null;
        } catch (error) {
            console.warn(`⚠️ 查找章节目录失败: ${mangaDir}/第${chapterNumber}章 - ${error.message}`);
            return null;
        }
    }

    /**
     * 检查单个漫画的所有章节
     */
    async checkMangaCompletion(mangaData) {
        const mangaName = mangaData.name;
        const mangaId = mangaData.id;
        const maxChapter = mangaData.maxChapter || 0;
        const totalChapters = mangaData.totalChapters || 0;
        const successfulChapters = mangaData.successfulChapters || 0;

        console.log(`📖 检查漫画: ${mangaName} (ID: ${mangaId})`);
        console.log(`   📊 数据统计: 最大章节${maxChapter}, 总章节${totalChapters}, 成功获取页数${successfulChapters}`);

        // 查找漫画目录
        const mangaDir = await this.findMangaDirectory(mangaName);
        if (!mangaDir) {
            console.log(`⚠️ 未找到漫画目录: ${mangaName}`);
            return {};
        }

        const chapterResults = {};
        let checkedCount = 0;
        let completedCount = 0;

        // 检查每个章节
        for (const chapterData of mangaData.chapters || []) {
            const chapterNumber = chapterData.chapter;
            const expectedPages = chapterData.totalPage;

            // 跳过失败的章节
            if (expectedPages === 'fail' || expectedPages === null || expectedPages === undefined) {
                console.log(`  第${chapterNumber}章: 跳过 (totalPage: ${expectedPages})`);
                continue;
            }

            const expectedCount = parseInt(expectedPages);
            if (isNaN(expectedCount) || expectedCount <= 0) {
                console.log(`  第${chapterNumber}章: 跳过 (无效页数: ${expectedPages})`);
                continue;
            }

            checkedCount++;

            // 查找章节目录
            const chapterDir = await this.findChapterDirectory(mangaDir, chapterNumber);
            if (!chapterDir) {
                chapterResults[chapterNumber] = {
                    completed: false,
                    expectedPages: expectedCount,
                    actualPages: 0,
                    status: 'directory_not_found'
                };
                console.log(`  第${chapterNumber}章: 0/${expectedCount} ❌ (目录不存在)`);
                continue;
            }

            // 获取有效图片数量
            const validImageCount = await this.getValidImageCount(chapterDir);

            // 判断是否完成（有效图片数量 >= 期望数量）
            const isComplete = validImageCount >= expectedCount;

            chapterResults[chapterNumber] = {
                completed: isComplete,
                expectedPages: expectedCount,
                actualPages: validImageCount,
                status: isComplete ? 'completed' : 'incomplete'
            };

            if (isComplete) {
                completedCount++;
            }

            const status = isComplete ? '✅' : '❌';
            const extra = validImageCount > expectedCount ? ` (超额${validImageCount - expectedCount})` : '';
            console.log(`  第${chapterNumber}章: ${validImageCount}/${expectedCount} ${status}${extra}`);
        }

        console.log(`   📈 本地完成率: ${completedCount}/${checkedCount} (${checkedCount > 0 ? ((completedCount / checkedCount) * 100).toFixed(1) : 0}%)`);
        return chapterResults;
    }

    /**
     * 检查所有漫画的完成状态
     */
    async checkAllCompletion() {
        console.log('🔍 开始检查所有漫画的章节完成状态...\n');

        for (const mangaData of this.totalPagesData) {
            const mangaName = mangaData.name;
            const chapterResults = await this.checkMangaCompletion(mangaData);
            
            if (Object.keys(chapterResults).length > 0) {
                this.completionResults[mangaName] = chapterResults;
            }
        }

        console.log('\n✅ 检查完成！');
    }

    /**
     * 生成并保存结果
     */
    async generateReport() {
        const outputFile = './chapter-completion-report.json';

        // 计算详细统计信息
        let totalMangas = 0;
        let mangasWithData = 0;
        let totalChapters = 0;
        let completedChapters = 0;
        let totalExpectedPages = 0;
        let totalValidPages = 0;
        const mangaStats = {};

        // 只遍历本地存在的漫画计算统计
        for (const mangaData of this.totalPagesData) {
            totalMangas++;
            const mangaName = mangaData.name;
            const chapterResults = this.completionResults[mangaName] || {};

            // 只统计本地存在的漫画
            if (Object.keys(chapterResults).length === 0) {
                continue; // 跳过本地不存在的漫画
            }

            mangasWithData++;

            let mangaExpectedPages = 0;
            let mangaValidPages = 0;
            let mangaCompletedChapters = 0;
            let mangaTotalChapters = 0;

            for (const chapterData of mangaData.chapters || []) {
                if (chapterData.totalPage === 'fail' || chapterData.totalPage === null || chapterData.totalPage === undefined) {
                    continue;
                }

                const expectedCount = parseInt(chapterData.totalPage);
                if (isNaN(expectedCount) || expectedCount <= 0) {
                    continue;
                }

                mangaTotalChapters++;
                totalChapters++;
                mangaExpectedPages += expectedCount;
                totalExpectedPages += expectedCount;

                const chapterNumber = chapterData.chapter;
                const chapterResult = chapterResults[chapterNumber];
                if (chapterResult && chapterResult.completed) {
                    mangaCompletedChapters++;
                    completedChapters++;
                    mangaValidPages += chapterResult.actualPages || expectedCount;
                    totalValidPages += chapterResult.actualPages || expectedCount;
                }
            }

            if (mangaTotalChapters > 0) {
                mangaStats[mangaName] = {
                    totalChapters: mangaTotalChapters,
                    completedChapters: mangaCompletedChapters,
                    completionRate: ((mangaCompletedChapters / mangaTotalChapters) * 100).toFixed(1) + '%',
                    expectedPages: mangaExpectedPages,
                    estimatedValidPages: mangaValidPages
                };
            }
        }

        // 生成详细的报告
        const report = {
            timestamp: new Date().toISOString(),
            summary: {
                totalMangasInData: totalMangas,
                mangasWithLocalData: mangasWithData,
                totalChapters: totalChapters,
                completedChapters: completedChapters,
                completionRate: totalChapters > 0 ? ((completedChapters / totalChapters) * 100).toFixed(2) + '%' : '0%',
                totalExpectedPages: totalExpectedPages,
                estimatedValidPages: totalValidPages,
                pageCompletionRate: totalExpectedPages > 0 ? ((totalValidPages / totalExpectedPages) * 100).toFixed(2) + '%' : '0%'
            },
            mangaStats: mangaStats,
            results: this.completionResults
        };

        // 保存报告
        await fs.writeJson(outputFile, report, { spaces: 2 });

        console.log(`\n📄 报告已保存: ${outputFile}`);
        console.log(`📊 总体统计:`);
        console.log(`   数据中的漫画总数: ${report.summary.totalMangasInData}`);
        console.log(`   本地存在的漫画: ${report.summary.mangasWithLocalData}`);
        console.log(`   本地漫画的章节总数: ${report.summary.totalChapters}`);
        console.log(`   已完成章节: ${report.summary.completedChapters}`);
        console.log(`   章节完成率: ${report.summary.completionRate}`);
        console.log(`   本地漫画预期图片总数: ${report.summary.totalExpectedPages}`);
        console.log(`   估计有效图片: ${report.summary.estimatedValidPages}`);
        console.log(`   图片完成率: ${report.summary.pageCompletionRate}`);

        return outputFile;
    }

    /**
     * 主执行函数
     */
    async run() {
        try {
            await this.init();
            await this.checkAllCompletion();
            await this.generateReport();
        } catch (error) {
            console.error('❌ 执行失败:', error.message);
            throw error;
        }
    }
}

// 主函数
async function main() {
    const checker = new ChapterCompletionChecker({
        totalPagesFile: '/Users/likaixuan/Documents/manga/manga-chapter-total-pages.json',
        mangaDir: '/Users/likaixuan/Documents/manga'
    });

    try {
        await checker.run();
    } catch (error) {
        console.error('❌ 程序执行失败:', error);
        process.exit(1);
    }
}

// 如果直接运行此文件
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { ChapterCompletionChecker };
