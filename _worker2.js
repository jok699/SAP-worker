// 单文件多应用管理器 - 集成Telegram Bot和独立锁死机制，包含应用事件记录
const pad = n => String(n).padStart(2, "0");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { "content-type": "application/json" } });

// KV辅助函数
async function kvGet(env, key) {
  if (!env.START_LOCK) {
    console.warn("KV START_LOCK not available, returning null for", key);
    return null;
  }
  try {
    return await env.START_LOCK.get(key);
  } catch (error) {
    console.error("KV get error:", error.message);
    return null;
  }
}

async function kvPut(env, key, value, options = {}) {
  if (!env.START_LOCK) {
    console.warn("KV START_LOCK not available, skip put", key);
    return false;
  }
  try {
    await env.START_LOCK.put(key, value, options);
    return true;
  } catch (error) {
    console.error("KV put error:", error.message);
    return false;
  }
}

async function kvDelete(env, key) {
  if (!env.START_LOCK) {
    console.warn("KV START_LOCK not available, skip delete", key);
    return false;
  }
  try {
    await env.START_LOCK.delete(key);
    return true;
  } catch (error) {
    console.error("KV delete error:", error.message);
    return false;
  }
}

// 计算到第二天UTC 0点的秒数
function getSecondsUntilNextUTCMidnight() {
  const now = new Date();
  const utcNow = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds()
  );
  
  // 明天UTC 0点
  const nextUTCMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  );
  
  const seconds = Math.floor((nextUTCMidnight - utcNow) / 1000);
  return Math.max(3600, seconds); // 确保至少1小时
}

// 管理员检查函数
function isAdmin(env, userId) {
  if (!env.TELEGRAM_ADMIN_IDS) return false;
  
  try {
    const adminIds = env.TELEGRAM_ADMIN_IDS.split(',').map(id => id.trim());
    return adminIds.includes(userId.toString());
  } catch (error) {
    console.error('Admin check error:', error);
    return false;
  }
}

// 发送权限拒绝消息
async function sendPermissionDenied(env, chatId) {
  return sendTelegramMessage(env, chatId,
    '❌ <b>权限拒绝</b>\n\n' +
    '您没有管理员权限执行此操作。\n' +
    '请联系系统管理员获取访问权限。',
    'HTML'
  );
}

// Telegram Bot 工具函数
async function sendTelegramMessage(env, chatId, text, parseMode = 'HTML', replyMarkup = null) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    return;
  }
  
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: parseMode
    };
    
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    return await response.json();
  } catch (error) {
    console.error('Telegram send message error:', error);
  }
}

// 生成主菜单键盘
function createMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📋 应用列表", callback_data: "list_apps" },
        { text: "🔓 解锁所有", callback_data: "unlock_all" }
      ],
      [
        { text: "🚀 启动所有", callback_data: "start_all" },
        { text: "🔄 刷新状态", callback_data: "refresh_status" }
      ]
    ]
  };
}

// 生成返回键盘
function createBackKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "↩️ 返回主菜单", callback_data: "main_menu" }]
    ]
  };
}

// 生成应用列表键盘
function createAppListKeyboard(APPS, lockStatuses, appStatuses) {
  const buttons = APPS.filter(app => app.enabled !== false).map(app => {
    const lockStatus = lockStatuses.find(s => s.app === app.name);
    const appStatus = appStatuses.find(s => s.app === app.name);
    
    let statusIcon = '❓'; // 默认问号
    let lockIcon = '🔒'; // 默认锁定
    
    if (appStatus && appStatus.success) {
      statusIcon = appStatus.appState === 'STARTED' ? '✅' : '❌';
    }
    
    if (lockStatus) {
      lockIcon = lockStatus.locked ? '🔒' : '🔑'; // 使用锁头表示锁定，钥匙表示解锁
    }
    
    return {
      text: `${statusIcon} ${lockIcon} ${app.name}`,
      callback_data: `app_detail_${app.name}`
    };
  });
  
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  
  // 只添加返回主菜单按钮，移除解锁应用和启动应用按钮
  rows.push([{ text: "↩️ 返回主菜单", callback_data: "main_menu" }]);
  
  return { inline_keyboard: rows };
}

// 生成应用详情键盘（三级菜单）
function createAppDetailKeyboard(appName) {
  return {
    inline_keyboard: [
      [
        { text: "🔓 解锁", callback_data: `unlock_${appName}` },
        { text: "🚀 启动", callback_data: `startapp_${appName}` }
      ],
      [
        { text: "🔄 刷新详情", callback_data: `app_detail_${appName}` },
        { text: "📜 更多记录", callback_data: `more_events_${appName}_1` }
      ],
      [
        { text: "↩️ 返回列表", callback_data: "list_apps" },
        { text: "🏠 返回主页", callback_data: "main_menu" }
      ]
    ]
  };
}

// 生成事件记录键盘（分页）
function createEventsKeyboard(appName, currentPage = 1, totalPages = 1) {
  const keyboard = {
    inline_keyboard: []
  };
  
  // 分页按钮
  const pageButtons = [];
  if (currentPage > 1) {
    pageButtons.push({ text: "◀️ 上一页", callback_data: `more_events_${appName}_${currentPage - 1}` });
  }
  pageButtons.push({ text: `📄 ${currentPage}/${totalPages}`, callback_data: `no_action` });
  if (currentPage < totalPages) {
    pageButtons.push({ text: "下一页 ▶️", callback_data: `more_events_${appName}_${currentPage + 1}` });
  }
  
  if (pageButtons.length > 0) {
    keyboard.inline_keyboard.push(pageButtons);
  }
  
  // 操作按钮
  keyboard.inline_keyboard.push([
    { text: "🔙 返回详情", callback_data: `app_detail_${appName}` },
    { text: "↩️ 返回列表", callback_data: "list_apps" }
  ]);
  
  keyboard.inline_keyboard.push([
    { text: "🏠 返回主页", callback_data: "main_menu" }
  ]);
  
  return keyboard;
}

// 工具函数
async function cfGET(u, t) {
  const r = await fetch(u, { headers: { authorization: `Bearer ${t}` } });
  const x = await r.text();
  if (!r.ok) throw new Error(`CF GET ${r.status} ${u}: ${x.slice(0, 200)}`);
  return x ? JSON.parse(x) : {};
}

async function cfPOST(u, t, p) {
  const r = await fetch(u, { 
    method: "POST", 
    headers: { 
      authorization: `Bearer ${t}`,
      "content-type": "application/json" 
    }, 
    body: p ? JSON.stringify(p) : null 
  });
  const x = await r.text();
  if (!r.ok) throw new Error(`CF POST ${r.status} ${u}: ${x.slice(0, 200)}`);
  return x ? JSON.parse(x) : {};
}

