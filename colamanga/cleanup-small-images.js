const fs = require('fs-extra');
const path = require('path');

/**
 * 删除漫画中所有小于指定大小的图片文件
 * 
 * 功能：
 * - 遍历漫画目录结构
 * - 检查所有图片文件大小
 * - 删除小于8KB的图片文件
 * - 提供详细的删除统计信息
 */
class SmallImageCleaner {
    constructor() {
        this.mangaDir = 'E:\\manga'; // 漫画根目录
        this.minFileSize = 8 * 1024; // 8KB = 8192 bytes
        this.supportedExtensions = ['.png', '.jpg', '.jpeg', '.webp']; // 支持的图片格式
        this.dryRun = false; // 是否只是模拟运行，不实际删除
        this.stats = {
            totalImages: 0,
            smallImages: 0,
            deletedImages: 0,
            failedDeletions: 0,
            totalSizeRemoved: 0
        };
    }

    /**
     * 设置最小文件大小（KB）
     */
    setMinSize(sizeKB) {
        this.minFileSize = sizeKB * 1024;
        console.log(`🔧 最小文件大小设置为: ${sizeKB}KB`);
    }

    /**
     * 设置漫画目录
     */
    setMangaDir(dir) {
        this.mangaDir = dir;
        console.log(`📁 漫画目录设置为: ${dir}`);
    }

    /**
     * 设置是否为干运行（不实际删除）
     */
    setDryRun(enabled) {
        this.dryRun = enabled;
        console.log(`🔍 ${enabled ? '启用' : '禁用'}试运行模式`);
    }

    /**
     * 格式化文件大小
     */
    formatFileSize(bytes) {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
        return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
    }

    /**
     * 检查是否为图片文件
     */
    isImageFile(filename) {
        const ext = path.extname(filename).toLowerCase();
        return this.supportedExtensions.includes(ext);
    }

    /**
     * 扫描并清理所有漫画
     */
    async cleanAllMangas() {
        console.log('🧹 开始清理所有漫画中的小图片...');
        console.log(`📁 漫画目录: ${this.mangaDir}`);
        console.log(`📏 最小大小: ${this.formatFileSize(this.minFileSize)}`);
        console.log(`🔍 模式: ${this.dryRun ? '试运行（不实际删除）' : '实际删除'}`);
        console.log('');

        if (!await fs.pathExists(this.mangaDir)) {
            throw new Error(`漫画目录不存在: ${this.mangaDir}`);
        }

        const startTime = Date.now();
        const mangaList = await this.scanMangaDirectory();

        if (mangaList.length === 0) {
            console.log('⚠️ 没有找到任何漫画目录');
            return;
        }

        console.log(`📚 找到 ${mangaList.length} 个漫画，开始处理...\n`);

        for (let i = 0; i < mangaList.length; i++) {
            const manga = mangaList[i];
            console.log(`📖 [${i + 1}/${mangaList.length}] 处理漫画: ${manga.name}`);
            
            try {
                await this.cleanManga(manga);
            } catch (error) {
                console.error(`❌ 处理漫画失败: ${manga.name} - ${error.message}`);
            }
            
            console.log(''); // 空行分隔
        }

        const duration = (Date.now() - startTime) / 1000;
        this.showFinalStats(duration);
    }

    /**
     * 扫描漫画目录
     */
    async scanMangaDirectory() {
        const items = await fs.readdir(this.mangaDir);
        const mangaList = [];

        for (const item of items) {
            const itemPath = path.join(this.mangaDir, item);
            const stat = await fs.stat(itemPath);
            
            if (stat.isDirectory()) {
                // 检查是否包含章节目录
                const chapters = await this.getChaptersInManga(itemPath);
                if (chapters.length > 0) {
                    mangaList.push({
                        name: item,
                        path: itemPath,
                        chapters: chapters
                    });
                }
            }
        }

        return mangaList;
    }

    /**
     * 获取漫画中的所有章节
     */
    async getChaptersInManga(mangaPath) {
        const items = await fs.readdir(mangaPath);
        const chapters = [];

        for (const item of items) {
            const itemPath = path.join(mangaPath, item);
            const stat = await fs.stat(itemPath);
            
            if (stat.isDirectory() && (item.startsWith('第') && item.includes('章'))) {
                chapters.push({
                    name: item,
                    path: itemPath
                });
            }
        }

        return chapters;
    }

