const CryptoJS = require('crypto-js');
const fs = require('fs');
const crypto = require('crypto');

/**
 * 模拟浏览器环境中的 devtools 对象
 * 实现解密CDATA的功能
 */
const devtools = {
    jsc: CryptoJS,

    /**
     * AES解密函数 - 模拟 window.devtools.jsd
     * @param {string} key - 解密密钥
     * @param {string} encryptedString - 加密的字符串数据
     * @returns {string} - 解密后的字符串
     */
    jsd: function (key, encryptedString) {
        try {
            // 将密钥转换为CryptoJS格式
            const parsedKey = CryptoJS.enc.Utf8.parse(key);

            // 执行AES解密 (ECB模式)
            const decrypted = CryptoJS.AES.decrypt(encryptedString, parsedKey, {
                mode: CryptoJS.mode.ECB,
                padding: CryptoJS.pad.Pkcs7
            });

            // 转换为UTF-8字符串
            return decrypted.toString(CryptoJS.enc.Utf8);
        } catch (error) {
            console.error('解密失败:', error);
            throw error;
        }
    },

    /**
     * 从mh_info生成image_info - 模拟 window.devtools.jse
     * @param {Object} mhInfo - 漫画信息对象
     * @returns {Object} - 图片信息对象
     */
    jse: function (mhInfo) {
        try {
            // 解密enc_code1和enc_code2来获取图片信息
            const key1 = "ZsfOA40m7kWjodMH"; // 默认密钥1
            const key2 = "aGzU9QOeLVaK3rnL"; // 默认密钥2
            const urlKey = "TJloldeXW7EJOfrd"; // URL解密密钥

            let imageInfo = {
                img_type: "",
                urls__direct: "",
                line_id: 1,
                local_watch_url: "",
                keyType: "",
                imgKey: ""
            };

            // 解密enc_code1获取imgKey
            if (mhInfo.enc_code1) {
                try {
                    const parsedEncCode1 = CryptoJS.enc.Base64.parse(mhInfo.enc_code1).toString(CryptoJS.enc.Utf8);
                    const decryptedCode1 = this.jsd(key1, parsedEncCode1);
                    imageInfo.imgKey = decryptedCode1;
                } catch (e) {
                    // 如果key1失败，尝试key2
                    try {
                        const parsedEncCode1 = CryptoJS.enc.Base64.parse(mhInfo.enc_code1).toString(CryptoJS.enc.Utf8);
                        const decryptedCode1 = this.jsd(key2, parsedEncCode1);
                        imageInfo.imgKey = decryptedCode1;
                    } catch (e2) {
                        console.warn('enc_code1解密失败:', e2);
                    }
                }
            }

            // 使用新的URL密钥解密enc_code2获取URL信息
            if (mhInfo.enc_code2) {
                try {
                    const parsedEncCode2 = CryptoJS.enc.Base64.parse(mhInfo.enc_code2).toString(CryptoJS.enc.Utf8);
                    const decryptedUrl = this.jsd(urlKey, parsedEncCode2);
                    imageInfo.urls__direct = decryptedUrl;
                    console.log('URL解密成功:', decryptedUrl);
                } catch (e) {
                    console.warn('URL解密失败，尝试其他密钥');
                    // 如果URL密钥失败，尝试其他密钥
                    try {
                        const parsedEncCode2 = CryptoJS.enc.Base64.parse(mhInfo.enc_code2).toString(CryptoJS.enc.Utf8);
                        const decryptedCode2 = this.jsd(key1, parsedEncCode2);

                        // 验证解密结果是否正确（应该以mhid开头）
                        if (decryptedCode2 && decryptedCode2.startsWith(`${mhInfo.mhid}/`)) {
                            imageInfo.urls__direct = decryptedCode2;
                        } else {
                            // 尝试key2
                            try {
                                const decryptedCode2Alt = this.jsd(key2, parsedEncCode2);
                                imageInfo.urls__direct = decryptedCode2Alt;
                            } catch (e2) {
                                console.warn('所有密钥都解密失败:', e2);
                            }
                        }
                    } catch (e) {
                        console.warn('enc_code2解密失败:', e);
                    }
                }
            }

            // 设置keyType（从pageid派生）
            if (mhInfo.pageid) {
                imageInfo.keyType = String(mhInfo.pageid % 1000000); // 简单的派生逻辑
            }

            return imageInfo;
        } catch (error) {
            console.error('生成image_info失败:', error);
            throw error;
        }
    }
};