async function getUAAToken(appConfig) {
  const u = appConfig.UAA_URL.replace(/\/+$/, "");
  const a = "Basic " + btoa("cf:");
  const b = new URLSearchParams();
  b.set("grant_type", "password");
  b.set("username", appConfig.CF_USERNAME);
  b.set("password", appConfig.CF_PASSWORD);
  b.set("response_type", "token");
  const r = await fetch(`${u}/oauth/token`, { 
    method: "POST", 
    headers: { 
      authorization: a, 
      "content-type": "application/x-www-form-urlencoded" 
    }, 
    body: b 
  });
  const x = await r.text();
  if (!r.ok) throw new Error(`UAA token error: ${r.status} ${x}`);
  return JSON.parse(x).access_token;
}

async function getAppState(api, tok, gid) {
  const r = await cfGET(`${api}/v3/apps/${gid}`, tok);
  return r?.state || "UNKNOWN";
}

async function getWebProcessGuid(api, tok, gid) {
  const r = await cfGET(`${api}/v3/apps/${gid}/processes`, tok);
  const w = r?.resources?.find(p => p?.type === "web") || r?.resources?.[0];
  if (!w) throw new Error("No process found on app");
  return w.guid;
}

async function getProcessStats(api, tok, pid) {
  return cfGET(`${api}/v3/processes/${pid}/stats`, tok);
}

async function resolveAppGuid(appConfig, tok, api) {
  if (appConfig.APP_GUID) return appConfig.APP_GUID;
  const org = await cfGET(`${api}/v3/organizations?names=${encodeURIComponent(appConfig.ORG_NAME)}`, tok);
  if (!org?.resources?.length) throw new Error("ORG_NAME not found");
  const og = org.resources[0].guid;
  const sp = await cfGET(`${api}/v3/spaces?names=${encodeURIComponent(appConfig.SPACE_NAME)}&organization_guids=${og}`, tok);
  if (!sp?.resources?.length) throw new Error("SPACE_NAME not found");
  const sg = sp.resources[0].guid;
  const apps = await cfGET(`${api}/v3/apps?names=${encodeURIComponent(appConfig.APP_NAME)}&space_guids=${sg}`, tok);
  if (!apps?.resources?.length) throw new Error("APP_NAME not found");
  return apps.resources[0].guid;
}

async function waitAppStarted(api, tok, gid) {
  let d = 2000, s = "";
  for (let i = 0; i < 8; i++) {
    await sleep(d);
    s = await getAppState(api, tok, gid);
    console.log("[app-state-check]", i, s);
    if (s === "STARTED") break;
    d = Math.min(d * 1.6, 15000);
  }
  if (s !== "STARTED") throw new Error(`App not STARTED in time, state=${s}`);
}

async function waitProcessInstancesRunning(api, tok, pid) {
  let d = 2000;
  for (let i = 0; i < 10; i++) {
    const st = await getProcessStats(api, tok, pid);
    const ins = st?.resources || [];
    const states = ins.map(it => it?.state);
    console.log("[proc-stats]", states.join(",") || "no-instances");
    if (states.some(s => s === "RUNNING")) return;
    await sleep(d);
    d = Math.min(d * 1.6, 15000);
  }
  throw new Error("Process instances not RUNNING in time");
}

// 获取应用事件记录（直接从CF API获取）- 修复版
async function getAppEventsFromCF(appConfig, env, days = 3) {
  try {
    const api = appConfig.CF_API.replace(/\/+$/, "");
    const tok = await getUAAToken(appConfig);
    const gid = await resolveAppGuid(appConfig, tok, api);
    
    // 计算时间范围 - 使用更精确的时间格式
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - (days * 24 * 60 * 60 * 1000));
    const startTimeISO = startTime.toISOString();
    
    console.log(`[${appConfig.name}] Fetching events from: ${startTimeISO}`);
    
    // 尝试不同的查询方式
    let events = { resources: [] };
    
    // 方式1: 查询应用相关的事件
    try {
      events = await cfGET(
        `${api}/v3/audit_events?target_guids=${gid}&per_page=100`,
        tok
      );
      console.log(`[${appConfig.name}] Found ${events.resources?.length || 0} events for app`);
    } catch (e) {
      console.log(`[${appConfig.name}] App events query failed:`, e.message);
    }
    
    // 方式2: 如果没有事件，尝试查询空间级别的事件
    if (!events.resources || events.resources.length === 0) {
      try {
        // 获取空间GUID
        const org = await cfGET(`${api}/v3/organizations?names=${encodeURIComponent(appConfig.ORG_NAME)}`, tok);
        const orgGuid = org.resources[0].guid;
        const space = await cfGET(`${api}/v3/spaces?names=${encodeURIComponent(appConfig.SPACE_NAME)}&organization_guids=${orgGuid}`, tok);
        const spaceGuid = space.resources[0].guid;
        
        events = await cfGET(
          `${api}/v3/audit_events?space_guids=${spaceGuid}&per_page=100`,
          tok
        );
        console.log(`[${appConfig.name}] Found ${events.resources?.length || 0} events for space`);
      } catch (e) {
        console.log(`[${appConfig.name}] Space events query failed:`, e.message);
      }
    }
    
    // 方式3: 查询所有事件然后过滤
    if (!events.resources || events.resources.length === 0) {
      try {
        events = await cfGET(
          `${api}/v3/audit_events?per_page=100`,
          tok
        );
        console.log(`[${appConfig.name}] Found ${events.resources?.length || 0} total events`);
        
        // 手动过滤应用相关事件
        if (events.resources) {
          events.resources = events.resources.filter(event => {
            // 检查事件是否与应用相关
            if (event.target_guid === gid) return true;
            if (event.actor?.name === appConfig.APP_NAME) return true;
            if (event.data?.app_guid === gid) return true;
            if (event.data?.request?.app_guid === gid) return true;
            return false;
          });
          console.log(`[${appConfig.name}] Filtered to ${events.resources.length} app-related events`);
        }
      } catch (e) {
        console.log(`[${appConfig.name}] General events query failed:`, e.message);
      }
    }
    
    // 过滤最近3天的事件
    let filteredEvents = [];
    if (events.resources) {
      filteredEvents = events.resources.filter(event => {
        const eventTime = new Date(event.created_at);
        return eventTime >= startTime;
      });
    }
    
    // 按时间倒序排序
    filteredEvents.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    console.log(`[${appConfig.name}] Returning ${filteredEvents.length} events from last ${days} days`);
    
    return filteredEvents;
    
  } catch (error) {
    console.error(`[${appConfig.name}] Get events error:`, error.message);
    return [];
  }
}

