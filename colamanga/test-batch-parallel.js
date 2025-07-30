const MangaToPdfConverter = require('./manga-to-pdf');

async function testBatchParallel() {
    console.log('🧪 测试批次并行处理功能...');
    
    const converter = new MangaToPdfConverter();
    
    try {
        // 设置测试配置
        converter.setConcurrency(1);           // 1个漫画
        converter.setBatchConcurrency(3);      // 3个批次并行
        converter.setMergePdfs(true);
        
        await converter.init();
        
        console.log('🔍 扫描漫画目录...');
        const mangaList = await converter.scanMangaDirectory();
        
        if (mangaList.length === 0) {
            console.log('❌ 没有找到任何漫画');
            return;
        }
        
        // 选择第一个漫画进行测试
        const testManga = mangaList[0];
        console.log(`🎯 选择测试漫画: ${testManga.name} (${testManga.chapters.length}章)`);
        
        // 人工创建足够的图片来测试并行
        const testImages = [];
        let imageCount = 0;
        
        // 收集前20张图片用于测试
        for (const chapter of testManga.chapters) {
            for (const image of chapter.images) {
                if (imageCount >= 20) break;
                testImages.push({
                    ...image,
                    chapterName: chapter.name
                });
                imageCount++;
            }
            if (imageCount >= 20) break;
        }
        
        console.log(`📊 测试图片数量: ${testImages.length} 张`);
        console.log(`📦 预计批次数: ${Math.ceil(testImages.length / converter.maxImagesPerBatch)} 个`);
        console.log(`🚀 批次并行数: ${converter.maxBatchConcurrency}`);
        
        const startTime = Date.now();
        
        // 直接调用批次处理方法进行测试
        const tempPdfPath = `./test_${testManga.name}_${Date.now()}.pdf`;
        const mainPage = await converter.getAvailablePage();
        
        try {
            const result = await converter.convertMangaInBatches(
                testImages, 
                tempPdfPath, 
                `测试_${testManga.name}`, 
                mainPage
            );
            
            const duration = (Date.now() - startTime) / 1000;
            
            if (result.success) {
                console.log(`✅ 批次并行测试成功！`);
                console.log(`⏱️ 总耗时: ${duration.toFixed(2)}秒`);
                console.log(`📄 生成文件: ${result.path}`);
                
                // 检查文件
                const fs = require('fs-extra');
                if (await fs.pathExists(result.path)) {
                    const stats = await fs.stat(result.path);
                    console.log(`📊 文件大小: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
                    
                    if (stats.size > 10240) { // 大于10KB
                        console.log('🎉 批次并行处理测试通过！');
                    } else {
                        console.log('⚠️ 文件可能内容有问题');
                    }
                }
            } else {
                console.log(`❌ 测试失败: ${result.error}`);
            }
            
        } finally {
            converter.releasePage(mainPage);
        }
        
    } catch (error) {
        console.error('❌ 测试过程中出错:', error.message);
    } finally {
        await converter.close();
    }
}

if (require.main === module) {
    testBatchParallel();
}

module.exports = testBatchParallel; 