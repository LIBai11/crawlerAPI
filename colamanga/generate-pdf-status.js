const fs = require('fs-extra');
const path = require('path');

class PDFStatusGenerator {
    constructor() {
        this.mangaIdsPath = '/Users/likaixuan/Documents/manga/manga-ids.json';
        this.mangaPdfDir = '/Users/likaixuan/Documents/manga-pdf';
        this.outputPath = '/Users/likaixuan/work/crawlerAPI/colamanga/manga-pdf-status.json';
    }

    async generatePDFStatus() {
        try {
            console.log('📖 开始生成PDF状态报告...');

            // 读取manga-ids.json
            const mangaIds = await this.loadMangaIds();
            console.log(`📊 从manga-ids.json加载了 ${mangaIds.length} 个漫画`);

            // 检查manga-pdf目录中存在的漫画
            const pdfStatus = await this.checkPDFStatus(mangaIds);
            console.log(`✅ 检查完成，找到 ${pdfStatus.length} 个有PDF的漫画`);

            // 保存结果
            await this.saveResult(pdfStatus);
            console.log(`💾 结果已保存到: ${this.outputPath}`);

            return pdfStatus;
        } catch (error) {
            console.error('❌ 生成PDF状态报告时出错:', error);
            throw error;
        }
    }

    async loadMangaIds() {
        if (!await fs.pathExists(this.mangaIdsPath)) {
            throw new Error(`manga-ids.json文件不存在: ${this.mangaIdsPath}`);
        }

        const mangaIds = await fs.readJson(this.mangaIdsPath);
        if (!Array.isArray(mangaIds)) {
            throw new Error('manga-ids.json格式错误，应该是数组');
        }

        return mangaIds;
    }

    async checkPDFStatus(mangaIds) {
        const pdfStatus = [];

        // 获取manga-pdf目录中的所有文件夹
        const pdfDirs = await this.getPDFDirectories();
        console.log(`📁 manga-pdf目录中找到 ${pdfDirs.length} 个文件夹`);

        // 按照manga-ids.json的顺序处理
        for (const manga of mangaIds) {
            const mangaName = manga.name;
            
            // 检查这个漫画是否在PDF目录中存在
            if (pdfDirs.includes(mangaName)) {
                console.log(`🔍 检查漫画: ${mangaName}`);
                
                const mangaPdfPath = path.join(this.mangaPdfDir, mangaName);
                const chapters = await this.getChaptersWithPDF(mangaPdfPath);
                
                if (chapters.length > 0) {
                    pdfStatus.push({
                        id: manga.id,
                        name: mangaName,
                        maxChapter: manga.maxChapter || null,
                        pdfChapters: chapters.length,
                        chapters: chapters
                    });
                    console.log(`  ✅ 找到 ${chapters.length} 个PDF章节`);
                } else {
                    console.log(`  ⚠️ 文件夹存在但没有PDF文件`);
                }
            }
        }

        return pdfStatus;
    }

    async getPDFDirectories() {
        if (!await fs.pathExists(this.mangaPdfDir)) {
            console.log(`⚠️ manga-pdf目录不存在: ${this.mangaPdfDir}`);
            return [];
        }

        const items = await fs.readdir(this.mangaPdfDir);
        const directories = [];

        for (const item of items) {
            const itemPath = path.join(this.mangaPdfDir, item);
            const stat = await fs.stat(itemPath);
            
            if (stat.isDirectory() && !item.startsWith('.')) {
                directories.push(item);
            }
        }

        return directories;
    }

    async getChaptersWithPDF(mangaPdfPath) {
        const chapters = [];

        try {
            const files = await fs.readdir(mangaPdfPath);
            
            for (const file of files) {
                const filePath = path.join(mangaPdfPath, file);
                const stat = await fs.stat(filePath);
                
                // 只处理PDF文件
                if (stat.isFile() && file.toLowerCase().endsWith('.pdf')) {
                    // 提取章节信息
                    const chapterInfo = this.extractChapterInfo(file);
                    if (chapterInfo) {
                        chapters.push(chapterInfo);
                    }
                }
            }

            // 按章节号排序
            chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
            
        } catch (error) {
            console.error(`❌ 读取目录失败: ${mangaPdfPath}`, error);
        }

        return chapters;
    }

    extractChapterInfo(filename) {
        // 匹配格式：第X章-章节名.pdf
        const match = filename.match(/第(\d+)章-(.+)\.pdf$/);
        
        if (match) {
            return {
                chapterNumber: parseInt(match[1]),
                chapterTitle: match[2],
                filename: filename
            };
        }

        // 如果没有匹配到标准格式，尝试其他可能的格式
        const simpleMatch = filename.match(/(\d+).*\.pdf$/);
        if (simpleMatch) {
            return {
                chapterNumber: parseInt(simpleMatch[1]),
                chapterTitle: filename.replace('.pdf', ''),
                filename: filename
            };
        }

        return null;
    }

    async saveResult(pdfStatus) {
        const result = {
            generatedAt: new Date().toISOString(),
            totalMangasWithPDF: pdfStatus.length,
            totalChapters: pdfStatus.reduce((sum, manga) => sum + manga.pdfChapters, 0),
            mangas: pdfStatus
        };

        await fs.writeJson(this.outputPath, result, { spaces: 2 });
        
        // 生成简要统计
        console.log('\n📊 统计信息:');
        console.log(`- 有PDF的漫画数量: ${result.totalMangasWithPDF}`);
        console.log(`- PDF章节总数: ${result.totalChapters}`);
        
        if (pdfStatus.length > 0) {
            const avgChapters = (result.totalChapters / result.totalMangasWithPDF).toFixed(1);
            console.log(`- 平均每个漫画的PDF章节数: ${avgChapters}`);
        }
    }
}

// 主函数
async function main() {
    const generator = new PDFStatusGenerator();
    
    try {
        await generator.generatePDFStatus();
        console.log('\n🎉 PDF状态报告生成完成！');
    } catch (error) {
        console.error('❌ 生成失败:', error);
        process.exit(1);
    }
}

// 如果直接运行此文件
if (require.main === module) {
    main().catch(console.error);
}

module.exports = PDFStatusGenerator;