// 获取应用构建和部署记录
async function getAppBuildsAndDeployments(appConfig, env) {
  try {
    const api = appConfig.CF_API.replace(/\/+$/, "");
    const tok = await getUAAToken(appConfig);
    const gid = await resolveAppGuid(appConfig, tok, api);
    
    const events = [];
    
    // 获取构建记录
    try {
      const builds = await cfGET(
        `${api}/v3/builds?app_guids=${gid}&per_page=20&order_by=-created_at`,
        tok
      );
      
      if (builds.resources) {
        builds.resources.forEach(build => {
          events.push({
            type: 'build',
            created_at: build.created_at,
            state: build.state,
            guid: build.guid,
            package_guid: build.package?.guid,
            description: `构建 ${build.state}`
          });
        });
      }
    } catch (e) {
      console.log(`[${appConfig.name}] Builds query failed:`, e.message);
    }
    
    // 获取部署记录
    try {
      const deployments = await cfGET(
        `${api}/v3/deployments?app_guids=${gid}&per_page=20&order_by=-created_at`,
        tok
      );
      
      if (deployments.resources) {
        deployments.resources.forEach(deployment => {
          events.push({
            type: 'deployment',
            created_at: deployment.created_at,
            state: deployment.status?.value || 'unknown',
            guid: deployment.guid,
            description: `部署 ${deployment.status?.value || 'unknown'}`
          });
        });
      }
    } catch (e) {
      console.log(`[${appConfig.name}] Deployments query failed:`, e.message);
    }
    
    // 获取进程统计历史（通过缩放事件推断）
    try {
      const processes = await cfGET(`${api}/v3/apps/${gid}/processes`, tok);
      const webProcess = processes?.resources?.find(p => p?.type === "web");
      
      if (webProcess) {
        const processEvents = await cfGET(
          `${api}/v3/processes/${webProcess.guid}/stats`,
          tok
        );
        
        // 这里可以分析实例数的变化来推断缩放事件
        if (processEvents.resources) {
          const instanceCount = processEvents.resources.length;
          events.push({
            type: 'scale',
            created_at: new Date().toISOString(),
            state: 'running',
            description: `运行中实例: ${instanceCount}`
          });
        }
      }
    } catch (e) {
      console.log(`[${appConfig.name}] Process stats query failed:`, e.message);
    }
    
    // 按时间排序
    events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    return events;
    
  } catch (error) {
    console.error(`[${appConfig.name}] Get builds/deployments error:`, error.message);
    return [];
  }
}

// 获取应用详细状态和历史记录 - 增强版
async function getAppDetailedStatus(appConfig, env) {
  try {
    const api = appConfig.CF_API.replace(/\/+$/, "");
    const tok = await getUAAToken(appConfig);
    const gid = await resolveAppGuid(appConfig, tok, api);
    
    // 获取应用基本信息
    const appInfo = await cfGET(`${api}/v3/apps/${gid}`, tok);
    
    // 获取进程信息
    const processes = await cfGET(`${api}/v3/apps/${gid}/processes`, tok);
    const webProcess = processes?.resources?.find(p => p?.type === "web") || processes?.resources?.[0];
    
    // 获取进程统计
    let processStats = { resources: [] };
    if (webProcess) {
      try {
        processStats = await getProcessStats(api, tok, webProcess.guid);
      } catch (e) {
        console.log(`[${appConfig.name}] No process stats available`);
      }
    }
    
    // 获取最近事件 - 尝试多种方式
    let recentEvents = await getAppEventsFromCF(appConfig, env, 3);
    
    // 如果还是没有事件，尝试获取构建和部署记录
    if (recentEvents.length === 0) {
      console.log(`[${appConfig.name}] No audit events found, trying builds/deployments`);
      recentEvents = await getAppBuildsAndDeployments(appConfig, env);
    }
    
    // 如果还是没有记录，创建一些基本状态记录
    if (recentEvents.length === 0) {
      console.log(`[${appConfig.name}] Creating basic status record`);
      recentEvents = [{
        type: 'app.status',
        created_at: appInfo.updated_at || appInfo.created_at || new Date().toISOString(),
        state: appInfo.state,
        description: `应用状态: ${appInfo.state}`
      }];
    }
    
    return {
      success: true,
      app: appConfig.name,
      appGuid: gid,
      appState: appInfo?.state || "UNKNOWN",
      created_at: appInfo?.created_at,
      updated_at: appInfo?.updated_at,
      instances: (processStats?.resources || []).map(it => ({
        index: it?.index,
        state: it?.state,
        usage: it?.usage,
        uptime: it?.uptime
      })),
      events: recentEvents,
      process: webProcess ? {
        guid: webProcess.guid,
        type: webProcess.type,
        instances: webProcess.instances,
        memory_in_mb: webProcess.memory_in_mb,
        disk_in_mb: webProcess.disk_in_mb
      } : null
    };
  } catch (error) {
    console.error(`[${appConfig.name}] Detailed status error:`, error.message);
    return { 
      success: false, 
      app: appConfig.name, 
      error: error.message,
      events: [] 
    };
  }
}

