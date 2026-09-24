import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { WarudoBridge, type WarudoResponse } from "./warudoBridge.js";
import { WarudoApiClient, type ApiMessage } from "./warudoApi.js";
import { discoverApiToken } from "./token.js";

// Bẫy lỗi toàn cục để ngăn Node.js crash tiến trình MCP server
process.on("uncaughtException", (err) => {
  console.error("[warudo-mcp] Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[warudo-mcp] Unhandled Rejection:", reason);
});

process.stdout.on("error", (err: unknown) => {
  if ((err as { code?: string })?.code === "EPIPE") {
    process.exit(0);
  }
});

const config = loadConfig();

// Kênh chính: control-plane tích hợp sẵn của Warudo (19053, có token).
const api = new WarudoApiClient(config.apiWsUrl, discoverApiToken);
api.connect();
api.onNotification((action) => {
  if (action === "confirmation") {
    console.error(`[WarudoApi] Confirmation từ Warudo — policy=${api.getConfirmationPolicy()} (xem warudo_set_confirmation_policy).`);
  } else if (action === "structuredDataInput") {
    console.error(`[WarudoApi] structuredDataInput từ Warudo — policy=${api.getConfirmationPolicy()}.`);
  }
});

// Kênh fallback cũ: plugin MCP Bridge (5678).
const bridge = new WarudoBridge(config.wsUrl);
bridge.connect();

