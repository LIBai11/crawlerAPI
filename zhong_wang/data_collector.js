const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

class DataCollector {
  constructor(configPath = './config.json') {
    this.configPath = configPath;
    this.config = null;
    this.params = [];
    this.tokens = [];
    this.tokenUsageCount = new Map();
    this.tokenStatus = new Map(); // 记录token状态：available, in_use, blocked
    this.workerTokenMap = new Map(); // worker到token的映射
    this.requestQueue = [];
    this.activeRequests = 0;
    this.results = new Map();
  }

  async init() {
    await this.loadConfig();
    await this.loadParams();
    await this.loadTokens();
    await this.ensureOutputDir();
    console.log(`初始化完成: ${this.params.length} 个参数, ${this.tokens.length} 个token`);
  }

  async loadConfig() {
    const configData = await fs.readFile(this.configPath, 'utf8');
    this.config = JSON.parse(configData);
  }

  async loadParams() {
    const paramsData = await fs.readFile(this.config.paramsFile, 'utf8');
    this.params = JSON.parse(paramsData);
  }

  async loadTokens() {
    const tokenData = await fs.readFile(this.config.tokenFile, 'utf8');
    const tokenInfo = JSON.parse(tokenData);
    this.tokens = tokenInfo.tokens.filter(t => t.isValid);

    // 初始化token使用计数和状态
    this.tokens.forEach(token => {
      this.tokenUsageCount.set(token.id, 0);
      this.tokenStatus.set(token.id, 'available'); // 初始状态：可用
    });

    console.log(`加载了 ${this.tokens.length} 个有效token`);
  }

  async ensureOutputDir() {
    try {
      await fs.access(this.config.outputDir);
    } catch {
      await fs.mkdir(this.config.outputDir, { recursive: true });
    }
  }

