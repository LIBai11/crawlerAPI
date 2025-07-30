#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

class Cleanup {
  constructor() {
    this.outputDir = 'output';
    this.testFiles = [
      'node_modules',
      'package-lock.json'
    ];
  }

  async cleanupOutputDir() {
    try {
      const stats = await fs.stat(this.outputDir);
      if (stats.isDirectory()) {
        const files = await fs.readdir(this.outputDir);
        
        if (files.length === 0) {
          console.log('输出目录为空，无需清理');
          return;
        }

        console.log(`发现 ${files.length} 个输出文件:`);
        files.forEach(file => console.log(`  - ${file}`));
        
        // 删除所有文件
        for (const file of files) {
          const filePath = path.join(this.outputDir, file);
          await fs.unlink(filePath);
          console.log(`✓ 删除文件: ${file}`);
        }
        
        console.log('输出目录清理完成');
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('输出目录不存在，无需清理');
      } else {
        console.error('清理输出目录时出错:', error.message);
      }
    }
  }

  async cleanupTestFiles() {
    console.log('\n清理测试文件...');
    
    for (const file of this.testFiles) {
      try {
        const stats = await fs.stat(file);
        
        if (stats.isDirectory()) {
          // 递归删除目录
          await this.removeDirectory(file);
          console.log(`✓ 删除目录: ${file}`);
        } else {
          // 删除文件
          await fs.unlink(file);
          console.log(`✓ 删除文件: ${file}`);
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log(`- 文件不存在: ${file}`);
        } else {
          console.error(`删除 ${file} 时出错:`, error.message);
        }
      }
    }
  }

  async removeDirectory(dirPath) {
    const files = await fs.readdir(dirPath);
    
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = await fs.stat(filePath);
      
      if (stats.isDirectory()) {
        await this.removeDirectory(filePath);
      } else {
        await fs.unlink(filePath);
      }
    }
    
    await fs.rmdir(dirPath);
  }

  async showStatus() {
    console.log('当前状态:');
    
    // 检查输出目录
    try {
      const files = await fs.readdir(this.outputDir);
      console.log(`输出文件: ${files.length} 个`);
    } catch {
      console.log('输出文件: 0 个');
    }
    
    // 检查测试文件
    for (const file of this.testFiles) {
      try {
        await fs.stat(file);
        console.log(`${file}: 存在`);
      } catch {
        console.log(`${file}: 不存在`);
      }
    }
  }

  async run(options = {}) {
    console.log('='.repeat(40));
    console.log('数据收集器清理工具');
    console.log('='.repeat(40));
    
    if (options.status) {
      await this.showStatus();
      return;
    }
    
    if (options.output !== false) {
      console.log('清理输出目录...');
      await this.cleanupOutputDir();
    }
    
    if (options.test !== false) {
      await this.cleanupTestFiles();
    }
    
    console.log('\n清理完成！');
  }
}

// 命令行参数处理
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    output: true,
    test: true,
    status: false
  };
  
  for (const arg of args) {
    switch (arg) {
      case '--status':
      case '-s':
        options.status = true;
        break;
      case '--no-output':
        options.output = false;
        break;
      case '--no-test':
        options.test = false;
        break;
      case '--output-only':
        options.test = false;
        break;
      case '--test-only':
        options.output = false;
        break;
      case '--help':
      case '-h':
        console.log(`
使用方法: node cleanup.js [选项]

选项:
  --status, -s      显示当前状态，不执行清理
  --no-output       不清理输出目录
  --no-test         不清理测试文件
  --output-only     仅清理输出目录
  --test-only       仅清理测试文件
  --help, -h        显示此帮助信息

默认行为: 清理输出目录和测试文件
        `);
        process.exit(0);
        break;
      default:
        console.error(`未知选项: ${arg}`);
        console.error('使用 --help 查看帮助信息');
        process.exit(1);
    }
  }
  
  return options;
}

// 如果直接运行此文件
if (require.main === module) {
  const options = parseArgs();
  const cleanup = new Cleanup();
  
  cleanup.run(options)
    .catch(error => {
      console.error('清理过程中发生错误:', error);
      process.exit(1);
    });
}

module.exports = Cleanup;
