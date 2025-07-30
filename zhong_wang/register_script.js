const readline = require('readline');
const axios = require('axios');
const crypto = require('crypto-js');
const fs = require('fs').promises;
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

// 添加手机号列表，用于整理已注册的手机号
const phoneList = [];

// 代理配置
const PROXY_CONFIG = {
    host: '182.106.136.217',
    port: '40664',
    username: 'd2196405406',
    password: 'triucylw',
    url: 'http://1714653636:triucylw@36.140.150.110:16816'
};

const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 1
});

// 创建代理agent
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:1080');

// 创建专门用于短信平台的axios实例（不使用代理，避免449错误）
const smsAxios = axios.create({
    timeout: 60000,
    // 设置默认请求头，模拟真实浏览器
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Google Chrome";v="120", "Chromium";v="120", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Connection': 'keep-alive'
    },
    httpsAgent: new HttpsProxyAgent('http://127.0.0.1:10809'),
    httpAgent: new HttpsProxyAgent('http://127.0.0.1:10809')
});

// 添加请求拦截器，增加随机延迟
smsAxios.interceptors.request.use(async (config) => {
    // 随机延迟100-500ms，模拟人类行为
    const delay = Math.random() * 400 + 100;
    await new Promise(resolve => setTimeout(resolve, delay));

    console.log(`🌐 发起请求: ${config.method?.toUpperCase()} ${config.url}`);
    return config;
});

// 添加响应拦截器
smsAxios.interceptors.response.use(
    (response) => {
        console.log(`✅ 请求成功: ${response.status} ${response.config.url}`);
        return response;
    },
    (error) => {
        console.log(`❌ 请求失败: ${error.code} ${error.message}`);
        return Promise.reject(error);
    }
);

// 带重试机制的请求函数
async function requestWithRetry(requestConfig, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔄 第${attempt}次尝试请求...`);
            const response = await smsAxios(requestConfig);
            return response;
        } catch (error) {
            console.log(`❌ 第${attempt}次请求失败:`, error.code || error.message);

            if (attempt === maxRetries) {
                throw error;
            }

            // 如果是连接相关错误，等待后重试
            if (error.code === 'ECONNRESET' ||
                error.code === 'ENOTFOUND' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ECONNREFUSED') {

                const waitTime = attempt * 2000; // 递增等待时间
                console.log(`⏳ 等待${waitTime}ms后重试...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
                throw error; // 非网络错误直接抛出
            }
        }
    }
}

// 电话号码加密函数
function phoneEncrypt(t) {
    let n = 'abADefg234cdegsd'
    let e = n
    let o = crypto.enc.Utf8.parse(n)
    let l = crypto.enc.Utf8.parse(e)
    let m = crypto.enc.Utf8.parse(t)

    return crypto.AES.encrypt(m, o, {
        iv: l,
        mode: crypto.mode.CBC,
        padding: crypto.pad.Pkcs7
    }).toString()
}

// 生成默认密码（手机号后六位）
function generateDefaultPassword(phone) {
    if (!phone || phone.length < 6) {
        return '';
    }
    return phone.slice(-6);
}

// 获取短信平台token
async function getSMSToken() {
    try {
        console.log('🔑 正在获取短信平台token...');

        // 如果已经配置了token，直接返回
        if (SMS_CONFIG.token) {
            console.log('✅ 使用已配置的token');
            return SMS_CONFIG.token;
        }

        const requestConfig = {
            method: 'GET',
            url: `${SMS_CONFIG.apiUrl}/login`,
            params: {
                username: SMS_CONFIG.username,
                password: SMS_CONFIG.password
            }
        };

        const response = await requestWithRetry(requestConfig, 3);

        console.log('短信平台登录响应:', response.data);

        if (response.data?.status === 200 && response.data.data?.token) {
            SMS_CONFIG.token = response.data.data.token;
            console.log('✅ 获取token成功');
            return response.data.data.token;
        } else {
            throw new Error('登录响应中未找到token: ' + (response.data?.msg || JSON.stringify(response.data)));
        }

    } catch (error) {
        console.error('❌ 获取短信平台token失败:');
        console.error('   错误代码:', error.code);
        console.error('   错误信息:', error.message);

        if (error.response) {
            console.error('   响应状态:', error.response.status);
            console.error('   响应数据:', error.response.data);
        }

        // 提供详细的故障排除建议
        if (error.code === 'ECONNRESET') {
            console.error('\n🔧 ECONNRESET错误解决建议:');
            console.error('   1. 服务器主动断开连接，可能是反爬虫机制');
            console.error('   2. 尝试减少请求频率');
            console.error('   3. 检查User-Agent和请求头设置');
            console.error('   4. 考虑使用代理或更换网络环境');
        }

        return null;
    }
}

