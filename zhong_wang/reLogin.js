const { phoneEncrypt, generateDefaultPassword } = require('./register_script');
const fs = require('fs');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');

// 设置全局SSL配置来解决代理SSL握手问题
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 忽略SSL证书验证（仅用于解决代理问题）
https.globalAgent.options.secureProtocol = 'TLS_method'; // 使用更兼容的TLS方法
https.globalAgent.options.ciphers = 'ALL'; // 允许所有加密套件

const tokensFile = './phone_list.json';
const tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
const phoneList = tokens.phones;

// 代理配置 - 格式: user:pass@ip:port
const PROXY_CONFIG = ''; // 可通过环境变量设置
// 示例: const PROXY_CONFIG = "username:password@192.168.1.100:8080";

// Token校验函数
const validateToken = async (token) => {
    const axiosConfig = {
        "headers": {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "DNT": "1",
            "Origin": "https://www.stzy.com",
            "Pragma": "no-cache",
            "Referer": "https://www.stzy.com/",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-site",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0",
            "sec-ch-ua": "\"Microsoft Edge\";v=\"137\", \"Chromium\";v=\"137\", \"Not/A)Brand\";v=\"24\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"macOS\"",
            "token": token
        }
    };

    // 如果配置了代理，添加代理agent
    if (PROXY_CONFIG) {
        const proxyUrl = `http://${PROXY_CONFIG}`;
        axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl, {
            // 添加SSL配置选项来解决SSL握手问题
            rejectUnauthorized: false, // 忽略SSL证书验证
            secureOptions: require('constants').SSL_OP_LEGACY_SERVER_CONNECT,
            ciphers: 'ALL', // 允许所有加密套件
        });
        // 添加全局https agent配置
        axiosConfig.timeout = 30000; // 30秒超时
    }

    try {
        const res = await axios.get("https://qms.stzy.com/matrix/zw-zzw/api/v1/zzw/user/detail", axiosConfig);
        console.log(res.data)
        // 检查返回的code是否为403
        if (res.data?.code === 403) {
            return { isValid: false, reason: 'Token校验失败 - code: 403' };
        }
        
        return { isValid: true, reason: 'Token校验成功' };
    } catch (error) {
        // 如果请求失败，也认为token无效
        return { isValid: false, reason: `Token校验异常: ${error.message}` };
    }
};

const login = async (phone, id) => {
    const phoneEnc = phoneEncrypt(phone);
    const password = generateDefaultPassword(phone);
    const passwordEnc = phoneEncrypt(password);
    const body = {
        loginName: phoneEnc,
        password: passwordEnc
    }

    // 配置axios选项
    const axiosConfig = {
        "headers": {
            "accept": "application/json, text/plain, */*",
            "accept-language": "zh-CN,zh;q=0.9,is;q=0.8,en;q=0.7",
            "cache-control": "no-cache",
            "content-type": "application/json",
            "pragma": "no-cache",
            "sec-ch-ua": "\"Google Chrome\";v=\"137\", \"Chromium\";v=\"137\", \"Not/A)Brand\";v=\"24\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"macOS\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
            "Referer": "https://www.stzy.com/",
            "Referrer-Policy": "strict-origin-when-cross-origin"
        }
    };

    // 如果配置了代理，添加代理agent
    if (PROXY_CONFIG) {
        const proxyUrl = `http://${PROXY_CONFIG}`;
        axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl, {
            // 添加SSL配置选项来解决SSL握手问题
            rejectUnauthorized: false, // 忽略SSL证书验证
            secureOptions: require('constants').SSL_OP_LEGACY_SERVER_CONNECT,
            ciphers: 'ALL', // 允许所有加密套件
        });
        // 添加全局https agent配置
        axiosConfig.timeout = 30000; // 30秒超时
        console.log(`使用代理登录: ${phone} -> ${PROXY_CONFIG.replace(/:[^:]*@/, ':****@')}`);
    }

    try {
        const res = await axios.post("https://qms.stzy.com/matrix/zw-auth/oauth/passwordLogin", body, axiosConfig);
        const token = res.data?.data?.access_token;
        if (!token) {
            console.log(`登录失败: ${phone}, ${JSON.stringify(res.data)}`);
            return { success: false, reason: '登录失败' };
        }
        
        console.log(`登录成功: ${phone}`);
        
        // 校验token
        console.log(`🔍 开始校验token: ${phone}`);
        const validation = await validateToken(token);
        
        if (!validation.isValid) {
            console.log(`❌ Token校验失败: ${phone} - ${validation.reason}`);
            return { 
                success: false, 
                reason: validation.reason,
                needMarkInvalid: true // 标记需要在phone_list.json中设置为无效
            };
        }
        
        console.log(`✅ Token校验成功: ${phone}`);
        
        const newToken = {
            id: id,
            token: token,
            phone: phone,
            isValid: true,
            lastValidated: new Date().toISOString(),
            registeredyAt: new Date().toISOString(),
            proxy: PROXY_CONFIG ? PROXY_CONFIG.replace(/:[^:]*@/, ':****@') : null,
            proxyAssignedAt: PROXY_CONFIG ? new Date().toISOString() : null,
            proxyValidatedAt: PROXY_CONFIG ? new Date().toISOString() : null
        };
        return { success: true, token: newToken };
    } catch (error) {
        console.log(`登录异常: ${phone}, ${error.message}`);
        return { success: false, reason: `登录异常: ${error.message}` };
    }
}

