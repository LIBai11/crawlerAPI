const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');

class MangaIdCollector {
    constructor() {
        this.browser = null;
        this.page = null;
        this.mangaList = [];
        this.outputDir = '/Users/likaixuan/Documents/manga';
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

    async collectMangaIds() {
        const baseUrl = 'https://www.colamanga.com/show?orderBy=weeklyCount&status=2';
        console.log(`📖 开始收集漫画ID，目标URL: ${baseUrl}`);

        // 先访问第一页获取总页数
        await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 获取总页数
        const totalPages = await this.getTotalPages();
        console.log(`📊 发现总共 ${totalPages} 页漫画`);

        // 限制为前3页进行测试
        const maxPages = Math.max(totalPages, 3);
        console.log(`🧪 测试模式：只收集前 ${maxPages} 页`);

        let currentPage = 1;

        while (currentPage <= maxPages) {
            console.log(`📄 正在处理第 ${currentPage}/${maxPages} 页...`);

            // 构造当前页面的URL
            const pageUrl = currentPage === 1 ? baseUrl : `${baseUrl}&page=${currentPage}`;
            await this.page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            // 等待页面加载完成
            await this.page.waitForSelector('a[href*="/manga-"]', { timeout: 10000 });

            // 滚动页面确保所有内容加载
            await this.scrollToLoadContent();

            // 提取当前页面的漫画信息
            const pageMangas = await this.extractMangaInfo();
            console.log(`✅ 第 ${currentPage} 页收集到 ${pageMangas.length} 个漫画`);

            this.mangaList.push(...pageMangas);

            currentPage++;

            // 添加延时避免请求过快
            await this.page.waitForTimeout(2000);
        }

        console.log(`🎉 收集完成！总共收集到 ${this.mangaList.length} 个漫画`);
        await this.saveMangaList();
    }

    async scrollToLoadContent() {
        // 滚动到页面底部以确保所有内容加载
        await this.page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });

        // 等待内容加载
        await this.page.waitForTimeout(1000);
    }

    async getTotalPages() {
        try {
            return await this.page.evaluate(() => {
                // 方法1：查找页码信息，格式类似 "1" "136" 页
                const pageInfoElements = document.querySelectorAll('*');
                for (const element of pageInfoElements) {
                    const text = element.textContent;
                    if (text && text.includes('页')) {
                        const match = text.match(/(\d+)\s*页/);
                        if (match) {
                            const totalPages = parseInt(match[1]);
                            if (totalPages > 1) {
                                return totalPages;
                            }
                        }
                    }
                }

                // 方法2：查找最大页码链接
                const pageLinks = document.querySelectorAll('a');
                let maxPage = 1;
                pageLinks.forEach(link => {
                    const href = link.getAttribute('href');
                    const text = link.textContent.trim();

                    // 检查href中的page参数
                    if (href && href.includes('page=')) {
                        const match = href.match(/page=(\d+)/);
                        if (match) {
                            const pageNum = parseInt(match[1]);
                            if (pageNum > maxPage) {
                                maxPage = pageNum;
                            }
                        }
                    }

                    // 检查链接文本是否为数字（页码）
                    if (text && /^\d+$/.test(text)) {
                        const pageNum = parseInt(text);
                        if (pageNum > maxPage && pageNum < 1000) { // 避免误判其他数字
                            maxPage = pageNum;
                        }
                    }
                });

                return maxPage;
            });
        } catch (error) {
            console.log('⚠️ 无法获取总页数，默认为1页');
            return 1;
        }
    }

    async extractMangaInfo() {
        return await this.page.evaluate(() => {
            // 专门查找 .fed-list-title 类的元素
            const titleElements = document.querySelectorAll('a.fed-list-title');
            const mangas = [];
            const seen = new Set(); // 用于去重

            titleElements.forEach(element => {
                const href = element.getAttribute('href');
                const name = element.textContent.trim();

                if (href && name && href.includes('/manga-')) {
                    // 从href中提取ID，格式：/manga-ap101511/ 或 /manga-ap101511
                    const match = href.match(/\/manga-([^\/]+)/);
                    if (match) {
                        const id = match[1];
                        const key = `${id}-${name}`;

                        // 避免重复添加同一个漫画
                        if (!seen.has(key) && name.length > 0) {
                            seen.add(key);
                            mangas.push({ id, name });
                        }
                    }
                }
            });

            return mangas;
        });
    }



    async saveMangaList() {
        const outputFile = path.join(this.outputDir, 'manga-ids.json');

        // 去重处理
        const uniqueMangas = this.mangaList.filter((manga, index, self) =>
            index === self.findIndex(m => m.id === manga.id)
        );

        await fs.writeJson(outputFile, uniqueMangas, { spaces: 2 });
        console.log(`💾 漫画列表已保存到: ${outputFile}`);
        console.log(`📊 总计: ${uniqueMangas.length} 个唯一漫画`);
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
    const collector = new MangaIdCollector();

    try {
        await collector.init();
        await collector.collectMangaIds();
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

module.exports = MangaIdCollector;