const cleanup = () => {
  api.stop();
  bridge.stop();
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// Khi IDE/Claude/host đóng pipe stdin (hoặc tiến trình cha thoát)
process.stdin.on("end", () => {
  cleanup();
  process.exit(0);
});
process.stdin.on("close", () => {
  cleanup();
  process.exit(0);
});
process.stdin.on("error", () => {
  cleanup();
  process.exit(0);
});

// Watchdog kiểm tra tiến trình cha để không bao giờ bị biến thành orphan process
if (process.ppid && process.platform === "win32") {
  const checkParentTimer = setInterval(() => {
    try {
      process.kill(process.ppid, 0);
    } catch {
      clearInterval(checkParentTimer);
      cleanup();
      process.exit(0);
    }
  }, 3000);
  checkParentTimer.unref();
}

const server = new McpServer({ name: "warudo-mcp", version: "0.2.1" });

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function text(message: string): ToolResult {
  return { content: [{ type: "text", text: message }] };
}

/** Gọi lệnh lên plugin MCP Bridge (kênh cũ). */
async function run(action: string, data: Record<string, unknown>): Promise<ToolResult> {
  try {
    const r: WarudoResponse = await bridge.call(action, data);
    if (!r.ok) return text(`Lỗi: ${r.error ?? "Warudo trả về lỗi không rõ."}`);
    return text(JSON.stringify(r.data ?? {}, null, 2));
  } catch (e) {
    return text(`Lỗi: ${(e as Error).message}`);
  }
}

/** Gọi một action của control-plane tích hợp sẵn (19053). */
async function apiRun(action: string, data: Record<string, unknown> = {}): Promise<ToolResult> {
  try {
    const r: ApiMessage = await api.call(action, data);
    if (r.error) return text(`Lỗi: ${r.error}`);
    return text(JSON.stringify(r.data ?? null, null, 2));
  } catch (e) {
    return text(`Lỗi: ${(e as Error).message}`);
  }
}

/** Báo trạng thái kết nối khi control-plane chưa sẵn sàng. */
function apiHint(): string {
  if (api.isConnected()) return "";
  return `\n\nKiểm tra: Warudo đang chạy chứ? Token API có lấy được không (warudo_get_status)?`;
}

/* ── Parsing giá trị material ─────────────────────────────── */

function parseColorHex(hex: string): [number, number, number, number] {
  const h = hex.replace("#", "");
  const m = h.match(/^([0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!m) throw new Error(`Màu không hợp lệ: "${hex}" (dùng dạng #rrggbb hoặc #rrggbbaa).`);
  const full = h.length === 6 ? h + "ff" : h;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const a = parseInt(full.slice(6, 8), 16) / 255;
  return [r, g, b, a];
}

function parseColorList(list: string): [number, number, number, number] {
  const parts = list.split(",").map((s) => Number(s.trim()));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Màu không hợp lệ: "${list}" (dùng "r,g,b" hoặc "r,g,b,a").`);
  }
  const scale = parts.some((n) => n > 1) ? 255 : 1; // 0-255 hay 0-1
  const [r, g, b] = parts.map((n) => n / scale);
  const a = parts.length >= 4 ? parts[3] / scale : 1;
  return [r, g, b, a];
}

function parseColor(raw: string): [number, number, number, number] {
  const s = raw.trim();
  if (s.startsWith("#")) return parseColorHex(s);
  return parseColorList(s);
}

/** "float:0.5" | "int:3" | "bool:true" | "keyword:true" | "color:#ff88ee" | "string:..." | "enum:..." | "vector3:1,2,3" */
function parseValue(raw: string): { type: string; value: unknown } {
  const idx = raw.indexOf(":");
  const kind = (idx >= 0 ? raw.slice(0, idx) : raw).trim().toLowerCase();
  const rest = idx >= 0 ? raw.slice(idx + 1).trim() : raw;
  switch (kind) {
    case "float":
      return { type: "float", value: Number(rest) };
    case "int":
      return { type: "int", value: Number(rest) };
    case "bool":
    case "keyword":
      return { type: kind, value: rest.toLowerCase() === "true" || rest === "1" };
    case "color":
      return { type: "color", value: parseColor(rest) };
    case "string":
      return { type: "string", value: rest };
    case "enum":
      return { type: "enum", value: rest };
    case "vector3": {
      const parts = rest.split(",").map((s) => Number(s.trim()));
      if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) {
        throw new Error(`vector3 không hợp lệ: "${rest}" (dùng "x,y,z").`);
      }
      return { type: "vector3", value: [parts[0], parts[1], parts[2]] };
    }
    case "json": {
      // Giá trị cấu trúc (struct/list/mapping) — best-effort cho setEntityDataInputPortValue.
      try {
        return { type: "json", value: JSON.parse(rest) };
      } catch (e) {
        throw new Error(`json không hợp lệ: ${(e as Error).message}`);
      }
    }
    default:
      throw new Error(
        `Kiểu giá trị không hỗ trợ: "${kind}". Dùng float:, int:, bool:, keyword:, color:, string:, enum:, vector3:, json:.`
      );
  }
}

/* ── Trạng thái ───────────────────────────────────────────── */

server.tool("warudo_status", "Báo trạng thái kết nối: control-plane API (19053) + bridge cũ (5678) + token API.", {}, async () => {
  const apiOk = api.isConnected();
  const bridgeOk = bridge.isConnected();
  const lines = [
    `Control-plane API (${config.apiWsUrl}): ${apiOk ? "connected ✓" : "disconnected ✗"}`,
    `Legacy bridge (${config.wsUrl}): ${bridgeOk ? "connected ✓" : "disconnected ✗"}`,
  ];
  if (apiOk) {
    try {
      const r = await api.call("getPlugins");
      const plugins = (r.data as { plugins?: Record<string, unknown> })?.plugins ?? {};
      lines.push(`API plugins: ${Object.keys(plugins).length}`);
      lines.push(`Frame state entities: ${apiEntityCount()}`);
    } catch {
      /* bỏ qua */
    }
    lines.push(`Confirmation policy: ${api.getConfirmationPolicy()}`);
    const recent = api.getRecentAutoReplies();
    if (recent.length > 0) {
      lines.push(`Auto-replies gần đây: ${JSON.stringify(recent.slice(-3))}`);
    }
  } else {
    lines.push(
      `Token API: ${await discoverApiToken().then((t) => (t ? "tìm thấy ✓" : "không tìm thấy (Warudo chưa chạy?)")).catch(() => "lỗi khi dò")}`
    );
  }
  return text(lines.join("\n"));
});

function apiEntityCount(): number {
  const frame = api.getLastFrame() as { entityData?: Record<string, unknown> } | null;
  return frame && typeof frame.entityData === "object" ? Object.keys(frame.entityData).length : 0;
}

/* ── Tools: control-plane API (19053) ─────────────────────── */

server.tool(
  "warudo_api",
  "Gọi trực tiếp MỘT action bất kỳ của control-plane Warudo (60 actions) khi chưa có tool chuyên dụng. " +
    "Data key phổ biến: getEntityDataInputPortValue {id,port}; setEntityDataInputPortValue {id,port,value,broadcast?}; " +
    "invokeEntityTriggerPort {id,port}; sendPluginMessage {pluginId,action,payload}; " +
    "addNodeOfType {graph,type,x,y}; addDataConnection {graph,outputNode,inputNode,outputPort,inputPort}; " +
    "invokeFlowAtInput {graph,node,inputPort}; importGraph {json}; exportGraph {graph}; " +
    "getEnumTypes {types}; getAutoCompleteLists; getAssetTypeList; getNodeTypeList; getPlugins; " +
    "getSelectedGraph; setSelectedGraph {graph}; getSelectedAsset; setSelectedAsset {asset}; " +
    "setGraphEnabled {graph,enabled}; addAssetOfType {type}; applyAssetProperties {asset,json}; ...",
  {
    action: z.string().describe("Tên action, ví dụ: getSelectedGraph, setEntityDataInputPortValue, addNodeOfType, getPlugins, sendPluginMessage"),
    data: z.record(z.string(), z.unknown()).optional().describe("Payload của action (KHÔNG đưa key 'id' — client tự gắn)"),
  },
  async ({ action, data }) => apiRun(action, data ?? {})
);

server.tool(
  "warudo_get_plugins",
  "Liệt kê các plugin Warudo đang tải (id, name, version, số data input / trigger). Nhỏ gọn, không kèm payload lớn.",
  {},
  async () => {
    try {
      const r = await api.call("getPlugins");
      const plugins = (r.data as { plugins?: Record<string, unknown> })?.plugins ?? {};
      const summary = Object.entries(plugins).map(([id, p]) => {
        const pv = (p ?? {}) as Record<string, unknown>;
        const type = (pv.type ?? {}) as Record<string, unknown>;
        const dataInputs = (pv.dataInputs ?? {}) as Record<string, unknown>;
        const triggers = (pv.triggers ?? {}) as Record<string, unknown>;
        return {
          id,
          name: type.name ?? id,
          version: type.version ?? pv.version ?? "?",
          dataInputs: Object.keys(dataInputs).length,
          triggers: Object.keys(triggers).length,
        };
      });
      return text(JSON.stringify({ count: summary.length, plugins: summary }, null, 2));
    } catch (e) {
      return text(`Lỗi: ${(e as Error).message}${apiHint()}`);
    }
  }
);

server.tool(
  "warudo_get_selected_graph",
  "Trả về graph (blueprint) đang được chọn trong editor Warudo, kèm nodes/connections. null nếu chưa chọn graph nào.",
  {},
  async () => apiRun("getSelectedGraph")
);

server.tool(
  "warudo_get_selected_asset",
  "Trả về id của asset đang được chọn trong editor Warudo (vd avatar).",
  {},
  async () => apiRun("getSelectedAsset")
);

server.tool(
  "warudo_get_asset_types",
  "Liệt kê các loại asset Warudo có thể tạo (theo category): id + title. full=true để lấy toàn bộ metadata.",
  { full: z.boolean().optional().describe("true = trả về toàn bộ metadata từng loại (mặc định false)") },
  async ({ full }) => {
    try {
      const r = await api.call("getAssetTypeList");
      const cats = (r.data as { categories?: Array<Record<string, unknown>> })?.categories ?? [];
      const out = cats.map((c) => {
        const types = (c.assetTypes ?? []) as Array<Record<string, unknown>>;
        return {
          name: c.name,
          count: types.length,
          assetTypes: full ? types : types.map((t) => ({ title: t.title, id: t.id })),
        };
      });
      return text(JSON.stringify({ categories: out }, null, 2));
    } catch (e) {
      return text(`Lỗi: ${(e as Error).message}${apiHint()}`);
    }
  }
);

server.tool(
  "warudo_get_node_types",
  "Liệt kê các loại node blueprint Warudo (theo category). Mặc định chỉ trả về tiêu đề mỗi loại để gọn; " +
    "full=true để kèm id cho từng node.",
  { full: z.boolean().optional().describe("true = kèm id từng node (dữ liệu lớn)") },
  async ({ full }) => {
    try {
      const r = await api.call("getNodeTypeList");
      const cats = (r.data as { categories?: Array<Record<string, unknown>> })?.categories ?? [];
      const out = cats.map((c) => {
        const types = (c.nodeTypes ?? []) as Array<Record<string, unknown>>;
        return {
          name: c.name,
          count: types.length,
          nodeTypes: full ? types.map((t) => ({ title: t.title, id: t.id })) : types.map((t) => t.title),
        };
      });
      return text(JSON.stringify({ categories: out }, null, 2));
    } catch (e) {
      return text(`Lỗi: ${(e as Error).message}${apiHint()}`);
    }
  }
);

server.tool(
  "warudo_get_entity_port_value",
  "Đọc giá trị hiện tại của một data input port trên entity (asset/graph/node) trong Warudo.",
  {
    id: z.string().describe("Id của entity (asset id, graph id, node id...)"),
    port: z.string().describe("Tên data input port, ví dụ 'FloatValue', 'Character', 'Enabled'"),
  },
  async ({ id, port }) => apiRun("getEntityDataInputPortValue", { id, port })
);

server.tool(
  "warudo_set_entity_port_value",
  "Gán giá trị cho một data input port trên entity trong Warudo. Giá trị dùng tiền tố kiểu như các tool khác: " +
    "'float:2.5', 'int:3', 'bool:true', 'string:hello', 'enum:Idle', 'color:#ff88ee', 'vector3:1,2,3'.",
  {
    id: z.string().describe("Id của entity"),
    port: z.string().describe("Tên data input port"),
    value: z.string().describe("Giá trị kèm kiểu, ví dụ 'float:2.5'"),
    broadcast: z.boolean().optional().describe("true = phát broadcast thay đổi cho mọi client (mặc định false)"),
  },
  async ({ id, port, value, broadcast }) => {
    try {
      const parsed = parseValue(value);
      return apiRun("setEntityDataInputPortValue", { id, port, value: parsed.value, broadcast: broadcast ?? false });
    } catch (e) {
      return text(`Lỗi: ${(e as Error).message}`);
    }
  }
);

server.tool(
  "warudo_invoke_entity_trigger",
  "Kích hoạt một trigger port trên entity trong Warudo (tương tự bấm nút trigger trong editor).",
  {
    id: z.string().describe("Id của entity"),
    port: z.string().describe("Tên trigger port, ví dụ 'RequestStepRender'"),
  },
  async ({ id, port }) => apiRun("invokeEntityTriggerPort", { id, port })
);

server.tool(
  "warudo_inspect_entity",
  "Liệt kê toàn bộ data input port của một entity (asset/node/graph) kèm type C#, label, enum values và " +
    "giá trị hiện tại — dùng để biết chính xác cách set value. Chạy qua bridge (5678).",
  { id: z.string().describe("Id của entity (asset id, node id, hoặc graph id/name)") },
  async ({ id }) => run("inspect_entity", { id, entityId: id })
);

server.tool(
  "warudo_import_graph",
  "Import một blueprint vào Warudo từ JSON định dạng 'Export Blueprint'. dryRun=true chỉ kiểm tra JSON hợp lệ.",
  {
    json: z.string().describe("Chuỗi JSON blueprint (format Export Blueprint của Warudo)"),
    dryRun: z.boolean().optional().describe("true = chỉ validate, không import"),
  },
  async ({ json, dryRun }) => {
    try {
      JSON.parse(json);
    } catch (e) {
      return text(`Lỗi: JSON không hợp lệ — ${(e as Error).message}`);
    }
    if (dryRun) {
      const o = (JSON.parse(json) ?? {}) as Record<string, unknown>;
      return text(`DRY RUN (không import): blueprint "${o.name ?? "(không tên)"}" sẽ có ${Array.isArray(o.nodes) ? o.nodes.length : "?"} node.`);
    }
    return apiRun("importGraph", { json });
  }
);

server.tool(
  "warudo_send_plugin_message",
  "Gửi một message tới Plugin Warudo (action chạy qua Plugin.OnMessageReceived). " +
    "Dùng cho các thao tác Unity-specific do plugin cung cấp.",
  {
    pluginId: z.string().describe("Id của plugin, ví dụ 'com.hasukatsu.warudo.mcpbridge'"),
    action: z.string().describe("Tên action plugin, ví dụ 'list_hierarchy', 'switch_outfit'"),
    payload: z.string().optional().describe("Payload JSON dạng chuỗi (mặc định '{}')"),
  },
  async ({ pluginId, action, payload }) => apiRun("sendPluginMessage", { pluginId, action, payload: payload ?? "{}" })
);

server.tool(
  "warudo_frame_state",
  "Trả về snapshot mới nhất của trạng thái entity do Warudo broadcast qua 'frameUpdate' " +
    "(giá trị port hiện tại của các entity đang được theo dõi).",
  {},
  async () => {
    const frame = api.getLastFrame();
    if (frame === null) return text(`Chưa có frameUpdate nào (chưa kết nối control-plane?).${apiHint()}`);
    return text(JSON.stringify(frame, null, 2));
  }
);

server.tool(
  "warudo_set_confirmation_policy",
  "Chọn cách MCP server phản hồi khi Warudo hỏi xác nhận (confirmation / structuredDataInput): " +
    "'decline' (mặc định) = tự từ chối — an toàn nhưng lệnh phá hoại (xóa asset, import chồng...) có thể no-op; " +
    "'accept' = tự đồng ý — bật khi bạn thực sự muốn chạy thao tác đó. Chính sách chỉ áp dụng cho phiên hiện tại.",
  {
    mode: z.enum(["decline", "accept"]).describe("'decline' = tự từ chối (mặc định, an toàn); 'accept' = tự đồng ý"),
  },
  async ({ mode }) => {
    api.setConfirmationPolicy(mode);
    return text(
      `Confirmation policy → ${mode}. ` +
        (mode === "accept"
          ? "⚠️ MCP sẽ tự ĐỒNG Ý các xác nhận của Warudo — cẩn thận với lệnh phá hoại."
          : "An toàn: MCP tự từ chối/hủy xác nhận.")
    );
  }
);

/* ── Tools: scene inventory ───────────────────────────────── */

server.tool(
  "warudo_scene_inventory",
  "Tổng quan toàn bộ scene: asset (nhóm theo category) + graph/blueprint kèm số node. " +
    "Ưu tiên qua bridge (5678) — nguồn duy nhất liệt kê được cả scene; nếu bridge offline, " +
    "fallback về control-plane (chỉ thấy selection + plugins) và báo rõ nguồn dữ liệu.",
  {},
  async () => {
    if (bridge.isConnected()) {
      try {
        const [assetsRes, graphsRes] = await Promise.all([
          bridge.call("list_assets", {}),
          bridge.call("list_graphs", {}),
        ]);
        if (!assetsRes.ok) return text(`Lỗi bridge list_assets: ${assetsRes.error}`);
        if (!graphsRes.ok) return text(`Lỗi bridge list_graphs: ${graphsRes.error}`);
        return text(
          JSON.stringify(
            { source: "bridge (5678)", assets: assetsRes.data ?? [], graphs: graphsRes.data ?? [] },
            null,
            2
          )
        );
      } catch (e) {
        return text(`Lỗi: ${(e as Error).message}`);
      }
    }
    try {
      const [g, a, p] = await Promise.all([
        api.call("getSelectedGraph").catch(() => ({ action: "getSelectedGraph", error: "api offline" }) as ApiMessage),
        api.call("getSelectedAsset").catch(() => ({ action: "getSelectedAsset", error: "api offline" }) as ApiMessage),
        api.call("getPlugins").catch(() => ({ action: "getPlugins", error: "api offline" }) as ApiMessage),
      ]);
      const plugins = (p.data as { plugins?: Record<string, unknown> })?.plugins ?? {};
      return text(
        JSON.stringify(
          {
            source: "control-plane (19053) — bridge offline, chỉ thấy selection + plugins",
            selectedGraph: g.error ? { error: g.error } : (g.data ?? null),
            selectedAsset: a.error ? { error: a.error } : (a.data ?? null),
            pluginCount: Object.keys(plugins).length,
            hint: "Thêm asset 'MCP Bridge' (5678) vào scene để liệt kê được toàn bộ asset/graph.",
          },
          null,
          2
        )
      );
    } catch (e) {
      return text(`Lỗi: ${(e as Error).message}`);
    }
  }
);

/* ── Tools: legacy bridge (5678, fallback) ────────────────── */

server.tool("warudo_list_avatars", "Liệt kê tất cả avatar (CharacterAsset) đang có trong scene Warudo.", {}, async () => {
  return run("list_avatars", {});
});

server.tool(
  "warudo_list_hierarchy",
  "Liệt kê cây GameObject của một avatar — giúp tìm đường dẫn chính xác tới từng bộ đồ/tóc/phụ kiện để dùng trong các lệnh khác.",
  {
    avatar: z.string().describe("Id hoặc tên avatar (ví dụ: 'Hiyori')"),
    onlyMeshes: z.boolean().optional().describe("Chỉ trả về các node có Renderer (giúp lọc gọn cây thư mục)"),
    maxDepth: z.number().int().min(1).optional().describe("Độ sâu tối đa khi duyệt cây GameObject"),
  },
  async ({ avatar, onlyMeshes, maxDepth }) => run("list_hierarchy", { avatar, onlyMeshes, maxDepth })
);

server.tool(
  "warudo_set_gameobject_active",
  "Bật hoặc tắt một GameObject của avatar (ví dụ: mặc cởi một bộ đồ).",
  {
    avatar: z.string().describe("Id hoặc tên avatar"),
    path: z.string().describe("Đường dẫn GameObject từ gốc avatar, ví dụ 'Clothes/Jacket'. Dùng '' hoặc '/' cho gốc."),
    active: z.boolean().describe("true = bật, false = tắt"),
  },
  async ({ avatar, path, active }) => run("set_active", { avatar, path, active })
);

server.tool(
  "warudo_switch_outfit",
  "Đổi trang phục: tắt các bộ đồ liệt kê trong 'off' (hoặc '*' để tắt TẤT CẢ các mesh con), rồi bật các bộ trong 'on'.",
  {
    avatar: z.string().describe("Id hoặc tên avatar"),
    on: z.array(z.string()).min(1).describe("Đường dẫn các bộ đồ cần BẬT, ví dụ ['Clothes/Top A', 'Clothes/Bottom A']"),
    off: z
      .array(z.string())
      .optional()
      .describe("Đường dẫn các bộ đồ cần TẮT, hoặc ['*'] để tắt mọi mesh con của avatar. Mặc định: ['*']"),
  },
  async ({ avatar, on, off }) => run("switch_outfit", { avatar, on, off: off ?? ["*"] })
);

server.tool(
  "warudo_set_material_property",
  "Đổi một thuộc tính material của mesh trong avatar. Giá trị dùng tiền tố kiểu: 'float:0.5', 'int:3', 'bool:true', 'keyword:true', 'color:#ff88ee' hoặc 'color:255,120,200'.",
  {
    avatar: z.string().describe("Id hoặc tên avatar"),
    path: z.string().describe("Đường dẫn GameObject chứa mesh, ví dụ 'Clothes/Jacket'. '' = gốc avatar."),
    property: z.string().describe("Tên property của shader, ví dụ '_EmissionColor', '_EmissionMultiply'."),
    value: z.string().describe("Giá trị kèm kiểu, ví dụ 'color:#ff88ee' hoặc 'float:0.5'."),
    materialIndex: z.number().int().min(0).optional().describe("Chỉ số material trên mesh (mặc định 0)."),
  },
  async ({ avatar, path, property, value, materialIndex }) => {
    const parsed = parseValue(value);
    return run("set_material_property", {
      avatar,
      path,
      property,
      materialIndex: materialIndex ?? 0,
      value: parsed,
    });
  }
);

server.tool(
  "warudo_glow_outfit",
  "Làm một bộ đồ phát sáng (emission) trong một khoảng thời gian rồi tự tắt — dùng làm hiệu ứng chuyển đồ.",
  {
    avatar: z.string().describe("Id hoặc tên avatar"),
    path: z.string().describe("Đường dẫn GameObject của bộ đồ cần glow, ví dụ 'Clothes/Top A'."),
    color: z.string().optional().describe("Màu glow, mặc định '#ff66cc'. Dùng #rrggbb hoặc r,g,b."),
    durationMs: z.number().int().min(0).optional().describe("Thời gian glow tính bằng mili giây (mặc định 600)."),
  },
  async ({ avatar, path, color, durationMs }) => {
    let c: [number, number, number, number];
    try {
      c = parseColor(color ?? "#ff66cc");
    } catch (e) {
      return text(`Lỗi: ${(e as Error).message}`);
    }
    return run("glow_outfit", {
      avatar,
      path,
      color: c,
      durationMs: durationMs ?? 600,
    });
  }
);

server.tool(
  "warudo_trigger",
  "Kích hoạt các node 'On MCP Command' trong blueprint Warudo có cùng tên command — nối chúng tới logic bạn muốn chạy (ví dụ chuyển biểu cảm, animation).",
  { command: z.string().describe("Tên command khớp với node 'On MCP Command' trong Warudo, ví dụ 'run_dance'") },
  async ({ command }) => run("trigger", { command })
);

server.tool(
  "warudo_list_blueprints",
  "Liệt kê tất cả blueprint (graph) trong scene, kèm từng node: id, typeId, title và các data input (tên + giá trị hiện tại). Dùng để tìm đúng blueprint/node trước khi chỉnh sửa.",
  {},
  async () => run("list_blueprints", {})
);

server.tool(
  "warudo_set_node_data_input",
  "Đổi giá trị một data input của node trong blueprint. Tìm node theo id hoặc title. Giá trị dùng tiền tố kiểu: 'float:0.5', 'int:3', 'bool:true', 'string:hello', 'enum:Idle', 'color:#ff88ee', 'vector3:1,2,3'.",
  {
    blueprint: z.string().describe("Tên blueprint (graph) chứa node"),
    node: z.string().describe("Id hoặc title của node cần sửa"),
    input: z.string().describe("Tên data input, ví dụ 'Duration' hoặc 'Target'"),
    value: z.string().describe("Giá trị kèm kiểu, ví dụ 'float:2.5', 'string:hello', 'enum:Joy', 'color:#ff66cc'"),
  },
  async ({ blueprint, node, input, value }) => {
    try {
      const parsed = parseValue(value);
      return run("set_node_data_input", { blueprint, node, input, value: parsed });
    } catch (e) {
      return text(`Lỗi: ${(e as Error).message}`);
    }
  }
);

server.tool(
  "warudo_create_blueprint",
  "Tạo blueprint mới trong Warudo từ JSON định dạng 'Export Blueprint' của Warudo (gồm các node với typeId, vị trí, connections). Lấy mẫu bằng cách: trong Warudo tạo 1 blueprint nhỏ → chuột phải blueprint → Export → copy nội dung JSON rồi đưa vào đây (đổi tên/input). dryRun=true chỉ kiểm tra JSON hợp lệ và mô tả, KHÔNG import gì.",
  {
    json: z.string().describe("Chuỗi JSON blueprint định dạng Warudo (format Export Blueprint)"),
    dryRun: z.boolean().optional().describe("true = chỉ validate + mô tả, không import (mặc định false)"),
  },
  async ({ json, dryRun }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return text(`Lỗi: JSON không hợp lệ — ${(e as Error).message}`);
    }
    if (dryRun) {
      const o = (parsed ?? {}) as Record<string, unknown>;
      const name = typeof o.name === "string" && o.name ? o.name : "(không có tên)";
      const nodes = Array.isArray(o.nodes) ? o.nodes.length : "?";
      return text(
        `DRY RUN (không import): blueprint "${name}" sẽ có ${nodes} node.\n` +
          `Kiểm tra: JSON parse OK. Hãy xem lại cấu trúc và gọi lại với dryRun=false nếu muốn thực sự tạo.`
      );
    }
    return run("import_blueprint", { json });
  }
);

/* ── Khởi chạy ─────────────────────────────────────────────── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[warudo-mcp] Sẵn sàng — API ${config.apiWsUrl} · bridge ${config.wsUrl}`);
