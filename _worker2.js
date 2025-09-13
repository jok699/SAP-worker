// 单文件多应用管理器 - 集成Telegram Bot（Webhook修复版）
const pad = n => String(n).padStart(2, "0");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { "content-type": "application/json" } });

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

// 计算到下一个UTC 0点的秒数
function getSecondsUntilNextUTCMidnight() {
  const now = new Date();
  const currentUTCHours = now.getUTCHours();
  const currentUTCMinutes = now.getUTCMinutes();
  const currentUTCSeconds = now.getUTCSeconds();
  
  // 如果当前时间已经过了UTC 0点，则计算到明天UTC 0点的秒数
  // 否则计算到今天UTC 0点的秒数
  if (currentUTCHours > 0 || currentUTCMinutes > 0 || currentUTCSeconds > 0) {
    // 已经过了UTC 0点，计算到明天UTC 0点的秒数
    const nextUTCMidnight = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0
    ));
    return Math.floor((nextUTCMidnight - now) / 1000);
  } else {
    // 还没到UTC 0点，计算到今天UTC 0点的秒数
    const todayUTCMidnight = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0, 0
    ));
    return Math.floor((todayUTCMidnight - now) / 1000);
  }
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
        { text: "↩️ 返回列表", callback_data: "list_apps" },
        { text: "🏠 返回主页", callback_data: "main_menu" }
      ]
    ]
  };
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
    if (states.some(s => s === "RUNNING")) return;
    await sleep(d);
    d = Math.min(d * 1.6, 15000);
  }
  throw new Error("Process instances not RUNNING in time");
}

// 核心函数
async function ensureAppRunning(appConfig, env, { reason = "unknown", force = false } = {}) {
  console.log(`[${appConfig.name}] trigger`, reason, new Date().toISOString());
  
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10);
  const lockKey = `start-lock:${appConfig.name}:${ymd}`;
  
  // 检查当前UTC时间，如果已经过了0点，则强制解锁
  const currentUTCHour = now.getUTCHours();
  const currentUTCMinute = now.getUTCMinutes();
  
  // 如果当前UTC时间在0点之后，清除昨天的锁
  if (currentUTCHour > 0 || currentUTCMinute > 0) {
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayYmd = yesterday.toISOString().slice(0, 10);
    const yesterdayLockKey = `start-lock:${appConfig.name}:${yesterdayYmd}`;
    
    // 删除昨天的锁
    await env.START_LOCK.delete(yesterdayLockKey);
  }
  
  if (!force) {
    const ex = await env.START_LOCK.get(lockKey);
    if (ex) {
      console.log(`[${appConfig.name}] lock exists, skip`, lockKey);
      return { success: false, app: appConfig.name, reason: "locked" };
    }
  }

  try {
    const api = appConfig.CF_API.replace(/\/+$/, "");
    const tok = await getUAAToken(appConfig);
    const gid = await resolveAppGuid(appConfig, tok, api);
    const pid = await getWebProcessGuid(api, tok, gid);
    const pre = await getProcessStats(api, tok, pid);
    const st = (pre?.resources || []).map(it => it?.state);
    
    if (st.some(s => s === "RUNNING")) {
      const expirationTtl = getSecondsUntilNextUTCMidnight();
      await env.START_LOCK.put(lockKey, "1", { expirationTtl });
      return { success: true, app: appConfig.name, reason: "already_running" };
    }

    let appState = await getAppState(api, tok, gid);
    
    if (appState !== "STARTED") {
      await cfPOST(`${api}/v3/apps/${gid}/actions/start`, tok);
    }

    await waitAppStarted(api, tok, gid);
    await waitProcessInstancesRunning(api, tok, pid);
    
    if (appConfig.APP_PING_URL) {
      try {
        await fetch(appConfig.APP_PING_URL, { method: "GET" });
      } catch (e) {
        console.log(`[${appConfig.name}] ping fail`, e?.message || e);
      }
    }

    const expirationTtl = getSecondsUntilNextUTCMidnight();
    await env.START_LOCK.put(lockKey, "1", { expirationTtl });
    
    return { success: true, app: appConfig.name };
  } catch (error) {
    console.error(`[${appConfig.name}] error:`, error.message);
    return { success: false, app: appConfig.name, error: error.message };
  }
}

// 获取应用锁状态
async function getAppLockStatus(appConfig, env) {
  const ymd = new Date().toISOString().slice(0, 10);
  const lockKey = `start-lock:${appConfig.name}:${ymd}`;
  const locked = !!(await env.START_LOCK.get(lockKey));
  
  return {
    app: appConfig.name,
    locked: locked,
    lockKey: lockKey
  };
}

