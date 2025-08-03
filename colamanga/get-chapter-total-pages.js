const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { parseFullMangaData, getTotalPage } = require('./analysis/decryptCDATA.js');

class ChapterTotalPageCollector {
    constructor() {
        this.mangaIdsFile = '/Users/likaixuan/Documents/manga/manga-ids.json';
        this.outputFile = '/Users/likaixuan/Documents/manga/manga-chapter-total-pages.json';
        this.results = [];
        this.concurrency = 15; // 并发数量
        this.limit = null; // 将在 init 中初始化

        // 进度跟踪
        this.processedCount = 0;
        this.successCount = 0;
        this.failCount = 0;
        this.startTime = null;
        this.saveInterval = 100; // 每处理100个任务保存一次
        this.completedTasks = new Map(); // 存储已完成的任务结果
        this.CDATAKEY = 'w57pVEV5N9vENbQ2'; // 用于解密C_DATA的密钥
        this.encodeKey1 = 'aGzU9QOeLVaK3rnL'; // 用于加密的密钥1
        this.encodeKey2 = 'TJloldeXW7EJOfrd'; // 用于加密的密钥2
    }

    async init() {
        console.log('🚀 初始化章节页数收集器...');

        // 动态导入 p-limit
        const pLimit = (await import('p-limit')).default;
        this.limit = pLimit(this.concurrency);

        // 检查输入文件是否存在
        if (!await fs.pathExists(this.mangaIdsFile)) {
            throw new Error(`漫画ID文件不存在: ${this.mangaIdsFile}`);
        }

        // 读取漫画ID列表
        this.mangaList = await fs.readJson(this.mangaIdsFile);
        console.log(`📚 加载了 ${this.mangaList.length} 个漫画`);

        // 加载已有的结果文件
        await this.loadExistingResults();

        // 收集所有需要处理的任务
        this.tasks = await this.collectAllTasks();
        console.log(`📋 收集到 ${this.tasks.length} 个待处理任务`);
    }

    async collectAllChapterPages() {
        console.log('📖 开始收集所有章节的总页数...');
        console.log(`⚡ 并发设置: ${this.concurrency} 个并发请求`);
        console.log(`� 开始处理 ${this.tasks.length} 个任务`);
        console.log(`💾 每处理 ${this.saveInterval} 个任务自动保存一次`);

        if (this.tasks.length === 0) {
            console.log('🎉 没有需要处理的任务！');
            return;
        }

        this.startTime = Date.now();
        this.processedCount = 0;
        this.successCount = 0;
        this.failCount = 0;

        // 使用 pLimit 并发处理所有任务，添加进度跟踪
        const results = await Promise.allSettled(
            this.tasks.map((task, index) => this.limit(() => this.processTaskWithProgress(task, index)))
        );

        // 处理结果并更新数据结构
        await this.processTaskResults(results);

        // 保存最终结果
        await this.saveResults();

        console.log('\n🎉 所有任务处理完成！');
        await this.printSummary();
    }

    async loadExistingResults() {
        try {
            if (await fs.pathExists(this.outputFile)) {
                const existingData = await fs.readJson(this.outputFile);
                this.results = existingData.results || [];

                console.log(`📂 加载已有结果: ${this.results.length} 个漫画`);
            }
        } catch (error) {
            console.warn('⚠️ 加载已有结果失败，将从头开始:', error.message);
        }
    }

    async collectAllTasks() {
        const tasks = [];

        // 为每个漫画收集需要处理的章节任务
        for (const manga of this.mangaList) {
            const existingResult = this.results.find(r => r.id === manga.id);
            const maxChapter = manga.maxChapter || 100;

            // 如果漫画已经完全处理过，跳过
            if (existingResult && !existingResult.error && existingResult.totalChapters >= maxChapter) {
                // 检查是否有失败的章节需要重试
                const hasFailedChapters = existingResult.chapters.some(c => c.totalPage === 'fail');
                if (!hasFailedChapters) {
                    continue; // 跳过已完成的漫画
                }
            }

            // 收集需要处理的章节
            for (let chapter = 1; chapter <= maxChapter; chapter++) {
                let needProcess = true;

                // 检查章节是否已经成功处理
                if (existingResult && existingResult.chapters) {
                    const existingChapter = existingResult.chapters.find(c => c.chapter === chapter);
                    if (existingChapter && existingChapter.totalPage !== null && existingChapter.totalPage !== 'fail') {
                        needProcess = false; // 已成功处理，跳过
                    }
                }

                if (needProcess) {
                    tasks.push({
                        mangaId: manga.id,
                        mangaName: manga.name,
                        chapter: chapter,
                        taskId: `${manga.id}-${chapter}`
                    });
                }
            }
        }

        return tasks;
    }

