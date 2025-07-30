const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');

class MaxChapterCollector {
    constructor() {
        this.browser = null;
        this.page = null;
        this.mangaList = [];
        this.outputDir = '/Users/likaixuan/Documents/manga';
        this.inputFile = path.join(__dirname, 'manga-ids.json');
        this.outputFile = path.join(__dirname, 'manga-ids.json'); // 直接更新原文件
    }

    async init() {
        console.log('🚀 启动浏览器...');
        this.browser = await chromium.launch({
            headless: true,
            channel: 'chrome',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        this.page = await this.browser.newPage();

        // 设置用户代理
        await this.page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });

        // 确保输出目录存在
        await fs.ensureDir(this.outputDir);
    }

    async loadMangaIds() {
        try {
            console.log(`📖 读取漫画ID文件: ${this.inputFile}`);
            this.mangaList = await fs.readJson(this.inputFile);
            console.log(`✅ 成功读取 ${this.mangaList.length} 个漫画ID`);
            
            // 获取命令行参数或环境变量
            const mangaLimit = process.argv[2] || process.env.MANGA_LIMIT;
            let testLimit = 10; // 默认值
            
            if (mangaLimit !== undefined) {
                const parsed = parseInt(mangaLimit);
                if (isNaN(parsed) || parsed < 0) {
                    console.log(`⚠️ 警告: 无效的参数 "${mangaLimit}"，使用默认值 10`);
                } else {
                    testLimit = parsed;
                }
            }
            
            if (testLimit > 0 && this.mangaList.length > testLimit) {
                console.log(`🧪 限制模式：只处理前 ${testLimit} 个漫画`);
                console.log(`💡 提示: 可以使用参数 "0" 来处理所有漫画，如: node run-max-chapters.js 0`);
                this.mangaList = this.mangaList.slice(0, testLimit);
            } else if (testLimit === 0) {
                console.log(`🚀 处理所有 ${this.mangaList.length} 个漫画`);
            }
            
        } catch (error) {
            console.error('❌ 读取漫画ID文件失败:', error);
            throw error;
        }
    }

    async getMaxChapterForManga(manga, pageInstance = null, retryCount = 0) {
        const url = `https://www.colamanga.com/manga-${manga.id}/`;
        const maxRetries = 2;
        
        console.log(`🔍 正在处理漫画: ${manga.name} (${manga.id})${retryCount > 0 ? ` [重试 ${retryCount}/${maxRetries}]` : ''}`);
        
        // 如果没有提供page实例，创建一个新的
        const page = pageInstance || await this.browser.newPage();
        
        try {
            // 设置用户代理
            if (!pageInstance) {
                await page.setExtraHTTPHeaders({
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                });
            }
            
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            
            // 等待页面加载
            await page.waitForTimeout(1000);
            
            // 获取最大章节数
            const maxChapter = await page.evaluate(() => {
                // 查找 .all_data_list 中的第一个 li 元素
                const allDataList = document.querySelector('.all_data_list');
                if (!allDataList) {
                    console.log('未找到 .all_data_list 元素');
                    return null;
                }
                
                const firstLi = allDataList.querySelector('li:first-child');
                if (!firstLi) {
                    console.log('未找到第一个 li 元素');
                    return null;
                }
                
                const firstLink = firstLi.querySelector('a');
                if (!firstLink) {
                    console.log('未找到第一个 li 中的 a 元素');
                    return null;
                }
                
                const href = firstLink.getAttribute('href');
                if (!href) {
                    console.log('未找到 href 属性');
                    return null;
                }
                
                console.log('找到的 href:', href);
                
                // 从 href 中提取章节数，格式如: "/manga-ap101511/1/934.html"
                const match = href.match(/\/manga-[^\/]+\/\d+\/(\d+)\.html/);
                if (match) {
                    const chapterNum = parseInt(match[1]);
                    console.log('提取到的章节数:', chapterNum);
                    return chapterNum;
                }
                
                return null;
            });
            
            if (maxChapter !== null) {
                console.log(`✅ ${manga.name}: 最大章节数 ${maxChapter}`);
                return maxChapter;
            } else {
                console.log(`⚠️ ${manga.name}: 无法获取章节数`);
                return null;
            }
            
        } catch (error) {
            console.error(`❌ 处理漫画 ${manga.name} 时出错:`, error.message);
            
            // 如果还有重试次数，则重试
            if (retryCount < maxRetries) {
                console.log(`🔄 将在2秒后重试...`);
                await page.waitForTimeout(2000);
                
                // 递归重试
                return await this.getMaxChapterForManga(manga, pageInstance, retryCount + 1);
            } else {
                console.error(`💥 ${manga.name} 达到最大重试次数，放弃处理`);
                return null;
            }
        } finally {
            // 如果是新创建的page，需要关闭它
            if (!pageInstance && page) {
                await page.close();
            }
        }
    }

