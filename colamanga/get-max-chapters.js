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

    async getMaxChapterForManga(manga) {
        const url = `https://www.colamanga.com/manga-${manga.id}/`;
        console.log(`🔍 正在处理漫画: ${manga.name} (${manga.id})`);
        
        try {
            await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            
            // 等待页面加载
            await this.page.waitForTimeout(2000);
            
            // 获取最大章节数
            const maxChapter = await this.page.evaluate(() => {
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
            return null;
        }
    }

    async collectMaxChapters() {
        console.log('🚀 开始收集最大章节数...');
        
        const updatedMangaList = [];
        
        for (let i = 0; i < this.mangaList.length; i++) {
            const manga = this.mangaList[i];
            console.log(`📄 处理进度: ${i + 1}/${this.mangaList.length}`);
            
            const maxChapter = await this.getMaxChapterForManga(manga);
            
            // 创建更新后的漫画对象
            const updatedManga = {
                ...manga,
                maxChapter: maxChapter
            };
            
            updatedMangaList.push(updatedManga);
            
            // 添加延时避免请求过快
            await this.page.waitForTimeout(3000);
        }
        
        this.mangaList = updatedMangaList;
        console.log('🎉 章节数收集完成！');
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