// 核心函数 - 修复锁机制，确保每天UTC0点都能启动
async function ensureAppRunning(appConfig, env, { reason = "unknown", force = false } = {}) {
  console.log(`[${appConfig.name}] trigger`, reason, new Date().toISOString());
  
  // 每个app有独立的每日锁
  const ymd = new Date().toISOString().slice(0, 10);
  const lockKey = `start-lock:${appConfig.name}:${ymd}`;
  
  if (!force) {
    const ex = await kvGet(env, lockKey);
    if (ex) {
      console.log(`[${appConfig.name}] lock exists, skip`, lockKey);
      return { success: false, app: appConfig.name, reason: "locked" };
    }
  } else {
    console.log(`[${appConfig.name}] force=1, ignore success-lock`);
  }

  try {
    const api = appConfig.CF_API.replace(/\/+$/, "");
    const tok = await getUAAToken(appConfig);
    const gid = await resolveAppGuid(appConfig, tok, api);
    const pid = await getWebProcessGuid(api, tok, gid);
    const pre = await getProcessStats(api, tok, pid);
    const st = (pre?.resources || []).map(it => it?.state);
    
    console.log(`[${appConfig.name}] proc-before`, st.join(",") || "no-instances");
    
    if (st.some(s => s === "RUNNING")) {
      console.log(`[${appConfig.name}] already RUNNING → nothing to do`);
      // 即使已经在运行，也设置锁（在第二天UTC0点过期）
      const expirationTtl = getSecondsUntilNextUTCMidnight();
      await kvPut(env, lockKey, "1", { expirationTtl });
      console.log(`[${appConfig.name}] lock set until next UTC midnight`, lockKey);
      return { success: true, app: appConfig.name, reason: "already_running" };
    }

    let appState = await getAppState(api, tok, gid);
    console.log(`[${appConfig.name}] app-state-before`, appState);
    
    if (appState !== "STARTED") {
      await cfPOST(`${api}/v3/apps/${gid}/actions/start`, tok);
      console.log(`[${appConfig.name}] app start requested`);
    }

    await waitAppStarted(api, tok, gid);
    await waitProcessInstancesRunning(api, tok, pid);
    
    if (appConfig.APP_PING_URL) {
      try {
        await fetch(appConfig.APP_PING_URL, { method: "GET" });
        console.log(`[${appConfig.name}] ping ok`);
      } catch (e) {
        console.log(`[${appConfig.name}] ping fail`, e?.message || e);
      }
    }

    // 设置锁，在第二天UTC 0点过期
    const expirationTtl = getSecondsUntilNextUTCMidnight();
    await kvPut(env, lockKey, "1", { expirationTtl });
    console.log(`[${appConfig.name}] lock set for ${expirationTtl} seconds`, lockKey);
    
    return { success: true, app: appConfig.name };
  } catch (error) {
    console.error(`[${appConfig.name}] error:`, error.message);
    return { success: false, app: appConfig.name, error: error.message };
  }
}

// 停止应用
async function stopApp(appConfig, env) {
  try {
    const api = appConfig.CF_API.replace(/\/+$/, "");
    const tok = await getUAAToken(appConfig);
    const gid = await resolveAppGuid(appConfig, tok, api);
    await cfPOST(`${api}/v3/apps/${gid}/actions/stop`, tok);
    console.log(`[${appConfig.name}] app stop requested`);
    return { success: true, app: appConfig.name };
  } catch (error) {
    console.error(`[${appConfig.name}] stop error:`, error.message);
    return { success: false, app: appConfig.name, error: error.message };
  }
}

// 获取应用状态
async function getAppStatus(appConfig, env) {
  try {
    const api = appConfig.CF_API.replace(/\/+$/, "");
    const tok = await getUAAToken(appConfig);
    const gid = await resolveAppGuid(appConfig, tok, api);
    const s = await getAppState(api, tok, gid);
    const p = await getWebProcessGuid(api, tok, gid).catch(() => null);
    const st = p ? await getProcessStats(api, tok, p) : null;
    
    return {
      success: true,
      app: appConfig.name,
      appGuid: gid,
      appState: s,
      instances: (st?.resources || []).map(it => ({
        index: it?.index,
        state: it?.state,
        usage: it?.usage
      }))
    };
  } catch (error) {
    console.error(`[${appConfig.name}] status error:`, error.message);
    return { success: false, app: appConfig.name, error: error.message };
  }
}

// 获取应用锁状态
async function getAppLockStatus(appConfig, env) {
  const ymd = new Date().toISOString().slice(0, 10);
  const lockKey = `start-lock:${appConfig.name}:${ymd}`;
  const locked = !!(await kvGet(env, lockKey));
  
  return {
    app: appConfig.name,
    locked: locked,
    lockKey: lockKey
  };
}

// 清除所有应用的锁定状态
async function clearAllAppLocks(env) {
  try {
    const APPS = JSON.parse(env.APPS_CONFIG || "[]");
    const enabledApps = APPS.filter(app => app.enabled !== false);
    const today = new Date().toISOString().slice(0, 10);
    let clearedCount = 0;
    
    for (const app of enabledApps) {
      const lockKey = `start-lock:${app.name}:${today}`;
      const wasLocked = !!(await kvGet(env, lockKey));
      
      if (wasLocked) {
        await kvDelete(env, lockKey);
        clearedCount++;
        console.log(`Cleared lock for ${app.name}`);
      }
    }
    
    return { success: true, clearedCount, totalCount: enabledApps.length };
  } catch (error) {
    console.error('Clear all locks error:', error);
    return { success: false, error: error.message };
  }
}

// 显示应用列表
async function showAppList(env, chatId) {
  try {
    const APPS = JSON.parse(env.APPS_CONFIG || "[]");
    const enabledApps = APPS.filter(app => app.enabled !== false);
    
    // 获取所有应用的锁状态
    const lockStatuses = await Promise.all(enabledApps.map(app => getAppLockStatus(app, env)));
    
    // 获取所有应用的状态
    const appStatuses = await Promise.all(enabledApps.map(app => getAppStatus(app, env)));
    
    let statusMessage = '📋 <b>应用列表</b>\n\n';
    
    enabledApps.forEach(app => {
      const lockStatus = lockStatuses.find(s => s.app === app.name);
      const appStatus = appStatuses.find(s => s.app === app.name);
      
      let statusIcon = '❓'; // 默认问号
      let lockIcon = '🔒'; // 默认锁定
      
      if (appStatus && appStatus.success) {
        statusIcon = appStatus.appState === 'STARTED' ? '✅' : '❌';
      }
      
      if (lockStatus) {
        lockIcon = lockStatus.locked ? '🔒' : '🔑'; // 使用锁头表示锁定，钥匙表示解锁
      }
      
      statusMessage += `${statusIcon} ${lockIcon} <code>${app.name}</code>\n`;
    });
    
    await sendTelegramMessage(env, chatId, statusMessage, 'HTML', createAppListKeyboard(APPS, lockStatuses, appStatuses));
    
  } catch (error) {
    console.error('Show app list error:', error);
    await sendTelegramMessage(env, chatId, '❌ 获取应用列表时出错', null, createBackKeyboard());
  }
}

