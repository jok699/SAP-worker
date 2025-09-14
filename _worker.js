// 单文件多应用管理器 - 独立锁死机制
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
    
    try {
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
            message: "Multi-App Cloud Foundry Manager",
            version: "3.0",
            description: "Each app has independent daily lock that expires at UTC midnight",
            endpoints: [
              "GET /list-apps - List all configured apps",
              "GET /start?app=name - Start specific app",
              "GET /start?app=name&force=1 - Force start specific app",
              "GET /start - Start all enabled apps", 
              "GET /stop?app=name - Stop specific app",
              "GET /state?app=name - Get app status",
              "GET /state - Get all apps status",
              "GET /diag - Diagnostic information",
              "GET /unlock?app=name - Remove daily lock for app",
              "GET /unlock - Remove all daily locks",
              "GET /locks - Check current lock status",
              "GET /clear-locks - Clear all app locks (force unlock)"
            ]
          });
      }
      
    } catch (error) {
      console.error("[fetch error]", error?.message || error);
      return json({ ok: false, error: String(error) }, 500);
    }
  }
};