// 更新phone_list.json中手机号的状态
const updatePhoneStatus = (phone, isValid, reason) => {
    const phoneIndex = phoneList.findIndex(p => p.phone === phone);
    if (phoneIndex !== -1) {
        phoneList[phoneIndex].tokenValid = true || isValid;
        phoneList[phoneIndex].lastTokenTest = new Date().toISOString();
        if (!isValid) {
            phoneList[phoneIndex].tokenTestError = reason;
        }
    }
};

const main = async () => {
    const _tokens = [];
    const invalidTokenPhones = []; // 记录token无效的手机号
    
    // 过滤出需要重新登录的手机号（跳过token已标记为无效的）
    const validPhones = phoneList.filter(phoneEntry => {
        // 如果没有tokenValid字段，默认认为需要重新登录
        // 如果tokenValid为false，则跳过
        if (phoneEntry.tokenValid === false) {
            console.log(`⏭️ 跳过token无效的手机号: ${phoneEntry.phone} (最后测试时间: ${phoneEntry.lastTokenTest || '未知'})`);
            return false;
        }
        return true;
    });
    
    console.log(`📱 总手机号: ${phoneList.length} 个`);
    console.log(`✅ 需要重新登录: ${validPhones.length} 个`);
    console.log(`⏭️ 跳过无效: ${phoneList.length - validPhones.length} 个\n`);
    
    if (validPhones.length === 0) {
        console.log('⚠️ 没有需要重新登录的手机号');
        process.exit(0);
    }
    
    for (let i = 0; i < validPhones.length; i++) {
        const phoneEntry = validPhones[i];
        const phone = phoneEntry.phone;
        console.log(`\n[${i + 1}/${validPhones.length}] 登录手机号: ${phone}`);
        
        const result = await login(phone, phoneEntry.tokenId || i + 1);
        
        if (result.success) {
            _tokens.push(result.token);
            // 更新为有效状态
            updatePhoneStatus(phone, true, null);
        } else {
            if (result.needMarkInvalid) {
                // 标记为无效状态
                updatePhoneStatus(phone, false, result.reason);
                invalidTokenPhones.push(phone);
                console.log(`📝 已标记手机号 ${phone} 为token无效`);
            }
        }
        
        // 在登录之间添加短暂延迟
        if (i < validPhones.length - 1) {
            console.log('⏱️ 等待 1 秒...');
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    console.log(`\n📊 登录结果统计:`);
    console.log(`   ✅ 成功登录: ${_tokens.length} 个`);
    console.log(`   ❌ 登录失败: ${validPhones.length - _tokens.length} 个`);
    console.log(`   🚫 Token无效: ${invalidTokenPhones.length} 个`);
    
    // 保存更新后的phone_list.json
    tokens.phones = phoneList;
    tokens.lastUpdated = new Date().toISOString();
    fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
    console.log(`📝 已更新 phone_list.json`);
    
    // 保存有效的tokens
    fs.writeFileSync('./tokens.json', JSON.stringify({
        tokens: _tokens,
        phoneList: validPhones.map(phoneEntry => phoneEntry.phone),
        skippedPhones: phoneList.filter(p => p.tokenValid === false).map(p => p.phone),
        invalidTokenPhones: invalidTokenPhones,
        lastUpdated: new Date().toISOString(),
        totalProcessed: validPhones.length,
        successCount: _tokens.length
    }, null, 2));
    
    console.log(`\n💾 已保存 ${_tokens.length} 个有效token到 tokens.json`);
    
    if (invalidTokenPhones.length > 0) {
        console.log(`⚠️ 检测到 ${invalidTokenPhones.length} 个无效token的手机号，下次运行将跳过：`);
        invalidTokenPhones.forEach(phone => console.log(`   - ${phone}`));
    }
    
    process.exit(0);
}

main();