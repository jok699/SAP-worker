# 利用clouflare worker，SAP BTP多账户多app应用一起并发拉起保活 #
## 1、创建worker项目 ##
1）把_worker.js里面的代码复制粘贴到你的worker上面，保存部署。 <br>
2）添加环境变量，名称：APPS_CONFIG，对应的值复制APPS_CONFIG.json里面的代码，改成你自己的账号信息，保存。 <br>
设置触发时间每分钟。 <br>
如图： <br>
![Image](https://github.com/jok699/SAP-worker/blob/main/image/%E7%8E%AF%E5%A2%83%E5%8F%98%E9%87%8F.png) <br>
3）创建KV空间，绑定kv空间，名称：START_LOCK，对应你刚刚创建的空间。 <br>
如图： <br>
![Image](https://github.com/jok699/SAP-worker/blob/main/image/kv.png) <br>

## 2、每个应用启动一次就锁定了当天无法再次启动，可以手动解锁： ## 
### 🔓 手动解锁方法： ###
1）解锁单个应用 <br>
https://your-worker.workers.dev/unlock?app=你的应用名称  <br>
2）解锁所有应用 <br>
https://your-worker.workers.dev/unlock  <br>
3）查看当前锁状态 <br>
https://your-worker.workers.dev/locks <br>

### 某个app启动失败需要重新启动，可以先解锁后手动启动。 ### 
启动单个应用： <br>
https://your-worker.workers.dev/start?app=你的应用名称 <br>
无需解锁强制启动单个应用（使用&force=1）：  <br>
https://your-worker.workers.dev/start?app=你的应用名&force=1  <br>

启动所有应用： <br>
https://your-worker.workers.dev/start <br>

# telegram bot版 #
## 本版本接入电报机器人手工拉起 ##
1）参考前面的部署流程，复制_worker2.js代码到你的worker上面，保存部署。 <br>
2）环境变量添加多两个变量：   <br>
TELEGRAM_BOT_TOKEN，填写机器人token  <br>
TELEGRAM_ADMIN_IDS，填写你的电报ID，多个管理员使用英文逗号隔开。  <br>

## 感谢 ##

基于老罗的代码改动：https://gist.github.com/uncleluogithub/083775a84afbff11f1057695ce29fddb <br>
老罗油管视频详细教程： https://www.youtube.com/watch?v=w-j8yPE2fKg
