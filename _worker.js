export default {
    async fetch(request, env) {
        const mytoken = (env.TOKEN || '').trim();
        if (!mytoken) {
            return new Response('服务未配置环境变量 TOKEN，已拒绝访问以保障安全。', {
                status: 500,
                headers: { 'content-type': 'text/plain; charset=utf-8' }
            });
        }

        const FileName = (env.SUBNAME || 'My-Subscription').trim() || 'My-Subscription';

        // 规范化转换后端地址（去协议头、去尾部斜杠）
        let subConverter = (env.SUBAPI || 'api.doit.cloudns.ch').trim();
        if (subConverter.includes('://')) {
            subConverter = subConverter.split('://')[1];
        }
        subConverter = subConverter.replace(/\/+$/, '');

        const userAgentHeader = request.headers.get('User-Agent') || '';
        const userAgent = userAgentHeader.toLowerCase();
        const url = new URL(request.url);

        // 提取 Token（支持 ?token= 或路径首段 /<token>）
        let token = (url.searchParams.get('token') || '').trim();
        const pathToken = decodeURIComponent(url.pathname.split('/')[1] || '').trim();

        // 基于 SHA-256 派生只读回调 Token（每日轮换）与访客 Token
        const dayBucket = Math.floor(Date.now() / 86400000);
        const fakeToken = (await sha256Hex(`${mytoken}:${dayBucket}:callback`)).slice(0, 32);
        const guestToken = (env.GUESTTOKEN || '').trim() || (await sha256Hex(`${mytoken}:guest`)).slice(0, 32);

        if (!token && pathToken && [mytoken, fakeToken, guestToken].includes(pathToken)) {
            token = pathToken;
        }

        const isAdmin = token === mytoken;
        const isGuest = token === guestToken;
        const isCallback = token === fakeToken;

        // -------------------------------------------------------------
        // 1. 严格鉴权与角色隔离
        // -------------------------------------------------------------
        if (!isAdmin && !isGuest && !isCallback) {
            return new Response(await nginx(), {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        // 只读回调令牌仅允许访问 ?b64=1 聚合源接口，禁止访问 UI 与其他接口
        if (isCallback && !url.searchParams.has('b64')) {
            return new Response(await nginx(), {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        // 流量信息（修正 expire 为标准 10 位秒级时间戳）
        const totalTB = Number(env.TOTAL_TB) > 0 ? Number(env.TOTAL_TB) : 99;
        const expireMs = Number(env.EXPIRE_TS) > 0 ? Number(env.EXPIRE_TS) : 4102329600000;
        const expireSeconds = expireMs > 1e11 ? Math.floor(expireMs / 1000) : Math.floor(expireMs);
        const totalBytes = Math.floor(totalTB * 1099511627776);
        const usedHalf = Math.max(0, Math.floor(((expireSeconds * 1000 - Date.now()) / (expireSeconds * 1000) * totalBytes) / 2));

        const targetContentType = {
            singbox: 'application/json; charset=utf-8',
            clash: 'text/yaml; charset=utf-8',
            surge: 'text/plain; charset=utf-8',
            xray: 'text/plain; charset=utf-8'
        };

        const responseHeaders = {
            'content-type': 'text/plain; charset=utf-8',
            'Profile-Update-Interval': '6',
            'Subscription-Userinfo': `upload=${usedHalf}; download=${usedHalf}; total=${totalBytes}; expire=${expireSeconds}`,
            'Cache-Control': 'no-store'
        };

        const action = (url.searchParams.get('action') || '').toLowerCase();

        // -------------------------------------------------------------
        // 2. 管理接口：订阅源健康检测与节点统计 (?action=check)
        // -------------------------------------------------------------
        if (action === 'check') {
            if (!isAdmin) {
                return jsonResponse({ ok: false, error: '仅管理员可执行健康检测' }, 403);
            }
            let rawInput = '';
            let filterOptions = getFilterOptionsFromParams(url.searchParams, env);

            if (request.method === 'POST') {
                const ct = (request.headers.get('Content-Type') || '').toLowerCase();
                if (ct.includes('application/json')) {
                    try {
                        const body = await request.json();
                        rawInput = typeof body.content === 'string' ? body.content : '';
                        filterOptions = {
                            clean: body.clean !== undefined ? parseBool(body.clean, true) : filterOptions.clean,
                            exclude: typeof body.exclude === 'string' ? body.exclude.trim() : filterOptions.exclude,
                            include: typeof body.include === 'string' ? body.include.trim() : filterOptions.include,
                            rename: typeof body.rename === 'string' ? body.rename.trim() : filterOptions.rename
                        };
                    } catch {
                        return jsonResponse({ ok: false, error: '无效的 JSON 请求体' }, 400);
                    }
                } else {
                    rawInput = await request.text();
                }
            } else if (env.KV) {
                rawInput = (await env.KV.get('LINK.txt')) || '';
            }

            const report = await runHealthCheck(rawInput, env, filterOptions);
            return jsonResponse({ ok: true, ...report }, 200);
        }

        // -------------------------------------------------------------
        // 3. 管理面板与节点保存 (浏览器访问 UI)
        // -------------------------------------------------------------
        const isKnownProxyClient = /clash|mihomo|stash|flclash|verge|meta|sing-box|singbox|sfa|sfi|sfm|surge|v2ray|xray|shadowrocket|quantumult|loon|hiddify|karing|nekobox|nekoray|matsuri|curl|wget|subconverter|sublink/i.test(userAgent);
        const isBrowserUiRequest =
            userAgent.includes('mozilla') &&
            !isKnownProxyClient &&
            !url.searchParams.has('target') &&
            !url.searchParams.has('b64') &&
            !action;

        if (isBrowserUiRequest) {
            if (request.method === 'POST') {
                if (!isAdmin) {
                    return jsonResponse({ ok: false, error: '访客模式无权修改节点源' }, 403);
                }
                if (!env.KV) {
                    return jsonResponse({ ok: false, error: '未绑定 KV 命名空间，无法保存内容' }, 501);
                }
                const newContent = await request.text();
                try {
                    const prev = await env.KV.get('LINK.txt');
                    if (prev !== null && prev !== newContent) {
                        await env.KV.put('LINK_BACKUP.txt', prev);
                    }
                    await env.KV.put('LINK.txt', newContent);
                    return jsonResponse({ ok: true, message: '保存成功（已自动备份上一版本）' }, 200);
                } catch (err) {
                    return jsonResponse({ ok: false, error: `KV 写入失败: ${err.message || err}` }, 500);
                }
            }

            return await renderUI(request, env, {
                FileName,
                token,
                guestToken,
                isAdmin,
                isGuest,
                subConverter,
                hasKV: Boolean(env.KV),
                totalTB,
                expireDateStr: formatDateYMD(expireSeconds * 1000)
            });
        }

        // -------------------------------------------------------------
        // 4. 聚合、清洗、过滤与自动重命名（仅 ?b64=1 执行，彻底消除双重拉取）
        // -------------------------------------------------------------
        const filterOptions = getFilterOptionsFromParams(url.searchParams, env);

        if (url.searchParams.has('b64')) {
            const aggResult = await aggregateAndProcessNodes(env, filterOptions);
            const b64Str = utf8ToBase64(aggResult.nodes.join('\n'));
            return new Response(b64Str, {
                headers: {
                    ...responseHeaders,
                    'X-Nodes-Raw': String(aggResult.rawCount),
                    'X-Nodes-Valid': String(aggResult.nodes.length),
                    'X-Nodes-Filtered': String(aggResult.filteredCount)
                }
            });
        }

        // -------------------------------------------------------------
        // 5. 基于 User-Agent 的单链通用适配 + 调用后端转换
        // -------------------------------------------------------------
        const rawTarget = (url.searchParams.get('target') || 'auto').toLowerCase();
        const isAutoTarget = rawTarget === 'auto' || !['singbox', 'clash', 'surge', 'xray'].includes(rawTarget);
        const targetPath = isAutoTarget ? detectTargetFromUA(userAgentHeader) : rawTarget;

        responseHeaders['content-type'] = targetContentType[targetPath] || responseHeaders['content-type'];
        responseHeaders['X-Detected-Target'] = targetPath;

        const reqSelectedRules = url.searchParams.get('selectedRules') || '';
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
        const normalizedConfig = normalizeConfig(rawConfig);

        // 构造只读回调地址，避免向第三方转换后端泄露管理员 TOKEN，同时透传清洗/过滤/重命名参数
        const callbackParams = new URLSearchParams();
        callbackParams.set('b64', '1');
        if (!filterOptions.clean) callbackParams.set('clean', 'false');
        if (filterOptions.exclude) callbackParams.set('exclude', filterOptions.exclude);
        if (filterOptions.include) callbackParams.set('include', filterOptions.include);
        if (filterOptions.rename) callbackParams.set('rename', filterOptions.rename);
        const sourceConfigUrl = `${url.origin}/${fakeToken}?${callbackParams.toString()}`;

        const backendParams = new URLSearchParams();
        if (normalizedConfig) {
            backendParams.set('config', normalizedConfig);
        } else {
            // 轻量校验是否存在源配置（零外部网络请求）
            const hasKvData = env.KV ? Boolean(((await env.KV.get('LINK.txt')) || '').trim()) : false;
            const hasEnvSub = Boolean((env.LINKSUB || '').trim());
            if (!hasKvData && !hasEnvSub) {
                return new Response('缺少订阅配置，请提供 config 参数或在 KV / LINKSUB 中配置节点源。', {
                    status: 400,
                    headers: { 'content-type': 'text/plain; charset=utf-8' }
                });
            }
            backendParams.set('config', sourceConfigUrl);
        }

        backendParams.set('ua', reqUa);
        backendParams.set('group_by_country', reqGroup);
        if (reqLang) backendParams.set('lang', reqLang);

        // 解除互斥：允许 selectedRules 与 customRules 同时生效叠加
        const hasCustomRules = Boolean(reqCustomRules && reqCustomRules.trim() !== '[]' && reqCustomRules.trim().length > 2);
        const hasSelectedRules = Boolean(reqSelectedRules && reqSelectedRules.trim() !== '');

        if (hasSelectedRules) {
            backendParams.set('selectedRules', reqSelectedRules);
        } else if (!hasCustomRules) {
            // 两者都未指定时才回落到精简预设，避免叠加自定义规则时强塞 minimal
            backendParams.set('selectedRules', 'minimal');
        }
        if (hasCustomRules) {
            backendParams.set('customRules', reqCustomRules);
            if (reqPin === 'true') backendParams.set('pin', 'true');
        } else {
            backendParams.set('customRules', '[]');
        }

        if (reqConfigId) backendParams.set('configId', reqConfigId);
        if (reqEnableClashUi === 'true') backendParams.set('enable_clash_ui', 'true');
        if (reqExternalController) backendParams.set('external_controller', reqExternalController);
        if (reqExternalUi) backendParams.set('external_ui_download_url', reqExternalUi);

        const ruleLabel = (() => {
            if (hasCustomRules) return 'custom';
            if (reqSelectedRules && reqSelectedRules.trim().startsWith('[')) return 'multi';
            return reqSelectedRules || 'minimal';
        })();

        const targetExtensions = {
            singbox: '.json',
            clash: '.yaml',
            surge: '.conf',
            xray: '.txt'
        };

        const nameParts = [sanitizeFileToken(FileName), sanitizeFileToken(targetPath)];
        const configLabel = sanitizeFileToken(reqConfigId || ruleLabel);
        if (configLabel) nameParts.push(configLabel);
        const subscriptionFileName = `${nameParts.join('-')}${targetExtensions[targetPath] || '.txt'}`;
        responseHeaders['Content-Disposition'] = `attachment; filename*=utf-8''${encodeURIComponent(subscriptionFileName)}`;

        const backendUrl = `https://${subConverter}/${targetPath}?${backendParams.toString()}`;

        try {
            const subRes = await fetch(backendUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Compatible; Cloudflare-Worker)' },
                signal: AbortSignal.timeout(15000)
            });

            let backendText = '';
            try {
                backendText = await subRes.text();
            } catch (err) {
                console.error('读取后端响应失败:', err);
            }

            if (!subRes.ok) {
                console.error('后端转换失败:', backendUrl, backendText);
                return new Response(`Backend ${subRes.status}: ${backendText || 'empty response'}`, {
                    status: 502,
                    headers: { 'content-type': 'text/plain; charset=utf-8' }
                });
            }

            if (!backendText.trim()) {
                console.warn('后端返回空内容:', backendUrl);
            }

            return new Response(backendText, { headers: responseHeaders });
        } catch (e) {
            console.error('转换失败:', e);
            return new Response(`转换失败: ${e.message || e}`, {
                status: 504,
                headers: { 'content-type': 'text/plain; charset=utf-8' }
            });
        }
    }
};

// ============================================================
// 核心工具：User-Agent 自动适配
// ============================================================
function detectTargetFromUA(uaHeader) {
    const ua = (uaHeader || '').toLowerCase();
    if (/clash|mihomo|stash|flclash|verge|meta/.test(ua)) return 'clash';
    if (/sing-box|singbox|sfa|sfi|sfm|hiddify|karing|nekobox/.test(ua)) return 'singbox';
    if (/surge/.test(ua)) return 'surge';
    if (/v2ray|xray|shadowrocket|quantumult|loon|nekoray|matsuri|passwall/.test(ua)) return 'xray';
    return 'singbox';
}

// ============================================================
// 节点源解析、抓取、清洗、过滤与自动重命名
// ============================================================
const SUPPORTED_NODE_SCHEMES = [
    'vmess://', 'vless://', 'trojan://', 'ss://', 'ssr://',
    'hysteria://', 'hysteria2://', 'hy2://', 'tuic://',
    'wireguard://', 'wg://', 'socks://', 'socks5://',
    'http://', 'https://', 'anytls://', 'snell://'
];

// 默认垃圾信息节点正则（机场公告、流量提示、过期提示、官网引流等）
const DEFAULT_JUNK_NODE_REGEX = /(剩余流量|套餐到期|过期时间|到期时间|距离下次重置|重置剩余|流量重置|可用流量|已用流量|官网|最新域名|发布页|备用域名|防失联|群组|电报群|频道|客服|工单|续费|套餐|公告|通知|说明|使用教程|邀请|返利|测试勿用|expire|traffic|remaining|reset\s*day|official\s*site)/i;

function getFilterOptionsFromParams(searchParams, env) {
    return {
        clean: parseBool(searchParams.has('clean') ? searchParams.get('clean') : (env.CLEAN_NODES ?? 'true'), true),
        exclude: (searchParams.get('exclude') ?? env.EXCLUDE ?? '').trim(),
        include: (searchParams.get('include') ?? env.INCLUDE ?? '').trim(),
        rename: (searchParams.get('rename') ?? env.RENAME ?? '').trim()
    };
}

function parseBool(val, defaultVal = false) {
    if (val === undefined || val === null || val === '') return defaultVal;
    const s = String(val).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    return defaultVal;
}

function parseSourceEntries(mainData, envLinkSub) {
    const inlineNodes = [];
    const subEntries = [];
    const seenUrls = new Set();

    const pushUrlEntry = (rawUrl, alias, originType) => {
        const cleanUrl = rawUrl.trim();
        if (!cleanUrl || seenUrls.has(cleanUrl)) return;
        seenUrls.add(cleanUrl);
        let fallbackName = alias;
        if (!fallbackName) {
            try {
                fallbackName = new URL(cleanUrl).hostname;
            } catch {
                fallbackName = `订阅源${subEntries.length + 1}`;
            }
        }
        subEntries.push({ url: cleanUrl, alias: fallbackName, origin: originType });
    };

    if (mainData) {
        const lines = mainData.split(/[\r\n]+/);
        for (let rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;

            if (/^https?:\/\//i.test(line)) {
                // 支持 "https://example.com/sub #机场A" 写法作为来源别名
                const aliasMatch = line.match(/^(https?:\/\/\S+?)(?:\s+#\s*(.+))?$/i);
                if (aliasMatch) {
                    pushUrlEntry(aliasMatch[1], (aliasMatch[2] || '').trim(), 'KV');
                }
            } else {
                inlineNodes.push(line);
            }
        }
    }

    if (envLinkSub) {
        const envUrls = parseEnvUrls(envLinkSub);
        for (const u of envUrls) {
            if (/^https?:\/\//i.test(u)) {
                pushUrlEntry(u, '', 'LINKSUB');
            }
        }
    }

    return { inlineNodes, subEntries };
}

function parseEnvUrls(envadd) {
    if (!envadd) return [];
    return envadd
        .replace(/[ "'|\r\n]+/g, '\n')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
}

async function fetchSingleSubscription(entry) {
    const start = Date.now();
    try {
        const res = await fetch(entry.url, {
            method: 'GET',
            headers: { 'User-Agent': 'v2rayN/6.0', 'Accept': '*/*' },
            signal: AbortSignal.timeout(8000)
        });
        const latencyMs = Date.now() - start;
        const userinfo = parseSubscriptionUserinfo(res.headers.get('subscription-userinfo'));

        if (!res.ok) {
            return {
                ...entry,
                ok: false,
                status: res.status,
                latencyMs,
                format: 'Error',
                rawLines: [],
                userinfo,
                error: `HTTP ${res.status}`
            };
        }

        const text = (await res.text()).trim();
        if (!text) {
            return {
                ...entry,
                ok: false,
                status: res.status,
                latencyMs,
                format: 'Empty',
                rawLines: [],
                userinfo,
                error: '上游返回空内容'
            };
        }

        let format = 'Plain';
        let decodedText = text;

        if (/^<!doctype\s+html|^<html/i.test(text)) {
            return {
                ...entry,
                ok: false,
                status: res.status,
                latencyMs,
                format: 'HTML',
                rawLines: [],
                userinfo,
                error: '上游返回了 HTML 页面（可能已失效或触发风控）'
            };
        } else if (text.includes('proxies:') && text.includes('name:')) {
            format = 'Clash YAML';
            decodedText = '';
        } else if (text.startsWith('{') && text.includes('"outbounds"') && text.includes('"inbounds"')) {
            format = 'Sing-Box JSON';
            decodedText = '';
        } else if (isValidBase64(text)) {
            format = 'Base64';
            try {
                decodedText = base64Decode(text);
            } catch {
                decodedText = text;
            }
        }

        const rawLines = decodedText
            ? decodedText.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean)
            : [];

        return {
            ...entry,
            ok: true,
            status: res.status,
            latencyMs,
            format,
            rawLines,
            userinfo,
            error: format === 'Clash YAML' || format === 'Sing-Box JSON'
                ? '原生结构化订阅（非通用 URI 列表，跳过 URI 清洗）'
                : null
        };
    } catch (err) {
        const latencyMs = Date.now() - start;
        const isTimeout = err && (err.name === 'TimeoutError' || String(err).includes('timeout'));
        return {
            ...entry,
            ok: false,
            status: 0,
            latencyMs,
            format: 'Error',
            rawLines: [],
            userinfo: null,
            error: isTimeout ? '请求超时 (>8s)' : (err.message || String(err))
        };
    }
}

async function aggregateAndProcessNodes(env, filterOptions) {
    const mainData = env.KV ? ((await env.KV.get('LINK.txt')) || '') : '';
    const { inlineNodes, subEntries } = parseSourceEntries(mainData, env.LINKSUB || '');

    const rawItems = [];
    for (const line of inlineNodes) {
        rawItems.push({ uri: line, sourceAlias: '手动节点' });
    }

    if (subEntries.length > 0) {
        const results = await Promise.all(subEntries.map(fetchSingleSubscription));
        for (const r of results) {
            if (!r.ok || r.rawLines.length === 0) continue;
            for (const line of r.rawLines) {
                rawItems.push({ uri: line, sourceAlias: r.alias });
            }
        }
    }

    return processNodeItems(rawItems, filterOptions);
}

async function runHealthCheck(rawInput, env, filterOptions) {
    const { inlineNodes, subEntries } = parseSourceEntries(rawInput, env.LINKSUB || '');
    const sourcesReport = [];
    const totalProtocols = {};
    let totalRaw = 0;
    let totalValid = 0;
    let totalFiltered = 0;

    // 1. 统计手动直填节点
    if (inlineNodes.length > 0) {
        const inlineProcessed = processNodeItems(
            inlineNodes.map(uri => ({ uri, sourceAlias: '手动节点' })),
            filterOptions
        );
        mergeProtocolCounts(totalProtocols, inlineProcessed.protocols);
        totalRaw += inlineProcessed.rawCount;
        totalValid += inlineProcessed.nodes.length;
        totalFiltered += inlineProcessed.filteredCount;

        sourcesReport.push({
            name: '手动直填节点',
            url: '',
            origin: 'INLINE',
            ok: true,
            status: 200,
            latencyMs: 0,
            format: 'URI List',
            rawCount: inlineProcessed.rawCount,
            validCount: inlineProcessed.nodes.length,
            filteredCount: inlineProcessed.filteredCount,
            protocols: inlineProcessed.protocols,
            userinfo: null,
            error: null
        });
    }

    // 2. 并发探测全部远程订阅源
    const remoteResults = await Promise.all(subEntries.map(fetchSingleSubscription));
    let healthyRemote = 0;
    let totalLatency = 0;
    let latencyCount = 0;

    for (const r of remoteResults) {
        if (r.ok) {
            healthyRemote++;
            totalLatency += r.latencyMs;
            latencyCount++;
        }
        const processed = processNodeItems(
            r.rawLines.map(uri => ({ uri, sourceAlias: r.alias })),
            filterOptions
        );
        mergeProtocolCounts(totalProtocols, processed.protocols);
        totalRaw += processed.rawCount;
        totalValid += processed.nodes.length;
        totalFiltered += processed.filteredCount;

        sourcesReport.push({
            name: r.alias,
            url: r.url,
            origin: r.origin,
            ok: r.ok,
            status: r.status,
            latencyMs: r.latencyMs,
            format: r.format,
            rawCount: processed.rawCount,
            validCount: processed.nodes.length,
            filteredCount: processed.filteredCount,
            protocols: processed.protocols,
            userinfo: r.userinfo,
            error: r.error
        });
    }

    return {
        checkedAt: new Date().toISOString(),
        summary: {
            totalSources: subEntries.length,
            healthySources: healthyRemote,
            failedSources: subEntries.length - healthyRemote,
            avgLatencyMs: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
            rawNodes: totalRaw,
            validNodes: totalValid,
            filteredOut: totalFiltered,
            protocols: totalProtocols
        },
        sources: sourcesReport
    };
}

function processNodeItems(rawItems, options) {
    const includeRegex = buildSafeRegex(options.include);
    const excludeRegex = buildSafeRegex(options.exclude);
    const renameMode = (options.rename || '').trim();

    const seenExactUri = new Set();
    const nameCounter = new Map();
    const finalNodes = [];
    const protocols = {};
    let rawCount = 0;
    let filteredCount = 0;

    for (const item of rawItems) {
        const cleanedLine = (item.uri || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
        if (!cleanedLine || cleanedLine.startsWith('#')) continue;

        const scheme = detectNodeScheme(cleanedLine);
        if (!scheme) continue;

        rawCount++;

        // 原始 URI 精确去重
        if (seenExactUri.has(cleanedLine)) {
            filteredCount++;
            continue;
        }
        seenExactUri.add(cleanedLine);

        const parsed = extractNodeName(cleanedLine, scheme);
        const nodeName = parsed.name || '';

        // 1. 智能清洗垃圾信息节点
        if (options.clean && DEFAULT_JUNK_NODE_REGEX.test(nodeName)) {
            filteredCount++;
            continue;
        }
        // 2. 自定义包含过滤
        if (includeRegex && !includeRegex.test(nodeName)) {
            filteredCount++;
            continue;
        }
        // 3. 自定义排除过滤
        if (excludeRegex && excludeRegex.test(nodeName)) {
            filteredCount++;
            continue;
        }

        // 4. 自动重命名与重名去重
        let outputUri = cleanedLine;
        if (renameMode && renameMode !== 'off') {
            let newName = cleanNodeNameText(nodeName) || `${scheme.toUpperCase()}-Node`;
            if (renameMode === 'prefix') {
                const alias = cleanNodeNameText(item.sourceAlias || '');
                if (alias && !newName.startsWith(`[${alias}]`)) {
                    newName = `[${alias}] ${newName}`;
                }
            } else if (renameMode !== 'dedup') {
                // 自定义固定前缀
                const customPrefix = cleanNodeNameText(renameMode);
                if (customPrefix && !newName.startsWith(`[${customPrefix}]`)) {
                    newName = `[${customPrefix}] ${newName}`;
                }
            }

            const count = (nameCounter.get(newName) || 0) + 1;
            nameCounter.set(newName, count);
            const dedupedName = count > 1 ? `${newName} ${String(count).padStart(2, '0')}` : newName;
            outputUri = applyNodeName(cleanedLine, scheme, dedupedName, parsed);
        }

        const protoKey = normalizeProtocolLabel(scheme);
        protocols[protoKey] = (protocols[protoKey] || 0) + 1;
        finalNodes.push(outputUri);
    }

    return {
        nodes: finalNodes,
        rawCount,
        filteredCount,
        protocols
    };
}

function detectNodeScheme(line) {
    const lower = line.toLowerCase();
    for (const s of SUPPORTED_NODE_SCHEMES) {
        if (lower.startsWith(s)) {
            // 排除普通网页链接被当作 http 代理节点（除非带认证或端口）
            if ((s === 'http://' || s === 'https://') && !/@/.test(line)) {
                return null;
            }
            return s.slice(0, -3);
        }
    }
    return null;
}

function normalizeProtocolLabel(scheme) {
    if (scheme === 'hysteria2' || scheme === 'hy2') return 'HY2';
    if (scheme === 'hysteria') return 'HY1';
    if (scheme === 'wireguard' || scheme === 'wg') return 'WG';
    if (scheme === 'socks' || scheme === 'socks5') return 'SOCKS';
    return scheme.toUpperCase();
}

function cleanNodeNameText(name) {
    return String(name || '').replace(/\s+/g, ' ').trim();
}

function extractNodeName(uri, scheme) {
    if (scheme === 'vmess') {
        const b64Part = uri.slice(8).trim();
        try {
            const obj = JSON.parse(base64Decode(b64Part));
            return { name: String(obj.ps || ''), vmessObj: obj };
        } catch {
            return { name: '' };
        }
    }
    if (scheme === 'ssr') {
        const b64Part = uri.slice(6).trim();
        try {
            const decoded = base64Decode(b64Part);
            const match = decoded.match(/[?&]remarks=([^&]+)/);
            const name = match ? base64Decode(match[1]) : '';
            return { name, ssrDecoded: decoded };
        } catch {
            return { name: '' };
        }
    }
    const hashIdx = uri.lastIndexOf('#');
    if (hashIdx === -1) return { name: '' };
    const rawFrag = uri.slice(hashIdx + 1);
    try {
        return { name: decodeURIComponent(rawFrag) };
    } catch {
        return { name: rawFrag };
    }
}

function applyNodeName(uri, scheme, newName, parsed) {
    if (scheme === 'vmess' && parsed && parsed.vmessObj) {
        try {
            const updated = { ...parsed.vmessObj, ps: newName };
            return 'vmess://' + utf8ToBase64(JSON.stringify(updated));
        } catch {
            return uri;
        }
    }
    if (scheme === 'ssr' && parsed && parsed.ssrDecoded) {
        try {
            const encodedRemarks = utf8ToBase64(newName).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            let nextDecoded = parsed.ssrDecoded;
            if (/[?&]remarks=[^&]*/.test(nextDecoded)) {
                nextDecoded = nextDecoded.replace(/([?&]remarks=)[^&]*/, `$1${encodedRemarks}`);
            } else {
                nextDecoded += (nextDecoded.includes('?') ? '&' : '/?') + `remarks=${encodedRemarks}`;
            }
            const nextB64 = utf8ToBase64(nextDecoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            return 'ssr://' + nextB64;
        } catch {
            return uri;
        }
    }
    const hashIdx = uri.lastIndexOf('#');
    const base = hashIdx === -1 ? uri : uri.slice(0, hashIdx);
    return `${base}#${encodeURIComponent(newName)}`;
}

function buildSafeRegex(expr) {
    const raw = (expr || '').trim();
    if (!raw) return null;
    // 允许用户用中文逗号、英文逗号或竖线分隔关键词，同时兼容直接输入正则
    const normalized = raw.includes('|') ? raw : raw.replace(/[，,]+/g, '|');
    try {
        return new RegExp(normalized, 'i');
    } catch {
        const escaped = normalized.split('|').filter(Boolean).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        return escaped ? new RegExp(escaped, 'i') : null;
    }
}

function mergeProtocolCounts(target, source) {
    for (const [k, v] of Object.entries(source || {})) {
        target[k] = (target[k] || 0) + v;
    }
}

function parseSubscriptionUserinfo(headerVal) {
    if (!headerVal) return null;
    const map = {};
    headerVal.split(';').forEach(part => {
        const [k, v] = part.split('=').map(s => (s || '').trim());
        if (k && v && !isNaN(Number(v))) map[k.toLowerCase()] = Number(v);
    });
    if (Object.keys(map).length === 0) return null;
    const used = (map.upload || 0) + (map.download || 0);
    const total = map.total || 0;
    const expire = map.expire ? (map.expire > 1e11 ? Math.floor(map.expire / 1000) : map.expire) : 0;
    return { usedBytes: used, totalBytes: total, expireSeconds: expire };
}

// ============================================================
// 基础编码与安全辅助函数
// ============================================================
function isValidBase64(str) {
    if (!str || str.length < 10) return false;
    if (str.includes('://') || str.includes('proxies:')) return false;
    const compact = str.replace(/\s+/g, '');
    return /^[A-Za-z0-9+/_-]+={0,2}$/.test(compact);
}

function base64Decode(str) {
    let s = String(str || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const binary = atob(s);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return binary;
    }
}

function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str || '');
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeConfig(rawConfig) {
    if (!rawConfig) return '';
    const trimmed = rawConfig.trim();
    if (!trimmed) return '';
    const compact = trimmed.replace(/ /g, '+').replace(/\s+/g, '');
    if (isValidBase64(compact)) return compact;
    return trimmed;
}

function sanitizeFileToken(token) {
    if (!token) return '';
    return token.toString().trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, m => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[m]));
}

function formatDateYMD(ms) {
    try {
        const d = new Date(ms);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    } catch {
        return '2099-12-31';
    }
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

async function nginx() {
    return `<!DOCTYPE html><html><head><title>Welcome</title></head><body><h1>Welcome to nginx!</h1></body></html>`;
}

// ============================================================
// UI 渲染函数（含单链自动适配、节点治理、可视化规则构建器、健康检测）
// ============================================================
async function renderUI(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin;
    const rawContent = (env.KV && ctx.isAdmin) ? ((await env.KV.get('LINK.txt')) || '') : '';

    const safeFileName = escapeHtml(ctx.FileName);
    const safeSubConverter = escapeHtml(ctx.subConverter);
    const safeContent = escapeHtml(rawContent);
    const guestToggleHtml = ctx.isAdmin
        ? '<label class="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer bg-slate-50 border border-slate-200 px-2.5 py-1.5 rounded-lg" title="分享给他人时开启，隐藏管理员 Token"><input type="checkbox" id="useGuestLink" class="accent-indigo-600" onchange="updateLink()"><span>访客链接</span></label>'
        : '';

    const appConfigJson = JSON.stringify({
        origin,
        token: ctx.token,
        guestToken: ctx.guestToken,
        isAdmin: ctx.isAdmin,
        fileName: ctx.FileName,
        hasKV: ctx.hasKV
    }).replace(/</g, '\\u003c');

    const ruleCheckboxesHtml = [
        'Ad Block', 'AI Services', 'Bilibili', 'Youtube', 'Google', 'Private',
        'Location:CN', 'Telegram', 'Github', 'Microsoft', 'Apple', 'Social Media',
        'Streaming', 'Gaming', 'Education', 'Financial', 'Cloud Services', 'Non-China'
    ].map(name => `
        <label class="flex items-center gap-2 bg-slate-50 hover:bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium text-slate-700 cursor-pointer transition">
            <input type="checkbox" value="${escapeHtml(name)}" class="rule-check accent-indigo-600" onchange="updateLink()">
            <span>${escapeHtml(name)}</span>
        </label>
    `).join('');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeFileName} 管理面板</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <style>
        body { background-color: #f8fafc; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
        .glass-card { background: white; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(15, 23, 42, 0.06); }
        .form-select, .form-input, .form-textarea { width: 100%; border-radius: 0.75rem; border: 1px solid #cbd5e1; padding: 0.55rem 0.9rem; background-color: #f8fafc; transition: all 0.2s; font-size: 0.875rem; }
        .form-select:focus, .form-input:focus, .form-textarea:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12); background-color: white; }
        .btn { transition: all 0.18s; }
        .btn:active { transform: scale(0.98); }
    </style>
</head>
<body class="min-h-screen py-6 md:py-8 px-4 text-slate-700">
    <div class="max-w-6xl mx-auto space-y-6">
        <!-- 顶部栏 -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-5 md:p-6 rounded-2xl shadow-sm border border-slate-100">
            <div>
                <h1 class="text-2xl font-bold text-slate-800 flex items-center gap-3">
                    <span class="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center"><i class="fa-solid fa-bolt"></i></span>
                    ${safeFileName}
                    <span class="text-xs font-medium px-2.5 py-0.5 rounded-full ${ctx.isAdmin ? 'bg-indigo-50 text-indigo-600' : 'bg-amber-50 text-amber-700'}">${ctx.isAdmin ? '管理员' : '访客只读'}</span>
                </h1>
                <p class="text-slate-500 text-xs mt-1.5">后端 API: <code class="bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">${safeSubConverter}</code></p>
            </div>
            <div class="flex items-center gap-2">
                <a href="https://github.com/JustDoIt166/sublink-worker" target="_blank" rel="noopener noreferrer" class="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-full transition text-slate-600">
                    <i class="fa-brands fa-github mr-1"></i> Powered by SubLink
                </a>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <!-- 左侧配置与管理区 -->
            <div class="lg:col-span-7 space-y-6">
                <!-- 1. 转换与分流配置 -->
                <div class="glass-card rounded-2xl p-5 md:p-6 space-y-5">
                    <h2 class="text-lg font-semibold flex items-center gap-2 text-slate-800">
                        <i class="fa-solid fa-sliders text-indigo-500"></i> 转换与分流配置
                    </h2>

                    <!-- 目标客户端（支持 UA 单链通用适配） -->
                    <div>
                        <label class="block text-sm font-medium text-slate-600 mb-2">目标客户端 (Target)</label>
                        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
                            <button type="button" onclick="setTarget('auto')" id="btn-auto" class="target-btn ring-2 ring-indigo-500 bg-indigo-50 text-indigo-700 py-2 px-2 rounded-xl border border-indigo-200 font-medium text-xs sm:text-sm">
                                <i class="fa-solid fa-wand-magic-sparkles mr-1"></i>自动适配
                            </button>
                            <button type="button" onclick="setTarget('singbox')" id="btn-singbox" class="target-btn bg-white hover:bg-slate-50 text-slate-600 py-2 px-2 rounded-xl border border-slate-200 font-medium text-xs sm:text-sm">Sing-Box</button>
                            <button type="button" onclick="setTarget('clash')" id="btn-clash" class="target-btn bg-white hover:bg-slate-50 text-slate-600 py-2 px-2 rounded-xl border border-slate-200 font-medium text-xs sm:text-sm">Clash</button>
                            <button type="button" onclick="setTarget('surge')" id="btn-surge" class="target-btn bg-white hover:bg-slate-50 text-slate-600 py-2 px-2 rounded-xl border border-slate-200 font-medium text-xs sm:text-sm">Surge</button>
                            <button type="button" onclick="setTarget('xray')" id="btn-xray" class="target-btn bg-white hover:bg-slate-50 text-slate-600 py-2 px-2 rounded-xl border border-slate-200 font-medium text-xs sm:text-sm">Xray</button>
                        </div>
                        <input type="hidden" id="targetInput" value="auto">
                        <p id="autoTargetHint" class="text-[11px] text-indigo-600 mt-2 bg-indigo-50/70 border border-indigo-100 rounded-lg px-3 py-1.5">
                            <i class="fa-solid fa-circle-info mr-1"></i>单链通用模式：根据客户端 User-Agent 自动输出 Clash / Sing-Box / Surge / Xray 配置。
                        </p>
                    </div>

                    <hr class="border-slate-100">

                    <!-- 基础分流规则（预设 / 多选） -->
                    <div class="space-y-3">
                        <div class="flex items-center justify-between">
                            <label class="block text-sm font-medium text-slate-600">基础分流规则 (Base Rules)</label>
                            <div class="flex bg-slate-100 p-1 rounded-xl">
                                <button type="button" onclick="toggleBaseRuleMode('preset')" id="tab-preset" class="px-3.5 py-1 rounded-lg text-xs font-medium bg-white shadow-sm text-indigo-600 transition-all">官方预设</button>
                                <button type="button" onclick="toggleBaseRuleMode('multi')" id="tab-multi" class="px-3.5 py-1 rounded-lg text-xs font-medium text-slate-500 hover:text-slate-700 transition-all">自由多选</button>
                            </div>
                        </div>

                        <div id="preset-area" class="space-y-2">
                            <div class="relative" id="presetDropdown">
                                <button type="button" onclick="togglePresetDropdown()" id="presetTrigger" class="w-full flex items-center justify-between bg-white border border-slate-200 hover:border-indigo-300 text-left px-4 py-2.5 rounded-xl text-sm font-medium text-slate-700 transition shadow-sm">
                                    <div>
                                        <p class="text-sm" id="presetLabel">Minimal · 精简模式</p>
                                        <p class="text-[11px] text-slate-500" id="presetHint">Location:CN · Private · Non-China</p>
                                    </div>
                                    <i class="fa-solid fa-chevron-down text-xs text-slate-400"></i>
                                </button>
                                <div id="presetMenu" class="hidden absolute z-20 mt-2 w-full bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
                                    <button type="button" class="w-full text-left px-4 py-3 hover:bg-indigo-50 transition flex justify-between items-start" onclick="setPreset('minimal','Minimal · 精简模式','Location:CN · Private · Non-China')">
                                        <div>
                                            <p class="text-sm font-semibold text-slate-800">Minimal</p>
                                            <p class="text-xs text-slate-500">Location:CN, Private, Non-China</p>
                                        </div>
                                        <span class="text-[11px] text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">推荐</span>
                                    </button>
                                    <button type="button" class="w-full text-left px-4 py-3 hover:bg-indigo-50 transition" onclick="setPreset('balanced','Balanced · 均衡模式','Minimal + Google + Youtube + Github + AI Services + Telegram')">
                                        <p class="text-sm font-semibold text-slate-800">Balanced</p>
                                        <p class="text-xs text-slate-500">Minimal + Google, Youtube, Github, AI Services, Telegram</p>
                                    </button>
                                    <button type="button" class="w-full text-left px-4 py-3 hover:bg-indigo-50 transition" onclick="setPreset('comprehensive','Comprehensive · 全量模式','包含全部可用规则')">
                                        <p class="text-sm font-semibold text-slate-800">Comprehensive</p>
                                        <p class="text-xs text-slate-500">包含全部可用规则</p>
                                    </button>
                                </div>
                                <input type="hidden" id="selectedRules" value="minimal">
                            </div>
                        </div>

                        <div id="multi-area" class="hidden space-y-2.5">
                            <p class="text-xs text-slate-500">勾选任意组合，自由拼装基础规则清单</p>
                            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                ${ruleCheckboxesHtml}
                            </div>
                        </div>
                    </div>

                    <hr class="border-slate-100">

                    <!-- 可视化 + JSON 双模式自定义规则（与基础规则可叠加） -->
                    <div class="space-y-3">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <div class="flex items-center gap-2">
                                <label class="text-sm font-medium text-slate-600">自定义叠加规则 (Custom Rules)</label>
                                <span id="customRuleStatus" class="text-[11px] font-medium text-slate-400">0 条启用</span>
                            </div>
                            <div class="flex items-center gap-3">
                                <div class="flex items-center gap-0.5 bg-slate-100 p-0.5 rounded-lg">
                                    <button type="button" onclick="switchCustomView('visual')" id="cv-btn-visual" class="px-2.5 py-1 rounded-md text-xs font-medium bg-white text-indigo-600 shadow-sm transition">
                                        <i class="fa-solid fa-layer-group mr-1"></i>可视化
                                    </button>
                                    <button type="button" onclick="switchCustomView('json')" id="cv-btn-json" class="px-2.5 py-1 rounded-md text-xs font-medium text-slate-500 hover:text-slate-700 transition">
                                        <i class="fa-solid fa-code mr-1"></i>JSON
                                    </button>
                                </div>
                                <label class="flex items-center gap-1.5 cursor-pointer select-none">
                                    <input type="checkbox" id="pinCheck" class="rounded accent-indigo-600" onchange="updateLink()">
                                    <span class="text-xs font-medium text-slate-600">置顶 (Pin)</span>
                                </label>
                            </div>
                        </div>

                        <!-- 快捷模板胶囊 -->
                        <div class="flex flex-wrap items-center gap-1.5">
                            <span class="text-[11px] text-slate-400 mr-0.5">快捷模板:</span>
                            <button type="button" onclick="addRuleTemplate('ai')" class="text-[11px] px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-100 transition">+ AI 专属</button>
                            <button type="button" onclick="addRuleTemplate('media')" class="text-[11px] px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-100 transition">+ 自建/Emby</button>
                            <button type="button" onclick="addRuleTemplate('direct')" class="text-[11px] px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-100 transition">+ 私有/内网</button>
                            <button type="button" onclick="addEmptyRule()" class="text-[11px] px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-200 transition ml-auto">
                                <i class="fa-solid fa-plus mr-1"></i>新建规则
                            </button>
                        </div>

                        <!-- 视图 1：可视化卡片列表 -->
                        <div id="custom-visual-view" class="space-y-2">
                            <div id="customRuleList" class="space-y-2"></div>
                            <div id="customRuleEmpty" class="text-center py-5 border border-dashed border-slate-300 rounded-xl bg-slate-50/60">
                                <p class="text-xs text-slate-400">暂无自定义规则，将仅使用上方基础分流规则；点击上方胶囊可快速叠加</p>
                            </div>
                        </div>

                        <!-- 视图 2：JSON 源码编辑区 -->
                        <div id="custom-json-view" class="hidden space-y-2">
                            <div class="flex items-center justify-between">
                                <span id="jsonValidationMsg" class="text-[11px] font-medium text-slate-400"></span>
                                <div class="flex gap-1.5">
                                    <button type="button" onclick="formatCustomJson()" class="text-[11px] px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-600 transition">格式化</button>
                                    <button type="button" onclick="clearCustomRules()" class="text-[11px] px-2 py-1 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-600 transition">清空</button>
                                </div>
                            </div>
                            <textarea id="customRules" rows="5" class="form-textarea font-mono text-xs leading-relaxed"
                                placeholder='[{"name":"AI专属","site":"openai,anthropic","domain_suffix":"claude.ai,chatgpt.com"}]'
                                oninput="onJsonInput()"></textarea>
                        </div>
                    </div>

                    <hr class="border-slate-100">

                    <!-- 节点清洗、过滤与自动重命名 -->
                    <div class="bg-slate-50/80 rounded-xl border border-slate-200 p-4 space-y-3.5">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-sm font-semibold text-slate-700 flex items-center gap-2">
                                    <i class="fa-solid fa-filter-circle-xmark text-indigo-500"></i> 节点清洗、过滤与自动重命名
                                </p>
                                <p class="text-[11px] text-slate-500 mt-0.5">自动剔除流量/到期/官网等垃圾节点，支持关键词过滤与来源前缀重命名</p>
                            </div>
                            <label class="relative inline-flex items-center cursor-pointer shrink-0">
                                <input type="checkbox" id="cleanCheck" class="sr-only peer" checked onchange="updateLink()">
                                <div class="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                            </label>
                        </div>

                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                                <label class="block text-xs font-medium text-slate-600 mb-1">仅保留包含 (include，正则/逗号分隔)</label>
                                <input id="includeInput" type="text" class="form-input bg-white text-xs" placeholder="例如：香港|台湾|日本|新加坡|美国" oninput="updateLink()">
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-slate-600 mb-1">排除包含 (exclude，正则/逗号分隔)</label>
                                <input id="excludeInput" type="text" class="form-input bg-white text-xs" placeholder="例如：测试|倍率|高倍|维护" oninput="updateLink()">
                            </div>
                        </div>

                        <div class="flex flex-wrap items-center gap-1.5">
                            <span class="text-[11px] text-slate-400">快捷过滤:</span>
                            <button type="button" onclick="applyQuickFilter('include','香港|台湾|日本|新加坡|美国|HK|TW|JP|SG|US')" class="text-[11px] px-2 py-0.5 rounded-full bg-white border border-slate-200 hover:border-indigo-300 text-slate-600 transition">仅留主流地区</button>
                            <button type="button" onclick="applyQuickFilter('exclude_junk','')" class="text-[11px] px-2 py-0.5 rounded-full bg-white border border-slate-200 hover:border-indigo-300 text-slate-600 transition">排除测试/高倍</button>
                            <button type="button" onclick="applyQuickFilter('clear','')" class="text-[11px] px-2 py-0.5 rounded-full bg-white border border-slate-200 hover:text-rose-600 text-slate-400 transition">重置过滤</button>
                        </div>

                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                            <div>
                                <label class="block text-xs font-medium text-slate-600 mb-1">自动重命名模式</label>
                                <select id="renameMode" class="form-select bg-white text-xs" onchange="onRenameModeChange()">
                                    <option value="">保持原节点名称</option>
                                    <option value="dedup">重名自动编号去重 (01, 02...)</option>
                                    <option value="prefix" selected>按订阅源别名加前缀 + 去重</option>
                                    <option value="custom">统一自定义前缀 + 去重</option>
                                </select>
                            </div>
                            <div id="customPrefixWrap" class="hidden">
                                <label class="block text-xs font-medium text-slate-600 mb-1">自定义前缀文本</label>
                                <input id="customPrefixInput" type="text" class="form-input bg-white text-xs" placeholder="例如：自用专线" oninput="updateLink()">
                            </div>
                        </div>
                    </div>

                    <!-- 高级选项 -->
                    <details class="bg-slate-50 rounded-xl border border-slate-200 p-4">
                        <summary class="cursor-pointer select-none text-sm font-semibold text-slate-700 flex items-center gap-2">
                            <i class="fa-solid fa-gear text-indigo-500"></i> 高级选项
                        </summary>
                        <div class="space-y-4 mt-4">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label class="block text-xs font-medium text-slate-600 mb-1">界面语言 (lang)</label>
                                    <select id="lang" class="form-select bg-white text-xs" onchange="updateLink()">
                                        <option value="">默认 (zh-CN)</option>
                                        <option value="zh-CN">中文 (zh-CN)</option>
                                        <option value="en-US">English (en-US)</option>
                                        <option value="fa">فارسی (fa)</option>
                                        <option value="ru">Русский (ru)</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-slate-600 mb-1">订阅拉取 UA (ua)</label>
                                    <input id="ua" type="text" class="form-input bg-white text-xs" placeholder="curl/7.74.0" oninput="updateLink()">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-slate-600 mb-1">模板 ID (configId)</label>
                                    <input id="configId" type="text" class="form-input bg-white text-xs" placeholder="singbox_xxxx" oninput="updateLink()">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-slate-600 mb-1">覆盖 config 参数 (可选)</label>
                                    <input id="configParam" type="text" class="form-input bg-white text-xs" placeholder="覆盖默认聚合订阅" oninput="updateLink()">
                                </div>
                            </div>

                            <div id="clashUiBox" class="p-3.5 rounded-xl border border-slate-200 bg-white space-y-3">
                                <div class="flex items-center justify-between">
                                    <div>
                                        <p class="text-xs font-semibold text-slate-700">Clash 面板支持</p>
                                        <p class="text-[11px] text-slate-500">开启外部控制器与自定义 Dashboard</p>
                                    </div>
                                    <label class="relative inline-flex items-center cursor-pointer">
                                        <input type="checkbox" id="enableClashUi" class="sr-only peer" onchange="updateLink()">
                                        <div class="w-10 h-5 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                                    </label>
                                </div>
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                    <input id="externalController" type="text" class="form-input text-xs" placeholder="external_controller (0.0.0.0:9090)" oninput="updateLink()">
                                    <input id="externalUi" type="text" class="form-input text-xs" placeholder="external_ui_download_url" oninput="updateLink()">
                                </div>
                            </div>

                            <div class="flex items-center justify-between pt-1">
                                <span class="text-xs font-medium text-slate-600">按国家/地区自动分组 (group_by_country)</span>
                                <label class="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" id="groupCheck" class="sr-only peer" onchange="updateLink()">
                                    <div class="w-10 h-5 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                                </label>
                            </div>
                        </div>
                    </details>
                </div>

                <!-- 2. 节点源管理与健康检测（仅管理员可见） -->
                <div class="glass-card rounded-2xl p-5 md:p-6 space-y-4 ${ctx.isAdmin ? '' : 'hidden'}">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <h2 class="text-lg font-semibold flex items-center gap-2 text-slate-800">
                                <i class="fa-solid fa-server text-indigo-500"></i> 节点源与健康检测
                            </h2>
                            <p class="text-[11px] text-slate-400 mt-0.5">支持每行一个节点 URI 或订阅 URL；URL 末尾加 <code class="bg-slate-100 px-1 rounded">#别名</code> 可用于自动重命名前缀</p>
                        </div>
                        <div class="flex items-center gap-2">
                            <button type="button" onclick="runHealthCheckUI()" id="checkBtn" class="btn text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 px-3.5 py-2 rounded-lg font-medium flex items-center gap-1.5">
                                <i class="fa-solid fa-heart-pulse"></i><span>健康检测与统计</span>
                            </button>
                            <button type="button" onclick="saveNodes()" id="saveBtn" class="btn text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium shadow-sm shadow-indigo-200 flex items-center gap-1.5 ${ctx.hasKV ? '' : 'opacity-50 cursor-not-allowed'}" ${ctx.hasKV ? '' : 'disabled title="未绑定 KV 命名空间"'}>
                                <i class="fa-solid fa-floppy-disk"></i><span>保存内容</span>
                            </button>
                        </div>
                    </div>

                    ${ctx.hasKV ? '' : '<div class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5"><i class="fa-solid fa-triangle-exclamation mr-1.5"></i>当前 Worker 未绑定名为 <code>KV</code> 的命名空间，在线保存功能已禁用（仍可使用环境变量 LINKSUB 或在线健康检测）。</div>'}

                    <textarea id="nodeContent" class="form-textarea h-56 font-mono text-xs leading-relaxed" placeholder="https://example.com/sub1 #机场A&#10;https://example.com/sub2 #备用节点&#10;vless://...&#10;vmess://...">${safeContent}</textarea>
                    <p id="saveMsg" class="text-right text-xs h-4 font-medium"></p>

                    <!-- 健康检测与节点统计报告面板 -->
                    <div id="healthPanel" class="hidden border-t border-slate-100 pt-4 space-y-4">
                        <div class="flex items-center justify-between">
                            <h3 class="text-sm font-semibold text-slate-700 flex items-center gap-2">
                                <i class="fa-solid fa-chart-pie text-emerald-500"></i> 订阅源健康与节点统计报告
                            </h3>
                            <span id="healthCheckedAt" class="text-[11px] text-slate-400"></span>
                        </div>

                        <div id="healthSummaryGrid" class="grid grid-cols-2 sm:grid-cols-4 gap-2.5"></div>
                        <div id="healthProtocolsBar" class="flex flex-wrap items-center gap-1.5"></div>
                        <div id="healthSourceList" class="space-y-2 max-h-80 overflow-y-auto pr-1"></div>
                    </div>
                </div>
            </div>

            <!-- 右侧订阅生成卡片 -->
            <div class="lg:col-span-5 space-y-6">
                <div class="glass-card rounded-2xl p-6 sticky top-6 border-t-4 border-t-indigo-500">
                    <div class="flex items-center justify-between mb-5">
                        <div>
                            <h2 class="text-lg font-bold text-slate-800">订阅链接就绪</h2>
                            <p class="text-xs text-slate-400 mt-0.5" id="modeBadgeText">当前模式：单链通用自动适配</p>
                        </div>
                        ${guestToggleHtml}
                    </div>

                    <button type="button" onclick="toggleQRCode()" id="qrToggleBtn" class="w-full py-2.5 mb-4 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-indigo-600 transition flex items-center justify-center gap-2 shadow-sm">
                        <i class="fa-solid fa-qrcode"></i>
                        <span id="qrBtnText">显示二维码</span>
                    </button>

                    <div id="qrContainer" class="hidden p-4 rounded-xl border border-dashed border-slate-300 flex justify-center mb-5 shadow-inner bg-slate-50">
                        <div id="qrcode" class="mix-blend-multiply opacity-95"></div>
                    </div>

                    <div class="space-y-3.5">
                        <div class="relative">
                            <input type="text" id="finalLink" class="form-input pr-20 text-xs text-slate-600 bg-slate-50 font-mono cursor-text" readonly onclick="this.select()">
                            <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                <a id="previewBtn" href="#" target="_blank" rel="noopener noreferrer" title="新窗口预览配置" class="text-slate-400 hover:text-indigo-600 p-1.5 transition">
                                    <i class="fa-solid fa-arrow-up-right-from-square text-xs"></i>
                                </a>
                                <button type="button" id="copyBtn" onclick="copyLink()" title="复制订阅链接" class="text-slate-400 hover:text-indigo-600 p-1.5 transition">
                                    <i class="fa-regular fa-copy"></i>
                                </button>
                            </div>
                        </div>

                        <a id="importBtn" href="#" class="btn block w-full text-center bg-slate-800 hover:bg-slate-900 text-white py-3 rounded-xl font-semibold text-sm shadow-lg shadow-slate-200 transition flex items-center justify-center gap-2">
                            <i class="fa-solid fa-download"></i>
                            <span>一键导入到客户端</span>
                        </a>

                        <!-- 单链通用模式下的多客户端快捷导入栏 -->
                        <div id="quickImportRow" class="grid grid-cols-3 gap-2 pt-1">
                            <a id="quickClash" href="#" class="text-center text-xs py-2 rounded-lg bg-slate-50 hover:bg-indigo-50 hover:text-indigo-600 border border-slate-200 transition font-medium">导入 Clash</a>
                            <a id="quickSingbox" href="#" class="text-center text-xs py-2 rounded-lg bg-slate-50 hover:bg-indigo-50 hover:text-indigo-600 border border-slate-200 transition font-medium">导入 Sing-Box</a>
                            <a id="quickSurge" href="#" class="text-center text-xs py-2 rounded-lg bg-slate-50 hover:bg-indigo-50 hover:text-indigo-600 border border-slate-200 transition font-medium">导入 Surge</a>
                        </div>
                    </div>

                    <div class="mt-6 pt-5 border-t border-slate-100 grid grid-cols-2 gap-4 text-center">
                        <div>
                            <p class="text-xs text-slate-400 mb-1">预设总量</p>
                            <p class="text-indigo-600 font-bold text-lg">${escapeHtml(String(ctx.totalTB))} <span class="text-xs">TB</span></p>
                        </div>
                        <div>
                            <p class="text-xs text-slate-400 mb-1">过期时间</p>
                            <p class="text-slate-600 font-bold text-sm mt-1">${escapeHtml(ctx.expireDateStr)}</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const APP_CFG = ${appConfigJson};
        const CUSTOM_STORAGE_KEY = 'sublink_custom_rules_v2';

        let baseRuleMode = 'preset';
        let isQRVisible = false;
        let copyTimer = null;
        let customRulesState = [];

        const RULE_TEMPLATES = {
            ai: { name: 'AI 专属', site: 'openai,anthropic,google-gemini', domain_suffix: 'claude.ai,chatgpt.com,perplexity.ai' },
            media: { name: '自建 Emby', domain_suffix: 'emby.example.com', domain_keyword: 'emby' },
            direct: { name: '私有内网', ip_cidr: '10.0.0.0/8,192.168.0.0/16', domain_suffix: 'corp.local' }
        };

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

        function escHtml(str) {
            return String(str || '').replace(/[&<>"']/g, function(m) {
                return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
            });
        }

        function normalizeRuleListStr(val) {
            return String(val || '').replace(/[，\\n\\r]+/g, ',').split(',').map(function(s) { return s.trim(); }).filter(Boolean).join(',');
        }

        function formatBytes(bytes) {
            if (!bytes || bytes <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let i = 0;
            let n = bytes;
            while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
            return n.toFixed(n >= 100 ? 0 : 1) + ' ' + units[i];
        }

        // ---------------- 目标客户端 ----------------
        function setTarget(target) {
            document.getElementById('targetInput').value = target;
            document.querySelectorAll('.target-btn').forEach(function(btn) {
                btn.classList.remove('bg-indigo-50', 'text-indigo-700', 'ring-2', 'ring-indigo-500', 'border-indigo-200');
                btn.classList.add('bg-white', 'text-slate-600', 'border-slate-200');
            });
            const activeBtn = document.getElementById('btn-' + target);
            if (activeBtn) {
                activeBtn.classList.remove('bg-white', 'text-slate-600', 'border-slate-200');
                activeBtn.classList.add('bg-indigo-50', 'text-indigo-700', 'ring-2', 'ring-indigo-500', 'border-indigo-200');
            }
            document.getElementById('autoTargetHint').classList.toggle('hidden', target !== 'auto');
            document.getElementById('clashUiBox').classList.toggle('hidden', target !== 'clash' && target !== 'auto');
            document.getElementById('quickImportRow').classList.toggle('hidden', target !== 'auto');
            updateLink();
        }

        // ---------------- 基础规则切换 ----------------
        function toggleBaseRuleMode(mode) {
            baseRuleMode = mode;
            const presetArea = document.getElementById('preset-area');
            const multiArea = document.getElementById('multi-area');
            const tabPreset = document.getElementById('tab-preset');
            const tabMulti = document.getElementById('tab-multi');

            const isPreset = mode === 'preset';
            presetArea.classList.toggle('hidden', !isPreset);
            multiArea.classList.toggle('hidden', isPreset);
            if (!isPreset) togglePresetDropdown(true);

            tabPreset.className = isPreset
                ? 'px-3.5 py-1 rounded-lg text-xs font-medium bg-white shadow-sm text-indigo-600 transition-all'
                : 'px-3.5 py-1 rounded-lg text-xs font-medium text-slate-500 hover:text-slate-700 transition-all';
            tabMulti.className = !isPreset
                ? 'px-3.5 py-1 rounded-lg text-xs font-medium bg-white shadow-sm text-indigo-600 transition-all'
                : 'px-3.5 py-1 rounded-lg text-xs font-medium text-slate-500 hover:text-slate-700 transition-all';

            updateLink();
        }

        function togglePresetDropdown(forceClose) {
            const menu = document.getElementById('presetMenu');
            const trigger = document.getElementById('presetTrigger');
            if (forceClose) {
                menu.classList.add('hidden');
                trigger.classList.remove('ring-2', 'ring-indigo-500', 'border-indigo-200');
                return;
            }
            const isHidden = menu.classList.contains('hidden');
            menu.classList.toggle('hidden', !isHidden);
            trigger.classList.toggle('ring-2', isHidden);
            trigger.classList.toggle('ring-indigo-500', isHidden);
            trigger.classList.toggle('border-indigo-200', isHidden);
        }

        function setPreset(value, label, hint) {
            document.getElementById('selectedRules').value = value;
            document.getElementById('presetLabel').innerText = label;
            if (hint) document.getElementById('presetHint').innerText = hint;
            togglePresetDropdown(true);
            updateLink();
        }

        document.addEventListener('click', function(e) {
            const dd = document.getElementById('presetDropdown');
            if (dd && !dd.contains(e.target)) togglePresetDropdown(true);
        });

        // ---------------- 节点过滤与重命名 ----------------
        function applyQuickFilter(type, val) {
            if (type === 'clear') {
                document.getElementById('includeInput').value = '';
                document.getElementById('excludeInput').value = '';
            } else if (type === 'include') {
                document.getElementById('includeInput').value = val;
            } else if (type === 'exclude_junk') {
                document.getElementById('excludeInput').value = '测试|维护|倍率|实验|0\\\\.1|5x|10x';
            } else if (type === 'exclude') {
                document.getElementById('excludeInput').value = val;
            }
            updateLink();
        }

        function onRenameModeChange() {
            const mode = document.getElementById('renameMode').value;
            document.getElementById('customPrefixWrap').classList.toggle('hidden', mode !== 'custom');
            updateLink();
        }

        // ---------------- 自定义规则可视化构建器 ----------------
        function loadCustomRulesFromStorage() {
            try {
                const saved = localStorage.getItem(CUSTOM_STORAGE_KEY);
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (Array.isArray(parsed)) customRulesState = parsed;
                }
            } catch (e) {}
            syncStateToJsonAndRender();
        }

        function saveCustomRulesToStorage() {
            try {
                localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(customRulesState));
            } catch (e) {}
        }

        function getActiveCustomRulesPayload() {
            return customRulesState.filter(function(r) { return r._enabled !== false; }).map(function(r) {
                const out = {};
                Object.keys(r).forEach(function(k) {
                    if (k.startsWith('_')) return;
                    const val = k === 'name' ? String(r[k] || '').trim() : normalizeRuleListStr(r[k]);
                    if (val) out[k] = val;
                });
                if (!out.name) out.name = '未命名规则';
                return out;
            }).filter(function(obj) {
                return Object.keys(obj).some(function(k) { return k !== 'name' && obj[k]; });
            });
        }

        function switchCustomView(view) {
            const isVisual = view === 'visual';
            document.getElementById('custom-visual-view').classList.toggle('hidden', !isVisual);
            document.getElementById('custom-json-view').classList.toggle('hidden', isVisual);
            document.getElementById('cv-btn-visual').className = isVisual
                ? 'px-2.5 py-1 rounded-md text-xs font-medium bg-white text-indigo-600 shadow-sm transition'
                : 'px-2.5 py-1 rounded-md text-xs font-medium text-slate-500 hover:text-slate-700 transition';
            document.getElementById('cv-btn-json').className = !isVisual
                ? 'px-2.5 py-1 rounded-md text-xs font-medium bg-white text-indigo-600 shadow-sm transition'
                : 'px-2.5 py-1 rounded-md text-xs font-medium text-slate-500 hover:text-slate-700 transition';
        }

        function addEmptyRule() {
            customRulesState.forEach(function(r) { r._open = false; });
            customRulesState.push({
                _enabled: true, _open: true,
                name: '新规则 ' + (customRulesState.length + 1),
                site: '', domain_suffix: '', domain_keyword: '', ip_cidr: '', ip: '', protocol: ''
            });
            syncStateToJsonAndRender();
        }

        function addRuleTemplate(key) {
            const tpl = RULE_TEMPLATES[key];
            if (!tpl) return;
            customRulesState.forEach(function(r) { r._open = false; });
            customRulesState.push(Object.assign({ _enabled: true, _open: true }, tpl));
            syncStateToJsonAndRender();
        }

        function toggleRuleOpen(idx) {
            customRulesState[idx]._open = !customRulesState[idx]._open;
            renderCustomRuleCards();
        }

        function toggleRuleEnabled(idx, checked) {
            customRulesState[idx]._enabled = checked;
            syncStateToJsonAndRender();
        }

        function moveRule(idx, dir) {
            const t = idx + dir;
            if (t < 0 || t >= customRulesState.length) return;
            const tmp = customRulesState[idx];
            customRulesState[idx] = customRulesState[t];
            customRulesState[t] = tmp;
            syncStateToJsonAndRender();
        }

        function removeRule(idx) {
            customRulesState.splice(idx, 1);
            syncStateToJsonAndRender();
        }

        function onRuleFieldInput(el) {
            const idx = Number(el.getAttribute('data-idx'));
            const field = el.getAttribute('data-field');
            if (!isNaN(idx) && field) updateRuleField(idx, field, el.value);
        }

        function updateRuleField(idx, field, value) {
            customRulesState[idx][field] = value;
            saveCustomRulesToStorage();
            const payload = getActiveCustomRulesPayload();
            document.getElementById('customRules').value = payload.length ? JSON.stringify(payload, null, 2) : '';
            updateCustomStatusBadge(payload.length);
            updateLink();
        }

        function clearCustomRules() {
            customRulesState = [];
            syncStateToJsonAndRender();
        }

        function formatCustomJson() {
            const el = document.getElementById('customRules');
            if (!el.value.trim()) return;
            try {
                el.value = JSON.stringify(JSON.parse(el.value), null, 2);
                onJsonInput();
            } catch (e) {}
        }

        function onJsonInput() {
            const raw = document.getElementById('customRules').value.trim();
            const msg = document.getElementById('jsonValidationMsg');
            if (!raw) {
                customRulesState = [];
                msg.textContent = '';
                saveCustomRulesToStorage();
                renderCustomRuleCards();
                updateCustomStatusBadge(0);
                updateLink();
                return;
            }
            try {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) throw new Error('根节点必须是 JSON 数组 [...]');
                customRulesState = parsed.map(function(item) {
                    return Object.assign({ _enabled: true, _open: false }, item);
                });
                msg.textContent = '✅ JSON 语法有效 (' + parsed.length + ' 条)';
                msg.className = 'text-[11px] text-emerald-600 font-medium';
                saveCustomRulesToStorage();
                renderCustomRuleCards();
                updateCustomStatusBadge(getActiveCustomRulesPayload().length);
                updateLink();
            } catch (err) {
                msg.textContent = '❌ 语法错误: ' + err.message;
                msg.className = 'text-[11px] text-rose-600 font-medium';
            }
        }

        function updateCustomStatusBadge(activeCount) {
            const badge = document.getElementById('customRuleStatus');
            badge.textContent = activeCount + ' / ' + customRulesState.length + ' 条启用';
            badge.className = activeCount > 0
                ? 'text-[11px] font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full'
                : 'text-[11px] font-medium text-slate-400';
        }

        function syncStateToJsonAndRender() {
            saveCustomRulesToStorage();
            const payload = getActiveCustomRulesPayload();
            document.getElementById('customRules').value = payload.length ? JSON.stringify(payload, null, 2) : '';
            document.getElementById('jsonValidationMsg').textContent = payload.length ? ('✅ JSON 语法有效 (' + payload.length + ' 条)') : '';
            updateCustomStatusBadge(payload.length);
            renderCustomRuleCards();
            updateLink();
        }

        function renderCustomRuleCards() {
            const listEl = document.getElementById('customRuleList');
            const emptyEl = document.getElementById('customRuleEmpty');
            emptyEl.classList.toggle('hidden', customRulesState.length > 0);

            listEl.innerHTML = customRulesState.map(function(rule, idx) {
                const enabled = rule._enabled !== false;
                const badges = [];
                if (rule.site) badges.push('<span class="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">Site</span>');
                if (rule.domain_suffix || rule.domain_keyword) badges.push('<span class="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600">Domain</span>');
                if (rule.ip_cidr || rule.ip) badges.push('<span class="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">IP</span>');
                if (rule.protocol) badges.push('<span class="px-1.5 py-0.5 rounded bg-purple-50 text-purple-600">Proto</span>');

                const detailHtml = rule._open ? (
                    '<div class="p-3 pt-2 border-t border-slate-100 bg-slate-50/70 space-y-2.5">' +
                        '<div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">' +
                            '<div><label class="block text-[11px] font-medium text-slate-500 mb-1">规则名称 (name)</label>' +
                                '<input type="text" data-idx="' + idx + '" data-field="name" class="form-input !py-1.5 !px-2.5 text-xs bg-white" value="' + escHtml(rule.name) + '" oninput="onRuleFieldInput(this)" placeholder="例如：AI 专属"></div>' +
                            '<div><label class="block text-[11px] font-medium text-slate-500 mb-1">Geosite 集合 (site)</label>' +
                                '<input type="text" data-idx="' + idx + '" data-field="site" class="form-input !py-1.5 !px-2.5 text-xs font-mono bg-white" value="' + escHtml(rule.site) + '" oninput="onRuleFieldInput(this)" placeholder="openai,anthropic"></div>' +
                            '<div><label class="block text-[11px] font-medium text-slate-500 mb-1">域名后缀 (domain_suffix)</label>' +
                                '<input type="text" data-idx="' + idx + '" data-field="domain_suffix" class="form-input !py-1.5 !px-2.5 text-xs font-mono bg-white" value="' + escHtml(rule.domain_suffix) + '" oninput="onRuleFieldInput(this)" placeholder="claude.ai,chatgpt.com"></div>' +
                            '<div><label class="block text-[11px] font-medium text-slate-500 mb-1">域名关键词 (domain_keyword)</label>' +
                                '<input type="text" data-idx="' + idx + '" data-field="domain_keyword" class="form-input !py-1.5 !px-2.5 text-xs font-mono bg-white" value="' + escHtml(rule.domain_keyword) + '" oninput="onRuleFieldInput(this)" placeholder="openai,emby"></div>' +
                            '<div><label class="block text-[11px] font-medium text-slate-500 mb-1">IP 段 (ip_cidr)</label>' +
                                '<input type="text" data-idx="' + idx + '" data-field="ip_cidr" class="form-input !py-1.5 !px-2.5 text-xs font-mono bg-white" value="' + escHtml(rule.ip_cidr) + '" oninput="onRuleFieldInput(this)" placeholder="192.168.0.0/16,10.0.0.0/8"></div>' +
                            '<div><label class="block text-[11px] font-medium text-slate-500 mb-1">GeoIP / 协议 (ip / protocol)</label>' +
                                '<div class="grid grid-cols-2 gap-1.5">' +
                                    '<input type="text" data-idx="' + idx + '" data-field="ip" class="form-input !py-1.5 !px-2 text-xs font-mono bg-white" value="' + escHtml(rule.ip) + '" oninput="onRuleFieldInput(this)" placeholder="cn">' +
                                    '<input type="text" data-idx="' + idx + '" data-field="protocol" class="form-input !py-1.5 !px-2 text-xs font-mono bg-white" value="' + escHtml(rule.protocol) + '" oninput="onRuleFieldInput(this)" placeholder="quic">' +
                                '</div></div>' +
                        '</div>' +
                        '<p class="text-[11px] text-slate-400">多项可用中英文逗号或换行分隔，留空字段会自动忽略。</p>' +
                    '</div>'
                ) : '';

                return (
                    '<div class="rounded-xl border transition overflow-hidden ' + (enabled ? 'bg-white border-slate-200 hover:border-indigo-300 shadow-sm' : 'bg-slate-50 border-slate-200/70 opacity-60') + '">' +
                        '<div class="flex items-center justify-between px-3 py-2.5 gap-2">' +
                            '<div class="flex items-center gap-2 min-w-0 flex-1 cursor-pointer" onclick="toggleRuleOpen(' + idx + ')">' +
                                '<i class="fa-solid ' + (rule._open ? 'fa-chevron-down text-indigo-500' : 'fa-chevron-right text-slate-400') + ' text-[11px] w-3"></i>' +
                                '<span class="text-xs font-semibold text-slate-700 truncate">' + escHtml(rule.name || '未命名规则') + '</span>' +
                                '<div class="hidden sm:flex items-center gap-1 text-[10px] font-medium">' + (badges.join('') || '<span class="text-slate-400">待配置条件</span>') + '</div>' +
                            '</div>' +
                            '<div class="flex items-center gap-1 shrink-0">' +
                                '<button type="button" onclick="moveRule(' + idx + ',-1)" title="上移" class="p-1 text-slate-400 hover:text-indigo-600 text-xs"><i class="fa-solid fa-arrow-up"></i></button>' +
                                '<button type="button" onclick="moveRule(' + idx + ',1)" title="下移" class="p-1 text-slate-400 hover:text-indigo-600 text-xs"><i class="fa-solid fa-arrow-down"></i></button>' +
                                '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' onchange="toggleRuleEnabled(' + idx + ',this.checked)" title="启用/禁用" class="accent-indigo-600 cursor-pointer mx-1">' +
                                '<button type="button" onclick="removeRule(' + idx + ')" title="删除" class="p-1 text-slate-400 hover:text-rose-500 text-xs"><i class="fa-regular fa-trash-can"></i></button>' +
                            '</div>' +
                        '</div>' +
                        detailHtml +
                    '</div>'
                );
            }).join('');
        }

        // ---------------- 链接生成与二维码 ----------------
        function getActiveRenameValue() {
            const mode = document.getElementById('renameMode').value;
            if (mode === 'custom') return document.getElementById('customPrefixInput').value.trim();
            return mode;
        }

        function updateLink() {
            const target = document.getElementById('targetInput').value;
            const isGroup = document.getElementById('groupCheck').checked;
            const useGuestEl = document.getElementById('useGuestLink');
            const activeToken = (useGuestEl && useGuestEl.checked) ? APP_CFG.guestToken : APP_CFG.token;
            const baseUrl = APP_CFG.origin + '/' + encodeURIComponent(activeToken);

            const params = new URLSearchParams();
            params.append('target', target);
            params.append('group_by_country', isGroup ? 'true' : 'false');

            // 基础规则
            if (baseRuleMode === 'multi') {
                const checked = Array.from(document.querySelectorAll('.rule-check:checked')).map(function(el) { return el.value; });
                params.append('selectedRules', checked.length > 0 ? JSON.stringify(checked) : 'minimal');
            } else {
                params.append('selectedRules', document.getElementById('selectedRules').value || 'minimal');
            }

            // 叠加自定义规则（自动压缩 JSON 缩短链接）
            const activeCustom = getActiveCustomRulesPayload();
            if (activeCustom.length > 0) {
                params.append('customRules', JSON.stringify(activeCustom));
                if (document.getElementById('pinCheck').checked) {
                    params.append('pin', 'true');
                }
            }

            // 节点清洗、过滤与自动重命名参数
            const cleanEnabled = document.getElementById('cleanCheck').checked;
            const includeVal = document.getElementById('includeInput').value.trim();
            const excludeVal = document.getElementById('excludeInput').value.trim();
            const renameVal = getActiveRenameValue();

            if (!cleanEnabled) params.append('clean', 'false');
            if (includeVal) params.append('include', includeVal);
            if (excludeVal) params.append('exclude', excludeVal);
            if (renameVal) params.append('rename', renameVal);

            // 高级参数
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

            const finalUrl = baseUrl + '?' + params.toString();
            document.getElementById('finalLink').value = finalUrl;
            document.getElementById('previewBtn').href = finalUrl;

            const modeMap = {
                auto: '当前模式：单链通用自动适配 (按 UA)',
                singbox: '当前目标：Sing-Box (JSON)',
                clash: '当前目标：Clash / Mihomo (YAML)',
                surge: '当前目标：Surge (Conf)',
                xray: '当前目标：Xray / 通用节点'
            };
            document.getElementById('modeBadgeText').innerText = modeMap[target] || '';

            if (isQRVisible) renderQRCode(finalUrl);
            updateImportButton(target, finalUrl);
        }

        function toggleQRCode() {
            const container = document.getElementById('qrContainer');
            const btn = document.getElementById('qrToggleBtn');
            const txt = document.getElementById('qrBtnText');
            const link = document.getElementById('finalLink').value;

            if (container.classList.contains('hidden')) {
                container.classList.remove('hidden');
                btn.classList.add('ring-2', 'ring-indigo-500', 'border-transparent', 'text-indigo-600', 'bg-indigo-50');
                btn.classList.remove('bg-white', 'text-slate-600');
                txt.innerText = '隐藏二维码';
                isQRVisible = true;
                renderQRCode(link);
            } else {
                container.classList.add('hidden');
                btn.classList.remove('ring-2', 'ring-indigo-500', 'border-transparent', 'text-indigo-600', 'bg-indigo-50');
                btn.classList.add('bg-white', 'text-slate-600');
                txt.innerText = '显示二维码';
                isQRVisible = false;
            }
        }

        function renderQRCode(text) {
            const container = document.getElementById('qrcode');
            container.innerHTML = '';
            try {
                new QRCode(container, {
                    text: text,
                    width: 192,
                    height: 192,
                    colorDark: '#0f172a',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.L
                });
            } catch (e) {
                container.innerHTML = '<p class="text-xs text-rose-500 px-3 py-4 text-center">链接过长无法生成二维码，请精简自定义规则或直接复制链接。</p>';
            }
        }

        function updateImportButton(target, url) {
            const btn = document.getElementById('importBtn');
            const span = btn.querySelector('span');
            const encUrl = encodeURIComponent(url);
            const encName = encodeURIComponent(APP_CFG.fileName);

            document.getElementById('quickClash').href = 'clash://install-config?url=' + encUrl + '&name=' + encName;
            document.getElementById('quickSingbox').href = 'sing-box://import-remote-profile?url=' + encUrl + '#' + encName;
            document.getElementById('quickSurge').href = 'surge:///install-config?url=' + encUrl;

            if (target === 'clash') {
                btn.href = 'clash://install-config?url=' + encUrl + '&name=' + encName;
                span.innerText = '一键导入到 Clash';
            } else if (target === 'singbox') {
                btn.href = 'sing-box://import-remote-profile?url=' + encUrl + '#' + encName;
                span.innerText = '一键导入到 Sing-Box';
            } else if (target === 'surge') {
                btn.href = 'surge:///install-config?url=' + encUrl;
                span.innerText = '一键导入到 Surge';
            } else if (target === 'xray') {
                btn.href = url;
                span.innerText = '打开 Xray 订阅链接';
            } else {
                btn.href = 'clash://install-config?url=' + encUrl + '&name=' + encName;
                span.innerText = '使用默认客户端导入（或选下方指定 App）';
            }
        }

        function copyLink() {
            const el = document.getElementById('finalLink');
            const btn = document.getElementById('copyBtn');
            el.select();
            const showSuccess = function() {
                clearTimeout(copyTimer);
                btn.innerHTML = '<i class="fa-solid fa-check text-emerald-500"></i>';
                copyTimer = setTimeout(function() {
                    btn.innerHTML = '<i class="fa-regular fa-copy"></i>';
                }, 1500);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(el.value).then(showSuccess).catch(function() {
                    document.execCommand('copy');
                    showSuccess();
                });
            } else {
                document.execCommand('copy');
                showSuccess();
            }
        }

        // ---------------- 保存 KV 与健康检测 ----------------
        function saveNodes() {
            if (!APP_CFG.hasKV) return;
            const btn = document.getElementById('saveBtn');
            const msg = document.getElementById('saveMsg');
            const content = document.getElementById('nodeContent').value;

            btn.disabled = true;
            btn.classList.add('opacity-70', 'cursor-not-allowed');
            msg.innerText = '正在保存...';
            msg.className = 'text-right text-xs h-4 font-medium text-indigo-500';

            fetch(window.location.href, { method: 'POST', body: content })
                .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
                .then(function(r) {
                    if (r.ok && r.data && r.data.ok) {
                        msg.innerText = '✅ ' + (r.data.message || '保存成功');
                        msg.className = 'text-right text-xs h-4 font-medium text-emerald-600';
                        setTimeout(function() { msg.innerText = ''; }, 2500);
                    } else {
                        throw new Error((r.data && r.data.error) || '保存失败');
                    }
                })
                .catch(function(err) {
                    msg.innerText = '❌ ' + (err.message || '保存失败');
                    msg.className = 'text-right text-xs h-4 font-medium text-rose-600';
                })
                .finally(function() {
                    btn.disabled = false;
                    btn.classList.remove('opacity-70', 'cursor-not-allowed');
                });
        }

        function runHealthCheckUI() {
            const btn = document.getElementById('checkBtn');
            const panel = document.getElementById('healthPanel');
            const summaryGrid = document.getElementById('healthSummaryGrid');
            const protocolsBar = document.getElementById('healthProtocolsBar');
            const sourceList = document.getElementById('healthSourceList');

            btn.disabled = true;
            btn.classList.add('opacity-70', 'cursor-not-allowed');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>检测中...</span>';
            panel.classList.remove('hidden');
            summaryGrid.innerHTML = '<div class="col-span-full text-center py-6 text-xs text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-1.5"></i>正在并发探测所有订阅源并统计清洗结果...</div>';
            protocolsBar.innerHTML = '';
            sourceList.innerHTML = '';

            const checkUrl = APP_CFG.origin + '/' + encodeURIComponent(APP_CFG.token) + '?action=check';
            const payload = {
                content: document.getElementById('nodeContent').value,
                clean: document.getElementById('cleanCheck').checked,
                include: document.getElementById('includeInput').value.trim(),
                exclude: document.getElementById('excludeInput').value.trim(),
                rename: getActiveRenameValue()
            };

            fetch(checkUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (!data || !data.ok) throw new Error((data && data.error) || '检测失败');
                renderHealthReport(data);
            })
            .catch(function(err) {
                summaryGrid.innerHTML = '<div class="col-span-full text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-xl p-3">❌ 检测失败: ' + escHtml(err.message || err) + '</div>';
            })
            .finally(function() {
                btn.disabled = false;
                btn.classList.remove('opacity-70', 'cursor-not-allowed');
                btn.innerHTML = '<i class="fa-solid fa-heart-pulse"></i><span>健康检测与统计</span>';
            });
        }

        function renderHealthReport(data) {
            const s = data.summary || {};
            document.getElementById('healthCheckedAt').innerText = '检测于 ' + new Date(data.checkedAt).toLocaleTimeString();

            const cards = [
                { label: '远程源状态', val: s.healthySources + ' / ' + s.totalSources, cls: s.failedSources > 0 ? 'text-amber-600' : 'text-emerald-600' },
                { label: '有效节点', val: s.validNodes, cls: 'text-indigo-600' },
                { label: '清洗/过滤', val: s.filteredOut, cls: 'text-slate-600' },
                { label: '平均耗时', val: s.avgLatencyMs + ' ms', cls: s.avgLatencyMs > 3000 ? 'text-amber-600' : 'text-emerald-600' }
            ];
            document.getElementById('healthSummaryGrid').innerHTML = cards.map(function(c) {
                return '<div class="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">' +
                    '<p class="text-[11px] text-slate-400">' + c.label + '</p>' +
                    '<p class="text-base font-bold mt-0.5 ' + c.cls + '">' + escHtml(String(c.val)) + '</p>' +
                '</div>';
            }).join('');

            const protoEntries = Object.entries(s.protocols || {}).sort(function(a, b) { return b[1] - a[1]; });
            document.getElementById('healthProtocolsBar').innerHTML = protoEntries.length
                ? '<span class="text-[11px] text-slate-400 mr-1">协议分布:</span>' + protoEntries.map(function(kv) {
                    return '<span class="text-[11px] font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">' + escHtml(kv[0]) + ': ' + kv[1] + '</span>';
                }).join('')
                : '<span class="text-[11px] text-slate-400">未检测到有效 URI 节点</span>';

            const sources = data.sources || [];
            document.getElementById('healthSourceList').innerHTML = sources.length ? sources.map(function(src) {
                const statusDot = src.ok
                    ? '<span class="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>'
                    : '<span class="w-2 h-2 rounded-full bg-rose-500 shrink-0"></span>';
                const latencyBadge = src.origin === 'INLINE'
                    ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">本地</span>'
                    : '<span class="text-[10px] px-1.5 py-0.5 rounded ' + (src.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600') + '">' + (src.ok ? (src.latencyMs + 'ms') : ('异常 ' + (src.status || ''))) + '</span>';
                let trafficHtml = '';
                if (src.userinfo && src.userinfo.totalBytes > 0) {
                    const rem = Math.max(0, src.userinfo.totalBytes - src.userinfo.usedBytes);
                    const exp = src.userinfo.expireSeconds ? (' · 到期 ' + new Date(src.userinfo.expireSeconds * 1000).toISOString().slice(0, 10)) : '';
                    trafficHtml = '<p class="text-[11px] text-indigo-600 mt-1">剩余流量: ' + formatBytes(rem) + ' / ' + formatBytes(src.userinfo.totalBytes) + exp + '</p>';
                }
                const errHtml = src.error ? '<p class="text-[11px] text-rose-500 mt-1">' + escHtml(src.error) + '</p>' : '';

                return '<div class="border border-slate-200 rounded-xl p-3 bg-white">' +
                    '<div class="flex items-center justify-between gap-2">' +
                        '<div class="flex items-center gap-2 min-w-0">' +
                            statusDot +
                            '<span class="text-xs font-semibold text-slate-700 truncate">' + escHtml(src.name) + '</span>' +
                            '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">' + escHtml(src.format) + '</span>' +
                        '</div>' +
                        '<div class="flex items-center gap-1.5 shrink-0">' +
                            '<span class="text-[11px] text-slate-600 font-medium">' + src.validCount + '/' + src.rawCount + ' 节点</span>' +
                            latencyBadge +
                        '</div>' +
                    '</div>' +
                    (src.url ? '<p class="text-[11px] text-slate-400 font-mono truncate mt-1">' + escHtml(src.url) + '</p>' : '') +
                    trafficHtml +
                    errHtml +
                '</div>';
            }).join('') : '<p class="text-xs text-slate-400 text-center py-3">当前没有任何节点或订阅源</p>';
        }

        // 初始化页面状态
        loadCustomRulesFromStorage();
        setTarget('auto');
        toggleBaseRuleMode('preset');
    </script>
</body>
</html>`;

    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}