/**
 * 解析完整的漫画数据（包含mh_info和image_info）
 * @param {string} cdata - 需要解密的CDATA字符串（Base64编码）
 * @param {string} key - 解密密钥，默认使用 '8enRS43hvFwocD7T'
 * @returns {Object} - 包含mh_info和image_info的对象
 */
function parseFullMangaData(cdata, key = '8enRS43hvFwocD7T') {
    try {
        // 解密CDATA获取原始数据
        const decryptedData = decryptCDATA(cdata, key);

        // 解析JavaScript代码以提取mh_info
        const mhInfoMatch = decryptedData.match(/mh_info=({[^}]*})/);
        if (!mhInfoMatch) {
            throw new Error('无法从解密数据中提取mh_info');
        }

        // 解析JavaScript代码以提取image_info
        const imageInfoMatch = decryptedData.match(/image_info=({[^}]*})/);
        if (!imageInfoMatch) {
            throw new Error('无法从解密数据中提取image_info');
        }

        // 将JavaScript对象字符串转换为实际对象
        const mhInfoStr = mhInfoMatch[1];
        const imageInfoStr = imageInfoMatch[1];

        const mhInfo = parseJSObject(mhInfoStr);
        const imageInfo = parseJSObject(imageInfoStr);

        return {
            mh_info: mhInfo,
            image_info: imageInfo,
            raw_data: decryptedData
        };
    } catch (error) {
        console.error('解析完整漫画数据失败:', error);
        throw error;
    }
}

/**
 * 使用devtools.jse生成image_info（基于mh_info的enc_code数据）
 * @param {Object} mhInfo - 漫画信息对象
 * @returns {Object} - 生成的图片信息对象
 */
function generateImageInfo(mhInfo) {
    return devtools.jse(mhInfo);
}

/**
 * 获取图片URL - 解密mh_info.enc_code2
 * 等同于: window.devtools.jsd('gym9zc8DLpZYvPQT', devtools.jsc.enc.Base64.parse(window.mh_info.enc_code2).toString(devtools.jsc.enc.Utf8))
 * @param {Object} mhInfo - 漫画信息对象
 * @param {string} urlKey - URL解密密钥，默认使用 'gym9zc8DLpZYvPQT'
 * @returns {string} - 解密后的URL字符串
 */
function getImageUrl(mhInfo, urlKey = 'gym9zc8DLpZYvPQT') {
    try {
        if (!mhInfo.enc_code2) {
            throw new Error('mh_info中缺少enc_code2');
        }

        // 解析Base64编码的enc_code2，并转换为UTF-8字符串
        const parsedEncCode2 = devtools.jsc.enc.Base64.parse(mhInfo.enc_code2).toString(devtools.jsc.enc.Utf8);

        // 使用URL密钥解密获取URL
        const imageUrl = devtools.jsd(urlKey, parsedEncCode2);

        return imageUrl;
    } catch (error) {
        console.error('获取图片URL失败:', error);
        throw error;
    }
}

/**
 * 获取总页数 - 解密mh_info.enc_code1
 * 等同于: window.devtools.jsd('gym9zc8DLpZYvPQT', devtools.jsc.enc.Base64.parse(mh_info.enc_code1).toString(devtools.jsc.enc.Utf8))
 * @param {Object} mhInfo - 漫画信息对象
 * @param {string} pageKey - 页数解密密钥，默认使用 'gym9zc8DLpZYvPQT'
 * @returns {string} - 解密后的页数字符串
 */
function getTotalPage(mhInfo, pageKey = 'gym9zc8DLpZYvPQT') {
    try {
        if (!mhInfo.enc_code1) {
            throw new Error('mh_info中缺少enc_code1');
        }

        // 解析Base64编码的enc_code1，并转换为UTF-8字符串
        const parsedEncCode1 = devtools.jsc.enc.Base64.parse(mhInfo.enc_code1).toString(devtools.jsc.enc.Utf8);

        // 使用密钥解密获取页数信息
        const totalPage = devtools.jsd(pageKey, parsedEncCode1);

        return totalPage;
    } catch (error) {
        console.error('获取总页数失败:', error);
        throw error;
    }
}

