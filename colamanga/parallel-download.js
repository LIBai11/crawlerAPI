const { MangaContentDownloader } = require('./download-manga-content');
const fs = require('fs-extra');
const path = require('path');

/**
 * 并行下载命令行工具
 */
async function main() {
    const args = process.argv.slice(2);
    
    // 解析命令行参数
    const options = parseArgs(args);
    
    if (options.help || args.length === 0) {
        showHelp();
        return;
    }
    
    console.log('🚀 启动并行漫画下载器...\n');
    
    // 创建下载器实例
    const downloader = new MangaContentDownloader({
        parallel: options.parallel,
        maxConcurrent: options.concurrent,
        retryAttempts: options.retry
    });
    
    try {
        // 初始化浏览器池
        console.log('🌐 初始化浏览器池...');
        await downloader.init();
        console.log(`✅ 浏览器池初始化完成 - 模式: ${options.parallel ? '并行' : '串行'}, 并发数: ${options.concurrent}\n`);
        
        let results;
        
        if (options.file) {
            // 从文件读取漫画列表
            results = await downloadFromFile(downloader, options);
        } else if (options.manga) {
            // 下载单个漫画
            results = await downloadSingleManga(downloader, options);
        } else {
            console.error('❌ 请指定要下载的漫画ID或漫画列表文件');
            showHelp();
            return;
        }
        
        // 显示最终统计
        showFinalStats(results, options);
        
    } catch (error) {
        console.error('❌ 下载过程中发生错误:', error.message);
    } finally {
        // 清理资源
        console.log('\n🧹 清理资源...');
        await downloader.close();
        console.log('✅ 下载完成，所有浏览器实例已关闭');
    }
}

/**
 * 解析命令行参数
 */
function parseArgs(args) {
    const options = {
        parallel: true,      // 默认启用并行
        concurrent: 2,       // 默认并发数
        retry: 2,           // 默认重试次数
        chapters: null,     // 最大章节数
        manga: null,        // 单个漫画ID
        name: null,         // 漫画名称
        file: null,         // 漫画列表文件
        help: false
    };
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const nextArg = args[i + 1];
        
        switch (arg) {
            case '--parallel':
            case '-p':
                options.parallel = true;
                break;
                
            case '--serial':
            case '-s':
                options.parallel = false;
                break;
                
            case '--concurrent':
            case '-c':
                options.concurrent = parseInt(nextArg) || 2;
                i++;
                break;
                
            case '--retry':
            case '-r':
                options.retry = parseInt(nextArg) || 2;
                i++;
                break;
                
            case '--chapters':
            case '--max-chapters':
                options.chapters = parseInt(nextArg) || null;
                i++;
                break;
                
            case '--manga':
            case '-m':
                options.manga = nextArg;
                i++;
                break;
                
            case '--name':
            case '-n':
                options.name = nextArg;
                i++;
                break;
                
            case '--file':
            case '-f':
                options.file = nextArg;
                i++;
                break;
                
            case '--help':
            case '-h':
                options.help = true;
                break;
        }
    }
    
    return options;
}

/**
 * 显示帮助信息
 */
function showHelp() {
    console.log(`
🚀 并行漫画下载器 - 使用说明

📖 下载单个漫画:
  node parallel-download.js --manga <漫画ID> --name <漫画名称> [选项]

📚 从文件下载多个漫画:
  node parallel-download.js --file <漫画列表文件> [选项]

🔧 选项:
  --parallel, -p          启用并行模式 (默认)
  --serial, -s            使用串行模式
  --concurrent, -c <数量>  最大并发数 (默认: 2)
  --retry, -r <次数>       重试次数 (默认: 2)
  --chapters <数量>        最大下载章节数
  --help, -h              显示帮助信息

📝 示例:
  # 并行下载单个漫画
  node parallel-download.js -m ap101511 -n "测试漫画" --chapters 5

  # 串行下载单个漫画
  node parallel-download.js -s -m ap101511 -n "测试漫画"

  # 并行下载多个漫画 (并发数3)
  node parallel-download.js -f manga-list.json -c 3

  # 从文件串行下载
  node parallel-download.js -s -f manga-list.json

📄 漫画列表文件格式 (JSON):
[
  {
    "id": "ap101511",
    "name": "漫画名称1",
    "maxChapter": 10
  },
  {
    "id": "ap101512", 
    "name": "漫画名称2",
    "maxChapter": 15
  }
]
`);
}

/**
 * 从文件下载漫画列表
 */
async function downloadFromFile(downloader, options) {
    console.log(`📄 从文件读取漫画列表: ${options.file}`);
    
    if (!await fs.pathExists(options.file)) {
        throw new Error(`文件不存在: ${options.file}`);
    }
    
    const mangaList = await fs.readJson(options.file);
    console.log(`📚 读取到 ${mangaList.length} 个漫画\n`);
    
    return await downloader.downloadFromMangaList(mangaList, {
        maxChapters: options.chapters
    });
}

/**
 * 下载单个漫画
 */
async function downloadSingleManga(downloader, options) {
    if (!options.manga || !options.name) {
        throw new Error('下载单个漫画需要指定 --manga 和 --name 参数');
    }
    
    console.log(`📖 下载单个漫画: ${options.name} (ID: ${options.manga})\n`);
    
    const mangaList = [{
        id: options.manga,
        name: options.name,
        maxChapter: options.chapters || 999
    }];
    
    return await downloader.downloadFromMangaList(mangaList, {
        maxChapters: options.chapters
    });
}

/**
 * 显示最终统计
 */
function showFinalStats(results, options) {
    console.log('\n📊 下载完成统计:');
    console.log(`🔧 模式: ${options.parallel ? '并行' : '串行'}`);
    if (options.parallel) {
        console.log(`⚡ 并发数: ${options.concurrent}`);
    }
    console.log(`🔄 重试次数: ${options.retry}`);
    console.log(`📚 处理漫画: ${results.length} 个`);
    
    const successful = results.filter(r => r.result && r.result.success).length;
    const failed = results.length - successful;
    
    console.log(`✅ 成功: ${successful}/${results.length}`);
    console.log(`❌ 失败: ${failed}/${results.length}`);
    console.log(`📈 成功率: ${(successful / results.length * 100).toFixed(1)}%`);
    
    // 显示详细结果
    if (results.length <= 10) {
        console.log('\n📋 详细结果:');
        results.forEach((result, index) => {
            const status = result.result && result.result.success ? '✅' : '❌';
            console.log(`  ${status} ${result.manga.name}`);
        });
    }
}

// 运行主程序
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { main };