    /**
     * 清理单个漫画
     */
    async cleanManga(manga) {
        let mangaStats = {
            totalImages: 0,
            smallImages: 0,
            deletedImages: 0,
            failedDeletions: 0
        };

        console.log(`   📁 漫画路径: ${manga.path}`);
        console.log(`   📚 章节数量: ${manga.chapters.length}`);

        for (let i = 0; i < manga.chapters.length; i++) {
            const chapter = manga.chapters[i];
            console.log(`   📖 [${i + 1}/${manga.chapters.length}] 处理章节: ${chapter.name}`);
            
            try {
                const chapterStats = await this.cleanChapter(chapter);
                mangaStats.totalImages += chapterStats.totalImages;
                mangaStats.smallImages += chapterStats.smallImages;
                mangaStats.deletedImages += chapterStats.deletedImages;
                mangaStats.failedDeletions += chapterStats.failedDeletions;
            } catch (error) {
                console.error(`      ❌ 处理章节失败: ${chapter.name} - ${error.message}`);
            }
        }

        // 显示漫画统计
        console.log(`   📊 漫画统计:`);
        console.log(`      🖼️ 总图片: ${mangaStats.totalImages}`);
        console.log(`      🔍 小图片: ${mangaStats.smallImages}`);
        console.log(`      ${this.dryRun ? '📋 将删除' : '🗑️ 已删除'}: ${mangaStats.deletedImages}`);
        if (mangaStats.failedDeletions > 0) {
            console.log(`      ❌ 删除失败: ${mangaStats.failedDeletions}`);
        }
    }

    /**
     * 清理单个章节
     */
    async cleanChapter(chapter) {
        const files = await fs.readdir(chapter.path);
        const imageFiles = files.filter(file => this.isImageFile(file));
        
        let chapterStats = {
            totalImages: imageFiles.length,
            smallImages: 0,
            deletedImages: 0,
            failedDeletions: 0
        };

        if (imageFiles.length === 0) {
            console.log(`      📝 章节中没有图片文件`);
            return chapterStats;
        }

        console.log(`      🖼️ 找到 ${imageFiles.length} 个图片文件`);

        for (const imageFile of imageFiles) {
            const imagePath = path.join(chapter.path, imageFile);
            
            try {
                const stats = await fs.stat(imagePath);
                this.stats.totalImages++;
                chapterStats.totalImages = imageFiles.length; // 确保正确计数

                if (stats.size < this.minFileSize) {
                    chapterStats.smallImages++;
                    this.stats.smallImages++;
                    this.stats.totalSizeRemoved += stats.size;

                    const sizeStr = this.formatFileSize(stats.size);
                    console.log(`      🔍 发现小图片: ${imageFile} (${sizeStr})`);

                    if (!this.dryRun) {
                        try {
                            await fs.remove(imagePath);
                            chapterStats.deletedImages++;
                            this.stats.deletedImages++;
                            console.log(`         🗑️ 已删除`);
                        } catch (deleteError) {
                            chapterStats.failedDeletions++;
                            this.stats.failedDeletions++;
                            console.error(`         ❌ 删除失败: ${deleteError.message}`);
                        }
                    } else {
                        chapterStats.deletedImages++;
                        console.log(`         📋 将删除（试运行模式）`);
                    }
                }
            } catch (error) {
                console.error(`      ❌ 检查文件失败: ${imageFile} - ${error.message}`);
            }
        }

        if (chapterStats.smallImages > 0) {
            console.log(`      📊 章节结果: ${chapterStats.smallImages}/${chapterStats.totalImages} 小图片${this.dryRun ? '将被' : '已被'}删除`);
        } else {
            console.log(`      ✅ 章节中没有小于${this.formatFileSize(this.minFileSize)}的图片`);
        }

        return chapterStats;
    }

    /**
     * 清理指定漫画
     */
    async cleanSpecificManga(mangaName) {
        console.log(`🎯 清理指定漫画: ${mangaName}`);

        const mangaList = await this.scanMangaDirectory();
        const manga = mangaList.find(m => m.name === mangaName || m.name.includes(mangaName));

        if (!manga) {
            console.log(`❌ 未找到漫画: ${mangaName}`);
            console.log('📚 可用的漫画:');
            mangaList.forEach((m, i) => {
                console.log(`   ${i + 1}. ${m.name} (${m.chapters.length}章)`);
            });
            return;
        }

        console.log(`📖 找到漫画: ${manga.name} (${manga.chapters.length}章)\n`);
        
        const startTime = Date.now();
        await this.cleanManga(manga);
        const duration = (Date.now() - startTime) / 1000;
        
        this.showFinalStats(duration);
    }