// 获取手机号
async function getPhoneNumber() {
    try {
        console.log('📱 正在获取可用手机号...');

        const token = await getSMSToken();
        if (!token) {
            throw new Error('无法获取token');
        }

        const requestConfig = {
            method: 'GET',
            url: `${SMS_CONFIG.apiUrl}/getPhone`,
            params: {
                token: token,
                channelId: SMS_CONFIG.channelId,
                operator: SMS_CONFIG.operator || '0'
            },
            httpsAgent: new HttpsProxyAgent('http://127.0.0.1:10809'),
            httpAgent: new HttpsProxyAgent('http://127.0.0.1:10809')
        };

        const response = await requestWithRetry(requestConfig, 3);

        console.log('获取手机号响应:', response.data);

        if (response.data?.status === 200 && response.data.data?.mobile) {
            const phone = response.data.data.mobile;
            const taskId = response.data.data.smsTask?.id;
            console.log(`✅ 获取到手机号: ${phone}`);
            return {
                phone: phone,
                taskId: taskId
            };
        } else {
            throw new Error('响应中未找到手机号: ' + (response.data?.msg || '未知错误'));
        }
    } catch (error) {
        console.error('❌ 获取手机号失败:', error.response?.data || error.message);
        return null;
    }
}

// 创建命令行接口
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// 短信平台配置
const SMS_CONFIG = {
    apiUrl: 'https://api.tqsms.xyz/api',
    projectName: '众望互联教育----金币：0.36----可用：实卡 在线:942/可用:942----channelId:1514220479076896770',
    channelId: '1514312352520998924',
    operator: '0', // 0表示不限运营商
    // 这些配置需要根据实际情况填写
    username: '1714653636', // 短信平台用户名
    password: '123456ll', // 短信平台密码
    token: '' // 如果已有token可以直接填写
};

// 发送验证码
async function sendVerifyCode(phone) {
    try {
        const encryptedPhone = phoneEncrypt(phone);
        console.log(`加密后的手机号: ${encryptedPhone}`);

        const response = await axios.post(
            'https://qms.stzy.com/matrix/zw-zzw/api/v1/zzw/user/send/verifyCode',
            {
                authType: 1,
                phone: encryptedPhone,
                type: 1
            },
            {
                httpsAgent: proxyAgent,
                httpAgent: proxyAgent,
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'zh-CN,zh;q=0.9,is;q=0.8,en;q=0.7',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.stzy.com',
                    'Pragma': 'no-cache',
                    'Referer': 'https://www.stzy.com/',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-site',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                    'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"macOS"'
                },
                timeout: 10000
            }
        );

        console.log('验证码发送响应:', response.data);
        return response.data;
    } catch (error) {
        console.error('发送验证码失败:', error.response?.data || error.message);
        return null;
    }
}