    async processTaskWithProgress(task, index) {
        try {
            const totalPage = await this.getChapterTotalPage(task.mangaId, task.chapter);
            const result = {
                ...task,
                totalPage: totalPage,
                success: true,
                processedAt: new Date().toISOString()
            };

            // 存储已完成的任务结果
            if (!this.completedTasks.has(result.mangaId)) {
                this.completedTasks.set(result.mangaId, []);
            }
            this.completedTasks.get(result.mangaId).push(result);

            this.successCount++;
            this.updateProgress();
            return result;
        } catch (error) {
            const result = {
                ...task,
                totalPage: 'fail',
                success: false,
                error: error.message,
                processedAt: new Date().toISOString()
            };

            // 存储已完成的任务结果
            if (!this.completedTasks.has(result.mangaId)) {
                this.completedTasks.set(result.mangaId, []);
            }
            this.completedTasks.get(result.mangaId).push(result);

            this.failCount++;
            this.updateProgress();
            return result;
        }
    }

    updateProgress() {
        this.processedCount++;

        // 每处理一定数量的任务显示进度
        if (this.processedCount % 50 === 0 || this.processedCount === this.tasks.length) {
            const elapsed = Date.now() - this.startTime;
            const rate = this.processedCount / (elapsed / 1000);
            const eta = this.tasks.length > this.processedCount ?
                ((this.tasks.length - this.processedCount) / rate) : 0;

            console.log(`📊 进度: ${this.processedCount}/${this.tasks.length} (${(this.processedCount/this.tasks.length*100).toFixed(1)}%) | ` +
                       `成功: ${this.successCount} | 失败: ${this.failCount} | ` +
                       `速度: ${rate.toFixed(1)} 任务/秒 | 预计剩余: ${this.formatTime(eta)}`);
        }

        // 实时保存
        if (this.processedCount % this.saveInterval === 0) {
            this.saveProgressResults();
        }
    }

    formatTime(seconds) {
        if (seconds < 60) return `${Math.round(seconds)}秒`;
        if (seconds < 3600) return `${Math.round(seconds/60)}分钟`;
        return `${Math.round(seconds/3600)}小时`;
    }

    async saveProgressResults() {
        try {
            // 使用当前已完成的任务更新结果
            this.updateResults(this.completedTasks);

            // 静默保存到文件
            await this.saveResults(true);

            console.log(`💾 [${new Date().toLocaleTimeString()}] 实时保存: ${this.processedCount}/${this.tasks.length} 已处理 (成功: ${this.successCount}, 失败: ${this.failCount})`);
        } catch (error) {
            console.error(`❌ 实时保存失败: ${error.message}`);
        }
    }

    async processTaskResults(results) {
        const processedTasks = new Map();

        // 处理任务结果
        results.forEach((result, index) => {
            const task = this.tasks[index];
            let taskResult;

            if (result.status === 'fulfilled') {
                taskResult = result.value;
            } else {
                taskResult = {
                    ...task,
                    totalPage: 'fail',
                    success: false,
                    error: result.reason?.message || 'Unknown error',
                    processedAt: new Date().toISOString()
                };
            }

            // 按漫画ID分组任务结果
            if (!processedTasks.has(taskResult.mangaId)) {
                processedTasks.set(taskResult.mangaId, []);
            }
            processedTasks.get(taskResult.mangaId).push(taskResult);
        });

        console.log(`\n📊 任务处理完成: 成功 ${this.successCount} 个，失败 ${this.failCount} 个`);

        // 更新结果数据结构
        this.updateResults(processedTasks);
    }

    updateResults(processedTasks) {
        // 为每个漫画更新或创建结果
        for (const [mangaId, taskResults] of processedTasks) {
            const manga = this.mangaList.find(m => m.id === mangaId);
            if (!manga) continue;

            // 查找现有结果
            let existingResultIndex = this.results.findIndex(r => r.id === mangaId);
            let mangaResult;

            if (existingResultIndex !== -1) {
                // 更新现有结果
                mangaResult = this.results[existingResultIndex];
            } else {
                // 创建新结果
                mangaResult = {
                    id: mangaId,
                    name: manga.name,
                    maxChapter: manga.maxChapter || 0,
                    chapters: [],
                    totalChapters: 0,
                    successfulChapters: 0,
                    processedAt: new Date().toISOString()
                };
                this.results.push(mangaResult);
                existingResultIndex = this.results.length - 1;
            }

            // 更新章节数据
            taskResults.forEach(taskResult => {
                const existingChapterIndex = mangaResult.chapters.findIndex(c => c.chapter === taskResult.chapter);
                const chapterData = {
                    chapter: taskResult.chapter,
                    totalPage: taskResult.totalPage
                };

                if (existingChapterIndex !== -1) {
                    // 更新现有章节
                    mangaResult.chapters[existingChapterIndex] = chapterData;
                } else {
                    // 添加新章节
                    mangaResult.chapters.push(chapterData);
                }
            });

            // 按章节号排序
            mangaResult.chapters.sort((a, b) => a.chapter - b.chapter);

            // 更新统计信息
            mangaResult.totalChapters = mangaResult.chapters.length;
            mangaResult.successfulChapters = mangaResult.chapters.filter(c => c.totalPage !== 'fail' && c.totalPage !== null).length;
            mangaResult.processedAt = new Date().toISOString();

            // 更新结果
            this.results[existingResultIndex] = mangaResult;

            console.log(`✅ 更新漫画 ${manga.name}: ${mangaResult.successfulChapters}/${mangaResult.totalChapters} 章节成功`);
        }
    }