    async collectMaxChapters() {
        console.log('🚀 开始收集最大章节数...');
        
        // 智能并发数设置
        let defaultConcurrency = 3;
        if (this.mangaList.length <= 20) {
            defaultConcurrency = 2; // 少量漫画用较低并发
        } else if (this.mangaList.length >= 100) {
            defaultConcurrency = 5; // 大量漫画用较高并发
        }
        
        const concurrency = parseInt(process.argv[3]) || defaultConcurrency;
        console.log(`⚡ 并发数设置: ${concurrency} (处理 ${this.mangaList.length} 个漫画)`);
        
        const results = await this.processConcurrently(this.mangaList, concurrency);
        
        this.mangaList = results;
        console.log('🎉 章节数收集完成！');
    }

    async processConcurrently(mangaList, concurrency) {
        const results = [];
        const total = mangaList.length;
        let completed = 0;
        let failed = 0;

        // 分批处理
        for (let i = 0; i < mangaList.length; i += concurrency) {
            const batch = mangaList.slice(i, i + concurrency);
            console.log(`📦 处理批次 ${Math.floor(i / concurrency) + 1}/${Math.ceil(mangaList.length / concurrency)}，包含 ${batch.length} 个漫画`);
            
            // 并发处理当前批次，每个任务使用独立的page
            const batchPromises = batch.map(async (manga, index) => {
                let page = null;
                try {
                    // 为每个任务创建独立的page
                    page = await this.browser.newPage();
                    await page.setExtraHTTPHeaders({
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    });
                    
                    const maxChapter = await this.getMaxChapterForManga(manga, page);
                    completed++;
                    
                    // 显示进度
                    if (completed % 5 === 0 || completed === total) {
                        console.log(`📊 进度: ${completed}/${total} (成功: ${completed - failed}, 失败: ${failed})`);
                    }
                    
                    return {
                        ...manga,
                        maxChapter: maxChapter
                    };
                } catch (error) {
                    failed++;
                    console.error(`❌ 处理 ${manga.name} 失败:`, error.message);
                    return {
                        ...manga,
                        maxChapter: null
                    };
                } finally {
                    // 确保page被关闭
                    if (page) {
                        await page.close();
                    }
                }
            });

            // 等待当前批次完成
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
            
            // 批次间延时，根据并发数动态调整
            if (i + concurrency < mangaList.length) {
                const delayTime = Math.max(1000, 3000 - (concurrency * 200)); // 并发越高，延时越短
                console.log(`⏳ 批次间等待 ${delayTime/1000} 秒...`);
                await new Promise(resolve => setTimeout(resolve, delayTime));
            }
        }

        console.log(`📈 处理完成统计: 总计 ${total}, 成功 ${completed - failed}, 失败 ${failed}`);
        return results;
    }

    async saveMangaList() {
        console.log(`💾 保存更新后的漫画列表到: ${this.outputFile}`);
        
        // 创建备份文件
        const backupFile = this.outputFile.replace('.json', '.backup.json');
        if (await fs.pathExists(this.outputFile)) {
            await fs.copy(this.outputFile, backupFile);
            console.log(`📋 已创建备份文件: ${backupFile}`);
        }
        
        await fs.writeJson(this.outputFile, this.mangaList, { spaces: 2 });
        
        // 统计信息
        const withChapters = this.mangaList.filter(manga => manga.maxChapter !== null).length;
        const withoutChapters = this.mangaList.length - withChapters;
        
        console.log(`📊 保存完成！`);
        console.log(`  - 总计漫画: ${this.mangaList.length}`);
        console.log(`  - 成功获取章节数: ${withChapters}`);
        console.log(`  - 未能获取章节数: ${withoutChapters}`);
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            console.log('🔒 浏览器已关闭');
        }
    }
}

// 主函数
async function main() {
    const collector = new MaxChapterCollector();

    try {
        await collector.init();
        await collector.loadMangaIds();
        await collector.collectMaxChapters();
        await collector.saveMangaList();
    } catch (error) {
        console.error('❌ 收集过程中出错:', error);
    } finally {
        await collector.close();
    }
}

// 如果直接运行此文件
if (require.main === module) {
    main().catch(console.error);
}

module.exports = MaxChapterCollector; 