/**
 * 批量获取多个漫画页面的URL
 * @param {Array<Object>} mhInfoArray - 漫画信息对象数组
 * @param {string} urlKey - URL解密密钥
 * @returns {Array<string>} - URL数组
 */
function batchGetImageUrls(mhInfoArray, urlKey = 'gym9zc8DLpZYvPQT') {
    return mhInfoArray.map((mhInfo, index) => {
        try {
            return getImageUrl(mhInfo, urlKey);
        } catch (error) {
            console.error(`第${index + 1}个URL获取失败:`, error);
            return null;
        }
    }).filter(url => url !== null);
}

/**
 * 解析JavaScript对象字符串为实际对象
 * @param {string} jsObjectStr - JavaScript对象字符串
 * @returns {Object} - 解析后的对象
 */
function parseJSObject(jsObjectStr) {
    try {
        // 简单的JavaScript对象解析（处理不带引号的键名）
        const jsonStr = jsObjectStr
            .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":') // 给键名加引号
            .replace(/:\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*([,}])/g, ':"$1"$2') // 给字符串值加引号
            .replace(/:\s*(\d+)\s*([,}])/g, ':$1$2'); // 保持数字不变

        return JSON.parse(jsonStr);
    } catch (error) {
        console.error('解析JavaScript对象失败:', error);
        // 如果JSON.parse失败，尝试eval（不安全，仅用于已知安全的数据）
        try {
            return eval('(' + jsObjectStr + ')');
        } catch (evalError) {
            console.error('eval解析也失败:', evalError);
            throw new Error('无法解析JavaScript对象: ' + jsObjectStr);
        }
    }
}

/**
 * 解密CDATA的主函数
 * @param {string} cdata - 需要解密的CDATA字符串（Base64编码）
 * @param {string} key - 解密密钥，默认使用 '8enRS43hvFwocD7T'
 * @returns {string} - 解密后的UTF-8字符串
 */
function decryptCDATA(cdata, key = '8enRS43hvFwocD7T') {
    try {
        // 解析Base64编码的CDATA，并直接转换为字符串
        const parsedDataString = devtools.jsc.enc.Base64.parse(cdata).toString(devtools.jsc.enc.Utf8);

        // 使用密钥解密数据字符串
        const result = devtools.jsd(key, parsedDataString);

        return result;
    } catch (error) {
        console.error('CDATA解密过程中发生错误:', error);
        throw error;
    }
}

/**
 * 模拟浏览器环境中的调用
 * 等同于: window.devtools.jsd('8enRS43hvFwocD7T',window.devtools.jsc.enc.Base64.parse(window.C_DATA).toString(window.devtools.jsc.enc.Utf8))
 * @param {string} cdata - window.C_DATA的值
 * @returns {string} - 解密后的字符串
 */
function simulateBrowserDecrypt(cdata) {
    return decryptCDATA(cdata, '8enRS43hvFwocD7T');
}

/**
 * 批量解密多个CDATA
 * @param {Array<string>} cdataArray - CDATA数组
 * @param {string} key - 解密密钥
 * @returns {Array<string>} - 解密后的字符串数组
 */
function batchDecryptCDATA(cdataArray, key = '8enRS43hvFwocD7T') {
    return cdataArray.map((cdata, index) => {
        try {
            return decryptCDATA(cdata, key);
        } catch (error) {
            console.error(`第${index + 1}个CDATA解密失败:`, error);
            return null;
        }
    }).filter(result => result !== null);
}

/**
 * 解密 webp 文件的 ArrayBuffer
 * 使用 AES-CBC 模式解密，参考浏览器中的解密代码
 * @param {string} filePath - webp 文件路径
 * @param {string} key - 解密密钥，默认使用 'VvQpoFwZC1UnfO0B'
 * @param {string} outputPath - 输出文件路径，可选
 * @returns {Buffer} - 解密后的数据
 */
