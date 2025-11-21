export default {
    async fetch(request, env) {
        // ============================================================
        // 1. 变量初始化 (解决并发污染)
        // ============================================================
        const mytoken = env.TOKEN || 'habalv123';
        const BotToken = env.TGTOKEN || '';
        const ChatID = env.TGID || '';
        const TG = env.TG || 0; 
        const FileName = env.SUBNAME || 'CF-Workers-SUB';
        const SUBUpdateTime = env.SUBUPTIME || 6; 
        
        let total = 99; 
        // 过期时间设定 (默认 2099-12-31)
        let timestamp = 4102329600000; 
        
        let MainData = env.LINK || `https://cfxr.eu.org/getSub`;
        let urls = [];

        // 订阅转换后端配置 (适配 JustDoIt166/sublink-worker)
        let subConverter = env.SUBAPI || "sublink-worker.pages.dev"; 
        let subProtocol = 'https';
        let subConfig = env.SUBCONFIG || "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini";
        
        // 处理 subConverter 协议
        if (subConverter.includes("http://")) {
            subConverter = subConverter.split("//")[1];
            subProtocol = 'http';
        } else {
            subConverter = subConverter.split("//")[1] || subConverter;
        }

        // 获取请求信息
        const userAgentHeader = request.headers.get('User-Agent');
        const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
        const url = new URL(request.url);
        const token = url.searchParams.get('token');

        // 生成验证 Token
        const currentDate = new Date();
        currentDate.setHours(0, 0, 0, 0);
        const timeTemp = Math.ceil(currentDate.getTime() / 1000);
        const fakeToken = await MD5MD5(`${mytoken}${timeTemp}`);
        
        let guestToken = env.GUESTTOKEN || env.GUEST || '';
        if (!guestToken) guestToken = await MD5MD5(mytoken);
        const 访客订阅 = guestToken;

        // 计算剩余流量 (用于 UI 显示)
        let UD = Math.floor(((timestamp - Date.now()) / timestamp * total * 1099511627776) / 2);
        total = total * 1099511627776;

        // ============================================================
        // 逻辑处理
        // ============================================================

        // 鉴权与访问控制
        if (!([mytoken, fakeToken, 访客订阅].includes(token) || url.pathname == ("/" + mytoken) || url.pathname.includes("/" + mytoken + "?"))) {
            if (TG == 1 && url.pathname !== "/" && url.pathname !== "/favicon.ico") {
                await sendMessage(`#异常访问 ${FileName}`, request, env, `UA: ${userAgent}\n域名: ${url.hostname}\n入口: ${url.pathname + url.search}`);
            }
            
            if (env.URL302) return Response.redirect(env.URL302, 302);
            else if (env.URL) return await proxyURL(env.URL, url);
            else return new Response(await nginx(), {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=UTF-8' },
            });
        } 
        
        // 鉴权成功
        else {
            if (env.KV) {
                await 迁移地址列表(env, 'LINK.txt');
                // 如果是浏览器直接访问且没有查询参数，显示管理面板
                if (userAgent.includes('mozilla') && !url.search) {
                    await sendMessage(`#编辑订阅 ${FileName}`, request, env, `UA: ${userAgentHeader}\n域名: ${url.hostname}\n入口: ${url.pathname + url.search}`);
                    // 传入流量数据给 UI
                    return await KV(request, env, 'LINK.txt', 访客订阅, FileName, mytoken, UD, total, timestamp);
                } else {
                    MainData = await env.KV.get('LINK.txt') || MainData;
                }
            } else {
                if (env.LINKSUB) urls = await ADD(env.LINKSUB);
            }

            // 汇总链接
            let 重新汇总所有链接 = await ADD(MainData + '\n' + urls.join('\n'));
            let 自建节点 = "";
            let 订阅链接 = "";
            for (let x of 重新汇总所有链接) {
                if (x.toLowerCase().startsWith('http')) {
                    订阅链接 += x + '\n';
                } else {
                    自建节点 += x + '\n';
                }
            }
            MainData = 自建节点;
            urls = await ADD(订阅链接);

            await sendMessage(`#获取订阅 ${FileName}`, request, env, `UA: ${userAgentHeader}\n域名: ${url.hostname}\n入口: ${url.pathname + url.search}`);

            // 识别客户端类型
            const isSubConverterRequest = request.headers.get('subconverter-request') || request.headers.get('subconverter-version') || userAgent.includes('subconverter');
            let 订阅格式 = 'base64';
            if (!(userAgent.includes('null') || isSubConverterRequest || userAgent.includes('nekobox') || userAgent.includes(('CF-Workers-SUB').toLowerCase()))) {
                if (userAgent.includes('sing-box') || userAgent.includes('singbox') || url.searchParams.has('sb') || url.searchParams.has('singbox')) {
                    订阅格式 = 'singbox';
                } else if (userAgent.includes('surge') || url.searchParams.has('surge')) {
                    订阅格式 = 'surge';
                } else if (userAgent.includes('quantumult') || url.searchParams.has('quanx')) {
                    订阅格式 = 'quanx';
                } else if (userAgent.includes('loon') || url.searchParams.has('loon')) {
                    订阅格式 = 'loon';
                } else if (userAgent.includes('clash') || userAgent.includes('meta') || userAgent.includes('mihomo') || url.searchParams.has('clash')) {
                    订阅格式 = 'clash';
                }
            }

            let subConverterUrl;
            let 订阅转换URL = `${url.origin}/${await MD5MD5(fakeToken)}?token=${fakeToken}`;
            let req_data = MainData;

            let 追加UA = 'v2rayn';
            if (url.searchParams.has('b64') || url.searchParams.has('base64')) 订阅格式 = 'base64';
            else if (url.searchParams.has('clash')) 追加UA = 'clash';
            else if (url.searchParams.has('singbox')) 追加UA = 'singbox';
            else if (url.searchParams.has('surge')) 追加UA = 'surge';
            else if (url.searchParams.has('quanx')) 追加UA = 'Quantumult%20X';
            else if (url.searchParams.has('loon')) 追加UA = 'Loon';

            // 获取外部订阅内容
            const 订阅链接数组 = [...new Set(urls)].filter(item => item?.trim?.());
            if (订阅链接数组.length > 0) {
                const 请求订阅响应内容 = await getSUB(订阅链接数组, request, 追加UA, userAgentHeader);
                req_data += 请求订阅响应内容[0].join('\n');
                订阅转换URL += "|" + 请求订阅响应内容[1];

                // 针对 sublink-worker 的 Base64 混合处理
                if (订阅格式 == 'base64' && !isSubConverterRequest && 请求订阅响应内容[1].includes('://')) {
                    subConverterUrl = `${subProtocol}://${subConverter}/?target=mixed&url=${encodeURIComponent(请求订阅响应内容[1])}&config=${encodeURIComponent(subConfig)}`;
                    try {
                        const subConverterResponse = await fetch(subConverterUrl, { headers: { 'User-Agent': 'v2rayN/CF-Workers-SUB' } });
                        if (subConverterResponse.ok) {
                            const subConverterContent = await subConverterResponse.text();
                            try {
                                req_data += '\n' + atob(subConverterContent);
                            } catch {
                                req_data += '\n' + subConverterContent;
                            }
                        }
                    } catch (error) {
                        console.error('订阅转换 Base64 失败:', error);
                    }
                }
            }

            if (env.WARP) 订阅转换URL += "|" + (await ADD(env.WARP)).join("|");
            
            // 去重
            const uniqueLines = new Set(req_data.split('\n'));
            const result = [...uniqueLines].join('\n');

            // 生成 Base64 数据
            let base64Data;
            try {
                base64Data = btoa(encodeURIComponent(result).replace(/%([0-9A-F]{2})/g,
                    function toSolidBytes(match, p1) {
                        return String.fromCharCode('0x' + p1);
                    }));
            } catch (e) {
                console.error("Base64 encoding failed", e);
                base64Data = "";
            }

            // 构建响应头
            const responseHeaders = {
                "content-type": "text/plain; charset=utf-8",
                "Profile-Update-Interval": `${SUBUpdateTime}`,
                "Profile-web-page-url": request.url.includes('?') ? request.url.split('?')[0] : request.url,
                "Subscription-Userinfo": `upload=${UD}; download=${UD}; total=${total}; expire=${timestamp}`,
            };

            if (订阅格式 == 'base64' || token == fakeToken) {
                return new Response(base64Data, { headers: responseHeaders });
            } 
            
            // 构建订阅转换链接 (适配 sublink-worker 根路径 /?target=...)
            const targetMapping = {
                'clash': 'clash',
                'singbox': 'singbox',
                'surge': 'surge',
                'quanx': 'quanx',
                'loon': 'loon'
            };
            
            if (targetMapping[订阅格式]) {
                const target = targetMapping[订阅格式];
                subConverterUrl = `${subProtocol}://${subConverter}/?target=${target}&url=${encodeURIComponent(订阅转换URL)}&config=${encodeURIComponent(subConfig)}`;
            }

            try {
                const subConverterResponse = await fetch(subConverterUrl, { headers: { 'User-Agent': userAgentHeader } });
                if (!subConverterResponse.ok) return new Response(base64Data, { headers: responseHeaders });
                let subConverterContent = await subConverterResponse.text();
                if (订阅格式 == 'clash') subConverterContent = await clashFix(subConverterContent);
                if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(FileName)}`;
                return new Response(subConverterContent, { headers: responseHeaders });
            } catch (error) {
                return new Response(base64Data, { headers: responseHeaders });
            }
        }
    }
};

// ============================================================
// 辅助函数
// ============================================================

async function ADD(envadd) {
    var addtext = envadd.replace(/[ "'|\r\n]+/g, '\n').replace(/\n+/g, '\n');
    if (addtext.charAt(0) == '\n') addtext = addtext.slice(1);
    if (addtext.charAt(addtext.length - 1) == '\n') addtext = addtext.slice(0, addtext.length - 1);
    return addtext.split('\n');
}

async function nginx() {
    const text = `
    <!DOCTYPE html>
    <html>
    <head>
    <title>Welcome to nginx!</title>
    <style>
        body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
    </style>
    </head>
    <body>
    <h1>Welcome to nginx!</h1>
    <p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p>
    <p>For online documentation and support please refer to <a href="http://nginx.org/">nginx.org</a>.<br/>Commercial support is available at <a href="http://nginx.com/">nginx.com</a>.</p>
    <p><em>Thank you for using nginx.</em></p>
    </body>
    </html>
    `
    return text;
}

async function sendMessage(type, request, env, add_data = "") {
    const BotToken = env.TGTOKEN;
    const ChatID = env.TGID;
    if (BotToken && ChatID) {
        const ip = request.headers.get('CF-Connecting-IP');
        const country = request.cf?.country || 'Unknown';
        const city = request.cf?.city || 'Unknown';
        const org = request.cf?.asOrganization || 'Unknown';
        const asn = request.cf?.asn || '';
        
        let msg = `${type}\nIP: ${ip}\n国家: ${country}\n<tg-spoiler>城市: ${city}\n组织: ${org} (AS${asn})\n${add_data}</tg-spoiler>`;

        let url = "https://api.telegram.org/bot" + BotToken + "/sendMessage?chat_id=" + ChatID + "&parse_mode=HTML&text=" + encodeURIComponent(msg);
        return fetch(url, {
            method: 'get',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;',
                'User-Agent': 'CF-Workers-SUB/Optimized'
            }
        });
    }
}

function base64Decode(str) {
    try {
        return decodeURIComponent(atob(str).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
    } catch(e) {
        return atob(str);
    }
}

async function MD5MD5(text) {
    const encoder = new TextEncoder();
    const firstPass = await crypto.subtle.digest('MD5', encoder.encode(text));
    const firstHex = Array.from(new Uint8Array(firstPass)).map(b => b.toString(16).padStart(2, '0')).join('');
    const secondPass = await crypto.subtle.digest('MD5', encoder.encode(firstHex.slice(7, 27)));
    const secondHex = Array.from(new Uint8Array(secondPass)).map(b => b.toString(16).padStart(2, '0')).join('');
    return secondHex.toLowerCase();
}

function clashFix(content) {
    if (content.includes('wireguard') && !content.includes('remote-dns-resolve')) {
        let lines = content.includes('\r\n') ? content.split('\r\n') : content.split('\n');
        let result = "";
        for (let line of lines) {
            if (line.includes('type: wireguard')) {
                const 备改内容 = `, mtu: 1280, udp: true`;
                const 正确内容 = `, mtu: 1280, remote-dns-resolve: true, udp: true`;
                result += line.replace(new RegExp(备改内容, 'g'), 正确内容) + '\n';
            } else {
                result += line + '\n';
            }
        }
        content = result;
    }
    return content;
}

async function proxyURL(proxyURL, url) {
    const URLs = await ADD(proxyURL);
    const fullURL = URLs[Math.floor(Math.random() * URLs.length)];
    let parsedURL = new URL(fullURL);
    let URLProtocol = parsedURL.protocol.slice(0, -1) || 'https';
    let URLHostname = parsedURL.hostname;
    let URLPathname = parsedURL.pathname;
    let URLSearch = parsedURL.search;

    if (URLPathname.charAt(URLPathname.length - 1) == '/') {
        URLPathname = URLPathname.slice(0, -1);
    }
    URLPathname += url.pathname;
    let newURL = `${URLProtocol}://${URLHostname}${URLPathname}${URLSearch}`;

    let response = await fetch(newURL);
    let newResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
    newResponse.headers.set('X-New-URL', newURL);
    return newResponse;
}

async function getSUB(api, request, 追加UA, userAgentHeader) {
    if (!api || api.length === 0) return [];
    let newapi = "";
    let 订阅转换URLs = "";
    let 异常订阅 = "";
    
    const controller = new AbortController(); 
    const timeout = setTimeout(() => {
        controller.abort(); 
    }, 5000); // 超时时间 5秒

    try {
        const responses = await Promise.allSettled(api.map(apiUrl => getUrl(request, apiUrl, 追加UA, userAgentHeader).then(response => response.ok ? response.text() : Promise.reject(response))));
        
        const modifiedResponses = responses.map((response, index) => {
            if (response.status === 'rejected') {
                return { status: '请求失败', value: null, apiUrl: api[index] };
            }
            return { status: response.status, value: response.value, apiUrl: api[index] };
        });

        for (const response of modifiedResponses) {
            if (response.status === 'fulfilled') {
                const content = await response.value || 'null';
                if (content.includes('proxies:')) {
                    订阅转换URLs += "|" + response.apiUrl; 
                } else if (content.includes('outbounds"') && content.includes('inbounds"')) {
                    订阅转换URLs += "|" + response.apiUrl; 
                } else if (content.includes('://')) {
                    newapi += content + '\n'; 
                } else if (isValidBase64(content)) {
                    newapi += base64Decode(content) + '\n'; 
                } else {
                    const 异常订阅LINK = `trojan://CMLiussss@127.0.0.1:8888?security=tls&allowInsecure=1&type=tcp&headerType=none#%E5%BC%82%E5%B8%B8%E8%AE%A2%E9%98%85%20${response.apiUrl.split('://')[1].split('/')[0]}`;
                    异常订阅 += `${异常订阅LINK}\n`;
                }
            }
        }
    } catch (error) {
        console.error(error);
    } finally {
        clearTimeout(timeout);
    }

    const 订阅内容 = await ADD(newapi + 异常订阅);
    return [订阅内容, 订阅转换URLs];
}

async function getUrl(request, targetUrl, 追加UA, userAgentHeader) {
    const newHeaders = new Headers(request.headers);
    newHeaders.set("User-Agent", `v2rayN/6.45 cmliu/CF-Workers-SUB ${追加UA}(${userAgentHeader})`);
    
    const modifiedRequest = new Request(targetUrl, {
        method: request.method,
        headers: newHeaders,
        body: request.method === "GET" ? null : request.body,
        redirect: "follow",
        cf: {
            insecureSkipVerify: true,
            allowUntrusted: true,
            validateCertificate: false
        }
    });
    return fetch(modifiedRequest);
}

function isValidBase64(str) {
    const cleanStr = str.replace(/\s/g, '');
    const base64Regex = /^[A-Za-z0-9+/=]+$/;
    return base64Regex.test(cleanStr);
}

async function 迁移地址列表(env, txt = 'ADD.txt') {
    const 旧数据 = await env.KV.get(`/${txt}`);
    const 新数据 = await env.KV.get(txt);
    if (旧数据 && !新数据) {
        await env.KV.put(txt, 旧数据);
        await env.KV.delete(`/${txt}`);
        return true;
    }
    return false;
}

async function KV(request, env, txt = 'ADD.txt', guest, FileName, mytoken, UD, total, expire) {
    const url = new URL(request.url);
    
    // 处理保存请求
    if (request.method === "POST") {
        try {
            const content = await request.text();
            await env.KV.put(txt, content);
            return new Response("保存成功");
        } catch (error) {
            return new Response("保存失败: " + error.message, { status: 500 });
        }
    }

    // 读取现有内容
    let content = await env.KV.get(txt) || '';
    
    // 获取相关配置用于展示
    const subProtocol = env.SUBAPI ? (env.SUBAPI.includes("http://") ? "http" : "https") : "https";
    let subConverter = env.SUBAPI ? (env.SUBAPI.split("//")[1] || env.SUBAPI) : "sublink-worker.pages.dev";
    const subConfig = env.SUBCONFIG || "Default Config";

    // 流量格式化
    const formatBytes = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };
    
    const usedData = formatBytes(UD);
    const totalData = formatBytes(total);
    const expireDate = new Date(expire).toLocaleDateString();
    const percent = total > 0 ? Math.min(100, ((UD / total) * 100)).toFixed(1) : 0;

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${FileName} 管理面板</title>
    <style>
        :root {
            --bg: #f3f4f6; --card-bg: #ffffff; --text-main: #111827; --text-sub: #6b7280;
            --primary: #4f46e5; --primary-hover: #4338ca; --border: #e5e7eb;
            --code-bg: #f9fafb; --success: #10b981;
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #111827; --card-bg: #1f2937; --text-main: #f9fafb; --text-sub: #9ca3af;
                --primary: #6366f1; --primary-hover: #818cf8; --border: #374151;
                --code-bg: #111827;
            }
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: var(--bg); color: var(--text-main); line-height: 1.5; padding: 20px; transition: background 0.3s, color 0.3s; }
        .container { max-width: 800px; margin: 0 auto; }
        
        /* Header */
        .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
        .header h1 { font-size: 1.5rem; font-weight: 700; color: var(--text-main); }
        .badge { font-size: 0.75rem; background: var(--primary); color: white; padding: 2px 8px; border-radius: 6px; font-weight: 500; }

        /* Cards */
        .card { background: var(--card-bg); border-radius: 16px; box-shadow: 0 1px 3px 0 rgba(0,0,0,0.1); padding: 24px; margin-bottom: 20px; border: 1px solid var(--border); }
        .card-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
        
        /* Stats */
        .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 16px; }
        .stat-item { text-align: center; padding: 12px; background: var(--code-bg); border-radius: 8px; }
        .stat-label { font-size: 0.8rem; color: var(--text-sub); margin-bottom: 4px; }
        .stat-value { font-weight: 600; font-size: 1rem; }
        .progress-bar { height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; margin-top: 8px; }
        .progress-fill { height: 100%; background: var(--primary); width: ${percent}%; transition: width 0.5s ease; }

        /* Links Grid */
        .links-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
        .link-btn { 
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            background: var(--code-bg); border: 1px solid var(--border); border-radius: 12px;
            padding: 16px; cursor: pointer; transition: all 0.2s; text-align: center; text-decoration: none; color: var(--text-main);
            height: 100px;
        }
        .link-btn:hover { border-color: var(--primary); background: var(--card-bg); transform: translateY(-2px); box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        .link-icon { width: 32px; height: 32px; margin-bottom: 8px; }
        .link-name { font-size: 0.9rem; font-weight: 500; }

        /* Text Area */
        .editor-wrapper { position: relative; }
        textarea { width: 100%; height: 200px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace; font-size: 14px; background: var(--code-bg); color: var(--text-main); resize: vertical; outline: none; transition: border 0.2s; }
        textarea:focus { border-color: var(--primary); ring: 2px solid var(--primary); }

        /* Actions */
        .action-bar { display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px; }
        .btn { padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; border: none; transition: opacity 0.2s; font-size: 0.95rem; display: flex; align-items: center; gap: 6px; }
        .btn-primary { background: var(--primary); color: white; }
        .btn-primary:hover { background: var(--primary-hover); }
        .btn-secondary { background: var(--code-bg); color: var(--text-main); border: 1px solid var(--border); }

        /* Toast */
        .toast-container { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 1000; }
        .toast { background: rgba(0,0,0,0.8); color: white; padding: 10px 20px; border-radius: 50px; margin-top: 10px; opacity: 0; transition: opacity 0.3s; font-size: 0.9rem; backdrop-filter: blur(4px); }
        .toast.show { opacity: 1; }

        /* SVG Icons */
        .icon-svg { width: 24px; height: 24px; fill: currentColor; }
        .config-info p { margin-bottom: 6px; font-size: 0.9rem; color: var(--text-sub); }
        .config-info code { background: var(--border); padding: 2px 6px; border-radius: 4px; color: var(--text-main); }
    </style>
</head>
<body>
    <div class="toast-container" id="toastContainer"></div>

    <div class="container">
        <div class="header">
            <h1>${FileName} <span class="badge">Panel</span></h1>
        </div>

        <div class="card">
            <div class="card-title">
                <svg class="icon-svg" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"></path></svg>
                订阅状态
            </div>
            <div class="stats-grid">
                <div class="stat-item">
                    <div class="stat-label">已用流量</div>
                    <div class="stat-value">${usedData}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">总流量</div>
                    <div class="stat-value">${totalData}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">过期时间</div>
                    <div class="stat-value">${expireDate}</div>
                </div>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" title="已用 ${percent}%"></div>
            </div>
        </div>

        <div class="card">
            <div class="card-title">
                <svg class="icon-svg" viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"></path></svg>
                一键订阅
            </div>
            <div class="links-grid">
                <div class="link-btn" onclick="copyLink('${url.origin}/${mytoken}')">
                    <svg class="link-icon" viewBox="0 0 24 24" fill="var(--primary)"><path d="M12 2L2 7l10 5 10-5-10-5zm0 9l2.5-1.25L12 8.5l-2.5 1.25L12 11zm0 2.5l-5-2.5-5 2.5L12 22l10-8.5-5-2.5-5 2.5z"/></svg>
                    <span class="link-name">自适应</span>
                </div>
                <div class="link-btn" onclick="copyLink('${url.origin}/${mytoken}?clash')">
                    <svg class="link-icon" viewBox="0 0 24 24" fill="#1890ff"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
                    <span class="link-name">Clash</span>
                </div>
                <div class="link-btn" onclick="copyLink('${url.origin}/${mytoken}?sb')">
                    <svg class="link-icon" viewBox="0 0 24 24" fill="#ec407a"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 12h-2v-2h2v2zm0-4h-2V7h2v4z"/></svg>
                    <span class="link-name">Sing-box</span>
                </div>
                <div class="link-btn" onclick="copyLink('${url.origin}/${mytoken}?surge')">
                    <svg class="link-icon" viewBox="0 0 24 24" fill="#7c4dff"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
                    <span class="link-name">Surge</span>
                </div>
                <div class="link-btn" onclick="copyLink('${url.origin}/${mytoken}?b64')">
                    <svg class="link-icon" viewBox="0 0 24 24" fill="#fb8c00"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
                    <span class="link-name">Base64</span>
                </div>
                <div class="link-btn" onclick="copyLink('${url.origin}/sub?token=${guest}')">
                    <svg class="link-icon" viewBox="0 0 24 24" fill="#10b981"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                    <span class="link-name">访客订阅</span>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-title">
                <svg class="icon-svg" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                节点管理
            </div>
            <div class="editor-wrapper">
                <textarea id="content" placeholder="在此输入节点链接，每行一个...">${content}</textarea>
            </div>
            <div class="action-bar">
                <button class="btn btn-secondary" onclick="copyToClipboard(document.getElementById('content').value)">复制内容</button>
                <button class="btn btn-primary" id="saveBtn" onclick="saveContent()">
                    <span id="saveBtnText">保存更改</span>
                </button>
            </div>
        </div>

        <div class="config-info" style="text-align: center; opacity: 0.7;">
            <p>Backend: <code>${subConverter}</code> (Modified)</p>
            <p>Config: <code>${subConfig.split('/').pop()}</code></p>
        </div>

    </div>

    <script>
        function showToast(message) {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.textContent = message;
            container.appendChild(toast);
            
            // Trigger reflow
            void toast.offsetWidth; 
            toast.classList.add('show');

            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 300);
            }, 2000);
        }

        function copyLink(text) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('✅ 订阅链接已复制');
            }).catch(() => {
                showToast('❌ 复制失败，请手动复制');
            });
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('✅ 内容已复制');
            });
        }

        function saveContent() {
            const btn = document.getElementById('saveBtn');
            const btnText = document.getElementById('saveBtnText');
            const content = document.getElementById('content').value;
            
            btn.disabled = true;
            btnText.textContent = '保存中...';
            
            fetch(window.location.href, {
                method: 'POST',
                body: content
            })
            .then(res => {
                if(res.ok) {
                    showToast('💾 保存成功');
                    setTimeout(() => { btnText.textContent = '保存更改'; btn.disabled = false; }, 1000);
                } else {
                    throw new Error('Status ' + res.status);
                }
            })
            .catch(err => {
                showToast('❌ 保存失败: ' + err.message);
                btnText.textContent = '重试';
                btn.disabled = false;
            });
        }
    </script>
</body>
</html>`;

    return new Response(html, {
        headers: { "Content-Type": "text/html;charset=utf-8" }
    });
}