  encodeDirName(name) {
    if (!name) return 'unknown'

    // 只处理会影响目录生成的字符
    const encoded = name
      .replace(/[<>:"|?*]/g, '_')    // 替换 Windows 不允许的字符
      .replace(/[\/\\]/g, '_')       // 替换路径分隔符
      .replace(/[\x00-\x1f\x80-\x9f]/g, '_')  // 替换控制字符
      .replace(/^\.+$/, '_')         // 替换只有点的名称（如 . 或 ..）
      .replace(/\s+/g, ' ')          // 将多个空格替换为单个空格
      .trim()                       // 去除首尾空格

    return encoded || 'unknown'
  }

  generateOutputPath(parameters) {
    const pathComponents = [
      {
        original: parameters.studyPhaseName,
        encoded: this.encodeDirName(parameters.studyPhaseName)
      },
      { original: parameters.subjectName, encoded: this.encodeDirName(parameters.subjectName) },
      {
        original: parameters.textbookVersionName,
        encoded: this.encodeDirName(parameters.textbookVersionName)
      },
      { original: parameters.ceciName, encoded: this.encodeDirName(parameters.ceciName) },
      { original: parameters.catalogName, encoded: this.encodeDirName(parameters.catalogName) }
    ]

    const encodedPath = path.join(this.config.outputDir || './output', ...pathComponents.map(c => c.encoded))

    return {
      encodedPath: encodedPath,
      pathComponents: pathComponents,
      originalPath: pathComponents.map(c => c.original).join('/') // 用于显示和调试
    }
  }

  async findExistingFiles(outputPath) {
    try {
      await fs.access(outputPath);
      const files = await fs.readdir(outputPath);
      const jsonFiles = files.filter(file => /^\d+\.json$/.test(file));

      if (jsonFiles.length === 0) {
        return { maxNumber: 0, existingFiles: [] };
      }

      const numbers = jsonFiles.map(file => parseInt(file.replace('.json', '')));
      const maxNumber = Math.max(...numbers);

      return { maxNumber, existingFiles: jsonFiles };
    } catch {
      // 目录不存在，从1开始
      return { maxNumber: 0, existingFiles: [] };
    }
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
      ...this.config.headers,
      'User-Agent': userAgent,
      'sec-ch-ua': secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${platform}"`
    };
  }

  // 为worker分配token
  assignTokenToWorker(workerId) {
    // 如果worker已经有token，直接返回
    if (this.workerTokenMap.has(workerId)) {
      const tokenId = this.workerTokenMap.get(workerId);
      const token = this.tokens.find(t => t.id === tokenId);
      if (token && this.tokenStatus.get(tokenId) !== 'blocked') {
        return token;
      }
    }

    // 寻找可用的token
    const availableToken = this.tokens.find(token =>
      this.tokenStatus.get(token.id) === 'available'
    );

    if (availableToken) {
      this.workerTokenMap.set(workerId, availableToken.id);
      this.tokenStatus.set(availableToken.id, 'in_use');
      console.log(`Worker ${workerId} 分配到 Token ${availableToken.id}`);
      return availableToken;
    }

    // 如果没有可用token，使用使用次数最少的token
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

  // 释放worker的token
  releaseWorkerToken(workerId) {
    if (this.workerTokenMap.has(workerId)) {
      const tokenId = this.workerTokenMap.get(workerId);
      this.workerTokenMap.delete(workerId);

      // 检查是否还有其他worker在使用这个token
      const stillInUse = Array.from(this.workerTokenMap.values()).includes(tokenId);
      if (!stillInUse && this.tokenStatus.get(tokenId) !== 'blocked') {
        this.tokenStatus.set(tokenId, 'available');
      }

      console.log(`Worker ${workerId} 释放 Token ${tokenId}`);
    }
  }

  // 标记token为被阻止（403错误时调用）
  blockToken(tokenId, reason = '403 Forbidden') {
    this.tokenStatus.set(tokenId, 'blocked');
    console.log(`Token ${tokenId} 被阻止: ${reason}`);

    // 找到使用这个token的worker并重新分配
    const affectedWorkers = [];
    for (const [workerId, workerTokenId] of this.workerTokenMap.entries()) {
      if (workerTokenId === tokenId) {
        affectedWorkers.push(workerId);
      }
    }

    return affectedWorkers;
  }

  // 获取token状态统计
  getTokenStats() {
    const stats = {
      total: this.tokens.length,
      available: 0,
      in_use: 0,
      blocked: 0
    };

    this.tokens.forEach(token => {
      const status = this.tokenStatus.get(token.id);
      stats[status]++;
    });

    return stats;
  }

  createProxyAgent() {
    if (!this.config.proxy.enabled) {
      console.log('代理未启用');
      return null;
    }

    let proxyUrl;
    const { host, port, username, password } = this.config.proxy;

    // 构建代理URL，包含认证信息
    if (username && password) {
      proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      console.log(`使用认证代理: ${username}:***@${host}:${port}`);
    } else {
      proxyUrl = `http://${host}:${port}`;
      console.log(`使用代理: ${host}:${port}`);
    }

    // 创建代理代理（同时支持HTTP和HTTPS）
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
    // SSL/TLS 错误
    if (error.code === 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ECONNREFUSED') {
      return true;
    }

    // HTTP 状态码错误
    if (error.response && error.response.status >= 500) {
      return true;
    }

    // 代理相关错误
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

  async makeRequest(requestData, workerId = 0) {
    const token = this.assignTokenToWorker(workerId);
    const headers = this.generateRandomHeaders();
    console.log(`Worker ${workerId} 使用 Token ${token.id}`);
    headers.Token = token.token;

    const agents = this.createProxyAgent();

    const axiosConfig = {
      method: 'POST',
      url: this.config.requestConfig.url,
      data: requestData,
      headers,
      timeout: this.config.requestConfig.timeout
    };

    // 添加代理配置
    if (agents) {
      axiosConfig.httpsAgent = agents.httpsAgent;
      axiosConfig.httpAgent = agents.httpAgent;
    }

    // 添加SSL配置以处理SSL错误
    if (agents && agents.httpsAgent) {
      agents.httpsAgent.options.rejectUnauthorized = false; // 忽略SSL证书验证
      agents.httpsAgent.options.secureProtocol = 'TLSv1_2_method'; // 强制使用TLS 1.2
    }

    try {
      const response = await axios(axiosConfig);

      // 增加token使用计数
      const currentCount = this.tokenUsageCount.get(token.id) || 0;
      this.tokenUsageCount.set(token.id, currentCount + 1);

      return response.data;
    } catch (error) {
      // 检查是否是403错误
      if (error.response && error.response.status === 403) {
        console.error(`Token ${token.id} 收到403错误，标记为被阻止`);
        this.blockToken(token.id, '403 Forbidden');

        // 创建403错误对象
        const forbiddenError = new Error('Token被阻止，需要切换token');
        forbiddenError.isForbidden = true;
        forbiddenError.tokenId = token.id;
        forbiddenError.originalError = error;
        throw forbiddenError;
      }

      // 记录详细的错误信息
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

      // 对于可重试的错误，抛出特殊标记
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

  async processParam(paramInfo, workerId = 0) {
    const catalogCode = paramInfo.catalogCode;
    const resultKey = `${catalogCode}`;

    if (this.results.has(resultKey)) {
      console.log(`跳过已处理的参数: ${catalogCode}`);
      return;
    }

    // 生成输出路径
    const outputPathInfo = this.generateOutputPath(paramInfo);
    console.log(`开始处理参数: ${paramInfo.catalogName} (${catalogCode})`);
    console.log(`输出路径: ${outputPathInfo.originalPath}`);

    // 确保输出目录存在
    await fs.mkdir(outputPathInfo.encodedPath, { recursive: true });

    // 检查已存在的文件，确定起始页码
    const { maxNumber } = await this.findExistingFiles(outputPathInfo.encodedPath);
    let pageNum = maxNumber + 1;
    let totalPages = 1;
    let allData = [];
    let hasTokenBanError = false; // 标记是否遇到token封禁

    console.log(`从第 ${pageNum} 页开始爬取...`);

    do {
      const requestData = {
        pageNum,
        pageSize: 10,
        params: {
          studyPhaseCode: paramInfo.studyPhaseCode,
          subjectCode: paramInfo.subjectCode,
          textbookVersionCode: paramInfo.textbookVersionCode,
          ceciCode: paramInfo.ceciCode,
          searchType: 1,
          sort: 0,
          yearCode: "",
          gradeCode: paramInfo.gradeCode || "",
          provinceCode: "",
          cityCode: "",
          areaCode: "",
          organizationCode: "",
          termCode: "",
          keyWord: "",
          filterQuestionFlag: false,
          searchScope: 0,
          treeIds: [catalogCode],
          categoryId: ""
        }
      };

      try {
        const response = await this.makeRequest(requestData, workerId);

        if (response && response.data) {
          const responseData = response.data;

          // 检查响应中是否包含403错误信息
          if (response.code === 403 || (response.message && response.message.includes('封禁'))) {
            console.error(`${catalogCode} - 页面 ${pageNum}: 检测到token封禁响应:`, response);
            hasTokenBanError = true; // 标记遇到token封禁
            // 获取当前使用的token并标记为被阻止
            const currentToken = this.assignTokenToWorker(workerId);
            this.blockToken(currentToken.id, `Token封禁: ${response.message || 'IP或账号被封禁'}`);

            // 抛出封禁错误，触发token切换逻辑
            const banError = new Error(`Token被封禁: ${response.message || 'IP或账号被封禁'}`);
            banError.isForbidden = true;
            banError.tokenId = currentToken.id;
            throw banError;
          }

          totalPages = responseData.totalPage || 1;

          if (responseData.list && responseData.list.length > 0) {
            allData.push(...responseData.list);
            console.log(`${catalogCode} - 页面 ${pageNum}/${totalPages}: 获取 ${responseData.list.length} 条数据`);

            // 保存当前页面的完整响应数据
            const pageResult = {
              paramInfo,
              pageNum,
              totalPages,
              pageSize: 10,
              currentPageData: responseData.list,
              currentPageCount: responseData.list.length,
              response: response, // 保存完整的响应数据
              collectedAt: new Date().toISOString(),
              outputPath: outputPathInfo.originalPath
            };

            await this.savePageResult(outputPathInfo.encodedPath, pageNum, pageResult);
          }

          pageNum++;
        } else {
          console.log(`${catalogCode} - 页面 ${pageNum}: 无数据返回,`, response);
          break;
        }
        
        // 添加随机延迟
        const delay = this.getRandomDelay(this.config.concurrency.delayBetweenRequests);
        console.log(`等待 ${delay}ms 后继续下一个请求...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
      } catch (error) {
        console.error(`${catalogCode} - 页面 ${pageNum} 请求失败:`, error.message);

        // 处理403错误 - 立即切换token重试
        if (error.isForbidden) {
          console.log(`${catalogCode} - 页面 ${pageNum}: 检测到403错误，切换token后重试...`);
          try {
            // 等待一小段时间后重试
            await new Promise(resolve => setTimeout(resolve, 1000));
            const response = await this.makeRequest(requestData, workerId);

            if (response && response.data) {
              const responseData = response.data;

              // 检查切换token后的响应是否仍然包含封禁信息
              if (response.code === 403 || (response.message && response.message.includes('封禁'))) {
                console.error(`${catalogCode} - 页面 ${pageNum}: 切换token后仍然收到封禁响应:`, response);
                hasTokenBanError = true; // 标记遇到token封禁
                // 获取当前使用的token并标记为被阻止
                const currentToken = this.assignTokenToWorker(workerId);
                this.blockToken(currentToken.id, `Token封禁: ${response.message || 'IP或账号被封禁'}`);

                // 如果切换token后仍然被封禁，跳过当前页面
                console.log(`${catalogCode} - 页面 ${pageNum}: 多个token被封禁，跳过当前页面`);
                pageNum++;
                continue;
              }

              totalPages = responseData.totalPage || 1;

              if (responseData.list && responseData.list.length > 0) {
                allData.push(...responseData.list);
                console.log(`${catalogCode} - 页面 ${pageNum}/${totalPages}: 切换token后成功，获取 ${responseData.list.length} 条数据`);

                // 保存切换token后成功的页面数据
                const pageResult = {
                  paramInfo,
                  pageNum,
                  totalPages,
                  pageSize: 10,
                  currentPageData: responseData.list,
                  currentPageCount: responseData.list.length,
                  response: response,
                  collectedAt: new Date().toISOString(),
                  outputPath: outputPathInfo.originalPath,
                  isTokenSwitch: true
                };

                await this.savePageResult(outputPathInfo.encodedPath, pageNum, pageResult);
              }

              pageNum++;
              continue; // 成功后继续下一页
            }
          } catch (switchError) {
            console.error(`${catalogCode} - 页面 ${pageNum}: 切换token后仍然失败:`, switchError.message);
            // 如果切换token后仍然失败，跳过当前页面
            pageNum++;
            continue;
          }
        }

        // 重试逻辑 - 只对可重试的错误进行重试
        let retryCount = 0;
        let shouldRetry = error.isRetryable || this.isRetryableError(error);
        let retrySuccess = false;

        if (shouldRetry) {
          console.log(`${catalogCode} - 页面 ${pageNum}: 检测到可重试错误，开始重试...`);

          while (retryCount < this.config.requestConfig.retryAttempts) {
            try {
              // 增加重试延迟，使用指数退避
              const retryDelay = this.config.requestConfig.retryDelay * Math.pow(2, retryCount);
              console.log(`${catalogCode} - 页面 ${pageNum}: 等待 ${retryDelay}ms 后进行第 ${retryCount + 1} 次重试...`);
              await new Promise(resolve => setTimeout(resolve, retryDelay));

              const response = await this.makeRequest(requestData, workerId);

              if (response && response.data) {
                const responseData = response.data;

                // 检查重试响应是否包含封禁信息
                if (response.code === 403 || (response.message && response.message.includes('封禁'))) {
                  console.error(`${catalogCode} - 页面 ${pageNum}: 重试时收到封禁响应:`, response);
                  hasTokenBanError = true; // 标记遇到token封禁
                  // 获取当前使用的token并标记为被阻止
                  const currentToken = this.assignTokenToWorker(workerId);
                  this.blockToken(currentToken.id, `Token封禁: ${response.message || 'IP或账号被封禁'}`);

                  // 如果重试时仍然被封禁，停止重试
                  console.log(`${catalogCode} - 页面 ${pageNum}: 重试时token被封禁，停止重试`);
                  break;
                }

                totalPages = responseData.totalPage || 1;

                if (responseData.list && responseData.list.length > 0) {
                  allData.push(...responseData.list);
                  console.log(`${catalogCode} - 页面 ${pageNum}/${totalPages}: 重试成功，获取 ${responseData.list.length} 条数据`);

                  // 保存重试成功的页面数据
                  const pageResult = {
                    paramInfo,
                    pageNum,
                    totalPages,
                    pageSize: 10,
                    currentPageData: responseData.list,
                    currentPageCount: responseData.list.length,
                    response: response,
                    collectedAt: new Date().toISOString(),
                    outputPath: outputPathInfo.originalPath,
                    isRetry: true,
                    retryCount: retryCount + 1
                  };

                  await this.savePageResult(outputPathInfo.encodedPath, pageNum, pageResult);
                }

                pageNum++;
                retrySuccess = true;
                break;
              }
            } catch (retryError) {
              retryCount++;
              console.error(`${catalogCode} - 页面 ${pageNum} 重试 ${retryCount} 失败:`, retryError.message);

              // 如果是不可重试的错误，直接跳出重试循环
              if (!retryError.isRetryable && !this.isRetryableError(retryError)) {
                console.log(`${catalogCode} - 页面 ${pageNum}: 遇到不可重试错误，停止重试`);
                break;
              }
            }
          }
        }

        // 如果重试失败或不需要重试，跳过当前页面继续下一页
        if (!retrySuccess) {
          if (shouldRetry && retryCount >= this.config.requestConfig.retryAttempts) {
            console.error(`${catalogCode} - 页面 ${pageNum}: 重试次数用尽，跳过此页面继续下一页`);
          } else {
            console.error(`${catalogCode} - 页面 ${pageNum}: 不可重试错误，跳过此页面继续下一页`);
          }

          // 跳过当前页面，继续下一页
          pageNum++;

          // 如果是第一页就失败，可能整个目录都有问题，但仍然继续
          if (pageNum === 2 && allData.length === 0) {
            console.warn(`${catalogCode}: 第一页请求失败，可能整个目录存在问题，但继续尝试后续页面`);
          }
        }
      }
      
    } while (pageNum <= totalPages);

    // 记录处理完成
    if (allData.length > 0) {
      const result = {
        paramInfo,
        totalCount: allData.length,
        totalPages: pageNum - 1,
        collectedAt: new Date().toISOString(),
        outputPath: outputPathInfo.originalPath
      };

      this.results.set(resultKey, result);
      console.log(`${catalogCode} 完成: 共收集 ${allData.length} 条数据，保存到 ${outputPathInfo.originalPath}`);
    } else {
      // 如果没有数据且遇到了token封禁，应该认为是失败而不是成功
      if (hasTokenBanError) {
        console.error(`${catalogCode} 失败: 因token封禁无法获取数据`);
        throw new Error(`参数处理失败: token被封禁，无法获取数据 - ${paramInfo.catalogName} (${catalogCode})`);
      } else {
        console.log(`${catalogCode} 完成: 无数据`);
      }
    }
  }

  async savePageResult(outputPath, pageNumber, result) {
    const filename = `${pageNumber}.json`;
    const filepath = path.join(outputPath, filename);
    await fs.writeFile(filepath, JSON.stringify(result, null, 2), 'utf8');

    // 同时保存一个 page.json 文件（最新的页面数据）
    const pageFilepath = path.join(outputPath, 'page.json');
    await fs.writeFile(pageFilepath, JSON.stringify(result, null, 2), 'utf8');
  }



  async processWithConcurrency() {
    const semaphore = new Array(this.config.concurrency.maxConcurrent).fill(null);
    let paramIndex = 0;
    const failedParams = [];

    const processNext = async (workerIndex) => {
      while (paramIndex < this.params.length) {
        const currentParam = this.params[paramIndex++];

        // 并发任务之间的随机延迟
        if (workerIndex > 0) {
          const concurrentDelay = this.getRandomDelay(this.config.concurrency.delayBetweenConcurrentTasks);
          console.log(`Worker ${workerIndex} 等待 ${concurrentDelay}ms 后开始处理...`);
          await new Promise(resolve => setTimeout(resolve, concurrentDelay));
        }

        try {
          await this.processParam(currentParam, workerIndex);
          console.log(`Worker ${workerIndex} 成功处理: ${currentParam.catalogName} (${currentParam.catalogCode})`);
        } catch (error) {
          console.error(`Worker ${workerIndex} 处理失败: ${currentParam.catalogName} (${currentParam.catalogCode})`, error.message);
          failedParams.push({
            param: currentParam,
            error: error.message,
            worker: workerIndex
          });

          // 即使失败也继续处理下一个参数
          console.log(`Worker ${workerIndex} 跳过失败的参数，继续处理下一个...`);
        }

        // 处理完成后释放worker的token（如果需要的话）
        // 注意：这里不释放token，因为worker可能还会处理更多参数

        // 处理完一个参数后的随机延迟
        if (paramIndex < this.params.length) {
          const taskDelay = this.getRandomDelay(this.config.concurrency.delayBetweenConcurrentTasks);
          console.log(`Worker ${workerIndex} 完成一个任务，等待 ${taskDelay}ms 后继续...`);
          await new Promise(resolve => setTimeout(resolve, taskDelay));
        }
      }
    };

    // 启动并发处理，为每个worker分配索引
    const promises = semaphore.map((_, index) => processNext(index));
    await Promise.all(promises);

    // 释放所有worker的token
    for (let i = 0; i < this.config.concurrency.maxConcurrent; i++) {
      this.releaseWorkerToken(i);
    }

    // 打印token使用统计
    const tokenStats = this.getTokenStats();
    console.log(`Token使用统计: 总计${tokenStats.total}, 可用${tokenStats.available}, 使用中${tokenStats.in_use}, 被阻止${tokenStats.blocked}`);

    // 返回失败的参数信息
    return failedParams;
  }

  async start() {
    console.log('开始数据收集...');
    const startTime = Date.now();

    try {
      const failedParams = await this.processWithConcurrency();

      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;

      console.log(`数据收集完成！`);
      console.log(`总耗时: ${duration.toFixed(2)} 秒`);
      console.log(`处理参数: ${this.params.length} 个`);
      console.log(`成功收集: ${this.results.size} 个`);
      console.log(`失败参数: ${failedParams.length} 个`);

      if (failedParams.length > 0) {
        console.log('\n失败的参数列表:');
        failedParams.forEach((failed, index) => {
          console.log(`  ${index + 1}. ${failed.param.catalogName} (${failed.param.catalogCode}) - ${failed.error}`);
        });
      }

      // 保存汇总信息
      const summary = {
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        duration: duration,
        totalParams: this.params.length,
        successCount: this.results.size,
        failedCount: failedParams.length,
        successRate: ((this.results.size / this.params.length) * 100).toFixed(2) + '%',
        results: Array.from(this.results.keys()),
        failedParams: failedParams.map(f => ({
          catalogCode: f.param.catalogCode,
          catalogName: f.param.catalogName,
          error: f.error,
          worker: f.worker
        }))
      };

      await fs.writeFile(
        path.join(this.config.outputDir, 'summary.json'),
        JSON.stringify(summary, null, 2),
        'utf8'
      );

      // 如果有失败的参数，也保存一个单独的失败列表
      if (failedParams.length > 0) {
        await fs.writeFile(
          path.join(this.config.outputDir, 'failed_params.json'),
          JSON.stringify(failedParams, null, 2),
          'utf8'
        );
        console.log(`失败参数详情已保存到: failed_params.json`);
      }

    } catch (error) {
      console.error('数据收集过程中发生严重错误:', error);
      console.log('程序将继续运行，不会因为单个错误而停止');
    }
  }
}

module.exports = DataCollector;

// 如果直接运行此文件
if (require.main === module) {
  const collector = new DataCollector();
  
  collector.init()
    .then(() => collector.start())
    .catch(error => {
      console.error('初始化失败:', error);
      process.exit(1);
    });
}