function decryptWebpFile(filePath, key = 'VvQpoFwZC1UnfO0B', outputPath = null) {
    try {
        console.log(`开始解密文件: ${filePath}`);
        console.log(`使用密钥: ${key}`);

        // 读取文件为 Buffer
        const fileBuffer = fs.readFileSync(filePath);
        console.log(`文件大小: ${fileBuffer.length} bytes`);

        // 将文件内容转换为 CryptoJS WordArray
        const wordArray = CryptoJS.lib.WordArray.create(fileBuffer);

        // 将 WordArray 转换为 Base64 字符串作为加密数据
        const base64Data = CryptoJS.enc.Base64.stringify(wordArray);

        // 使用 CryptoJS 进行 AES-CBC 解密
        // 参考代码: window.CryptoJS.AES.decrypt(_0x1d85d5, key, {
        //   'iv': window.CryptoJS.enc.Utf8.parse("0000000000000000"),
        //   'mode': window.CryptoJS.mode.CBC,
        //   'padding': window.CryptoJS.pad.Pkcs7
        // });
        const decrypted = CryptoJS.AES.decrypt(base64Data, key, {
            'iv': CryptoJS.enc.Utf8.parse("0000000000000000"),
            'mode': CryptoJS.mode.CBC,
            'padding': CryptoJS.pad.Pkcs7
        });

        // 将解密结果转换为字节数组
        const decryptedWordArray = decrypted;
        const decryptedBytes = [];

        // 从 WordArray 中提取字节
        for (let i = 0; i < decryptedWordArray.words.length; i++) {
            const word = decryptedWordArray.words[i];
            decryptedBytes.push((word >> 24) & 0xff);
            decryptedBytes.push((word >> 16) & 0xff);
            decryptedBytes.push((word >> 8) & 0xff);
            decryptedBytes.push(word & 0xff);
        }

        // 根据实际长度截取字节数组
        const actualLength = decryptedWordArray.sigBytes;
        const trimmedBytes = decryptedBytes.slice(0, actualLength);

        // 转换为 Buffer
        const decryptedBuffer = Buffer.from(trimmedBytes);

        console.log(`解密后数据大小: ${decryptedBuffer.length} bytes`);

        // 如果指定了输出路径，保存解密后的文件
        if (outputPath) {
            fs.writeFileSync(outputPath, decryptedBuffer);
            console.log(`解密后的文件已保存到: ${outputPath}`);
        }

        return decryptedBuffer;

    } catch (error) {
        console.error('解密 webp 文件失败:', error);
        throw error;
    }
}

/**
 * 使用 Node.js crypto 模块解密 webp 文件
 * @param {string} filePath - webp 文件路径
 * @param {string} key - 解密密钥，默认使用 'VvQpoFwZC1UnfO0B'
 * @param {string} outputPath - 输出文件路径，可选
 * @returns {Buffer} - 解密后的数据
 */
function decryptWebpFileWithNodeCrypto(filePath, key = 'VvQpoFwZC1UnfO0B', outputPath = null) {
    try {
        console.log(`开始解密文件 (Node.js crypto): ${filePath}`);
        console.log(`使用密钥: ${key}`);

        // 读取文件为 Buffer
        const fileBuffer = fs.readFileSync(filePath);
        console.log(`文件大小: ${fileBuffer.length} bytes`);

        // 设置 IV（初始化向量）- 16字节的零
        const iv = Buffer.alloc(16, 0);

        // 确保密钥长度正确（16字节用于AES-128）
        const keyBuffer = Buffer.from(key, 'utf8').slice(0, 16);
        if (keyBuffer.length < 16) {
            // 如果密钥不足16字节，用零填充
            const paddedKey = Buffer.alloc(16, 0);
            keyBuffer.copy(paddedKey);
            keyBuffer = paddedKey;
        }

        console.log(`密钥长度: ${keyBuffer.length} bytes`);
        console.log(`IV长度: ${iv.length} bytes`);

        // 创建解密器
        const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuffer, iv);
        decipher.setAutoPadding(false); // 手动处理 padding

        // 执行解密
        let decrypted = decipher.update(fileBuffer);
        const final = decipher.final();
        decrypted = Buffer.concat([decrypted, final]);

        // 手动移除 PKCS7 padding
        if (decrypted.length > 0) {
            const paddingLength = decrypted[decrypted.length - 1];
            if (paddingLength > 0 && paddingLength <= 16) {
                // 验证 padding 是否有效
                let validPadding = true;
                for (let i = 1; i <= paddingLength; i++) {
                    if (decrypted[decrypted.length - i] !== paddingLength) {
                        validPadding = false;
                        break;
                    }
                }
                if (validPadding) {
                    decrypted = decrypted.slice(0, decrypted.length - paddingLength);
                }
            }
        }

        console.log(`解密后数据大小: ${decrypted.length} bytes`);

        // 如果指定了输出路径，保存解密后的文件
        if (outputPath) {
            fs.writeFileSync(outputPath, decrypted);
            console.log(`解密后的文件已保存到: ${outputPath}`);
        }

        return decrypted;

    } catch (error) {
        console.error('解密 webp 文件失败 (Node.js crypto):', error);
        throw error;
    }
}

