const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const crypto = require('crypto-js');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

class QuestionDetailCollector {
  constructor(configPath = './config.json') {
    this.configPath = configPath;
    this.config = null;
    this.tokens = [];
    this.tokenUsageCount = new Map();
    this.tokenStatus = new Map();
    this.workerTokenMap = new Map();
    this.activeRequests = 0;
    this.processedQuestions = new Set();
    this.inputDirectory = null;
    this.outputDirectory = null;
    this.allJsonFiles = [];
    this.processedFiles = 0;
    this.totalFiles = 0;
    this.failedQuestions = new Map(); // 记录失败次数
    this.maxRetries = 3; // 最大重试次数
    this.saveInterval = 300000; // 5分钟自动保存间隔
    this.lastSaveTime = Date.now();
  }

  async init() {
    await this.loadConfig();
    await this.loadTokens();
    await this.validateDirectories();
    await this.ensureOutputDirectory();
    console.log(`初始化完成: ${this.tokens.length} 个token`);
    console.log(`输入目录: ${this.inputDirectory}`);
    console.log(`输出目录: ${this.outputDirectory}`);
  }

  async loadConfig() {
    const configData = await fs.readFile(this.configPath, 'utf8');
    this.config = JSON.parse(configData);

    // 验证题目详情配置
    if (!this.config.questionDetail) {
      throw new Error('配置文件中缺少 questionDetail 配置项');
    }

    this.inputDirectory = this.config.questionDetail.inputDirectory;
    this.outputDirectory = this.config.questionDetail.outputDirectory;

    if (!this.inputDirectory || !this.outputDirectory) {
      throw new Error('配置文件中缺少 inputDirectory 或 outputDirectory 配置');
    }
  }