// 获取应用状态
async function getAppStatus(appConfig, env) {
  try {
    const api = appConfig.CF_API.replace(/\/+$/, "");
    const tok = await getUAAToken(appConfig);
    const gid = await resolveAppGuid(appConfig, tok, api);
    const s = await getAppState(api, tok, gid);
    
    return {
      success: true,
      app: appConfig.name,
      appState: s
    };
  } catch (error) {
    console.error(`[${appConfig.name}] status error:`, error.message);
    return { success: false, app: appConfig.name, error: error.message };
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

// 显示应用详情（三级菜单）
async function showAppDetail(env, chatId, appName) {
  try {
    const APPS = JSON.parse(env.APPS_CONFIG || "[]");
    const app = APPS.find(a => a.name === appName);
    
    if (!app) {
      await sendTelegramMessage(env, chatId, '❌ 应用不存在', null, createBackKeyboard());
      return;
    }
    
    // 获取应用状态
    const appStatus = await getAppStatus(app, env);
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
    
    if (appStatus.error) {
      message += `<b>错误:</b> ${appStatus.error}\n`;
    }
    
    await sendTelegramMessage(env, chatId, message, 'HTML', createAppDetailKeyboard(appName));
    
  } catch (error) {
    console.error('Show app detail error:', error);
    await sendTelegramMessage(env, chatId, '❌ 获取应用详情时出错', null, createBackKeyboard());
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
        await showAppList(env, chatId);
        break;
        
      case 'unlock_all':
        const ymdToday = new Date().toISOString().slice(0, 10);
        const enabledApps = APPS.filter(app => app.enabled !== false);
        let unlockCount = 0;
        
        for (const app of enabledApps) {
          const lockKey = `start-lock:${app.name}:${ymdToday}`;
          const wasLocked = !!(await env.START_LOCK.get(lockKey));
          await env.START_LOCK.delete(lockKey);
          if (wasLocked) unlockCount++;
        }
        
        await sendTelegramMessage(
          env, 
          chatId, 
          `✅ 已解锁 ${unlockCount} 个应用`, 
          'HTML', 
          createMainMenuKeyboard() // 返回主菜单而不是返回列表
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
          createMainMenuKeyboard() // 返回主菜单
        );
        break;
        
      default:
        if (data.startsWith('app_detail_')) {
          const appName = data.replace('app_detail_', '');
          await showAppDetail(env, chatId, appName);
          break;
        }
        
        if (data.startsWith('unlock_')) {
          const appName = data.replace('unlock_', '');
          const app = APPS.find(a => a.name === appName);
          if (app) {
            const ymd = new Date().toISOString().slice(0, 10);
            const lockKey = `start-lock:${appName}:${ymd}`;
            await env.START_LOCK.delete(lockKey);
            await sendTelegramMessage(env, chatId, `✅ 应用 <code>${appName}</code> 已解锁`, 'HTML', createAppDetailKeyboard(appName));
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

// 定时任务
async function runAllInSchedule(env) {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  
  if (utcH === 0 && utcM % 2 === 0) {
    try {
      const APPS = JSON.parse(env.APPS_CONFIG || "[]");
      const results = [];
      
      for (const app of APPS) {
        if (app.enabled !== false) {
          const result = await ensureAppRunning(app, env, { reason: "cron" });
          results.push(result);
          await sleep(1000);
        }
      }
      
      // 注释掉以下Telegram通知代码，关闭启动通知
      /*
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_IDS) {
        const adminIds = env.TELEGRAM_ADMIN_IDS.split(',').map(id => id.trim());
        const successCount = results.filter(r => r.success).length;
        const totalCount = APPS.filter(app => app.enabled !== false).length;
        
        for (const adminId of adminIds) {
          await sendTelegramMessage(env, adminId,
            `⏰ <b>定时启动报告</b>\n` +
            `时间: ${new Date().toLocaleString('zh-CN')}\n` +
            `成功: ${successCount}/${totalCount} 个应用`
          );
        }
      }
      */
      
      return results;
    } catch (error) {
      console.error("[cron] error:", error);
    }
  }
  return [];
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
      
      // 默认响应
      return json({ 
        ok: true, 
        message: "CF App Manager with Telegram Bot (Admin Only)",
        telegram_webhook: "/webhook",
        setup_instructions: {
          step1: "极速部署：一键配置Cloudflare Workers",
          step2: "设置环境变量：TELEGRAM_BOT_TOKEN和TELEGRAM_ADMIN_IDS",
          step3: `设置Webhook：GET https://${host}/webhook?action=set`,
          step4: "在Telegram中向您的机器人发送 /start 命令"
        }
      });
      
    } catch (error) {
      console.error("[fetch error]", error?.message || error);
      return json({ ok: false, error: String(error) }, 500);
    }
  }
};