/**
 * 尝试将文件内容作为 Base64 字符串解密
 * @param {string} filePath - webp 文件路径
 * @param {string} key - 解密密钥，默认使用 'VvQpoFwZC1UnfO0B'
 * @param {string} outputPath - 输出文件路径，可选
 * @returns {Buffer} - 解密后的数据
 */
function decryptWebpFileAsBase64(filePath, key = 'VvQpoFwZC1UnfO0B', outputPath = null) {
    try {
        console.log(`开始解密文件 (作为Base64): ${filePath}`);
        console.log(`使用密钥: ${key}`);

        // 读取文件内容作为字符串
        const fileContent = fs.readFileSync(filePath, 'utf8');
        console.log(`文件内容长度: ${fileContent.length} 字符`);

        // 使用 CryptoJS 进行 AES-CBC 解密
        const decrypted = CryptoJS.AES.decrypt(fileContent, key, {
            'iv': CryptoJS.enc.Utf8.parse("0000000000000000"),
            'mode': CryptoJS.mode.CBC,
            'padding': CryptoJS.pad.Pkcs7
        });

        // 将解密结果转换为 Buffer
        const decryptedBuffer = Buffer.from(decrypted.toString(CryptoJS.enc.Base64), 'base64');

        console.log(`解密后数据大小: ${decryptedBuffer.length} bytes`);

        // 如果指定了输出路径，保存解密后的文件
        if (outputPath) {
            fs.writeFileSync(outputPath, decryptedBuffer);
            console.log(`解密后的文件已保存到: ${outputPath}`);
        }

        return decryptedBuffer;

    } catch (error) {
        console.error('解密 webp 文件失败 (作为Base64):', error);
        throw error;
    }
}

// 导出函数供其他模块使用
module.exports = {
    decryptCDATA,
    simulateBrowserDecrypt,
    batchDecryptCDATA,
    parseFullMangaData,
    generateImageInfo,
    getImageUrl,
    getTotalPage,
    batchGetImageUrls,
    parseJSObject,
    devtools,
    decryptWebpFile,
    decryptWebpFileWithNodeCrypto,
    decryptWebpFileAsBase64
};

