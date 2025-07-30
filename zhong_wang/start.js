#!/usr/bin/env node

const DataCollector = require('./data_collector');
const fs = require('fs').promises;

async function main() {
  console.log('='.repeat(60));
  console.log('中望数据收集器启动');
  console.log('='.repeat(60));

  try {
    // 首先检查 config.json 是否存在
    try {
      await fs.access('config.json');
      console.log(`✓ 配置文件 config.json 存在`);
    } catch {
      console.error(`✗ 配置文件 config.json 不存在`);
      process.exit(1);
    }

    // 读取配置文件获取其他文件路径
    const configData = await fs.readFile('config.json', 'utf8');
    const config = JSON.parse(configData);

    // 检查配置中指定的文件是否存在
    const requiredFiles = [
      { path: config.paramsFile, name: 'params文件' },
      { path: config.tokenFile, name: 'tokens文件' }
    ];

    for (const file of requiredFiles) {
      try {
        await fs.access(file.path);
        console.log(`✓ ${file.name} ${file.path} 存在`);
      } catch {
        console.error(`✗ ${file.name} ${file.path} 不存在`);
        process.exit(1);
      }
    }

    // 创建数据收集器实例
    const collector = new DataCollector('./config.json');
    
    // 初始化
    console.log('\n正在初始化...');
    await collector.init();
    
    // 开始收集
    console.log('\n开始数据收集...');
    await collector.start();
    
    console.log('\n数据收集完成！');
    
  } catch (error) {
    console.error('\n发生错误:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 处理进程信号
process.on('SIGINT', () => {
  console.log('\n收到中断信号，正在退出...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n收到终止信号，正在退出...');
  process.exit(0);
});

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('未处理的Promise拒绝:', reason);
  process.exit(1);
});

// 启动主程序
main();