  async validateDirectories() {
    // 检查输入目录是否存在
    try {
      const stats = await fs.stat(this.inputDirectory);
      if (!stats.isDirectory()) {
        throw new Error(`输入路径不是目录: ${this.inputDirectory}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`输入目录不存在: ${this.inputDirectory}`);
      }
      throw error;
    }
  }

  async ensureOutputDirectory() {
    try {
      await fs.access(this.outputDirectory);
    } catch {
      await fs.mkdir(this.outputDirectory, { recursive: true });
      console.log(`创建输出目录: ${this.outputDirectory}`);
    }
  }

  async loadTokens() {
    const tokenData = await fs.readFile(this.config.tokenFile, 'utf8');
    const tokenInfo = JSON.parse(tokenData);
    this.tokens = tokenInfo.tokens.filter(t => t.isValid);

    // 初始化token使用计数和状态
    this.tokens.forEach(token => {
      this.tokenUsageCount.set(token.id, 0);
      this.tokenStatus.set(token.id, 'available');
    });

    console.log(`加载了 ${this.tokens.length} 个有效token`);
  }

  // 解密函数
  phoneDecrypt(encryptedText) {
    let n = 'abADefg234cdegsd';
    let e = n;
    let o = crypto.enc.Utf8.parse(n);
    let l = crypto.enc.Utf8.parse(e);

    let decrypted = crypto.AES.decrypt(encryptedText, o, {
      iv: l,
      mode: crypto.mode.CBC,
      padding: crypto.pad.Pkcs7
    });

    return decrypted.toString(crypto.enc.Utf8);
  }

  // Token管理方法（复用data_collector.js的逻辑）
  assignTokenToWorker(workerId) {
    if (this.workerTokenMap.has(workerId)) {
      const tokenId = this.workerTokenMap.get(workerId);
      const token = this.tokens.find(t => t.id === tokenId);
      if (token && this.tokenStatus.get(tokenId) !== 'blocked') {
        return token;
      }
    }

    const availableToken = this.tokens.find(token =>
      this.tokenStatus.get(token.id) === 'available'
    );

    if (availableToken) {
      this.workerTokenMap.set(workerId, availableToken.id);
      this.tokenStatus.set(availableToken.id, 'in_use');
      console.log(`Worker ${workerId} 分配到 Token ${availableToken.id}`);
      return availableToken;
    }

    const leastUsedToken = this.tokens
      .filter(token => this.tokenStatus.get(token.id) !== 'blocked')
      .sort((a, b) =>
        (this.tokenUsageCount.get(a.id) || 0) - (this.tokenUsageCount.get(b.id) || 0)
      )[0];

    if (leastUsedToken) {
      this.workerTokenMap.set(workerId, leastUsedToken.id);
      this.tokenStatus.set(leastUsedToken.id, 'in_use');
      console.log(`Worker ${workerId} 分配到 Token ${leastUsedToken.id} (共享使用)`);
      return leastUsedToken;
    }

    throw new Error('没有可用的token');
  }

  blockToken(tokenId, reason = '403 Forbidden') {
    this.tokenStatus.set(tokenId, 'blocked');
    console.log(`Token ${tokenId} 被阻止: ${reason}`);

    const affectedWorkers = [];
    for (const [workerId, workerTokenId] of this.workerTokenMap.entries()) {
      if (workerTokenId === tokenId) {
        affectedWorkers.push(workerId);
      }
    }

    return affectedWorkers;
  }

  getRandomUserAgent() {
    return this.config.userAgents[Math.floor(Math.random() * this.config.userAgents.length)];
  }

  getRandomSecChUa() {
    return this.config.secChUa[Math.floor(Math.random() * this.config.secChUa.length)];
  }

  getRandomPlatform() {
    return this.config.platforms[Math.floor(Math.random() * this.config.platforms.length)];
  }

  generateRandomHeaders() {
    const userAgent = this.getRandomUserAgent();
    const secChUa = this.getRandomSecChUa();
    const platform = this.getRandomPlatform();

    return {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
      'Connection': 'keep-alive',
      'Content-Type': 'application/json',
      'DNT': '1',
      'Host': 'qms.stzy.com',
      'Origin': 'https://zj.stzy.com',
      'Referer': 'https://zj.stzy.com/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'User-Agent': userAgent,
      'sec-ch-ua': secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${platform}"`
    };
  }

  createProxyAgent() {
    if (!this.config.proxy.enabled) {
      console.log('代理未启用');
      return null;
    }

    let proxyUrl;
    const { host, port, username, password } = this.config.proxy;

    if (username && password) {
      proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      console.log(`使用认证代理: ${username}:***@${host}:${port}`);
    } else {
      proxyUrl = `http://${host}:${port}`;
      console.log(`使用代理: ${host}:${port}`);
    }

    const httpsAgent = new HttpsProxyAgent(proxyUrl);
    const httpAgent = new HttpProxyAgent(proxyUrl);

    return { httpsAgent, httpAgent };
  }

  getRandomDelay(delayConfig) {
    if (typeof delayConfig === 'number') {
      return delayConfig;
    }

    const min = delayConfig.min || 1000;
    const max = delayConfig.max || 3000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  isRetryableError(error) {
    if (error.code === 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED') {
      return true;
    }

    if (error.response && error.response.status >= 500) {
      return true;
    }

    if (error.message && (
      error.message.includes('proxy') ||
      error.message.includes('tunnel') ||
      error.message.includes('ECONNRESET') ||
      error.message.includes('socket hang up')
    )) {
      return true;
    }

    return false;
  }

  async makeQuestionDetailRequest(questionId, workerId = 0) {
    const token = this.assignTokenToWorker(workerId);
    const headers = this.generateRandomHeaders();
    headers.token = token.token;

    const agents = this.createProxyAgent();

    const requestData = {
      questionId: questionId,
      studyPhaseCode: "300",
      subjectCode: "1"
    };

    const axiosConfig = {
      method: 'POST',
      url: 'https://qms.stzy.com/matrix/zw-zzw/api/v1/zzw/home/pickQuestion/questionDetail',
      data: requestData,
      headers,
      timeout: this.config.requestConfig.timeout
    };

    if (agents) {
      axiosConfig.httpsAgent = agents.httpsAgent;
      axiosConfig.httpAgent = agents.httpAgent;
    }

    if (agents && agents.httpsAgent) {
      agents.httpsAgent.options.rejectUnauthorized = false;
      agents.httpsAgent.options.secureProtocol = 'TLSv1_2_method';
    }

    try {
      const response = await axios(axiosConfig);

      const currentCount = this.tokenUsageCount.get(token.id) || 0;
      this.tokenUsageCount.set(token.id, currentCount + 1);

      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 403) {
        console.error(`Token ${token.id} 收到403错误，标记为被阻止`);
        this.blockToken(token.id, '403 Forbidden');

        const forbiddenError = new Error('Token被阻止，需要切换token');
        forbiddenError.isForbidden = true;
        forbiddenError.tokenId = token.id;
        forbiddenError.originalError = error;
        throw forbiddenError;
      }

      const errorInfo = {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        statusText: error.response?.statusText,
        tokenId: token.id,
        workerId: workerId,
        isRetryable: this.isRetryableError(error)
      };

      console.error(`Worker ${workerId} Token ${token.id} 请求失败:`, errorInfo);

      if (this.isRetryableError(error)) {
        const retryableError = new Error(error.message);
        retryableError.isRetryable = true;
        retryableError.originalError = error;
        retryableError.tokenId = token.id;
        retryableError.workerId = workerId;
        throw retryableError;
      }

      throw error;
    }
  }

  // 递归读取目录下的所有JSON文件
  async readJsonFilesRecursively(directoryPath, baseInputPath = null) {
    const jsonFiles = [];
    const basePath = baseInputPath || directoryPath;

    try {
      const items = await fs.readdir(directoryPath, { withFileTypes: true });

      for (const item of items) {
        const fullPath = path.join(directoryPath, item.name);

        if (item.isDirectory()) {
          // 递归处理子目录
          const subFiles = await this.readJsonFilesRecursively(fullPath, basePath);
          jsonFiles.push(...subFiles);
        } else if (item.isFile() && item.name.endsWith('.json')) {
          try {
            const content = await fs.readFile(fullPath, 'utf8');
            const jsonData = JSON.parse(content);

            // 计算相对路径，用于在输出目录中重建目录结构
            const relativePath = path.relative(basePath, fullPath);
            const outputPath = path.join(this.outputDirectory, relativePath);

            jsonFiles.push({
              fileName: item.name,
              inputPath: fullPath,
              outputPath: outputPath,
              relativePath: relativePath,
              data: jsonData
            });
          } catch (error) {
            console.error(`读取文件 ${fullPath} 失败:`, error.message);
          }
        }
      }
    } catch (error) {
      console.error(`读取目录 ${directoryPath} 失败:`, error.message);
      throw error;
    }

    return jsonFiles;
  }

  // 检查输出目录中已存在的questionDetail
  async checkExistingQuestionDetails(jsonFiles) {
    const existingQuestionIds = new Set();

    for (const fileInfo of jsonFiles) {
      try {
        // 检查输出文件是否存在
        const outputExists = await fs.access(fileInfo.outputPath).then(() => true).catch(() => false);
        if (outputExists) {
          const content = await fs.readFile(fileInfo.outputPath, 'utf8');
          const existingData = JSON.parse(content);

          if (Array.isArray(existingData)) {
            existingData.forEach(question => {
              if (question.questionId && question.questionDetail) {
                existingQuestionIds.add(question.questionId);
              }
            });
          }
        }
      } catch (error) {
        console.error(`检查已存在文件 ${fileInfo.outputPath} 时出错:`, error.message);
      }
    }

    console.log(`发现 ${existingQuestionIds.size} 个已存在questionDetail的题目`);
    return existingQuestionIds;
  }

  // 从JSON文件中提取questionId并准备处理数据
  async extractQuestionIds(jsonFiles) {
    const questionIds = [];
    const questionMap = new Map(); // 用于存储questionId到原始question的映射
    const fileQuestionMap = new Map(); // 用于存储文件到questions的映射

    // 检查已存在的questionDetail
    const existingQuestionIds = await this.checkExistingQuestionDetails(jsonFiles);

    jsonFiles.forEach(fileInfo => {
      try {
        const questions = [];

        // 检查是否有response.data.list结构
        if (fileInfo?.data?.response?.data?.list &&
          Array.isArray(fileInfo?.data.response.data.list)) {

          fileInfo?.data.response.data.list.forEach((question, index) => {
            if (question.questionId) {
              // 创建question的副本，移除不需要的字段
              const cleanQuestion = { ...question };
              questions.push(cleanQuestion);

              // 只有当questionId不存在questionDetail时才添加到处理队列
              if (!existingQuestionIds.has(question.questionId)) {
                questionIds.push(question.questionId);
                questionMap.set(question.questionId, {
                  question: cleanQuestion,
                  fileInfo: fileInfo?.data,
                  questionIndex: index
                });
              } else {
                console.log(`跳过已存在questionDetail的题目: ${question.questionId}`);
              }
            }
          });
        }

        // 存储文件对应的questions数组
        fileQuestionMap.set(fileInfo?.data?.outputPath, questions);

      } catch (error) {
        console.error(`处理文件 ${fileInfo.fileName} 时出错:`, error.message);
      }
    });

    const totalQuestions = Array.from(fileQuestionMap.values()).reduce((sum, questions) => sum + questions.length, 0);
    const skippedCount = totalQuestions - questionIds.length;

    console.log(`从 ${jsonFiles.length} 个文件中提取到 ${totalQuestions} 个题目`);
    console.log(`需要获取详情: ${questionIds.length} 个，跳过已存在: ${skippedCount} 个`);

    return { questionIds, questionMap, fileQuestionMap, existingQuestionIds };
  }

  // 处理单个question的详情获取
  async processQuestionDetail(questionId, questionInfo, workerId = 0) {
    if (this.processedQuestions.has(questionId)) {
      console.log(`跳过已处理的题目: ${questionId}`);
      return true;
    }

    // 检查失败次数
    const failCount = this.failedQuestions.get(questionId) || 0;
    if (failCount >= this.maxRetries) {
      console.log(`跳过多次失败的题目: ${questionId} (失败${failCount}次)`);
      return false;
    }

    try {
      console.log(`Worker ${workerId} 开始处理题目: ${questionId} (尝试${failCount + 1}/${this.maxRetries})`);

      const response = await this.makeQuestionDetailRequest(questionId, workerId);

      if (response && response.data) {
        // 解密响应数据
        const decryptedData = this.phoneDecrypt(response.data);
        const questionDetail = JSON.parse(decryptedData);

        // 将解密后的数据添加到原始question中
        questionInfo.question.questionDetail = questionDetail;

        console.log(`Worker ${workerId} 成功获取题目详情: ${questionId}`);
        this.processedQuestions.add(questionId);
        // 清除失败记录
        this.failedQuestions.delete(questionId);

        return true;
      } else {
        console.error(`Worker ${workerId} 题目 ${questionId} 响应数据格式异常:`, response);
        this.failedQuestions.set(questionId, failCount + 1);
        return false;
      }
    } catch (error) {
      console.error(`Worker ${workerId} 处理题目 ${questionId} 失败:`, error.message);
      this.failedQuestions.set(questionId, failCount + 1);

      // 简化的错误处理 - 由于我们已经有失败计数机制，这里只记录错误
      if (error.isForbidden) {
        console.log(`Worker ${workerId} 题目 ${questionId}: 检测到403错误，token被封禁`);
      } else if (error.isRetryable || this.isRetryableError(error)) {
        console.log(`Worker ${workerId} 题目 ${questionId}: 检测到可重试错误: ${error.message}`);
      } else {
        console.log(`Worker ${workerId} 题目 ${questionId}: 不可重试错误: ${error.message}`);
      }

      return false;
    }
  }

  // 并发处理所有题目详情
  async processWithConcurrency(questionIds, questionMap, fileQuestionMap) {
    const semaphore = new Array(this.config.concurrency.maxConcurrent).fill(null);
    let questionIndex = 0;
    const failedQuestions = [];
    const successCount = { value: 0 };
    let lastProgressReport = Date.now();

    const processNext = async (workerIndex) => {
      while (questionIndex < questionIds.length) {
        const currentQuestionId = questionIds[questionIndex++];
        const questionInfo = questionMap.get(currentQuestionId);

        if (!questionInfo) {
          console.error(`找不到题目信息: ${currentQuestionId}`);
          continue;
        }

        // 并发任务之间的随机延迟
        if (workerIndex > 0) {
          const concurrentDelay = this.getRandomDelay(this.config.concurrency.delayBetweenConcurrentTasks);
          console.log(`Worker ${workerIndex} 等待 ${concurrentDelay}ms 后开始处理...`);
          await new Promise(resolve => setTimeout(resolve, concurrentDelay));
        }

        try {
          const success = await this.processQuestionDetail(currentQuestionId, questionInfo, workerIndex);
          if (success) {
            successCount.value++;
            console.log(`Worker ${workerIndex} 成功处理题目: ${currentQuestionId} (${successCount.value}/${questionIds.length})`);
          } else {
            failedQuestions.push({
              questionId: currentQuestionId,
              error: '处理失败',
              worker: workerIndex
            });
          }
        } catch (error) {
          console.error(`Worker ${workerIndex} 处理题目失败: ${currentQuestionId}`, error.message);
          failedQuestions.push({
            questionId: currentQuestionId,
            error: error.message,
            worker: workerIndex
          });
        }

        // 检查是否需要定期保存和进度报告
        const now = Date.now();
        if (now - lastProgressReport > 60000) { // 每分钟报告一次进度
          const processed = successCount.value + failedQuestions.length;
          const progress = ((processed / questionIds.length) * 100).toFixed(1);
          console.log(`\n📊 进度报告: ${processed}/${questionIds.length} (${progress}%) - 成功: ${successCount.value}, 失败: ${failedQuestions.length}`);
          lastProgressReport = now;
        }

        // 处理完一个题目后的随机延迟
        if (questionIndex < questionIds.length) {
          const taskDelay = this.getRandomDelay(this.config.concurrency.delayBetweenRequests);
          console.log(`Worker ${workerIndex} 完成一个题目，等待 ${taskDelay}ms 后继续...`);
          await new Promise(resolve => setTimeout(resolve, taskDelay));
        }
      }
    };

    // 启动并发处理
    const promises = semaphore.map((_, index) => processNext(index));
    await Promise.all(promises);

    return { successCount: successCount.value, failedQuestions };
  }

  // 检查文件中所有question是否都有questionDetail
  checkFileCompletion(questions) {
    const totalQuestions = questions.length;
    const completedQuestions = questions.filter(q => q.questionDetail).length;
    const isComplete = totalQuestions > 0 && completedQuestions === totalQuestions;

    return {
      isComplete,
      totalQuestions,
      completedQuestions,
      completionRate: totalQuestions > 0 ? (completedQuestions / totalQuestions * 100).toFixed(1) : 0
    };
  }

  // 保存处理后的JSON文件到输出目录
  async saveProcessedFiles(fileQuestionMap, existingQuestionIds, forcePartialSave = false) {
    const savedFiles = [];
    const failedFiles = [];
    const pendingFiles = [];

    for (const [outputPath, questions] of fileQuestionMap.entries()) {
      try {
        // 确保输出目录存在
        const outputDir = path.dirname(outputPath);
        await fs.mkdir(outputDir, { recursive: true });

        // 合并已存在的questionDetail
        let finalQuestions = questions;

        // 检查是否有已存在的文件
        const outputExists = await fs.access(outputPath).then(() => true).catch(() => false);
        if (outputExists) {
          try {
            const existingContent = await fs.readFile(outputPath, 'utf8');
            const existingData = JSON.parse(existingContent);

            if (Array.isArray(existingData)) {
              // 创建一个Map来存储已存在的questionDetail
              const existingDetailsMap = new Map();
              existingData.forEach(existingQuestion => {
                if (existingQuestion.questionId && existingQuestion.questionDetail) {
                  existingDetailsMap.set(existingQuestion.questionId, existingQuestion.questionDetail);
                }
              });

              // 将已存在的questionDetail合并到新的questions中
              finalQuestions = questions.map(question => {
                if (existingDetailsMap.has(question.questionId)) {
                  return {
                    ...question,
                    questionDetail: existingDetailsMap.get(question.questionId)
                  };
                }
                return question;
              });
            }
          } catch (error) {
            console.error(`读取已存在文件 ${outputPath} 失败:`, error.message);
          }
        }

        // 检查文件完成度
        const completion = this.checkFileCompletion(finalQuestions);

        if (completion.isComplete || forcePartialSave) {
          // 所有question都有questionDetail，或者强制保存部分完成的文件
          await fs.writeFile(outputPath, JSON.stringify(finalQuestions, null, 2), 'utf8');
          savedFiles.push(path.basename(outputPath));

          if (completion.isComplete) {
            console.log(`✓ 保存完整文件: ${path.relative(this.outputDirectory, outputPath)} (${completion.completedQuestions}/${completion.totalQuestions})`);
          } else {
            console.log(`📄 保存部分文件: ${path.relative(this.outputDirectory, outputPath)} (${completion.completedQuestions}/${completion.totalQuestions}, ${completion.completionRate}%)`);
          }
        } else {
          // 还有question没有questionDetail，暂不保存
          pendingFiles.push({
            fileName: path.basename(outputPath),
            outputPath: outputPath,
            totalQuestions: completion.totalQuestions,
            completedQuestions: completion.completedQuestions,
            completionRate: completion.completionRate
          });
          console.log(`⏳ 文件未完成，暂不保存: ${path.relative(this.outputDirectory, outputPath)} (${completion.completedQuestions}/${completion.totalQuestions}, ${completion.completionRate}%)`);
        }

      } catch (error) {
        console.error(`保存文件失败: ${outputPath}`, error.message);
        failedFiles.push({
          fileName: path.basename(outputPath),
          outputPath: outputPath,
          error: error.message
        });
      }
    }

    return { savedFiles, failedFiles, pendingFiles };
  }

  // 主处理方法
  async processAllFiles() {
    console.log(`开始处理目录: ${this.inputDirectory}`);
    const startTime = Date.now();

    try {
      // 1. 递归读取所有JSON文件
      console.log('步骤1: 递归读取JSON文件...');
      const jsonFiles = await this.readJsonFilesRecursively(this.inputDirectory);
      this.allJsonFiles = jsonFiles;
      this.totalFiles = jsonFiles.length;

      if (jsonFiles.length === 0) {
        console.log('未找到任何JSON文件');
        return;
      }

      console.log(`找到 ${jsonFiles.length} 个JSON文件`);

      // 2. 提取questionId
      console.log('步骤2: 提取questionId...');
      const { questionIds, questionMap, fileQuestionMap, existingQuestionIds } = await this.extractQuestionIds(jsonFiles);

      if (questionIds.length === 0) {
        console.log('未找到需要处理的questionId');
        // 即使没有新的questionId，也要检查文件完成度
        const { savedFiles, failedFiles, pendingFiles } = await this.saveProcessedFiles(fileQuestionMap, existingQuestionIds);

        console.log('\n=== 处理完成 ===');
        console.log(`完整文件: ${savedFiles.length} 个`);
        console.log(`未完成文件: ${pendingFiles.length} 个`);
        console.log(`失败文件: ${failedFiles.length} 个`);

        if (pendingFiles.length > 0) {
          console.log('\n未完成的文件列表:');
          pendingFiles.forEach((pending, index) => {
            console.log(`  ${index + 1}. ${pending.fileName} (${pending.completedQuestions}/${pending.totalQuestions}, ${pending.completionRate}%)`);
          });
        }
        return;
      }

      // 3. 并发获取题目详情
      console.log('步骤3: 获取题目详情...');
      console.log(`开始处理 ${questionIds.length} 个题目，最大重试次数: ${this.maxRetries}`);

      const { successCount, failedQuestions } = await this.processWithConcurrency(questionIds, questionMap, fileQuestionMap);

      // 4. 保存处理后的文件
      console.log('步骤4: 保存处理后的文件...');

      // 首先尝试正常保存（只保存完整的文件）
      const { savedFiles, failedFiles, pendingFiles } = await this.saveProcessedFiles(fileQuestionMap, existingQuestionIds);

      // 如果有未完成的文件，询问是否强制保存部分完成的文件
      if (pendingFiles.length > 0) {
        console.log(`\n发现 ${pendingFiles.length} 个未完成的文件，考虑强制保存部分完成的文件...`);

        // 强制保存部分完成的文件
        const { savedFiles: partialSavedFiles } = await this.saveProcessedFiles(fileQuestionMap, existingQuestionIds, true);

        console.log(`强制保存了 ${partialSavedFiles.length} 个部分完成的文件`);
      }

      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;

      // 5. 输出统计信息
      console.log('\n=== 处理完成 ===');
      console.log(`总耗时: ${duration.toFixed(2)} 秒`);
      console.log(`输入目录: ${this.inputDirectory}`);
      console.log(`输出目录: ${this.outputDirectory}`);
      console.log(`处理文件: ${jsonFiles.length} 个`);
      console.log(`题目总数: ${questionIds.length} 个`);
      console.log(`成功获取详情: ${successCount} 个`);
      console.log(`失败题目: ${failedQuestions.length} 个`);
      console.log(`完整保存文件: ${savedFiles.length} 个`);
      console.log(`未完成文件: ${pendingFiles.length} 个`);
      console.log(`保存失败文件: ${failedFiles.length} 个`);

      if (pendingFiles.length > 0) {
        console.log('\n未完成的文件列表:');
        pendingFiles.forEach((pending, index) => {
          console.log(`  ${index + 1}. ${pending.fileName} (${pending.completedQuestions}/${pending.totalQuestions}, ${pending.completionRate}%)`);
        });
      }

      if (failedQuestions.length > 0) {
        console.log('\n失败的题目列表:');
        failedQuestions.forEach((failed, index) => {
          console.log(`  ${index + 1}. ${failed.questionId} - ${failed.error}`);
        });
      }

      if (failedFiles.length > 0) {
        console.log('\n保存失败的文件列表:');
        failedFiles.forEach((failed, index) => {
          console.log(`  ${index + 1}. ${failed.fileName} - ${failed.error}`);
        });
      }

      // 保存处理报告到输出目录
      const report = {
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        duration: duration,
        inputDirectory: this.inputDirectory,
        outputDirectory: this.outputDirectory,
        totalFiles: jsonFiles.length,
        totalQuestions: questionIds.length,
        successCount: successCount,
        failedCount: failedQuestions.length,
        completedFiles: savedFiles.length,
        pendingFiles: pendingFiles.length,
        failedFiles: failedFiles.length,
        failedQuestions: failedQuestions,
        pendingFilesList: pendingFiles,
        failedFilesList: failedFiles
      };

      const reportPath = path.join(this.outputDirectory, 'question_detail_report.json');
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
      console.log(`\n处理报告已保存到: ${reportPath}`);

    } catch (error) {
      console.error('处理过程中发生严重错误:', error);
      throw error;
    }
  }

  async start() {
    console.log('开始题目详情收集...');

    try {
      await this.processAllFiles();
    } catch (error) {
      console.error('题目详情收集失败:', error);
      process.exit(1);
    }
  }
}

module.exports = QuestionDetailCollector;

// 如果直接运行此文件
if (require.main === module) {
  console.log('=== 题目详情收集器 ===');
  console.log('从配置文件读取输入和输出目录...');

  const collector = new QuestionDetailCollector();

  collector.init()
    .then(() => collector.start())
    .catch(error => {
      console.error('初始化或运行失败:', error);
      process.exit(1);
    });
}