// 如果直接运行此文件，提供测试示例
if (require.main === module) {
    const testCDATA = "MXZlSHlDbFlCQnpxYllSSGJ0UU83OWMrUjdCVmg0TEppU0haa0RUdmNKalp1Mzc0VFpVa29xUzhXYjZEZkRXT3JwSFRiUENOUE0zeFpwbGRSUXJ2eG1Dckxmck9QcER5YndlNVg2clhEaTNrVHdqU21vODdnaUtlb2srcGszaGNsQVRaZmZ3LzF4ekhnclZWMDVrbDRENEEyYzBMNGNDSGlmMmpvMEZpZjg0R0xWVEt3dEE2WXFvRDV5ZURuV09IWTcwQ2xMTHdlUElROWUwZk1hbUpxYVNhaENmVU9MbEk2ZGZ3RFNJTHJtMHQ2U3NEY1dqRDVaWTBubVVUSHUzalB1OHFQL2FMWk9HeFJnT2JMNUErdDc5a095dE9TUHllYVQ4Q0lHdEZibWx3Tmd0TFJiMXRnRUI4M3ZmWUkzUno1N0JPV3kyRFhheE4zcWxHZS8yK2QzdG1lMi9YYy9SamlGdlFxRk1BZks1aE5WTE90VlZ4Rm9CQmx2R3dHOVpqNWxjZ1lHdWw5cTRuZy9rSHpMdHVwSG5hdXVpd0JOUkZ3ay9EaW5hTEhub09WaVFKMWc1U0NnazVQcG1UREl4TFhPbnloZkw5RENzTFJsSHIxNmU5VnZ3QVNiWjdidFc5R1pVVWNzQmsvT2h4NzFQZy95dzI0dWpiVlpSMGhVd293K2FLek1RVzJjNVMxSzAxSGc0NHRueU85QkNXV3o3S1RBZC9BL0xWV08rZWlzUjRqYlk1Y3BMTStCRDdoUk5DSFVCUC9ZSU9SdURPaWUwaUZqS2NUZG92Q3Vyc3BreTJpUjRHWWwyZVFWbi9FU2U0N2U2Y1hlWDBnV043dVYrV2tBd2NtYUZranNRckZ6TlIzRXU5Y2lFcXh5VmZjZDR0N1lSc0wydEdLYU1GLzJvbzYwejlISFJUVmNWa2NyUkg=";

    // console.log('=== 基础解密测试 ===');
    // const result = decryptCDATA(testCDATA);
    // console.log('解密结果:');
    // console.log(result);
    // console.log('\n');

    console.log('=== 完整数据解析测试 ===');
    try {
        const fullData = parseFullMangaData(testCDATA, 'w57pVEV5N9vENbQ2');
        console.log('解析的mh_info:');
        console.log(JSON.stringify(fullData.mh_info, null, 2));
        // console.log('\n解析的image_info:');
        // console.log(JSON.stringify(fullData.image_info, null, 2));

        console.log('\n=== 生成image_info测试（使用jse函数）===');
        try {
            const generatedImageInfo = generateImageInfo(fullData.mh_info);
            console.log('通过jse函数生成的image_info:');
            console.log(JSON.stringify(generatedImageInfo, null, 2));
        } catch (jseError) {
            console.error('jse函数生成失败:', jseError.message);
        }

        const encodeKey1 = 'aGzU9QOeLVaK3rnL';
        const encodeKey2 = 'TJloldeXW7EJOfrd'

        console.log('\n=== URL获取测试 ===');
        // 测试新的URL获取功能
        try {
            const imageUrl = getImageUrl(fullData.mh_info, encodeKey1);
            console.log('使用URL密钥解密的图片URL:');
            console.log(imageUrl);
        } catch (urlError) {
            console.error('URL获取失败:', urlError.message);
        }

        console.log('\n=== 总页数获取测试 ===');
        // 测试新的总页数获取功能
        try {
            let totalPage = getTotalPage(fullData.mh_info, encodeKey1);
            if (!totalPage) {
                // 如果第一个密钥失败，尝试第二个密钥
                totalPage = getTotalPage(fullData.mh_info, encodeKey2);
            }
            console.log('使用密钥解密的总页数:');
            console.log(totalPage);
        } catch (pageError) {
            console.error('总页数获取失败:', pageError.message);
        }


    } catch (error) {
        console.error('完整数据解析失败:', error.message);
    }

    console.log('\n=== WebP 文件解密测试 ===');
    // 测试 webp 文件解密功能
    try {
        const webpFilePath = '/Users/likaixuan/Downloads/1.webp';
        const outputPath = '/Users/likaixuan/Downloads/1_decrypted.webp';

        // 检查文件是否存在
        if (fs.existsSync(webpFilePath)) {
            console.log(`找到文件: ${webpFilePath}`);
            const decryptedBuffer = decryptWebpFile(webpFilePath, '8enRS43hvFwocD7T', outputPath);
            console.log('WebP 文件解密成功！');
            // 保存
            fs.writeFileSync(outputPath, decryptedBuffer);
        } else {
            console.log(`文件不存在: ${webpFilePath}`);
        }
    } catch (webpError) {
        console.error('WebP 文件解密失败:', webpError.message);
    }
}
