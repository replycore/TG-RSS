/**
 * 测试用 dev-server 助手（N-6 隔离修复）。
 *
 * 旧做法：8 个测试文件共用一台手动启动的 localhost:8787——内存 KV/Cache 是全局共享的，
 * 评审脚本或任一测试改了管理员/设置/RSS token，其他文件就偶发失败。
 *
 * 中间做法（已废弃）：spawn 子进程跑 dev-server。iSH + node --test 并发下孙进程
 * 高概率静默夭折（exit 0、零输出），不可靠。
 *
 * 现做法：测试进程内直接 import tools/dev-server.mjs 的 startDevServer({port:0})——
 * 零子进程，每测试文件一个专属实例（独立内存 KV），server.unref() 不拖住退出。
 * 仍可 TEST_BASE / TG_RSS_BASE 指定外部实例（复现问题/调试用）。
 */
let basePromise = null;
let handle = null;

/** 返回本测试文件专属 dev-server 的 base URL；启动失败返回 null（调用方按旧逻辑 skip）。 */
export function isolatedBase() {
  const external = process.env.TEST_BASE || process.env.TG_RSS_BASE;
  if (external) return Promise.resolve(external);
  if (!basePromise) {
    basePromise = (async () => {
      try {
        const { startDevServer } = await import("../../tools/dev-server.mjs");
        handle = await startDevServer({ port: 0, keepAlive: false });
        return handle.url;
      } catch (err) {
        console.error(`[isolatedBase] 专属 dev-server 启动失败，回退 serverUp 跳过语义：${err.message}`);
        return null;
      }
    })();
  }
  return basePromise;
}

/** 需要直接访问 KV/环境的测试用（例如注入初始设置）。未隔离时返回 null。 */
export function isolatedHandle() {
  return handle;
}
