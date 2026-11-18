require("dotenv").config();
const {
  CloudClient,
  FileTokenStore,
  logger: sdkLogger,
} = require("cloud189-sdk");
const recording = require("log4js/lib/appenders/recording");
const accounts = require("../accounts");
const { mask, delay } = require("./utils");
const push = require("./push");
const { log4js, cleanLogs, catLogs } = require("./logger");
const tokenDir = ".token";

sdkLogger.configure({
  isDebugEnabled: process.env.CLOUD189_VERBOSE === "1",
});

// 每个账号的执行结果，用于拼推送标题
const accountResults = [];

// 个人任务签到
const doUserTask = async (cloudClient, logger) => {
  const result = await cloudClient.userSign()
  const netdiskBonus = result.isSign? 0: result.netdiskBonus
  logger.info(`个人签到任务: 获得 ${netdiskBonus}M 空间`);
  return netdiskBonus;
};

const run = async (userName, password, userSizeInfoMap, logger) => {
  if (userName && password) {
    const before = Date.now();
    const outcome = { userName: mask(userName, 3, 7), ok: false, bonus: 0 };
    accountResults.push(outcome);
    try {
      logger.log("开始执行");
      const cloudClient = new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`),
      });
      const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();
      userSizeInfoMap.set(userName, {
        cloudClient,
        userSizeInfo: beforeUserSizeInfo,
        logger,
      });
      const [bonus] = await Promise.all([doUserTask(cloudClient, logger)]);
      outcome.ok = true;
      outcome.bonus = Number(bonus) || 0;
    } catch (e) {
      outcome.error = e.response
        ? `HTTP ${e.response.statusCode}`
        : e.message || String(e);
      if (e.response) {
        logger.log(`请求失败: ${e.response.statusCode}, ${e.response.body}`);
      } else {
        logger.error(e);
      }
      if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") {
        logger.error("请求超时");
        throw e;
      }
    } finally {
      logger.log(
        `执行完毕, 耗时 ${((Date.now() - before) / 1000).toFixed(2)} 秒`
      );
    }
  }
};

// 微信预览只显示标题，所以把签到结果写进标题
const buildPushTitle = () => {
  const total = accountResults.length;
  const failed = accountResults.filter((r) => !r.ok).length;
  const bonus = accountResults.reduce((sum, r) => sum + r.bonus, 0);
  if (total === 0) {
    return "⚠️ 天翼签到 未执行";
  }
  if (failed === 0) {
    return bonus > 0 ? `✅ 天翼签到 +${bonus}M` : "✅ 天翼签到 今日已签";
  }
  if (failed === total) {
    return `❌ 天翼签到失败 ${failed}/${total}`;
  }
  return `⚠️ 天翼签到 ${total - failed}/${total} 成功`;
};

// 开始执行程序
async function main() {
  //  用于统计实际容量变化
  const userSizeInfoMap = new Map();
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const { userName, password } = account;
    const userNameInfo = mask(userName, 3, 7);
    const logger = log4js.getLogger(userName);
    logger.addContext("user", userNameInfo);
    await run(userName, password, userSizeInfoMap, logger);
  }

  //数据汇总
  for (const [
    userName,
    { cloudClient, userSizeInfo, logger },
  ] of userSizeInfoMap) {
    const afterUserSizeInfo = await cloudClient.getUserSizeInfo();
    logger.log(
      `个人容量：⬆️  ${(
        (afterUserSizeInfo.cloudCapacityInfo.totalSize -
          userSizeInfo.cloudCapacityInfo.totalSize) /
        1024 /
        1024
      ).toFixed(2)}M/${(
        afterUserSizeInfo.cloudCapacityInfo.totalSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G`,
      `家庭容量：⬆️  ${(
        (afterUserSizeInfo.familyCapacityInfo.totalSize -
          userSizeInfo.familyCapacityInfo.totalSize) /
        1024 /
        1024
      ).toFixed(2)}M/${(
        afterUserSizeInfo.familyCapacityInfo.totalSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G`
    );
  }
}

(async () => {
  try {
    await main();
    //等待日志文件写入
    await delay(1000);
  } finally {
    const logs = catLogs();
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
    push(buildPushTitle(), logs + content);
    recording.erase();
    cleanLogs();
  }
})();