// 显示应用详情（增强版，包含历史记录）- 修复版
async function showAppDetail(env, chatId, appName) {
  try {
    const APPS = JSON.parse(env.APPS_CONFIG || "[]");
    const app = APPS.find(a => a.name === appName);
    
    if (!app) {
      await sendTelegramMessage(env, chatId, '❌ 应用不存在', null, createBackKeyboard());
      return;
    }
    
    // 发送"查询中"消息
    const loadingMsg = await sendTelegramMessage(env, chatId, '⏳ 正在查询应用状态和历史记录...');
    
    // 获取应用详细状态（包含事件记录）
    const appStatus = await getAppDetailedStatus(app, env);
    const lockStatus = await getAppLockStatus(app, env);
    
    let statusIcon = '❓';
    if (appStatus.success) {
      statusIcon = appStatus.appState === 'STARTED' ? '✅' : '❌';
    }
    
    let lockIcon = lockStatus.locked ? '🔒' : '🔑';
    
    let message = `📱 <b>应用详情</b>\n\n`;
    message += `<b>名称:</b> <code>${app.name}</code>\n`;
    message += `<b>状态:</b> ${statusIcon} ${appStatus.success ? appStatus.appState : '未知'}\n`;
    message += `<b>锁定状态:</b> ${lockIcon} ${lockStatus.locked ? '已锁定' : '已解锁'}\n`;
    
    // 显示实例信息
    if (appStatus.instances && appStatus.instances.length > 0) {
      const runningInstances = appStatus.instances.filter(inst => inst.state === 'RUNNING').length;
      message += `<b>运行实例:</b> ${runningInstances}/${appStatus.instances.length}\n`;
    }
    
    if (appStatus.process) {
      message += `<b>内存:</b> ${appStatus.process.memory_in_mb}MB\n`;
      message += `<b>磁盘:</b> ${appStatus.process.disk_in_mb}MB\n`;
    }
    
    if (appStatus.updated_at) {
      const lastUpdated = new Date(appStatus.updated_at).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      message += `<b>最后更新:</b> ${lastUpdated}\n`;
    }
    
    if (appStatus.error) {
      message += `<b>错误:</b> ${appStatus.error}\n`;
    }
    
    // 添加事件记录 - 只显示最近3条
    message += `\n⏰ <b>最近操作记录 (最近3条):</b>\n`;
    
    if (!appStatus.events || appStatus.events.length === 0) {
      message += `暂无事件记录\n`;
      message += `<i>这可能是因为：</i>\n`;
      message += `<i>1. 应用最近没有操作</i>\n`;
      message += `<i>2. API权限限制</i>\n`;
      message += `<i>3. 事件保留时间较短</i>\n`;
    } else {
      const eventTypeMap = {
        'audit.app.start': '🚀 启动',
        'audit.app.stop': '🛑 停止', 
        'audit.app.update': '📝 更新',
        'audit.app.create': '🆕 创建',
        'audit.app.restage': '🔄 重新部署',
        'audit.app.crash': '💥 崩溃',
        'audit.app.sshd': '🔐 SSH访问',
        'build': '🔨 构建',
        'deployment': '📦 部署',
        'scale': '📊 缩放',
        'app.status': '📱 状态'
      };
      
      const stateMap = {
        'STAGED': '已准备',
        'STAGING': '准备中',
        'STARTED': '已启动',
        'STOPPED': '已停止',
        'FAILED': '失败',
        'running': '运行中',
        'pending': '等待中',
        'succeeded': '成功',
        'failed': '失败'
      };
      
      const recentEvents = appStatus.events.slice(0, 3); // 只显示最近3条记录
      
      for (const event of recentEvents) {
        const eventTime = new Date(event.created_at).toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        const eventType = eventTypeMap[event.type] || `📝 ${event.type}`;
        const eventState = stateMap[event.state] || event.state;
        
        message += `${eventType}`;
        
        if (eventState && eventState !== 'unknown') {
          message += ` [${eventState}]`;
        }
        
        message += `\n   ⏱️ ${eventTime}\n`;
        
        if (event.actor?.name || event.actor?.type) {
          const actor = event.actor?.name || event.actor?.type;
          message += `   👤 ${actor}\n`;
        }
        
        if (event.description) {
          message += `   📝 ${event.description}\n`;
        }
        
        message += `\n`;
      }
      
      // 如果有更多记录，显示提示
      if (appStatus.events.length > 3) {
        message += `📜 还有 ${appStatus.events.length - 3} 条记录，点击"更多记录"查看\n`;
      }
    }
    
    // 删除加载消息
    try {
      if (loadingMsg && loadingMsg.result && loadingMsg.result.message_id) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: loadingMsg.result.message_id
          })
        });
      }
    } catch (e) {
      console.log('Delete loading message error:', e);
    }
    
    await sendTelegramMessage(env, chatId, message, 'HTML', createAppDetailKeyboard(appName));
    
  } catch (error) {
    console.error('Show app detail error:', error);
    
    // 确保删除加载消息
    try {
      if (loadingMsg && loadingMsg.result && loadingMsg.result.message_id) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: loadingMsg.result.message_id
          })
        });
      }
    } catch (e) {
      console.log('Delete loading message error:', e);
    }
    
    await sendTelegramMessage(env, chatId, 
      '❌ 获取应用详情时出错\n错误信息: ' + error.message, 
      null, 
      createBackKeyboard()
    );
  }
}

// 显示更多事件记录（分页显示）
async function showMoreEvents(env, chatId, appName, page = 1) {
  try {
    const APPS = JSON.parse(env.APPS_CONFIG || "[]");
    const app = APPS.find(a => a.name === appName);
    
    if (!app) {
      await sendTelegramMessage(env, chatId, '❌ 应用不存在', null, createBackKeyboard());
      return;
    }
    
    // 发送"查询中"消息
    const loadingMsg = await sendTelegramMessage(env, chatId, '⏳ 正在查询更多操作记录...');
    
    // 获取应用详细状态（包含事件记录）
    const appStatus = await getAppDetailedStatus(app, env);
    
    if (!appStatus.success) {
      await sendTelegramMessage(env, chatId, '❌ 获取应用记录失败', null, createBackKeyboard());
      return;
    }
    
    const eventsPerPage = 8;
    const totalEvents = appStatus.events.length;
    const totalPages = Math.ceil(totalEvents / eventsPerPage);
    const startIndex = (page - 1) * eventsPerPage;
    const endIndex = startIndex + eventsPerPage;
    const pageEvents = appStatus.events.slice(startIndex, endIndex);
    
    let message = `📜 <b>${app.name} - 操作记录</b>\n\n`;
    message += `<b>页码:</b> ${page}/${totalPages}\n`;
    message += `<b>总记录数:</b> ${totalEvents} 条\n\n`;
    
    if (pageEvents.length === 0) {
      message += `暂无更多记录\n`;
    } else {
      const eventTypeMap = {
        'audit.app.start': '🚀 启动',
        'audit.app.stop': '🛑 停止', 
        'audit.app.update': '📝 更新',
        'audit.app.create': '🆕 创建',
        'audit.app.restage': '🔄 重新部署',
        'audit.app.crash': '💥 崩溃',
        'audit.app.sshd': '🔐 SSH访问',
        'build': '🔨 构建',
        'deployment': '📦 部署',
        'scale': '📊 缩放',
        'app.status': '📱 状态'
      };
      
      const stateMap = {
        'STAGED': '已准备',
        'STAGING': '准备中',
        'STARTED': '已启动',
        'STOPPED': '已停止',
        'FAILED': '失败',
        'running': '运行中',
        'pending': '等待中',
        'succeeded': '成功',
        'failed': '失败'
      };
      
      for (const event of pageEvents) {
        const eventTime = new Date(event.created_at).toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        const eventType = eventTypeMap[event.type] || `📝 ${event.type}`;
        const eventState = stateMap[event.state] || event.state;
        
        message += `${eventType}`;
        
        if (eventState && eventState !== 'unknown') {
          message += ` [${eventState}]`;
        }
        
        message += `\n⏱️ ${eventTime}\n`;
        
        if (event.actor?.name || event.actor?.type) {
          const actor = event.actor?.name || event.actor?.type;
          message += `👤 ${actor}\n`;
        }
        
        if (event.description) {
          message += `📝 ${event.description}\n`;
        }
        
        message += `\n`;
      }
    }
    
    // 删除加载消息
    try {
      if (loadingMsg && loadingMsg.result && loadingMsg.result.message_id) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: loadingMsg.result.message_id
          })
        });
      }
    } catch (e) {
      console.log('Delete loading message error:', e);
    }
    
    await sendTelegramMessage(env, chatId, message, 'HTML', createEventsKeyboard(appName, page, totalPages));
    
  } catch (error) {
    console.error('Show more events error:', error);
    
    // 确保删除加载消息
    try {
      if (loadingMsg && loadingMsg.result && loadingMsg.result.message_id) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: loadingMsg.result.message_id
          })
        });
      }
    } catch (e) {
      console.log('Delete loading message error:', e);
    }
    
    await sendTelegramMessage(env, chatId, 
      '❌ 获取操作记录时出错\n错误信息: ' + error.message, 
      null, 
      createBackKeyboard()
    );
  }
}

