const MangaIdCollector = require('./collect-manga-ids');
const {MangaContentDownloader} = require('./download-manga-content');
const fs = require('fs-extra');
const path = require('path');

class ColamangaCrawler {
    constructor(options = {}) {
        this.outputDir = '/Users/likaixuan/Documents/manga';
        // 注意：新版本已移除并发功能，这些选项仅为兼容性保留
        this.parallelOptions = {
            parallel: false, // 新版本不支持并发
            maxConcurrent: 1, // 固定为1
            retryAttempts: options.retryAttempts || 2,
            retryDelay: options.retryDelay || 1000
        };
    }

    async collectIds() {
        console.log('🔍 开始收集漫画ID...\n');
        const collector = new MangaIdCollector();
        
        try {
            await collector.init();
            await collector.collectMangaIds();
            console.log('✅ 漫画ID收集完成！\n');
            return true;
        } catch (error) {
            console.error('❌ 收集漫画ID失败:', error);
            return false;
        } finally {
            await collector.close();
        }
    }

    async downloadContent(options = {}) {
        const {
            startIndex = 0,
            count = null,
            mangaId = null,
            mangaName = null,
            chapter = 1,
            maxChapters = null  // 默认为 null，表示下载所有章节
        } = options;

        console.log('📥 开始下载漫画内容...\n');
        console.log('🔧 下载配置:');
        console.log(`   - 运行模式: 串行模式 (简化版)`);
        console.log(`   - 重试次数: ${this.parallelOptions.retryAttempts}`);
        console.log('');

        const downloader = new MangaContentDownloader(this.parallelOptions);

        try {
            await downloader.init();

            if (mangaId && mangaName) {
                await downloader.downloadMangaContent(mangaId, mangaName, chapter);
            } else {
                const mangaListFile = path.join('/Users/likaixuan/Documents/manga/manga-ids.json');
                if (await fs.pathExists(mangaListFile)) {
                    await downloader.downloadFromMangaList(mangaListFile, startIndex, count, maxChapters);
                } else {
                    console.log('❌ 未找到漫画列表文件，请先运行收集ID功能');
                    return false;
                }
            }

            console.log('✅ 漫画内容下载完成！\n');
            return true;
        } catch (error) {
            console.error('❌ 下载漫画内容失败:', error);
            return false;
        } finally {
            await downloader.close();
        }
    }

    async runFullProcess(downloadOptions = {}) {
        console.log('🚀 开始完整的漫画爬取流程...\n');
        
        // 步骤1: 收集漫画ID
        const collectSuccess = await this.collectIds();
        if (!collectSuccess) {
            console.log('❌ 收集ID失败，终止流程');
            return;
        }
        
        // 步骤2: 下载漫画内容
        const downloadSuccess = await this.downloadContent(downloadOptions);
        if (!downloadSuccess) {
            console.log('❌ 下载内容失败');
            return;
        }
        
        console.log('🎉 完整流程执行完成！');
    }

    async showMangaList() {
        const mangaListFile = path.join('./manga-ids.json');
        console.log(mangaListFile)
        
        if (!(await fs.pathExists(mangaListFile))) {
            console.log('❌ 未找到漫画列表文件，请先运行收集ID功能');
            return;
        }
        
        const mangaList = await fs.readJson(mangaListFile);
        console.log(`📚 漫画列表 (共 ${mangaList.length} 个):\n`);
        
        mangaList.forEach((manga, index) => {
            console.log(`${index + 1}. ${manga.name} (ID: ${manga.id})`);
        });
        
        console.log('');
    }

    printUsage() {
        console.log(`
🎯 Colamanga 爬虫使用说明

基本命令:
  node run-colamanga.js collect              # 收集漫画ID
  node run-colamanga.js download             # 下载所有漫画内容
  node run-colamanga.js full                 # 执行完整流程（收集+下载）
  node run-colamanga.js list                 # 显示已收集的漫画列表

下载选项:
  node run-colamanga.js download --start 0 --count 5    # 下载前5个漫画
  node run-colamanga.js download --start 10 --count 3   # 从第11个开始下载3个漫画
  
单个漫画下载:
  node run-colamanga.js download --id ap101511 --name "漫画名称" --chapter 1

配置选项:
  --maxChapters 50               # 限制最大下载章节数

示例:
  # 收集所有漫画ID
  node run-colamanga.js collect

  # 下载前3个漫画
  node run-colamanga.js download --start 0 --count 3

  # 执行完整流程并只下载前5个漫画
  node run-colamanga.js full --count 5

  # 限制下载章节数
  node run-colamanga.js download --maxChapters 10
        `);
    }
}

// 命令行参数解析
function parseArgs() {
    const args = process.argv.slice(2);
    const command = args[0];
    const options = {};

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        // 处理键值对参数
        if (arg.startsWith('--')) {
            const key = arg.replace('--', '');
            const value = args[i + 1];

            if (value !== undefined && !value.startsWith('--')) {
                if (['start', 'count', 'chapter', 'maxChapters', 'retryAttempts', 'retryDelay'].includes(key)) {
                    options[key] = parseInt(value);
                } else {
                    options[key] = value;
                }
                i++; // 跳过值参数
            } else {
                // 没有值的标志参数
                options[key] = true;
            }
        }
    }

    return { command, options };
}

// 主函数
async function main() {
    const { command, options } = parseArgs();
    const crawler = new ColamangaCrawler(options);
    
    switch (command) {
        case 'collect':
            await crawler.collectIds();
            break;
            
        case 'download':
            await crawler.downloadContent(options);
            break;
            
        case 'full':
            await crawler.runFullProcess(options);
            break;
            
        case 'list':
            await crawler.showMangaList();
            break;
            
        case 'help':
        case '--help':
        case '-h':
            crawler.printUsage();
            break;
            
        default:
            console.log('❌ 未知命令，使用 --help 查看使用说明');
            crawler.printUsage();
    }
}

// 如果直接运行此文件
if (require.main === module) {
    main().catch(console.error);
}

module.exports = ColamangaCrawler;

