const MangaToPdfConverter = require('./manga-to-pdf');

async function testPageRecovery() {
    console.log('🧪 测试页面关闭恢复机制...');
    
    const converter = new MangaToPdfConverter();
    
    try {
        // 设置测试配置
        converter.setConcurrency(1);
        converter.setBatchConcurrency(2); // 使用2个批次并行测试
        converter.setMergePdfs(false);
        
        await converter.init();
        
        console.log('🔍 扫描漫画目录...');
        const mangaList = await converter.scanMangaDirectory();
        
        if (mangaList.length === 0) {
            console.log('❌ 没有找到任何漫画');
            return;
        }
        
        // 选择第一个有图片的漫画进行测试
        let selectedManga = null;
        for (const manga of mangaList) {
            let totalImages = 0;
            for (const chapter of manga.chapters) {
                totalImages += chapter.images.length;
            }
            if (totalImages > 6) { // 至少6张图片，能分成2个批次
                selectedManga = manga;
                break;
            }
        }
        
        if (!selectedManga) {
            console.log('❌ 没有找到合适的测试漫画');
            return;
        }
        
        // 限制图片数量到12张，测试页面恢复
        let testImageCount = 0;
        for (const chapter of selectedManga.chapters) {
            if (testImageCount >= 12) {
                chapter.images = [];
                continue;
            }
            const availableImages = Math.min(chapter.images.length, 12 - testImageCount);
            chapter.images = chapter.images.slice(0, availableImages);
            testImageCount += availableImages;
        }
        
        console.log(`🎯 测试漫画: ${selectedManga.name}`);
        console.log(`📊 图片数量: ${testImageCount} 张`);
        console.log(`🔧 批次配置: ${Math.ceil(testImageCount / 3)} 个批次，${converter.maxBatchConcurrency} 个并行`);
        
        const startTime = Date.now();
        const result = await converter.convertMangaToPdf(selectedManga);
        const duration = (Date.now() - startTime) / 1000;
        
        if (result.success) {
            console.log(`✅ 页面恢复测试成功！`);
            console.log(`⏱️ 耗时: ${duration.toFixed(2)}秒`);
            
            // 检查生成的文件
            const fs = require('fs-extra');
            if (await fs.pathExists(result.path)) {
                const stats = await fs.stat(result.path);
                console.log(`📊 文件大小: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
                
                if (stats.size > 500000) { // 大于500KB
                    console.log('🎉 页面关闭恢复机制工作正常！');
                } else {
                    console.log('⚠️ 文件较小，可能仍有问题');
                }
            }
        } else {
            console.log(`❌ 测试失败: ${result.error}`);
        }
        
    } catch (error) {
        console.error('❌ 测试过程中出错:', error.message);
        console.error(error.stack);
    } finally {
        await converter.close();
    }
}

if (require.main === module) {
    testPageRecovery();
}

module.exports = testPageRecovery; 