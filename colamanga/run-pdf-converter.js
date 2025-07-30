const MangaToPdfConverter = require('./manga-to-pdf');

async function main() {
    const converter = new MangaToPdfConverter();
    
    try {
        console.log('🚀 启动PDF转换器...');
        await converter.init();
        
        // 检查命令行参数
        const args = process.argv.slice(2);
        
        if (args.length === 0) {
            console.log(`
📖 漫画转PDF工具使用说明

用法:
  node run-pdf-converter.js                    # 转换所有漫画
  node run-pdf-converter.js "漫画名称"          # 转换指定漫画
  node run-pdf-converter.js --list             # 列出所有可用漫画
  node run-pdf-converter.js --help             # 显示帮助信息

示例:
  node run-pdf-converter.js                    # 转换所有漫画为PDF
  node run-pdf-converter.js "进击的巨人"        # 只转换"进击的巨人"
  node run-pdf-converter.js --list             # 查看所有漫画列表
`);
            return;
        }
        
        const command = args[0];
        
        if (command === '--help') {
            console.log(`
📖 漫画转PDF工具

功能:
- 扫描漫画目录 (E:\\manga)
- 将每个漫画的所有章节合并为一个PDF文件
- 按章节和页码顺序排列
- 输出到 E:\\manga-pdf 目录

支持的图片格式: PNG, JPG, JPEG, WEBP
`);
        } else if (command === '--list') {
            console.log('📚 扫描漫画目录...');
            const mangaList = await converter.scanMangaDirectory();
            
            if (mangaList.length === 0) {
                console.log('⚠️ 没有找到任何漫画');
            } else {
                console.log(`\n📚 找到 ${mangaList.length} 个漫画:\n`);
                mangaList.forEach((manga, i) => {
                    console.log(`${i + 1}. ${manga.name} (${manga.chapters.length}章)`);
                });
            }
        } else {
            // 转换指定漫画或所有漫画
            if (command.startsWith('--')) {
                console.log(`❌ 未知命令: ${command}`);
                console.log('使用 --help 查看帮助信息');
            } else {
                // 转换指定漫画
                await converter.convertSpecificManga(command);
            }
        }
        
    } catch (error) {
        console.error('❌ 运行出错:', error.message);
    } finally {
        await converter.close();
    }
}

// 如果没有参数，显示帮助并转换所有漫画
if (process.argv.length === 2) {
    main().then(() => {
        // 显示帮助后，询问是否继续转换所有漫画
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        rl.question('\n是否要转换所有漫画为PDF? (y/N): ', async (answer) => {
            rl.close();
            
            if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
                const converter = new MangaToPdfConverter();
                try {
                    await converter.init();
                    await converter.convertAllMangas();
                } catch (error) {
                    console.error('❌ 转换出错:', error.message);
                } finally {
                    await converter.close();
                }
            } else {
                console.log('👋 已取消转换');
            }
        });
    });
} else {
    main();
}
