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


基于老罗的代码改动，感谢老罗：https://gist.github.com/uncleluogithub/083775a84afbff11f1057695ce29fddb <br>
老罗油管视频详细教程： https://www.youtube.com/watch?v=w-j8yPE2fKg