// Telegram Bot 处理函数
async function handleTelegramCommand(env, message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || '';
  const command = text.split(' ')[0];
  
  // 检查管理员权限
  if (!isAdmin(env, userId)) {
    await sendPermissionDenied(env, chatId);
    return;
  }
  
  try {
    switch (command) {
      case '/start':
      case '/help':
        await sendTelegramMessage(env, chatId, 
          `🤖 <b>Cloud Foundry 应用管理器</b>\n\n` +
          `👑 <b>管理员模式</b>\n\n` +
          `点击下方按钮管理应用:`,
          'HTML',
          createMainMenuKeyboard()
        );
        break;
        
      case '/list':
        await showAppList(env, chatId);
        break;
        
      default:
        await sendTelegramMessage(env, chatId, 
          '未知命令，使用 /start 查看主菜单',
          null,
          createMainMenuKeyboard()
        );
    }
  } catch (error) {
    console.error('Telegram command error:', error);
    await sendTelegramMessage(env, chatId, `❌ 处理命令时出错: ${error.message}`);
  }
}

// 处理Telegram回调查询
async function handleTelegramCallback(env, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const userId = callbackQuery.from?.id;
  const data = callbackQuery.data;
  
  if (!chatId || !userId) {
    console.error('Invalid callback query:', JSON.stringify(callbackQuery));
    return;
  }
  
  // 检查管理员权限
  if (!isAdmin(env, userId)) {
    await sendPermissionDenied(env, chatId);
    return;
  }
  
  try {
    const APPS = JSON.parse(env.APPS_CONFIG || "[]");
    
    switch (data) {
      case 'main_menu':
        await sendTelegramMessage(env, chatId, 
          '🤖 <b>主菜单</b>\n选择要执行的操作:',
          'HTML',
          createMainMenuKeyboard()
        );
        break;
        
      case 'list_apps':
        await showAppList(env, chatId);
        break;
        
      case 'refresh_status':
        await showAppList(env, chatId);
        break;
        
      case 'no_action':
        // 无操作，只是更新消息
        break;
        
      case 'unlock_all':
        const ymdToday = new Date().toISOString().slice(0, 10);
        const enabledApps = APPS.filter(app => app.enabled !== false);
        let unlockCount = 0;
        
        for (const app of enabledApps) {
          const lockKey = `start-lock:${app.name}:${ymdToday}`;
          const wasLocked = !!(await kvGet(env, lockKey));
          await kvDelete(env, lockKey);
          if (wasLocked) unlockCount++;
        }
        
        await sendTelegramMessage(
          env, 
          chatId, 
          `✅ 已解锁 ${unlockCount} 个应用`, 
          'HTML', 
          createMainMenuKeyboard()
        );
        break;
        
      case 'start_all':
        // 发送启动中消息
        await sendTelegramMessage(env, chatId, '🚀 正在启动所有应用...');
        
        const enabledApps2 = APPS.filter(app => app.enabled !== false);
        const results = [];
        const detailedResults = [];
        
        // 启动所有应用
        for (const app of enabledApps2) {
          const result = await ensureAppRunning(app, env, { reason: "telegram", force: true });
          results.push(result);
          
          // 记录详细结果
          if (result.success) {
            detailedResults.push(`✅ ${app.name}: 启动成功`);
          } else {
            detailedResults.push(`❌ ${app.name}: 启动失败 - ${result.error || result.reason}`);
          }
          
          await sleep(1000); // 每个应用之间等待1秒
        }
        
        // 计算成功和失败的数量
        const successCount = results.filter(r => r.success).length;
        const totalCount = enabledApps2.length;
        
        // 构建详细结果消息
        let resultMessage = `🚀 <b>启动所有应用完成</b>\n\n`;
        resultMessage += `✅ 成功: ${successCount}/${totalCount}\n`;
        resultMessage += `❌ 失败: ${totalCount - successCount}/${totalCount}\n\n`;
        
        // 添加详细结果（最多显示前10个应用的结果，避免消息过长）
        const maxDisplay = 10;
        if (detailedResults.length <= maxDisplay) {
          resultMessage += detailedResults.join('\n');
        } else {
          resultMessage += detailedResults.slice(0, maxDisplay).join('\n');
          resultMessage += `\n... 还有 ${detailedResults.length - maxDisplay} 个应用的结果未显示`;
        }
        
        // 发送详细结果并返回主菜单
        await sendTelegramMessage(
          env, 
          chatId, 
          resultMessage,
          'HTML',
          createMainMenuKeyboard()
        );
        break;
        
      default:
        if (data.startsWith('app_detail_')) {
          const appName = data.replace('app_detail_', '');
          await showAppDetail(env, chatId, appName);
          break;
        }
        
        if (data.startsWith('more_events_')) {
          const parts = data.split('_');
          const appName = parts[2];
          const page = parseInt(parts[3]) || 1;
          await showMoreEvents(env, chatId, appName, page);
          break;
        }
        
        if (data.startsWith('unlock_')) {
          const appName = data.replace('unlock_', '');
          const app = APPS.find(a => a.name === appName);
          if (app) {
            const ymd = new Date().toISOString().slice(0, 10);
            const lockKey = `start-lock:${appName}:${ymd}`;
            await kvDelete(env, lockKey);
            await sendTelegramMessage(env, chatId, `✅ 应用 <code>${appName}</code> 已解锁`, 'HTML', createAppDetailKeyboard(appName));
            await sleep(1000);
            await showAppDetail(env, chatId, appName); // 刷新详情页面
          }
          break;
        }
        
        if (data.startsWith('startapp_')) {
          const appName = data.replace('startapp_', '');
          const app = APPS.find(a => a.name === appName);
          if (app) {
            await sendTelegramMessage(env, chatId, `🚀 正在启动应用 <code>${appName}</code>...`);
            const result = await ensureAppRunning(app, env, { reason: "telegram", force: true });
            
            if (result.success) {
              await sendTelegramMessage(env, chatId, `✅ 应用 <code>${appName}</code> 启动成功`, 'HTML', createAppDetailKeyboard(appName));
            } else {
              await sendTelegramMessage(env, chatId, 
                `❌ 应用 <code>${appName}</code> 启动失败\n错误: ${result.error || result.reason}`,
                'HTML',
                createAppDetailKeyboard(appName)
              );
            }
          }
          break;
        }
        
        // 未知回调数据
        await sendTelegramMessage(env, chatId, '❌ 未知操作', null, createMainMenuKeyboard());
    }
    
  } catch (error) {
    console.error('Telegram callback error:', error);
    await sendTelegramMessage(env, chatId, `❌ 处理操作时出错: ${error.message}`, null, createMainMenuKeyboard());
  }
}

