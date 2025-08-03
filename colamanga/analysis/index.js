const CryptoJS = require('crypto-js');

function aesDecrypt(encData, key) {
    const parsedKey = CryptoJS.enc.Utf8.parse(key);
    const decrypted = CryptoJS.AES.decrypt(encData, parsedKey, {
        mode: CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7
    });
    return CryptoJS.enc.Utf8.stringify(decrypted);
}

function parseBase64(encodedStr) {
    return CryptoJS.enc.Base64.parse(encodedStr);
}

function decryptProcess(encCode1, encCode2, pageId, mhId) {
    const key1 = "ZsfOA40m7kWjodMH";

    const parsedEncCode2 = parseBase64(encCode2).toString(CryptoJS.enc.Utf8);
    const parsedEncCode1 = parseBase64(encCode1).toString(CryptoJS.enc.Utf8);

    let decryptedEncCode2;
    try {
        decryptedEncCode2 = aesDecrypt(parsedEncCode2, key1);
        
        if (!decryptedEncCode2 || !decryptedEncCode2.startsWith(`${mhId}/`)) {
            decryptedEncCode2 = aesDecrypt(parsedEncCode2, key2);
        }
        console.log(aesDecrypt(parsedEncCode1, key1));
    } catch (e) {
        decryptedEncCode2 = aesDecrypt(parsedEncCode2, key2);
    }

    return {
        cookie: { key: `_tkb_${pageId}`, value: decryptedEncCode2 },
    };
}

// 测试数据
const mh_info = {
    "startimg": 1,
    "enc_code1": "cDJSdkkyUFUzbVZrUXZ1S213TFBuQT09",
    "mhid": "873947",
    "enc_code2": "Q1FrNTVrRGZHZjhQM3dEdkg0cU4vYnVmTU9RWjBWdzMzYmhYSlpyKzM0QjN3cmxFSTdYV1VVWUlXRkNMVHhhNw==",
    "mhname": "捉刀人",
    "pageid": 7557687,
    "pagename": "56",
    "pageurl": "1/57.html",
    "readmode": 3,
    "maxpreload": 10,
    "defaultminline": 1,
    "domain": "img.colamanga.com",
    "manga_size": "",
    "default_price": 0,
    "price": 0,
    "use_server": "",
    "webPath": "/manga-mf874127/"
};

const result = decryptProcess(mh_info.enc_code1, mh_info.enc_code2, mh_info.pageid, mh_info.mhid);
console.log(result);