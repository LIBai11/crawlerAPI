const MaxChapterCollector = require('./get-max-chapters');

async function main() {
    console.log('🎯 启动漫画最大章节数收集器');
    console.log('=' .repeat(60));
    console.log('📋 功能说明:');
    console.log('   - 读取 manga-ids.json 文件');
    console.log('   - 访问每个漫画页面获取最大章节数');
    console.log('   - 更新 manga-ids.json 文件添加 maxChapter 字段');
    console.log('');
    console.log('🔧 使用方法:');
    console.log('   语法: node run-max-chapters.js [数量] [并发数]');
    console.log('');
    console.log('   📊 数量参数:');
    console.log('   - node run-max-chapters.js             处理前10个漫画（默认）');
    console.log('   - node run-max-chapters.js 0           处理所有漫画');
    console.log('   - node run-max-chapters.js 50          处理前50个漫画');
    console.log('');
    console.log('   ⚡ 并发参数:');
    console.log('   - node run-max-chapters.js 50 3        处理前50个，并发数3（默认）');
    console.log('   - node run-max-chapters.js 0 5         处理所有，并发数5');
    console.log('   - node run-max-chapters.js 100 2       处理前100个，并发数2');
    console.log('');
    console.log('   💡 建议: 并发数2-5比较合适，避免被网站限制');
    console.log('=' .repeat(60));
    
    const collector = new MaxChapterCollector();
    
    try {
        await collector.init();
        await collector.loadMangaIds();
        await collector.collectMaxChapters();
        await collector.saveMangaList();
        
        console.log('=' .repeat(60));
        console.log('🎉 所有任务完成！');
        
    } catch (error) {
        console.error('❌ 执行失败:', error);
        process.exit(1);
    } finally {
        await collector.close();
    }
}

main().catch(console.error); 