// 设置Telegram Webhook
async function setTelegramWebhook(env, webhookUrl) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  }
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query']
      })
    });
    
    return await response.json();
  } catch (error) {
    console.error('Set webhook error:', error);
    return { ok: false, error: error.message };
  }
}

// 获取Webhook信息
async function getWebhookInfo(env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  }
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
    return await response.json();
  } catch (error) {
    console.error('Get webhook info error:', error);
    return { ok: false, error: error.message };
  }
}

// 定时任务 - 所有app都会在UTC 0点尝试启动一次
async function runAllInSchedule(env) {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const allowedUtcHour = 0;
  
  if (utcH === allowedUtcHour && utcM % 2 === 0) {
    console.log(`[cron] hit ${pad(utcH)}:${pad(utcM)} UTC → starting all apps`);
    
    try {
      const APPS = JSON.parse(env.APPS_CONFIG || "[]");
      
      // 清除所有应用的锁定状态
      const clearResult = await clearAllAppLocks(env);
      console.log(`[cron] cleared ${clearResult.clearedCount} app locks`);
      
      const results = [];
      
      for (const app of APPS) {
        if (app.enabled !== false) {
          const result = await ensureAppRunning(app, env, { reason: "cron" });
          results.push(result);
          await sleep(1000); // 每个app之间延迟1秒
        }
      }
      
      console.log("[cron] completed with results:", results);
      
      // 统计结果
      const successCount = results.filter(r => r.success).length;
      const totalCount = results.length;
      console.log(`[cron] ${successCount}/${totalCount} apps processed successfully`);
      
      return results;
    } catch (error) {
      console.error("[cron] config error:", error);
      return [{ success: false, error: "Config parse error" }];
    }
  } else {
    console.log(`[cron] skip at ${pad(utcH)}:${pad(utcM)} UTC`);
    return [];
  }
}