// 从短信平台获取验证码
async function getVerifyCodeFromSMS(phone, taskId, maxRetries = 15) {
    try {
        console.log('🔍 正在从短信平台获取验证码...');

        const token = await getSMSToken();
        if (!token) {
            throw new Error('无法获取token');
        }

        let retries = 0;
        while (retries < maxRetries) {
            try {
                const requestConfig = {
                    method: 'GET',
                    url: `${SMS_CONFIG.apiUrl}/getCode`,
                    params: {
                        token: token,
                        channelId: SMS_CONFIG.channelId,
                        phoneNum: phone
                    }
                };

                const response = await smsAxios(requestConfig);

                console.log(`第${retries + 1}次尝试获取短信:`, response.data);

                if (response.data?.status === 200 && response.data.data?.code) {
                    const verifyCode = response.data.data.code;
                    console.log(`✅ 自动获取到验证码: ${verifyCode}`);
                    console.log(`📩 短信内容: ${response.data.data.modle || response.data.data.message || ''}`);
                    return verifyCode;
                }

                retries++;
                if (retries < maxRetries) {
                    console.log(`⏳ 等待3秒后重试 (${retries}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }

            } catch (error) {
                console.error(`第${retries + 1}次获取失败:`, error.response?.data || error.message);
                retries++;
                if (retries < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
        }

        console.log('❌ 达到最大重试次数，未能获取到验证码');
        await blacklistPhone(phone, taskId);
        return null;

    } catch (error) {
        console.error('❌ 从短信平台获取验证码失败:', error.response?.data || error.message);
        return null;
    }
}

// 拉黑手机号码
async function blacklistPhone(phone, taskId) {
    try {
        console.log(`🚫 正在拉黑手机号: ${phone}`);

        const token = await getSMSToken();
        if (!token) {
            throw new Error('无法获取token');
        }

        // 根据文档使用GET方式调用拉黑接口
        const params = new URLSearchParams({
            token: token,
            channelId: SMS_CONFIG.channelId,
            phoneNo: phone,
            type: '0'
        });

        const response = await axios.get(
            `${SMS_CONFIG.apiUrl}/phoneCollectAdd?${params.toString()}`, {
            httpsAgent: new HttpsProxyAgent('http://127.0.0.1:10809'),
            httpAgent: new HttpsProxyAgent('http://127.0.0.1:10809')
        }
        );

        console.log('拉黑手机号响应:', response.data);

        if (response.data?.status === 200) {
            console.log(`✅ 手机号 ${phone} 已拉黑并释放任务`);
            return true;
        } else {
            console.log(`❌ 拉黑手机号失败: ${response.data?.msg || '未知错误'}`);
            return false;
        }

    } catch (error) {
        console.error('❌ 拉黑手机号失败:', error.response?.data || error.message);
        return false;
    }
}

// 从短信内容中提取验证码
function extractVerificationCode(smsContent) {
    try {
        // 常见的验证码格式匹配
        const patterns = [
            /验证码[：:]\s*(\d{4,6})/,
            /验证码为[：:]\s*(\d{4,6})/,
            /验证码是[：:]\s*(\d{4,6})/,
            /\b(\d{4,6})\b/,
            /code[：:]\s*(\d{4,6})/i,
            /verification[：:]\s*(\d{4,6})/i
        ];

        for (const pattern of patterns) {
            const match = smsContent.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }

        return null;
    } catch (error) {
        console.error('提取验证码失败:', error.message);
        return null;
    }
}

// 注册或登录
async function registerOrLogin(phone, verifyCode) {
    try {
        const encryptedPhone = phoneEncrypt(phone);
        // 使用手机号后六位作为默认密码
        const defaultPassword = generateDefaultPassword(phone);
        const encryptedPassword = phoneEncrypt(defaultPassword);

        console.log(`加密后的手机号: ${encryptedPhone}`);
        console.log(`默认密码: ${defaultPassword}`);
        console.log(`加密后的密码: ${encryptedPassword}`);

        const response = await axios.post(
            'https://qms.stzy.com/matrix/zw-auth/oauth/registerOrLogin',
            {
                phone: encryptedPhone,
                password: encryptedPassword,
                vcode: verifyCode,
                sharer: ""
            },
            {
                httpsAgent: proxyAgent,
                httpAgent: proxyAgent,
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'zh-CN,zh;q=0.9,is;q=0.8,en;q=0.7',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.stzy.com',
                    'Pragma': 'no-cache',
                    'Referer': 'https://www.stzy.com/',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-site',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                    'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"macOS"'
                },
                timeout: 10000
            }
        );

        console.log('注册/登录响应:', response.data);
        return response.data;
    } catch (error) {
        console.error('注册/登录失败:', error.response?.data || error.message);
        return null;
    }
}

// 保存token到文件
async function saveTokenToFile(tokenData, phone) {
    try {
        const tokensFilePath = './tokens.json';
        let tokensData;

        // 尝试读取现有文件
        try {
            const fileContent = await fs.readFile(tokensFilePath, 'utf8');
            tokensData = JSON.parse(fileContent);
        } catch (error) {
            // 文件不存在或格式错误，创建新的数据结构
            tokensData = {
                tokens: [],
                lastUpdated: new Date().toISOString(),
                description: "存储用于数据爬取的token列表和对应的代理配置，支持多token并发请求"
            };
        }

        // 生成新的token条目
        const newToken = {
            id: tokensData.tokens.length + 1,
            token: tokenData.data.access_token || tokenData.token || JSON.stringify(tokenData),
            phone: phone,
            isValid: true,
            lastValidated: new Date().toISOString(),
            registeredyAt: new Date().toISOString(),
            proxy: null,
            proxyAssignedAt: null,
            proxyValidatedAt: null,
            // originalResponse: tokenData
        };

        // 添加新token
        tokensData.tokens.push(newToken);
        tokensData.lastUpdated = new Date().toISOString();

        // 添加到phoneList
        phoneList.push({
            phone: phone,
            tokenId: newToken.id,
            registeredAt: new Date().toISOString()
        });

        // 写入文件
        await fs.writeFile(tokensFilePath, JSON.stringify(tokensData, null, 4), 'utf8');
        console.log(`✅ Token已保存到文件: ${tokensFilePath}`);
        console.log(`📱 手机号: ${phone}`);
        console.log(`🔑 Token ID: ${newToken.id}`);

        // 保存手机号列表到文件
        await savePhoneList();

        return true;
    } catch (error) {
        console.error('❌ 保存token到文件失败:', error.message);
        return false;
    }
}

// 保存手机号列表到文件
async function savePhoneList() {
    try {
        const phoneListFilePath = './phone_list.json';
        const phoneListData = {
            phones: phoneList,
            lastUpdated: new Date().toISOString(),
            totalCount: phoneList.length,
            description: "已注册的手机号列表"
        };

        await fs.writeFile(phoneListFilePath, JSON.stringify(phoneListData, null, 4), 'utf8');
        console.log(`✅ 手机号列表已保存到文件: ${phoneListFilePath}`);
        return true;
    } catch (error) {
        console.error('❌ 保存手机号列表失败:', error.message);
        return false;
    }
}

// 加载手机号列表
async function loadPhoneList() {
    try {
        const phoneListFilePath = './phone_list.json';

        try {
            const fileContent = await fs.readFile(phoneListFilePath, 'utf8');
            const phoneListData = JSON.parse(fileContent);

            // 清空当前列表并添加加载的手机号
            phoneList.length = 0;
            phoneListData.phones.forEach(phone => phoneList.push(phone));

            console.log(`✅ 已加载${phoneList.length}个手机号`);
            return true;
        } catch (error) {
            // 文件不存在或格式错误
            console.log('📝 手机号列表文件不存在，将创建新列表');
            return false;
        }
    } catch (error) {
        console.error('❌ 加载手机号列表失败:', error.message);
        return false;
    }
}

// 显示手机号列表
function displayPhoneList() {
    console.log('\n=== 已注册手机号列表 ===');
    if (phoneList.length === 0) {
        console.log('列表为空，还没有注册任何手机号');
    } else {
        console.log(`共有 ${phoneList.length} 个已注册手机号:`);
        phoneList.forEach((item, index) => {
            console.log(`${index + 1}. 手机号: ${item.phone}, Token ID: ${item.tokenId}, 注册时间: ${new Date(item.registeredAt).toLocaleString()}`);
        });
    }
    console.log('========================\n');
}

// 用户输入提示函数
function askQuestion(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.trim());
        });
    });
}

// 一键式自动化注册
async function autoRegister() {
    try {
        console.log('🚀 开始一键式自动化注册流程...');

        // 1. 获取短信平台token
        const token = await getSMSToken();
        if (!token) {
            throw new Error('无法获取短信平台token');
        }
        console.log('✅ Step 1: 获取token成功');

        // 2. 获取手机号
        const phoneData = await getPhoneNumber();
        if (!phoneData) {
            throw new Error('无法获取手机号');
        }
        console.log(`✅ Step 2: 获取手机号成功 - ${phoneData.phone}`);

        // 3. 发送验证码
        console.log('📤 Step 3: 发送验证码...');
        const sendResult = await sendVerifyCode(phoneData.phone);
        if (!sendResult) {
            throw new Error('发送验证码失败');
        }
        console.log('✅ Step 3: 验证码发送成功');

        // 4. 自动获取验证码
        console.log('📥 Step 4: 自动获取验证码...');
        const verifyCode = await getVerifyCodeFromSMS(phoneData.phone, phoneData.taskId);
        if (!verifyCode) {
            throw new Error('无法获取验证码');
        }
        console.log(`✅ Step 4: 验证码获取成功 - ${verifyCode}`);

        // 5. 进行注册/登录
        console.log('🔐 Step 5: 进行注册/登录...');
        const registerResult = await registerOrLogin(phoneData.phone, verifyCode);

        if (registerResult && registerResult.success !== false && !registerResult.error) {
            console.log('✅ Step 5: 注册/登录成功!');
            console.log('响应数据:', JSON.stringify(registerResult, null, 2));

            // 6. 保存token到文件
            console.log('💾 Step 6: 保存token到文件...');
            const saveSuccess = await saveTokenToFile(registerResult, phoneData.phone);
            if (saveSuccess) {
                console.log('✅ Step 6: Token保存成功!');
            }

            console.log('\n🎉 一键式自动化注册完成!');
            console.log(`📱 手机号: ${phoneData.phone}`);
            console.log(`🔑 验证码: ${verifyCode}`);

            return {
                success: true,
                phone: phoneData.phone,
                verifyCode: verifyCode,
                registerResult: registerResult
            };

        } else {
            throw new Error('注册/登录失败: ' + (registerResult?.message || registerResult?.error || '未知错误'));
        }

    } catch (error) {
        console.error('❌ 一键式自动化注册失败:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// 连续自动注册多个账号
async function continuousAutoRegister(count = Infinity) {
    let successCount = 0;
    let failCount = 0;
    let continueRegistration = true;

    console.log(`\n🔄 开始连续自动注册模式，将注册 ${count === Infinity ? '无限' : count} 个账号...\n`);

    while (continueRegistration && (successCount + failCount) < count) {
        console.log(`\n===== 开始第 ${successCount + failCount + 1} 次注册 =====`);

        try {
            const result = await autoRegister();

            if (result.success) {
                successCount++;
                console.log(`\n✅ 注册成功! 当前成功: ${successCount} | 失败: ${failCount}`);

                // 短暂延迟后继续下一个注册，避免频率过高
                console.log('⏳ 等待 5 秒后继续下一个注册...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                failCount++;
                console.log(`\n❌ 注册失败! 当前成功: ${successCount} | 失败: ${failCount}`);

                // 失败后等待时间更长，避免触发平台限制
                console.log('⏳ 等待 10 秒后重试...');
                await new Promise(resolve => setTimeout(resolve, 10000));

                // 如果连续失败次数过多，提示用户是否继续
                if (failCount >= 3 && failCount % 3 === 0) {
                    const continueChoice = await askQuestion(`已连续失败 ${failCount} 次，是否继续尝试？(y/n): `);
                    if (continueChoice.toLowerCase() !== 'y' && continueChoice.toLowerCase() !== 'yes') {
                        continueRegistration = false;
                        console.log('⛔ 用户选择停止连续注册');
                    }
                }
            }
        } catch (error) {
            failCount++;
            console.error(`\n❌ 注册过程发生错误: ${error.message}`);
            console.log(`当前成功: ${successCount} | 失败: ${failCount}`);

            // 错误后等待更长时间
            console.log('⏳ 等待 15 秒后重试...');
            await new Promise(resolve => setTimeout(resolve, 15000));
        }
    }

    console.log(`\n🏁 连续注册完成! 总计成功: ${successCount} | 失败: ${failCount}`);
    return { successCount, failCount };
}

// 主函数
async function main() {
    console.log('=== 批量注册手机号脚本 ===');
    console.log('短信平台配置:', SMS_CONFIG.projectName);
    console.log('');

    // 加载已有的手机号列表
    await loadPhoneList();

    while (true) {
        try {
            // 选择操作模式
            const mode = await askQuestion('选择操作模式:\n1. 一键式自动化注册\n2. 连续自动注册多个账号\n3. 手动输入手机号注册\n4. 显示已注册手机号列表\n5. 退出\n请选择 (1-5): ');

            if (mode === '5' || mode.toLowerCase() === 'exit') {
                console.log('退出程序');
                break;
            }

            if (mode === '4') {
                // 显示已注册手机号列表
                displayPhoneList();
                continue;
            }

            if (mode === '1') {
                // 一键式自动化模式
                console.log('\n🤖 启动一键式自动化模式...');
                const result = await autoRegister();

                if (result.success) {
                    console.log('\n✅ 自动化注册完成!');

                    // 询问是否继续
                    const continueChoice = await askQuestion('是否继续进行下一次自动化注册？(y/n): ');
                    if (continueChoice.toLowerCase() !== 'y' && continueChoice.toLowerCase() !== 'yes') {
                        continue; // 返回主菜单
                    } else {
                        // 用户选择继续，再次执行当前模式
                        continue;
                    }
                } else {
                    console.log('\n❌ 自动化注册失败，请检查配置或手动操作');

                    // 询问是否切换到手动模式
                    const switchMode = await askQuestion('是否切换到手动模式？(y/n): ');
                    if (switchMode.toLowerCase() === 'y' || switchMode.toLowerCase() === 'yes') {
                        continue; // 回到主菜单
                    }
                }
            } else if (mode === '2') {
                // 连续自动注册模式
                const countInput = await askQuestion('请输入要连续注册的账号数量 (输入0表示无限注册): ');
                const count = parseInt(countInput);

                if (isNaN(count) || count < 0) {
                    console.log('❌ 无效的数量，请输入有效的数字');
                    continue;
                }

                // 开始连续注册
                await continuousAutoRegister(count === 0 ? Infinity : count);

                // 注册结束后返回主菜单
                console.log('\n返回主菜单...');

            } else if (mode === '3') {
                // 手动输入模式（原有逻辑）
                console.log('\n📱 手动输入模式...');

                // 获取手机号
                const phone = await askQuestion('请输入手机号 (输入 "back" 返回主菜单): ');

                if (phone.toLowerCase() === 'back') {
                    continue;
                }

                // 验证手机号格式
                if (!/^1[3-9]\d{9}$/.test(phone)) {
                    console.log('手机号格式不正确，请重新输入');
                    continue;
                }

                console.log(`正在为手机号 ${phone} 发送验证码...`);

                // 发送验证码
                const result = await sendVerifyCode(phone);

                if (!result) {
                    console.log('发送验证码失败，请重试');
                    continue;
                }

                // 验证码输入和验证循环
                let registerResult = null;
                let verifyCodeAttempts = 0;
                const maxAttempts = 3;

                while (!registerResult && verifyCodeAttempts < maxAttempts) {
                    verifyCodeAttempts++;

                    // 手动输入验证码
                    const verifyCode = await askQuestion(`请输入收到的验证码 (第${verifyCodeAttempts}次尝试): `);

                    console.log(`手机号: ${phone}, 验证码: ${verifyCode}`);
                    console.log('正在进行注册/登录...');

                    // 进行注册/登录
                    registerResult = await registerOrLogin(phone, verifyCode);

                    if (registerResult) {
                        // 检查是否注册成功
                        if (registerResult.success !== false && !registerResult.error) {
                            console.log('✅ 注册/登录成功!');
                            console.log('响应数据:', JSON.stringify(registerResult, null, 2));

                            // 保存token到文件
                            const saveSuccess = await saveTokenToFile(registerResult, phone);
                            if (saveSuccess) {
                                console.log('💾 Token保存成功!');
                            }
                            break;
                        } else {
                            console.log('❌ 注册/登录失败:', registerResult.message || registerResult.error || '验证码错误');
                            registerResult = null; // 重置以继续循环

                            if (verifyCodeAttempts < maxAttempts) {
                                console.log('请重新输入验证码...');
                            }
                        }
                    } else {
                        console.log('❌ 注册/登录失败，请检查验证码是否正确');

                        if (verifyCodeAttempts < maxAttempts) {
                            console.log('请重新输入验证码...');
                        }
                    }
                }

                if (!registerResult && verifyCodeAttempts >= maxAttempts) {
                    console.log(`❌ 验证码尝试次数已达上限(${maxAttempts}次)，请重新发送验证码`);
                }
            } else {
                console.log('无效选择，请重新选择');
                continue;
            }

            console.log('---');

        } catch (error) {
            console.error('处理过程中发生错误:', error.message);
        }
    }

    rl.close();
}

// 运行脚本
if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    sendVerifyCode,
    registerOrLogin,
    saveTokenToFile,
    getSMSToken,
    getPhoneNumber,
    getVerifyCodeFromSMS,
    blacklistPhone,
    extractVerificationCode,
    generateDefaultPassword,
    autoRegister,
    phoneEncrypt,
    phoneList,
    savePhoneList,
    loadPhoneList,
    displayPhoneList
}; 