    /**
     * 显示最终统计信息
     */
    showFinalStats(duration) {
        console.log('🎉 清理完成!\n');
        console.log('📊 最终统计:');
        console.log(`   🖼️ 扫描图片总数: ${this.stats.totalImages}`);
        console.log(`   🔍 发现小图片: ${this.stats.smallImages}`);
        console.log(`   ${this.dryRun ? '📋 将删除' : '🗑️ 已删除'}: ${this.stats.deletedImages}`);
        if (this.stats.failedDeletions > 0) {
            console.log(`   ❌ 删除失败: ${this.stats.failedDeletions}`);
        }
        console.log(`   💾 释放空间: ${this.formatFileSize(this.stats.totalSizeRemoved)}`);
        console.log(`   ⏱️ 总耗时: ${duration.toFixed(2)}秒`);
        
        if (this.stats.smallImages > 0) {
            const percentage = ((this.stats.smallImages / this.stats.totalImages) * 100).toFixed(2);
            console.log(`   📈 小图片比例: ${percentage}%`);
        }

        if (this.dryRun && this.stats.smallImages > 0) {
            console.log('\n💡 提示: 这是试运行模式，要实际删除请使用 --execute 参数');
        }
    }

    /**
     * 显示帮助信息
     */
    static showHelp() {
        console.log(`
📖 小图片清理工具使用说明:

基本用法:
  node cleanup-small-images.js                    # 试运行所有漫画（不实际删除）
  node cleanup-small-images.js --execute          # 实际删除所有漫画中的小图片
  node cleanup-small-images.js "漫画名" --execute  # 删除指定漫画中的小图片
  
选项:
  --execute, -e                    # 实际执行删除（默认是试运行模式）
  --size <KB>, -s <KB>             # 设置最小文件大小（默认8KB）
  --dir <路径>, -d <路径>          # 设置漫画目录（默认 E:\\manga）
  --help, -h                       # 显示此帮助信息
  
示例:
  node cleanup-small-images.js --size 5           # 试运行，删除小于5KB的图片
  node cleanup-small-images.js --execute --size 10 # 删除小于10KB的图片
  node cleanup-small-images.js "鬼刀" --execute   # 删除指定漫画中的小图片
  node cleanup-small-images.js --dir "D:\\manga" --execute # 指定目录

安全提示:
  - 默认为试运行模式，会显示将要删除的文件但不实际删除
  - 使用 --execute 参数才会真正删除文件
  - 建议先进行试运行，确认无误后再执行删除
  - 删除的文件无法恢复，请谨慎操作
`);
    }
}

// 如果直接运行此文件
if (require.main === module) {
    async function main() {
        const cleaner = new SmallImageCleaner();
        
        try {
            // 解析命令行参数
            const args = process.argv.slice(2);
            
            let mangaName = null;
            let execute = false;
            let minSize = 8; // 默认8KB
            let customDir = null;
            
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                
                if (arg === '--help' || arg === '-h') {
                    SmallImageCleaner.showHelp();
                    return;
                } else if (arg === '--execute' || arg === '-e') {
                    execute = true;
                } else if (arg === '--size' || arg === '-s') {
                    minSize = parseInt(args[i + 1]);
                    i++; // 跳过下一个参数
                } else if (arg === '--dir' || arg === '-d') {
                    customDir = args[i + 1];
                    i++; // 跳过下一个参数
                } else if (!mangaName && !arg.startsWith('-')) {
                    mangaName = arg;
                }
            }
            
            // 配置清理器
            if (customDir) {
                cleaner.setMangaDir(customDir);
            }
            
            cleaner.setMinSize(minSize);
            cleaner.setDryRun(!execute);
            
            console.log('🧹 小图片清理工具\n');
            
            if (!execute) {
                console.log('⚠️ 当前为试运行模式，不会实际删除文件');
                console.log('💡 要实际删除请添加 --execute 参数\n');
            }
            
            if (mangaName) {
                // 清理指定漫画
                await cleaner.cleanSpecificManga(mangaName);
            } else {
                // 清理所有漫画
                await cleaner.cleanAllMangas();
            }
            
        } catch (error) {
            console.error('❌ 清理过程中出错:', error.message);
            console.log('\n💡 使用 --help 查看使用说明');
        }
    }
    
    main();
}

module.exports = SmallImageCleaner; 