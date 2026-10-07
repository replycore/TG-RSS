/**
 * 一次性登录：获取 Telegram 会话字符串（StringSession）
 * 用法：npm run login  →  按提示输入手机号 / 验证码 / 两步验证密码
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { config } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(1);
}

async function main() {
  if (!config.apiId || !config.apiHash) {
    fail("请先在 bridge/.env 填写 TG_API_ID / TG_API_HASH（https://my.telegram.org/apps）");
  }

  const rl = readline.createInterface({ input, output });
  const ask = async (q) => (await rl.question(q)).trim();

  const phone = config.phone || (await ask("手机号（国际格式，如 +8613800138000）："));

  const client = new TelegramClient(new StringSession(config.session || ""), config.apiId, config.apiHash, {
    connectionRetries: 5,
    useWSS: false,
  });

  try {
    await client.start({
      phoneNumber: async () => phone,
      password: async () => {
        const p = await ask("两步验证密码（没有则直接回车后仍会失败，可留空）：");
        return p || " ";
      },
      phoneCode: async () => ask("收到的验证码："),
      onError: (err) => console.error("登录出错：", err.message || err),
    });

    const session = client.session.save();
    const me = await client.getMe();

    console.log("\n登录成功：", me.first_name || "", me.last_name || "", `(id=${me.id})`);
    console.log("会话字符串：\n");
    console.log(session);
    console.log("\n正在写入 bridge/.env …");

    const envPath = path.join(here, ".env");
    if (fs.existsSync(envPath)) {
      const text = fs.readFileSync(envPath, "utf8");
      if (/^TG_SESSION=.*$/m.test(text)) {
        fs.writeFileSync(envPath, text.replace(/^TG_SESSION=.*$/m, `TG_SESSION=${session}`));
      } else {
        fs.writeFileSync(envPath, `${text.trimEnd()}\nTG_SESSION=${session}\n`);
      }
      console.log(`已更新 ${envPath}`);
    } else {
      fs.writeFileSync(envPath, `TG_API_ID=${config.apiId}\nTG_API_HASH=${config.apiHash}\nTG_PHONE=${phone}\nTG_SESSION=${session}\nBRIDGE_TOKEN=${config.token || "change-me-to-a-long-random-string"}\nPORT=${config.port}\n`);
      console.log(`已创建 ${envPath}（请补齐 BRIDGE_TOKEN 等配置）`);
    }
    console.log("\n接下来：npm start 启动桥接，并在 TG-RSS 后台填入地址与令牌。");
  } finally {
    rl.close();
    await client.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("登录失败：", err.message || err);
  process.exit(1);
});
