/**
 * TG-RSS 统一入口。
 * Workers：wrangler.jsonc 的 main 指向本文件。
 * Pages：functions/[[path]].js 直接调用 default.fetch。
 */
import { handleRequest } from "./router.js";

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx || {});
  },
};
