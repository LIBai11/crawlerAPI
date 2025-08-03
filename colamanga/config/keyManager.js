const fs = require('fs-extra');
const path = require('path');

/**
 * 密钥管理器 - 集中管理所有解密密钥
 * 支持密钥轮换和失败重试机制
 */
class KeyManager {
    constructor(configPath = null) {
        this.configPath = configPath || path.join(__dirname, 'config.json');
        this.config = null;
        this.loadConfig();
    }

    /**
     * 加载配置文件
     */
    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                this.config = fs.readJsonSync(this.configPath);
                console.log(`✅ 配置文件加载成功: ${this.configPath}`);
            } else {
                throw new Error(`配置文件不存在: ${this.configPath}`);
            }
        } catch (error) {
            console.error(`❌ 配置文件加载失败: ${error.message}`);
            // 使用默认配置
            this.config = this.getDefaultConfig();
            console.log('🔄 使用默认配置');
        }
    }

    /**
     * 获取默认配置
     */
    getDefaultConfig() {
        return {
            paths: {
                mangaIdsFile: '/Users/likaixuan/Documents/manga/manga-ids.json',
                outputFile: '/Users/likaixuan/Documents/manga/manga-chapter-total-pages.json'
            },
            keys: {
                cdataKey: 'w57pVEV5N9vENbQ2',
                encryptionKeys: [
                    'aGzU9QOeLVaK3rnL',
                    'TJloldeXW7EJOfrd', 
                    'ijABEbPmMwut0nmD',
                    'ZsfOA40m7kWjodMH',
                    'gym9zc8DLpZYvPQT',
                    'VvQpoFwZC1UnfO0B',
                    '8enRS43hvFwocD7T'
                ]
            },
            settings: {
                concurrency: 15,
                saveInterval: 100,
                timeout: 30000
            }
        };
    }

    /**
     * 获取CDATA解密密钥
     */
    getCdataKey() {
        return this.config.keys.cdataKey;
    }

    /**
     * 获取所有加密密钥
     */
    getEncryptionKeys() {
        return [...this.config.keys.encryptionKeys];
    }

    /**
     * 获取文件路径配置
     */
    getPaths() {
        return { ...this.config.paths };
    }

    /**
     * 获取设置配置
     */
    getSettings() {
        return { ...this.config.settings };
    }

    /**
     * 尝试使用多个密钥解密，直到成功或全部失败
     * @param {Function} decryptFunction - 解密函数，接受密钥作为参数
     * @param {Array} customKeys - 自定义密钥列表，如果不提供则使用配置中的密钥
     * @param {Object} context - 上下文信息，用于日志记录
     * @returns {*} 解密结果
     */
    async tryDecryptWithKeys(decryptFunction, customKeys = null, context = {}) {
        const keys = customKeys || this.getEncryptionKeys();
        const contextStr = context.mangaId && context.chapter ? 
            `漫画${context.mangaId}-章节${context.chapter}` : 
            (context.description || '数据');

        let lastError = null;

        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            try {
                console.log(`🔑 [${contextStr}] 尝试密钥 ${i + 1}/${keys.length}: ${key.substring(0, 4)}...`);
                
                const result = await decryptFunction(key);
                
                // 验证解密结果
                if (this.isValidDecryptResult(result, context)) {
                    console.log(`✅ [${contextStr}] 密钥 ${i + 1} 解密成功`);
                    return result;
                }
                
                console.log(`⚠️ [${contextStr}] 密钥 ${i + 1} 解密结果无效，尝试下一个`);
            } catch (error) {
                lastError = error;
                console.log(`❌ [${contextStr}] 密钥 ${i + 1} 解密失败: ${error.message}`);
                continue;
            }
        }

        // 所有密钥都失败了
        const errorMsg = `所有 ${keys.length} 个密钥都无法解密 ${contextStr}`;
        console.error(`💥 ${errorMsg}`);
        if (lastError) {
            console.error(`最后一个错误: ${lastError.message}`);
        }
        throw new Error(errorMsg);
    }

    /**
     * 验证解密结果是否有效
     * @param {*} result - 解密结果
     * @param {Object} context - 上下文信息
     * @returns {boolean} 是否有效
     */
    isValidDecryptResult(result, context = {}) {
        if (!result) {
            return false;
        }

        // 如果是字符串类型的结果
        if (typeof result === 'string') {
            const trimmed = result.trim();
            
            // 检查是否为空或失败标识
            if (!trimmed || trimmed === 'fail' || trimmed === 'error') {
                return false;
            }

            // 如果上下文表明这是页数，检查是否为有效数字
            if (context.type === 'totalPage') {
                const pageNum = parseInt(trimmed);
                return !isNaN(pageNum) && pageNum > 0;
            }

            // 如果上下文表明这是URL，检查基本格式
            if (context.type === 'imageUrl') {
                return trimmed.includes('/') || trimmed.includes('http');
            }

            // 默认情况下，非空字符串视为有效
            return true;
        }

        // 如果是数字类型
        if (typeof result === 'number') {
            return !isNaN(result) && result > 0;
        }

        // 如果是对象类型
        if (typeof result === 'object') {
            return result !== null;
        }

        // 其他类型默认有效
        return true;
    }

    /**
     * 重新加载配置文件
     */
    reloadConfig() {
        console.log('🔄 重新加载配置文件...');
        this.loadConfig();
    }

    /**
     * 更新配置文件
     * @param {Object} newConfig - 新的配置对象
     */
    updateConfig(newConfig) {
        try {
            this.config = { ...this.config, ...newConfig };
            fs.writeJsonSync(this.configPath, this.config, { spaces: 2 });
            console.log(`✅ 配置文件更新成功: ${this.configPath}`);
        } catch (error) {
            console.error(`❌ 配置文件更新失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 添加新的加密密钥
     * @param {string} key - 新密钥
     */
    addEncryptionKey(key) {
        if (!this.config.keys.encryptionKeys.includes(key)) {
            this.config.keys.encryptionKeys.push(key);
            this.updateConfig(this.config);
            console.log(`✅ 新密钥已添加: ${key.substring(0, 4)}...`);
        } else {
            console.log(`⚠️ 密钥已存在: ${key.substring(0, 4)}...`);
        }
    }

    /**
     * 移除加密密钥
     * @param {string} key - 要移除的密钥
     */
    removeEncryptionKey(key) {
        const index = this.config.keys.encryptionKeys.indexOf(key);
        if (index > -1) {
            this.config.keys.encryptionKeys.splice(index, 1);
            this.updateConfig(this.config);
            console.log(`✅ 密钥已移除: ${key.substring(0, 4)}...`);
        } else {
            console.log(`⚠️ 密钥不存在: ${key.substring(0, 4)}...`);
        }
    }

    /**
     * 获取密钥统计信息
     */
    getKeyStats() {
        return {
            cdataKey: this.config.keys.cdataKey,
            encryptionKeysCount: this.config.keys.encryptionKeys.length,
            encryptionKeys: this.config.keys.encryptionKeys.map(key => `${key.substring(0, 4)}...`),
            configPath: this.configPath
        };
    }
}

module.exports = KeyManager;
