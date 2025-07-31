const { MangaContentDownloader } = require('./download-manga-content');

/**
 * 测试浏览器实例管理修复
 */
async function testBrowserInstanceFix() {
    console.log('🧪 测试浏览器实例管理修复...\n');
    
    const downloader = new MangaContentDownloader({
        parallel: true,
        maxConcurrent: 2
    });
    
    try {
        // 初始化
        console.log('1️⃣ 初始化浏览器池...');
        await downloader.init();
        console.log(`✅ 创建了 ${downloader.browserInstances.length} 个浏览器实例\n`);
        
        // 显示初始状态
        console.log('📊 初始状态:');
        console.log(`   总实例数: ${downloader.browserInstances.length}`);
        console.log(`   可用实例数: ${downloader.availableInstances.length}`);
        console.log(`   忙碌实例数: ${downloader.busyInstances.size}`);
        
        downloader.browserInstances.forEach((instance, index) => {
            console.log(`   实例 ${index + 1}: ${instance.id} (busy: ${instance.busy})`);
        });
        console.log('');
        
        // 测试并行下载
        console.log('2️⃣ 测试并行下载...');
        
        const testMangaList = [
            {
                id: 'ap101511', // 替换为实际的漫画ID
                name: '测试漫画A',
                maxChapter: 2
            },
            {
                id: 'ap101512', // 替换为实际的漫画ID
                name: '测试漫画B',
                maxChapter: 2
            }
        ];
        
        console.log(`📚 测试漫画: ${testMangaList.length} 个`);
        testMangaList.forEach((manga, index) => {
            console.log(`   ${index + 1}. ${manga.name} (ID: ${manga.id})`);
        });
        console.log('');
        
        // 监控浏览器实例状态
        const monitorInterval = setInterval(() => {
            console.log(`📊 实时状态: 可用=${downloader.availableInstances.filter(i => !i.busy).length}, 忙碌=${downloader.busyInstances.size}`);
        }, 5000);
        
        const startTime = Date.now();
        const results = await downloader.downloadFromMangaList(testMangaList, {
            maxChapters: 1 // 每个漫画只下载1章进行测试
        });
        const duration = Date.now() - startTime;
        
        clearInterval(monitorInterval);
        
        // 检查最终状态
        console.log('\n📊 下载完成后状态:');
        console.log(`   总实例数: ${downloader.browserInstances.length}`);
        console.log(`   可用实例数: ${downloader.availableInstances.filter(i => !i.busy).length}`);
        console.log(`   忙碌实例数: ${downloader.busyInstances.size}`);
        
        downloader.browserInstances.forEach((instance, index) => {
            console.log(`   实例 ${index + 1}: ${instance.id} (busy: ${instance.busy})`);
        });
        
        // 检查浏览器页面状态
        console.log('\n🔍 检查浏览器页面状态:');
        for (let i = 0; i < downloader.browserInstances.length; i++) {
            const instance = downloader.browserInstances[i];
            try {
                const pageInfo = await instance.page.evaluate(() => ({
                    url: window.location.href,
                    title: document.title
                }));
                console.log(`   实例 ${i + 1} (${instance.id}): ${pageInfo.url}`);
                
                if (pageInfo.url === 'about:blank') {
                    console.log(`   ⚠️ 实例 ${i + 1} 停留在 about:blank 页面`);
                } else {
                    console.log(`   ✅ 实例 ${i + 1} 正常使用`);
                }
            } catch (error) {
                console.log(`   ❌ 实例 ${i + 1} 检查失败: ${error.message}`);
            }
        }
        
        // 分析结果
        console.log('\n📊 下载结果:');
        console.log(`⏱️ 总耗时: ${(duration / 1000).toFixed(1)} 秒`);
        
        let successCount = 0;
        let failCount = 0;
        
        results.forEach((result, index) => {
            const status = result.result && result.result.success ? '✅' : '❌';
            const manga = result.manga;
            
            console.log(`${status} 漫画 ${index + 1}: ${manga.name}`);
            
            if (result.result && result.result.success) {
                successCount++;
            } else {
                failCount++;
            }
        });
        
        console.log(`\n🎯 最终统计:`);
        console.log(`   ✅ 成功: ${successCount}/${testMangaList.length}`);
        console.log(`   ❌ 失败: ${failCount}/${testMangaList.length}`);
        
        if (downloader.busyInstances.size === 0) {
            console.log('🎉 所有浏览器实例都已正确释放！');
        } else {
            console.log(`⚠️ 还有 ${downloader.busyInstances.size} 个实例未释放`);
        }
        
        console.log('\n✅ 测试完成');
        
    } catch (error) {
        console.error('❌ 测试过程中发生错误:', error);
        console.error('错误堆栈:', error.stack);
    } finally {
        // 清理资源
        console.log('\n3️⃣ 清理资源...');
        await downloader.close();
        console.log('✅ 测试完成，所有浏览器实例已关闭');
    }
}

// 运行测试
testBrowserInstanceFix().catch(console.error);
