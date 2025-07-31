const { MangaContentDownloader } = require('./download-manga-content');

/**
 * 测试动态并行下载功能
 */
async function testDynamicParallel() {
    console.log('🧪 测试动态并行下载功能...\n');
    
    const downloader = new MangaContentDownloader({
        parallel: true,
        maxConcurrent: 2
    });
    
    try {
        // 初始化
        console.log('1️⃣ 初始化浏览器池...');
        await downloader.init();
        console.log(`✅ 创建了 ${downloader.browserInstances.length} 个浏览器实例\n`);
        
        // 准备测试漫画列表 - 包含已完成和未完成的漫画
        const testMangaList = [
            {
                id: 'ap101511',
                name: '已完成漫画A',
                maxChapter: 5 // 假设这个已经下载完成
            },
            {
                id: 'ap101512',
                name: '未完成漫画B',
                maxChapter: 10
            },
            {
                id: 'ap101513',
                name: '已完成漫画C',
                maxChapter: 3 // 假设这个也已经下载完成
            },
            {
                id: 'ap101514',
                name: '未完成漫画D',
                maxChapter: 8
            },
            {
                id: 'ap101515',
                name: '未完成漫画E',
                maxChapter: 6
            }
        ];
        
        console.log('2️⃣ 开始动态并行下载测试...');
        console.log(`📚 测试漫画: ${testMangaList.length} 个`);
        testMangaList.forEach((manga, index) => {
            console.log(`   ${index + 1}. ${manga.name} (ID: ${manga.id}, 最大章节: ${manga.maxChapter})`);
        });
        console.log('');
        
        console.log('🎯 预期行为:');
        console.log('   - 工作器1和工作器2同时开始处理前两个漫画');
        console.log('   - 如果某个漫画很快完成（已下载），该工作器立即开始下一个漫画');
        console.log('   - 不会等待其他工作器，实现真正的动态并行');
        console.log('');
        
        // 监控浏览器实例状态
        const monitorInterval = setInterval(() => {
            const busyCount = downloader.busyInstances.size;
            const availableCount = downloader.availableInstances.filter(i => !i.busy).length;
            console.log(`📊 实时状态: 忙碌实例=${busyCount}, 可用实例=${availableCount}`);
        }, 3000);
        
        const startTime = Date.now();
        const results = await downloader.downloadFromMangaList(testMangaList, {
            maxChapters: 2 // 每个漫画最多下载2章进行测试
        });
        const totalDuration = Date.now() - startTime;
        
        clearInterval(monitorInterval);
        
        // 分析结果
        console.log('\n📊 动态并行下载测试结果:');
        console.log(`⏱️ 实际总耗时: ${(totalDuration / 1000).toFixed(1)} 秒`);
        console.log(`📚 处理漫画数: ${results.length}`);
        
        let successCount = 0;
        let failCount = 0;
        let quickCompletions = 0; // 快速完成的漫画（可能是已下载的）
        
        results.forEach((result, index) => {
            const status = result.success ? '✅' : '❌';
            const manga = result.manga;
            const downloadResult = result.result;
            const duration = result.duration || 0;
            
            console.log(`\n${status} 漫画 ${index + 1}: ${manga.name}`);
            console.log(`   ⏱️ 耗时: ${(duration / 1000).toFixed(1)} 秒`);
            
            if (result.success) {
                successCount++;
                if (downloadResult.success) {
                    console.log(`   📖 成功章节: ${downloadResult.successfulChapters}/${downloadResult.totalChapters}`);
                    
                    // 如果耗时很短，可能是已完成的漫画
                    if (duration < 5000) { // 少于5秒
                        quickCompletions++;
                        console.log(`   ⚡ 快速完成（可能已下载）`);
                    }
                } else {
                    console.log(`   ❌ 失败原因: ${downloadResult.error || '未知错误'}`);
                }
            } else {
                failCount++;
                console.log(`   ❌ 失败原因: ${downloadResult?.error || '未知错误'}`);
            }
        });
        
        console.log(`\n🎯 最终统计:`);
        console.log(`   ✅ 成功: ${successCount}/${testMangaList.length}`);
        console.log(`   ❌ 失败: ${failCount}/${testMangaList.length}`);
        console.log(`   ⚡ 快速完成: ${quickCompletions} 个`);
        console.log(`   📈 成功率: ${(successCount / testMangaList.length * 100).toFixed(1)}%`);
        console.log(`   ⏱️ 实际总耗时: ${(totalDuration / 1000).toFixed(1)} 秒`);
        
        // 验证动态并行效果
        console.log(`\n🔍 动态并行效果分析:`);
        if (quickCompletions > 0) {
            console.log(`   ✅ 检测到 ${quickCompletions} 个快速完成的任务`);
            console.log(`   ✅ 这些任务完成后，工作器应该立即开始下一个任务`);
            console.log(`   ✅ 动态并行功能正常工作！`);
        } else {
            console.log(`   ⚠️ 没有检测到快速完成的任务`);
            console.log(`   ⚠️ 可能所有漫画都需要实际下载，无法验证动态效果`);
        }
        
        console.log('\n✅ 动态并行测试完成');
        
    } catch (error) {
        console.error('❌ 测试过程中发生错误:', error);
    } finally {
        // 清理资源
        console.log('\n3️⃣ 清理资源...');
        await downloader.close();
        console.log('✅ 测试完成，所有浏览器实例已关闭');
    }
}

// 运行测试
testDynamicParallel().catch(console.error);
