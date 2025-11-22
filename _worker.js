export default {
    async fetch(request, env) {
        const mytoken = env.TOKEN || '';
        const FileName = env.SUBNAME || 'My-Subscription';
        
        // 新版 API 地址
        let subConverter = env.SUBAPI || "api.doit.cloudns.ch"; 
        
        // 处理协议头
        if (subConverter.includes("://")) {
            subConverter = subConverter.split("://")[1];
        }

        const userAgentHeader = request.headers.get('User-Agent');
        const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
        const url = new URL(request.url);
        let token = url.searchParams.get('token');
        
        // 路径 Token 提取
        if (!token) {
            let pathToken = url.pathname.split('/')[1];
            if (pathToken === mytoken) {
                token = mytoken;
            }
        }
        
        // 鉴权 Token
        const fakeToken = await MD5MD5(`${mytoken}${Math.ceil(new Date().setHours(0,0,0,0)/1000)}`);
        let guestToken = env.GUESTTOKEN || await MD5MD5(mytoken);
        
        // 流量计算演示
        let total = 99; 
        let timestamp = 4102329600000;
        let UD = Math.floor(((timestamp - Date.now()) / timestamp * total * 1099511627776) / 2);
        total = total * 1099511627776;
        
        const targetContentType = {
            "singbox": "application/json; charset=utf-8",
            "clash": "text/yaml; charset=utf-8",
            "surge": "text/plain; charset=utf-8",
            "xray": "text/plain; charset=utf-8"
        };

        const responseHeaders = {
            "content-type": "text/plain; charset=utf-8",
            "Profile-Update-Interval": "6",
            "Subscription-Userinfo": `upload=${UD}; download=${UD}; total=${total}; expire=${timestamp}`,
        };

        // -------------------------------------------------------------
        // 1. 拦截与鉴权
        // -------------------------------------------------------------
        if (![mytoken, fakeToken, guestToken].includes(token)) {
            return new Response(await nginx(), { headers: { 'Content-Type': 'text/html' }});
        }

        // -------------------------------------------------------------
        // 2. 管理面板 (浏览器访问 UI)
        // -------------------------------------------------------------
        if (userAgent.includes('mozilla') && !url.searchParams.has('target') && !url.searchParams.has('b64')) {
             const isGuest = token === guestToken;
             if (env.KV && !isGuest && request.method === "POST") {
                 await env.KV.put('LINK.txt', await request.text());
                 return new Response("Saved");
             }
             return await renderUI(request, env, FileName, token, isGuest, subConverter);
        }

        // -------------------------------------------------------------
        // 3. 数据聚合
        // -------------------------------------------------------------
        let MainData = "";
        let urls = [];
        
        if (env.KV) MainData = await env.KV.get('LINK.txt') || "";
        if (env.LINKSUB) urls = await ADD(env.LINKSUB);

        let collectedNodes = ""; 

        if (MainData) {
            const lines = MainData.split(/[\n\r]+/);
            for (let line of lines) {
                line = line.trim();
                if (line.length === 0) continue; 
                if (line.startsWith('http://') || line.startsWith('https://')) {
                    urls.push(line); 
                } else {
                    collectedNodes += line + "\n";
                }
            }
        }

        if (urls.length > 0) {
            const proxyRes = await getSUB(urls, request, userAgentHeader);
            if (proxyRes && proxyRes[0]) {
                 collectedNodes += "\n" + proxyRes[0].join("\n");
            }
        }
        
        const uniqueLines = [...new Set(collectedNodes.split('\n'))].filter(x=>x.trim()!="" && !x.trim().startsWith("#"));
        const finalSourceStr = uniqueLines.join('\n');

        if (url.searchParams.has('b64')) {
            return new Response(
                btoa(encodeURIComponent(finalSourceStr).replace(/%([0-9A-F]{2})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16)))), 
                { headers: responseHeaders } 
            );
        }

        // -------------------------------------------------------------
        // 4. 调用 API 转换
        // -------------------------------------------------------------
        const target = (url.searchParams.get('target') || 'singbox').toLowerCase();
        const targetPath = ["singbox", "clash", "surge", "xray"].includes(target) ? target : "singbox";
        responseHeaders["content-type"] = targetContentType[targetPath] || responseHeaders["content-type"];

        const reqSelectedRules = url.searchParams.get('selectedRules') || "minimal";
        const reqCustomRules = url.searchParams.get('customRules');
        const reqGroup = url.searchParams.has('group_by_country') ? url.searchParams.get('group_by_country') : 'false';
        const reqPin = url.searchParams.get('pin') || 'false';
        const reqLang = url.searchParams.get('lang');
        const reqUa = url.searchParams.get('ua') || userAgentHeader || 'curl/7.74.0';
        const reqConfigId = url.searchParams.get('configId');
        const reqEnableClashUi = url.searchParams.get('enable_clash_ui');
        const reqExternalController = url.searchParams.get('external_controller');
        const reqExternalUi = url.searchParams.get('external_ui_download_url');
        const rawConfig = url.searchParams.get('config');

        const sourceConfigUrl = `${url.origin}/${token}?b64=1`;
        const backendParams = new URLSearchParams();
        backendParams.set('config', rawConfig || sourceConfigUrl);
        backendParams.set('ua', reqUa);
        backendParams.set('group_by_country', reqGroup);

        if (reqLang) backendParams.set('lang', reqLang);

        if (reqCustomRules && reqCustomRules !== '[]' && reqCustomRules.length > 2) {
            backendParams.set('customRules', reqCustomRules);
            if (reqPin === 'true') backendParams.set('pin', 'true');
        } else {
            backendParams.set('selectedRules', reqSelectedRules);
            backendParams.set('customRules', '[]');
        }

        if (reqConfigId) backendParams.set('configId', reqConfigId);
        if (reqEnableClashUi === 'true') backendParams.set('enable_clash_ui', 'true');
        if (reqExternalController) backendParams.set('external_controller', reqExternalController);
        if (reqExternalUi) backendParams.set('external_ui_download_url', reqExternalUi);

        const backendUrl = `https://${subConverter}/${targetPath}?${backendParams.toString()}`;

        try {
            const subRes = await fetch(backendUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Compatible; Cloudflare-Worker)' }
            });

            if (!subRes.ok) {
                 throw new Error(`Backend ${subRes.status}: ${await subRes.text()}`);
            }

            let subText = await subRes.text();
            responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(FileName)}`;
            return new Response(subText, { headers: responseHeaders });

        } catch (e) {
            console.error("转换失败:", e);
            return new Response(
                btoa(encodeURIComponent(finalSourceStr).replace(/%([0-9A-F]{2})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16)))),
                { headers: responseHeaders }
            );
        }
    }
};

async function ADD(envadd) {
    var addtext = envadd.replace(/[ "'|\r\n]+/g, '\n').replace(/\n+/g, '\n');
    if (addtext.charAt(0) == '\n') addtext = addtext.slice(1);
    if (addtext.charAt(addtext.length - 1) == '\n') addtext = addtext.slice(0, addtext.length - 1);
    return addtext.split('\n');
}

async function getSUB(api, request, ua) {
    if (!api || api.length === 0) return [[], []];
    let nodeContentList = [];
    let extraApiList = [];

    const fetchPromises = api.map(apiUrl => {
        return fetch(apiUrl, {
            method: 'GET',
            headers: { "User-Agent": "v2rayN/6.0", "Accept": "*/*" },
            cf: { insecureSkipVerify: true, validateCertificate: false }
        })
        .then(async res => {
            if (res.ok) return { url: apiUrl, content: await res.text() };
            return null;
        })
        .catch(err => null);
    });

    const results = await Promise.all(fetchPromises);

    for (const result of results) {
        if (!result || !result.content) continue;
        const content = result.content.trim();
        
        if (content.includes('proxies:') || (content.includes('outbounds') && content.includes('inbounds'))) {
            extraApiList.push(result.url); 
        } else if (isValidBase64(content)) {
            try {
                const decoded = base64Decode(content);
                nodeContentList.push(decoded);
            } catch (e) {
                nodeContentList.push(content);
            }
        } else {
            nodeContentList.push(content);
        }
    }
    return [nodeContentList, extraApiList];
}

function isValidBase64(str) {
    if (!str || str.length < 10) return false;
    const regex = /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/;
    try {
        if (str.includes('://') || str.includes('proxies:')) return false;
        return regex.test(str.replace(/\s/g, ''));
    } catch { return false; }
}

function base64Decode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    try {
        return decodeURIComponent(atob(str).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
    } catch (e) { return atob(str); }
}

async function MD5MD5(text) {
    const encoder = new TextEncoder();
    const firstPass = await crypto.subtle.digest('MD5', encoder.encode(text));
    return Array.from(new Uint8Array(firstPass)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function nginx() {
    return `<!DOCTYPE html><html><body><h1>Welcome</h1></body></html>`;
}

// ============================================================
// UI 渲染函数 (已修复二维码折叠逻辑)
// ============================================================
async function renderUI(request, env, FileName, token, isGuest, subConverter) {
    const url = new URL(request.url);
    const origin = url.origin;
    let content = "";
    if (env.KV && !isGuest) content = await env.KV.get('LINK.txt') || "";

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${FileName} 管理面板</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <style>
        body { background-color: #f8fafc; font-family: 'Segoe UI', sans-serif; }
        .glass-card { background: white; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        .form-select, .form-input, .form-textarea { width: 100%; border-radius: 0.75rem; border: 1px solid #cbd5e1; padding: 0.625rem 1rem; background-color: #f8fafc; transition: all 0.2s; }
        .form-select:focus, .form-input:focus, .form-textarea:focus { outline: none; border-color: #6366f1; ring: 2px; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1); background-color: white; }
        .btn { transition: all 0.2s; }
        .btn:active { transform: scale(0.98); }
    </style>
</head>
<body class="min-h-screen py-8 px-4 text-slate-700">
    <div class="max-w-5xl mx-auto space-y-6">
        <div class="flex flex-col md:flex-row justify-between items-center mb-8 bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
            <div>
                <h1 class="text-2xl font-bold text-slate-800 flex items-center gap-3">
                    <i class="fa-solid fa-bolt text-indigo-500"></i>
                    ${FileName}
                </h1>
                <p class="text-slate-500 text-sm mt-1">API: ${subConverter}</p>
            </div>
            <div class="mt-4 md:mt-0 flex gap-2">
                <a href="https://github.com/JustDoIt166/sublink-worker" target="_blank" class="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1 rounded-full transition">
                    <i class="fa-brands fa-github mr-1"></i> Powered by SubLink
                </a>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div class="lg:col-span-7 space-y-6">
                
                <div class="glass-card rounded-2xl p-6">
                    <h2 class="text-lg font-semibold mb-4 flex items-center gap-2">
                        <i class="fa-solid fa-sliders text-indigo-500"></i> 转换配置
                    </h2>
                    
                    <div class="space-y-5">
                        <div>
                            <label class="block text-sm font-medium text-slate-600 mb-2">目标客户端 (Target)</label>
                            <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                                <button onclick="setTarget('singbox')" id="btn-singbox" class="target-btn active ring-2 ring-indigo-500 bg-indigo-50 text-indigo-700 py-2 rounded-xl border border-indigo-200 font-medium text-sm">Sing-Box</button>
                                <button onclick="setTarget('clash')" id="btn-clash" class="target-btn bg-white hover:bg-slate-50 text-slate-600 py-2 rounded-xl border border-slate-200 font-medium text-sm">Clash</button>
                                <button onclick="setTarget('surge')" id="btn-surge" class="target-btn bg-white hover:bg-slate-50 text-slate-600 py-2 rounded-xl border border-slate-200 font-medium text-sm">Surge</button>
                                <button onclick="setTarget('xray')" id="btn-xray" class="target-btn bg-white hover:bg-slate-50 text-slate-600 py-2 rounded-xl border border-slate-200 font-medium text-sm">Xray</button>
                            </div>
                            <input type="hidden" id="targetInput" value="singbox">
                        </div>

                        <hr class="border-slate-100">

                        <div>
                            <label class="block text-sm font-medium text-slate-600 mb-2">分流规则 (Rules)</label>
                            
                            <div class="flex bg-slate-100 p-1 rounded-xl mb-3 w-fit">
                                <button onclick="toggleRuleMode('preset')" id="tab-preset" class="px-4 py-1.5 rounded-lg text-sm font-medium bg-white shadow-sm text-indigo-600 transition-all">预设规则</button>
                                <button onclick="toggleRuleMode('custom')" id="tab-custom" class="px-4 py-1.5 rounded-lg text-sm font-medium text-slate-500 hover:text-slate-700 transition-all">自定义 JSON</button>
                            </div>

                            <div id="preset-area">
                                <select id="selectedRules" class="form-select" onchange="updateLink()">
                                    <option value="minimal">Minimal (精简模式)</option>
                                    <option value="balanced">Balanced (均衡模式)</option>
                                    <option value="comprehensive">Comprehensive (全面模式)</option>
                                    <option value="adblock">AdBlock (去广告)</option>
                                </select>
                            </div>

                            <div id="custom-area" class="hidden">
                                <textarea id="customRules" rows="4" class="form-textarea font-mono text-xs" placeholder='[{"site":"google.com","ip":"8.8.8.8","name":"MyRule"}]' oninput="updateLink()"></textarea>
                                <div class="flex items-center justify-between mt-2">
                                    <label class="flex items-center gap-2 cursor-pointer">
                                        <input type="checkbox" id="pinCheck" class="rounded text-indigo-500 focus:ring-indigo-500" onchange="updateLink()">
                                        <span class="text-xs text-slate-600">置顶规则 (Pin)</span>
                                    </label>
                                </div>
                            </div>
                        </div>

                        <hr class="border-slate-100">

                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label class="block text-sm font-medium text-slate-600 mb-2">界面语言 (lang)</label>
                                <select id="lang" class="form-select" onchange="updateLink()">
                                    <option value="">默认 (zh-CN)</option>
                                    <option value="zh-CN">中文 (zh-CN)</option>
                                    <option value="en-US">English (en-US)</option>
                                    <option value="fa">فارسی (fa)</option>
                                    <option value="ru">Русский (ru)</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-sm font-medium text-slate-600 mb-2">订阅拉取 UA (ua)</label>
                                <input id="ua" type="text" class="form-input" placeholder="curl/7.74.0" value="" oninput="updateLink()">
                            </div>
                        </div>

                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                            <div>
                                <label class="block text-sm font-medium text-slate-600 mb-2">模板 ID (configId)</label>
                                <input id="configId" type="text" class="form-input" placeholder="singbox_xxxx" oninput="updateLink()">
                            </div>
                            <div>
                                <label class="block text-sm font-medium text-slate-600 mb-2">自定义 config 参数 (可选)</label>
                                <input id="configParam" type="text" class="form-input" placeholder="覆盖默认聚合订阅" oninput="updateLink()">
                            </div>
                        </div>

                        <div class="mt-4 p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-3">
                            <div class="flex items-center justify-between">
                                <div>
                                    <p class="text-sm font-semibold text-slate-700">Clash 面板支持</p>
                                    <p class="text-xs text-slate-500">开启后可直接使用外部控制器与自定义 Dashboard 下载</p>
                                </div>
                                <label class="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" id="enableClashUi" class="sr-only peer" onchange="updateLink()">
                                    <div class="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                                </label>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label class="block text-xs font-medium text-slate-600 mb-1">external_controller</label>
                                    <input id="externalController" type="text" class="form-input" placeholder="0.0.0.0:9090" oninput="updateLink()">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-slate-600 mb-1">external_ui_download_url</label>
                                    <input id="externalUi" type="text" class="form-input" placeholder="https://.../dashboard.zip" oninput="updateLink()">
                                </div>
                            </div>
                        </div>

                        <hr class="border-slate-100">

                        <div class="flex items-center justify-between">
                            <span class="text-sm font-medium text-slate-600">按国家/地区分组</span>
                            <label class="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" id="groupCheck" class="sr-only peer" onchange="updateLink()">
                                <div class="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                            </label>
                        </div>
                    </div>
                </div>

                <div class="glass-card rounded-2xl p-6 ${isGuest ? 'hidden' : ''}">
                    <div class="flex items-center justify-between mb-4">
                        <h2 class="text-lg font-semibold flex items-center gap-2">
                            <i class="fa-solid fa-server text-indigo-500"></i> 节点源
                        </h2>
                        <button onclick="saveNodes()" id="saveBtn" class="text-sm bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg transition shadow-sm shadow-indigo-200">
                            保存内容
                        </button>
                    </div>
                    <textarea id="nodeContent" class="form-textarea h-64 font-mono text-xs leading-relaxed" placeholder="vmess://...&#10;trojan://...">${content}</textarea>
                    <p id="saveMsg" class="text-right text-xs mt-2 h-4 font-medium"></p>
                </div>
            </div>

            <div class="lg:col-span-5 space-y-6">
                <div class="glass-card rounded-2xl p-6 sticky top-6 border-t-4 border-t-indigo-500">
                    <div class="text-center mb-6">
                        <h2 class="text-lg font-bold text-slate-700">订阅生成完毕</h2>
                        <p class="text-xs text-slate-400 mt-1">点击按钮查看二维码或直接导入</p>
                    </div>

                    <button type="button" onclick="toggleQRCode()" id="qrToggleBtn" class="w-full py-2.5 mb-4 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-indigo-600 transition flex items-center justify-center gap-2 shadow-sm">
                        <i class="fa-solid fa-qrcode"></i>
                        <span id="qrBtnText">显示二维码</span>
                    </button>
                    
                    <div id="qrContainer" class="hidden bg-white p-4 rounded-xl border border-dashed border-slate-300 flex justify-center mb-6 shadow-inner bg-slate-50">
                        <div id="qrcode" class="mix-blend-multiply opacity-90"></div>
                    </div>

                    <div class="space-y-4">
                        <div class="relative group">
                            <input type="text" id="finalLink" class="form-input pr-10 text-xs text-slate-500 bg-slate-50 cursor-text" readonly onclick="this.select()">
                            <button onclick="copyLink()" class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-indigo-600 p-1 transition">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                        </div>
                        
                        <a id="importBtn" href="#" class="btn block w-full text-center bg-slate-800 hover:bg-slate-900 text-white py-3 rounded-xl font-semibold shadow-lg shadow-slate-200 transition flex items-center justify-center gap-2">
                            <i class="fa-solid fa-download"></i>
                            <span>一键导入到 App</span>
                        </a>
                    </div>

                    <div class="mt-8 pt-6 border-t border-slate-100 grid grid-cols-2 gap-4 text-center">
                        <div>
                            <p class="text-xs text-slate-400 mb-1">剩余流量</p>
                            <p class="text-indigo-600 font-bold text-lg">99 <span class="text-xs">TB</span></p>
                        </div>
                        <div>
                            <p class="text-xs text-slate-400 mb-1">过期时间</p>
                            <p class="text-slate-600 font-bold text-sm mt-1">2099-12-31</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const baseUrl = "${origin}/${token}";
        let currentMode = 'preset';
        let isQRVisible = false;
        const uaInput = document.getElementById('ua');
        const langSelect = document.getElementById('lang');
        const configIdInput = document.getElementById('configId');
        const configParamInput = document.getElementById('configParam');
        const enableClashUiInput = document.getElementById('enableClashUi');
        const externalControllerInput = document.getElementById('externalController');
        const externalUiInput = document.getElementById('externalUi');

        if (!uaInput.value && navigator.userAgent) {
            uaInput.placeholder = navigator.userAgent;
        }

        // 二维码开关逻辑
        function toggleQRCode() {
            const container = document.getElementById('qrContainer');
            const btn = document.getElementById('qrToggleBtn');
            const txt = document.getElementById('qrBtnText');
            const link = document.getElementById('finalLink').value;

            if (container.classList.contains('hidden')) {
                // 展开
                container.classList.remove('hidden');
                btn.classList.add('ring-2', 'ring-indigo-500', 'border-transparent', 'text-indigo-600', 'bg-indigo-50');
                btn.classList.remove('bg-white', 'text-slate-600');
                txt.innerText = "隐藏二维码";
                isQRVisible = true;
                // 展开时强制重新渲染，防止 display:none 导致尺寸计算错误
                renderQRCode(link);
            } else {
                // 折叠
                container.classList.add('hidden');
                btn.classList.remove('ring-2', 'ring-indigo-500', 'border-transparent', 'text-indigo-600', 'bg-indigo-50');
                btn.classList.add('bg-white', 'text-slate-600');
                txt.innerText = "显示二维码";
                isQRVisible = false;
            }
        }

        function setTarget(target) {
            document.getElementById('targetInput').value = target;
            document.querySelectorAll('.target-btn').forEach(btn => {
                btn.classList.remove('bg-indigo-50', 'text-indigo-700', 'ring-2', 'ring-indigo-500', 'border-indigo-200');
                btn.classList.add('bg-white', 'text-slate-600', 'border-slate-200');
            });
            const activeBtn = document.getElementById('btn-' + target);
            activeBtn.classList.remove('bg-white', 'text-slate-600', 'border-slate-200');
            activeBtn.classList.add('bg-indigo-50', 'text-indigo-700', 'ring-2', 'ring-indigo-500', 'border-indigo-200');
            updateLink();
        }

        function toggleRuleMode(mode) {
            currentMode = mode;
            const presetArea = document.getElementById('preset-area');
            const customArea = document.getElementById('custom-area');
            const tabPreset = document.getElementById('tab-preset');
            const tabCustom = document.getElementById('tab-custom');

            if (mode === 'preset') {
                presetArea.classList.remove('hidden');
                customArea.classList.add('hidden');
                tabPreset.classList.add('bg-white', 'shadow-sm', 'text-indigo-600');
                tabPreset.classList.remove('text-slate-500');
                tabCustom.classList.remove('bg-white', 'shadow-sm', 'text-indigo-600');
                tabCustom.classList.add('text-slate-500');
            } else {
                presetArea.classList.add('hidden');
                customArea.classList.remove('hidden');
                tabCustom.classList.add('bg-white', 'shadow-sm', 'text-indigo-600');
                tabCustom.classList.remove('text-slate-500');
                tabPreset.classList.remove('bg-white', 'shadow-sm', 'text-indigo-600');
                tabPreset.classList.add('text-slate-500');
            }
            updateLink();
        }

        function updateLink() {
            const target = document.getElementById('targetInput').value;
            const isGroup = document.getElementById('groupCheck').checked;
            
            let params = new URLSearchParams();
            params.append('target', target);
            if (isGroup) params.append('group_by_country', 'true');
            else params.append('group_by_country', 'false');

            if (currentMode === 'custom') {
                const customJson = document.getElementById('customRules').value.trim();
                const isPin = document.getElementById('pinCheck').checked;
                if (customJson) {
                    params.append('customRules', customJson);
                    if(isPin) params.append('pin', 'true');
                }
            } else {
                const selectedRule = document.getElementById('selectedRules').value;
                params.append('selectedRules', selectedRule);
            }

            const lang = langSelect.value;
            const ua = uaInput.value.trim();
            const configId = configIdInput.value.trim();
            const configParam = configParamInput.value.trim();
            const enableClashUi = enableClashUiInput.checked;
            const externalController = externalControllerInput.value.trim();
            const externalUi = externalUiInput.value.trim();

            if (lang) params.append('lang', lang);
            if (ua) params.append('ua', ua);
            if (configId) params.append('configId', configId);
            if (configParam) params.append('config', configParam);
            if (enableClashUi) params.append('enable_clash_ui', 'true');
            if (externalController) params.append('external_controller', externalController);
            if (externalUi) params.append('external_ui_download_url', externalUi);

            const finalUrl = baseUrl + "?" + params.toString();
            document.getElementById('finalLink').value = finalUrl;
            
            // 只有在二维码可见时才渲染，节省资源并避免错误
            if (isQRVisible) {
                renderQRCode(finalUrl);
            }
            
            updateImportButton(target, finalUrl);
        }

        function renderQRCode(text) {
            const container = document.getElementById("qrcode");
            container.innerHTML = "";
            // 使用标准的 QRCode 构造函数
            new QRCode(container, {
                text: text,
                width: 180,
                height: 180,
                colorDark : "#0f172a", // 对应 slate-900
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.M // 稍微提高容错率
            });
        }

        function updateImportButton(target, url) {
            const btn = document.getElementById('importBtn');
            const span = btn.querySelector('span');
            
            if (target === 'clash') {
                btn.href = 'clash://install-config?url=' + encodeURIComponent(url);
                span.innerText = '导入到 Clash';
            } else if (target === 'singbox') {
                btn.href = 'sing-box://import-remote-profile?url=' + encodeURIComponent(url) + '#${FileName}';
                span.innerText = '导入到 Sing-Box';
            } else if (target === 'surge') {
                btn.href = 'surge:///install-config?url=' + encodeURIComponent(url);
                span.innerText = '导入到 Surge';
            } else if (target === 'xray') {
                btn.href = url;
                span.innerText = '导入到 Xray';
            } else {
                btn.href = url;
                span.innerText = '打开订阅链接';
            }
        }

        function copyLink() {
            const el = document.getElementById("finalLink");
            el.select();
            navigator.clipboard.writeText(el.value).then(() => {
                // 简单的视觉反馈
                const btn = document.querySelector('.fa-copy').parentElement;
                const originalHtml = btn.innerHTML;
                btn.innerHTML = '<i class="fa-solid fa-check text-emerald-500"></i>';
                setTimeout(() => btn.innerHTML = originalHtml, 1500);
            });
        }

        function saveNodes() {
            const btn = document.getElementById('saveBtn');
            const msg = document.getElementById('saveMsg');
            const content = document.getElementById('nodeContent').value;
            
            btn.disabled = true;
            btn.classList.add('opacity-70', 'cursor-not-allowed');
            msg.innerText = "正在保存...";
            msg.className = "text-right text-xs mt-2 h-4 font-medium text-indigo-500";

            fetch(window.location.href, { method: 'POST', body: content })
            .then(res => {
                if(res.ok) {
                    msg.innerText = "✅ 保存成功";
                    msg.className = "text-right text-xs mt-2 h-4 font-medium text-emerald-500";
                    setTimeout(() => msg.innerText = "", 2000);
                } else {
                    throw new Error();
                }
            })
            .catch(() => {
                msg.innerText = "❌ 保存失败";
                msg.className = "text-right text-xs mt-2 h-4 font-medium text-red-500";
            })
            .finally(() => {
                btn.disabled = false;
                btn.classList.remove('opacity-70', 'cursor-not-allowed');
            });
        }

        toggleRuleMode('preset');
    </script>
</body>
</html>
    `;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