// 主处理函数
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllInSchedule(env));
  },
  
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = request.headers.get('host');
    const webhookUrl = `https://${host}/webhook`;
    
    try {
      // 处理Telegram Webhook
      if (url.pathname === '/webhook') {
        // 首先检查是否是webhook管理请求（GET）
        if (request.method === 'GET') {
          const action = url.searchParams.get('action');
          
          if (action === 'set') {
            const result = await setTelegramWebhook(env, webhookUrl);
            return json(result);
          }
          
          if (action === 'info') {
            const result = await getWebhookInfo(env);
            return json(result);
          }
          
          if (action === 'delete') {
            const result = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteWebhook`);
            return json(await result.json());
          }
          
          return json({ 
            ok: true, 
            message: "Telegram webhook management",
            webhook_url: webhookUrl,
            endpoints: [
              "GET /webhook?action=set - Set webhook",
              "GET /webhook?action=info - Get webhook info", 
              "GET /webhook?action=delete - Delete webhook"
            ]
          });
        }
        
        // 然后处理Telegram的POST请求（消息推送）
        if (request.method === 'POST') {
          let update;
          try {
            update = await request.json();
          } catch (e) {
            console.error('Failed to parse Telegram update:', e);
            return new Response('Invalid JSON', { status: 400 });
          }
          
          if (update.message) {
            ctx.waitUntil(handleTelegramCommand(env, update.message).catch(error => {
              console.error('Message handling error:', error);
            }));
          } else if (update.callback_query) {
            ctx.waitUntil(handleTelegramCallback(env, update.callback_query).catch(error => {
              console.error('Callback handling error:', error);
            }));
          }
          
          return new Response('OK');
        }
        
        return new Response('Method not allowed', { status: 405 });
      }
      
      // 解析应用配置
      let APPS;
      try {
        APPS = JSON.parse(env.APPS_CONFIG || "[]");
        console.log("APPS parsed successfully:", APPS.length, "apps");
      } catch (e) {
        console.error("JSON parse error:", e.message);
        return json({ 
          ok: false, 
          error: "Invalid APPS_CONFIG JSON format",
          details: e.message
        }, 500);
      }
      
      // API 路由处理
      switch (url.pathname) {
        case "/list-apps":
          const appsList = APPS.map(app => ({
            name: app.name,
            enabled: app.enabled !== false,
            description: app.description || "",
            hasPing: !!app.APP_PING_URL,
            config: {
              hasAPI: !!app.CF_API,
              hasUAA: !!app.UAA_URL,
              hasCredentials: !!(app.CF_USERNAME && app.CF_PASSWORD),
              hasGUID: !!app.APP_GUID
            }
          }));
          return json({ ok: true, apps: appsList, total: appsList.length });
          
        case "/start":
          const appName = url.searchParams.get("app");
          const force = url.searchParams.get("force") === "1";
          
          if (appName) {
            const appConfig = APPS.find(a => a.name === appName);
            if (!appConfig) return json({ ok: false, error: "App not found" }, 404);
            
            ctx.waitUntil(ensureAppRunning(appConfig, env, { reason: "manual", force }));
            return json({ ok: true, app: appName, force, message: "Start requested" });
          } else {
            const promises = APPS
              .filter(app => app.enabled !== false)
              .map(app => ensureAppRunning(app, env, { reason: "manual-all", force }));
            
            ctx.waitUntil(Promise.all(promises));
            return json({ ok: true, message: "All enabled apps start requested", force, count: promises.length });
          }
          
        case "/stop":
          const stopAppName = url.searchParams.get("app");
          if (!stopAppName) return json({ ok: false, error: "app parameter required" }, 400);
          
          const stopAppConfig = APPS.find(a => a.name === stopAppName);
          if (!stopAppConfig) return json({ ok: false, error: "App not found" }, 404);
          
          const stopResult = await stopApp(stopAppConfig, env);
          return json(stopResult);
          
        case "/state":
          const stateAppName = url.searchParams.get("app");
          
          if (stateAppName) {
            const stateAppConfig = APPS.find(a => a.name === stateAppName);
            if (!stateAppConfig) return json({ ok: false, error: "App not found" }, 404);
            
            const stateResult = await getAppStatus(stateAppConfig, env);
            return json(stateResult);
          } else {
            const statePromises = APPS
              .filter(app => app.enabled !== false)
              .map(app => getAppStatus(app, env));
            
            const allStates = await Promise.all(statePromises);
            return json({ ok: true, apps: allStates, total: allStates.length });
          }
          
        case "/detailed-status":
          const detailAppName = url.searchParams.get("app");
          
          if (!detailAppName) {
            return json({ ok: false, error: "app parameter required" }, 400);
          }
          
          const detailAppConfig = APPS.find(a => a.name === detailAppName);
          if (!detailAppConfig) {
            return json({ ok: false, error: "App not found" }, 404);
          }
          
          const detailedStatus = await getAppDetailedStatus(detailAppConfig, env);
          return json(detailedStatus);
          
        case "/events":
          const eventsAppName = url.searchParams.get("app");
          const days = parseInt(url.searchParams.get("days")) || 3;
          
          if (!eventsAppName) {
            return json({ ok: false, error: "app parameter required" }, 400);
          }
          
          const eventsAppConfig = APPS.find(a => a.name === eventsAppName);
          if (!eventsAppConfig) {
            return json({ ok: false, error: "App not found" }, 404);
          }
          
          const events = await getAppEventsFromCF(eventsAppConfig, env, days);
          return json({ 
            ok: true, 
            app: eventsAppName,
            days: days,
            events: events,
            count: events.length 
          });
          
        case "/diag":
          const now = new Date();
          const utcH = now.getUTCHours();
          const utcM = now.getUTCMinutes();
          const secondsUntilMidnight = getSecondsUntilNextUTCMidnight();
          
          // 检查KV状态
          const kvStatus = {
            available: !!env.START_LOCK,
            binding: "START_LOCK",
            type: typeof env.START_LOCK
          };
          
          return json({ 
            ok: true, 
            app_count: APPS.length,
            enabled_count: APPS.filter(app => app.enabled !== false).length,
            current_time: now.toISOString(),
            utc_time: `${pad(utcH)}:${pad(utcM)} UTC`,
            seconds_until_utc_midnight: secondsUntilMidnight,
            kv_status: kvStatus,
            next_utc_midnight: new Date(Date.now() + secondsUntilMidnight * 1000).toISOString(),
            lock_mechanism: "daily_lock_until_utc_midnight"
          });
          
        case "/unlock":
          const unlockAppName = url.searchParams.get("app");
          const ymd = new Date().toISOString().slice(0, 10);
          
          if (unlockAppName) {
            const lockKey = `start-lock:${unlockAppName}:${ymd}`;
            const deleted = await kvDelete(env, lockKey);
            return json({ 
              ok: true, 
              deleted: lockKey, 
              success: deleted,
              app: unlockAppName 
            });
          } else {
            const deletedKeys = [];
            for (const app of APPS) {
              const lockKey = `start-lock:${app.name}:${ymd}`;
              const success = await kvDelete(env, lockKey);
              deletedKeys.push({ 
                app: app.name, 
                lockKey,
                success 
              });
            }
            return json({ 
              ok: true, 
              deleted: deletedKeys, 
              message: "All app locks cleared" 
            });
          }
          
        case "/locks":
          const ymdToday = new Date().toISOString().slice(0, 10);
          const lockStatus = [];
          
          for (const app of APPS) {
            const lockKey = `start-lock:${app.name}:${ymdToday}`;
            const exists = await kvGet(env, lockKey);
            lockStatus.push({
              app: app.name,
              locked: !!exists,
              lockKey: lockKey,
              kvAvailable: !!env.START_LOCK
            });
          }
          
          return json({ 
            ok: true, 
            locks: lockStatus, 
            date: ymdToday,
            kvAvailable: !!env.START_LOCK
          });
          
        case "/clear-locks":
          // 清除所有应用的锁定状态
          const clearResult = await clearAllAppLocks(env);
          return json(clearResult);
          
        default:
          return json({ 
            ok: true, 
            message: "Multi-App Cloud Foundry Manager with Telegram Bot",
            version: "3.0",
            description: "Each app has independent daily lock that expires at UTC midnight with Telegram Bot integration and event history",
            endpoints: [
              "GET /list-apps - List all configured apps",
              "GET /start?app=name - Start specific app",
              "GET /start?app=name&force=1 - Force start specific app",
              "GET /start - Start all enabled apps", 
              "GET /stop?app=name - Stop specific app",
              "GET /state?app=name - Get app status",
              "GET /state - Get all apps status",
              "GET /detailed-status?app=name - Get detailed app status with events",
              "GET /events?app=name&days=3 - Get app events from CF API",
              "GET /diag - Diagnostic information",
              "GET /unlock?app=name - Remove daily lock for app",
              "GET /unlock - Remove all daily locks",
              "GET /locks - Check current lock status",
              "GET /clear-locks - Clear all app locks (force unlock)",
              "POST /webhook - Telegram webhook endpoint",
              "GET /webhook?action=set - Set Telegram webhook",
              "GET /webhook?action=info - Get webhook info",
              "GET /webhook?action=delete - Delete webhook"
            ]
          });
      }
      
    } catch (error) {
      console.error("[fetch error]", error?.message || error);
      return json({ ok: false, error: String(error) }, 500);
    }
  }
};
