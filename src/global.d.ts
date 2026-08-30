// 补充 wrangler types 无法从配置生成的绑定类型：
// - KV 绑定（kv_namespaces 在创建 namespace 后才填入配置）
// - Secret（STEAM_API_KEY 通过 `wrangler secret put` 设置）
interface Env {
  STEAM_CACHE: KVNamespace;
  STEAM_API_KEY: string;
}