    async getChapterTotalPage(mangaId, chapter) {
        // 构造章节URL
        const chapterUrl = `https://www.colamanga.com/manga-${mangaId}/1/${chapter}.html`;
        
        try {
            // 发送GET请求获取页面内容
            const response = await axios.get(chapterUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.8,en-US;q=0.5,en;q=0.3',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                timeout: 30000
            });

            // 从响应中提取C_DATA
            const htmlContent = response.data;
            const cdataMatch = htmlContent.match(/C_DATA\s*=\s*['"]([^'"]+)['"]/);
            
            if (!cdataMatch) {
                throw new Error('未找到C_DATA');
            }

            const cdata = cdataMatch[1];
            
            // 使用解密函数解析数据
            const mangaData = parseFullMangaData(cdata, this.CDATAKEY);

            // 使用 getTotalPage 函数解密 enc_code1 获取总页数
            try {
                // 尝试不同的密钥
                const keys = ['aGzU9QOeLVaK3rnL', 'TJloldeXW7EJOfrd'];

                for (const key of keys) {
                    try {
                        const totalPageStr = getTotalPage(mangaData.mh_info, key);
                        if (totalPageStr && totalPageStr.trim()) {
                            const totalPage = parseInt(totalPageStr.trim());
                            if (!isNaN(totalPage) && totalPage > 0) {
                                return totalPage;
                            }
                        }
                    } catch (keyError) {
                        // 继续尝试下一个密钥
                        continue;
                    }
                }

                throw new Error('所有密钥都无法解密总页数');
            } catch (error) {
                throw new Error(`解密总页数失败: ${error.message}`);
            }
            
        } catch (error) {
            if (error.response && error.response.status === 404) {
                throw new Error('章节不存在(404)');
            } else if (error.code === 'ECONNABORTED') {
                throw new Error('请求超时');
            } else {
                throw new Error(`请求失败: ${error.message}`);
            }
        }
    }

    async saveResults(silent = false) {
        try {
            const totalChapters = this.results.reduce((sum, r) => sum + r.totalChapters, 0);
            const successfulChapters = this.results.reduce((sum, r) => sum + r.successfulChapters, 0);
            const failedChapters = totalChapters - successfulChapters;
            const successfulMangas = this.results.filter(r => !r.error).length;

            await fs.writeJson(this.outputFile, {
                timestamp: new Date().toISOString(),
                summary: {
                    totalMangas: this.results.length,
                    successfulMangas: successfulMangas,
                    totalChapters: totalChapters,
                    successfulChapters: successfulChapters,
                    failedChapters: failedChapters,
                    successRate: totalChapters > 0 ? ((successfulChapters / totalChapters) * 100).toFixed(2) + '%' : '0%',
                    concurrency: this.concurrency
                },
                results: this.results
            }, { spaces: 2 });

            if (!silent) {
                console.log(`💾 结果已保存: ${this.results.length} 个漫画, ${successfulChapters} 个成功章节, ${failedChapters} 个失败章节`);
            }
        } catch (error) {
            console.error('❌ 保存结果失败:', error);
        }
    }

    async printSummary() {
        const totalMangas = this.results.length;
        const successfulMangas = this.results.filter(r => !r.error).length;
        const totalChapters = this.results.reduce((sum, r) => sum + r.totalChapters, 0);
        const successfulChapters = this.results.reduce((sum, r) => sum + r.successfulChapters, 0);
        const failedChapters = totalChapters - successfulChapters;

        console.log('\n📊 收集统计:');
        console.log(`  📚 总漫画数: ${totalMangas}`);
        console.log(`  ✅ 成功处理的漫画: ${successfulMangas}`);
        console.log(`  📄 总章节数: ${totalChapters}`);
        console.log(`  ✅ 成功获取页数的章节: ${successfulChapters}`);
        console.log(`  ❌ 失败的章节: ${failedChapters}`);
        console.log(`  📈 成功率: ${totalChapters > 0 ? ((successfulChapters / totalChapters) * 100).toFixed(2) : 0}%`);
        console.log(`  ⚡ 并发数: ${this.concurrency}`);
    }
}

// 主函数
async function main() {
    const collector = new ChapterTotalPageCollector();
    
    try {
        await collector.init();
        await collector.collectAllChapterPages();
    } catch (error) {
        console.error('❌ 收集过程中出错:', error);
    }
}

// 如果直接运行此文件
if (require.main === module) {
    main().catch(console.error);
}

module.exports = ChapterTotalPageCollector;
