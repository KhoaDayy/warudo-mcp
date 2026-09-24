# warudo-mcp — Điều khiển Warudo bằng Claude (qua MCP)

[**English**](README.md) | [**Tiếng Việt**](README.vi.md)

Cho phép **Claude điều khiển trực tiếp Warudo** bằng lời nói: đổi trang phục, làm hiệu ứng glow chuyển đồ, đổi material, bật/tắt mesh, trigger blueprint, tạo/sửa blueprint…

MCP server dùng **2 kênh** tới Warudo:

```
Claude ──(stdio MCP)──► MCP server (Node/TS)
                          │
                          ├─(1) Control-plane API tích hợp sẵn ──ws://localhost:19053 + token──► Warudo.Core.Server (60 actions)
                          │
                          └─(2) "MCP Bridge" (kênh cũ, fallback) ──ws://localhost:5678──► asset trong scene Warudo (Unity ops)
```

---

## 📁 Cấu trúc

```
warudo-mcp/
├── mcp-server/                 ← MCP server (Node/TypeScript) — phần "Claude nhìn thấy"
│   ├── src/index.ts            ← định nghĩa 26 tool
│   ├── src/warudoApi.ts        ← client control-plane Warudo 19053 (subprotocol token)
│   ├── src/token.ts            ← tự động tìm token API (log / companion client / env)
│   ├── src/warudoBridge.ts     ← WebSocket client kênh cũ + auto-reconnect
│   ├── src/config.ts           ← cấu hình qua env (WARUDO_WS_* / WARUDO_API_WS_*)
│   └── package.json
├── warudo-plugin/              ← phần chạy BÊN TRONG Warudo (C#)
│   ├── McpBridgeAsset.cs       ← asset mở WebSocket server (port mặc định 5678)
│   ├── McpBridgeService.cs     ← xử lý từng lệnh: đổi đồ, glow, material…
│   ├── Nodes/OnMcpCommandNode.cs ← node blueprint nhận lệnh trigger từ Claude
│   └── McpBridgePlugin.cs      ← kênh plugin sendPluginMessage (tạm hoãn — bị Warudo chặn, xem §Cách build plugin mod)
└── reference/                  ← source tham khảo plugin Stream Deck của Warudo
```

---

## 🚀 Cách cài

### Bước 1 — Cài "MCP Bridge" vào Warudo

**Cách nhanh nhất (Playground — không cần Unity):**

1. Copy **3 file** sau vào thư mục Playground của Warudo (đường dẫn thật trên máy Steam):
   `<Warudo>\Warudo_Data\StreamingAssets\Playground\`
   (thường là `C:\Program Files (x86)\Steam\steamapps\common\Warudo\Warudo_Data\StreamingAssets\Playground\`)
   - `McpBridgeAsset.cs`
   - `McpBridgeService.cs`
   - `Nodes/OnMcpCommandNode.cs` — có thể đặt thẳng trong Playground, không cần giữ thư mục `Nodes` (namespace đã khai báo trong file).
2. Khởi động Warudo → mở scene → thêm asset **"MCP Bridge"** (search "MCP").
3. Kiểm tra Console/Log thấy `[McpBridge] WebSocket server started at port 5678`.

**Cách build thành plugin mod (cần Unity + Warudo SDK + Warudo Mod Tool) — ⚠️ tạm hoãn:**

Công cụ build chính thức là repo **HakuyaLabs/Warudo-Mod-Tool** (`https://github.com/HakuyaLabs/Warudo-Mod-Tool.git` — UPM package `app.warudo.modtool`, kèm full SDK `Warudo.Core` + native plugins websocket-sharp/EmbedIO). Flow đúng theo docs *"Creating Your First Plugin Mod"*:

1. Tạo Unity project (Warudo khuyên Unity 2021.3 LTS; máy này có 2022.3.22f1 dùng được) → Package Manager → **Add package from git URL** → dán `https://github.com/HakuyaLabs/Warudo-Mod-Tool.git` → **tắt "Assembly Version Validation"**.
2. Menu **Warudo → New Mod** → đặt tên mod (vd `McpBridge`) → Create Mod → xuất hiện folder mod dưới `Assets/`.
3. Copy **toàn bộ** `warudo-plugin/*.cs` vào folder mod đó (**không được** để `.asmdef` trong mod folder — Warudo chặn).
4. **Warudo → Mod Settings** → set *Mod Export Directory* = `C:\Program Files (x86)\Steam\steamapps\common\Warudo\Warudo_Data\StreamingAssets\Plugins`.
5. **Warudo → Export Mod** → thấy `BUILD SUCCEEDED!` → xuất ra `<mod>.warudo` trong `StreamingAssets\Plugins`.

**Tại sao tạm hoãn** — Warudo đang chặn chính các thứ bridge này cần khi thành plugin mod:
- Plugin mod **không truy cập được WebSocketSharp** (docs: *"Playground can currently access more libraries… such as WebSocketSharp… we are working on improving this for plugin mods"*) → WS server 5678 (`McpBridgeAsset`) không chạy được trong mod.
- Plugin mod **cấm `System.Reflection`** → `list_assets` / `list_blueprints` / `inspect_entity` (đọc `[DataInput]` field qua reflection) hỏng.
- Plugin mod **cấm DLL thứ 3** + không được có `.asmdef` → không có cách nhét lib thay thế.
- Docs cảnh báo phải **xóa `.cs` khỏi Playground** khi export mod → mod và Playground là *thay thế nhau*, không thể song song.

→ Kết luận (đã chốt): **giữ bridge chạy ở Playground** (full access, hoạt động). Kênh `sendPluginMessage` tạm đóng; theo dõi changelog Warudo khi họ mở WebSocketSharp cho plugin mod thì làm lại.

### Bước 2 — Cài MCP server

```powershell
cd C:\Users\Hasukatsu\warudo-mcp\mcp-server
npm install
npm run build        # → tạo dist/
```

### Bước 3 — Đăng ký với Claude Code

```powershell
claude mcp add warudo -s user -- node C:\Users\Hasukatsu\warudo-mcp\mcp-server\dist\index.js
```

> **`-s user`** = đăng ký ở *user scope* — tools `warudo_*` xuất hiện ở **mọi** thư mục mở Claude Code. Nếu bỏ `-s user` thì nó chỉ có ở thư mục hiện tại lúc chạy lệnh (dễ tưởng "không thấy tool").

Hoặc chạy trực tiếp từ source khi đang phát triển:

```powershell
claude mcp add warudo -s user -- npx tsx C:\Users\Hasukatsu\warudo-mcp\mcp-server\src\index.ts
```

> Đổi port: set env `WARUDO_WS_PORT` (mặc định `5678`) — phải khớp với port trong asset "MCP Bridge" ở Warudo. Sau khi đăng ký xong, **khởi động lại Claude Code** để tool nạp vào.

---

## 🛠️ Các tool Claude có (26 tool — 2 kênh)

### Kênh (1) — Control-plane API tích hợp sẵn (`ws://localhost:19053`, có token)

| Tool | Công dụng |
|---|---|
| `warudo_status` | Báo trạng thái kết nối cả 2 kênh + token API + số plugin/entity trong frame + confirmation policy |
| `warudo_set_confirmation_policy` | Chọn cách phản hồi khi Warudo hỏi xác nhận: `decline` (tự từ chối, mặc định) / `accept` (tự đồng ý — dùng cho thao tác phá hoại bạn thực sự muốn chạy) |
| `warudo_api` | Gọi trực tiếp **bất kỳ action nào** trong 60 actions của control-plane (khi chưa có tool chuyên dụng) |
| `warudo_get_plugins` | Liệt kê plugin Warudo đang tải (id, name, version) |
| `warudo_get_selected_graph` | Blueprint đang được chọn trong editor (nodes/connections) — `null` nếu chưa chọn |
| `warudo_get_selected_asset` | Asset đang được chọn trong editor |
| `warudo_get_asset_types` | Các loại asset có thể tạo (theo category) — `full=true` để kèm metadata |
| `warudo_get_node_types` | Các loại node blueprint (theo category) — `full=true` để kèm id từng node |
| `warudo_get_entity_port_value` | Đọc giá trị hiện tại của 1 data input port (`{id, port}`) |
| `warudo_set_entity_port_value` | Gán giá trị cho data input port của entity (`value` dùng tiền tố kiểu) |
| `warudo_invoke_entity_trigger` | Kích hoạt 1 trigger port của entity |
| `warudo_import_graph` | Import blueprint từ JSON định dạng "Export Blueprint" (`dryRun=true` để kiểm tra an toàn) |
| `warudo_send_plugin_message` | Gửi message tới Plugin Warudo — kênh dành cho thao tác Unity-specific do plugin cung cấp. ⚠️ Tạm đóng: cần mod `McpBridgePlugin` chưa build được (xem §Bước 1) |
| `warudo_frame_state` | Snapshot trạng thái entity mới nhất (Warudo broadcast qua `frameUpdate`) |

### Kênh (2) — Legacy MCP Bridge (`ws://localhost:5678`, fallback)

| Tool | Công dụng |
|---|---|
| `warudo_scene_inventory` | **Tổng quan cả scene**: asset (nhóm theo category, qua action `list_assets`) + graph kèm số node (action `list_graphs`). Ưu tiên bridge; nếu bridge offline fallback control-plane (chỉ thấy selection) và báo rõ nguồn |
| `warudo_inspect_entity` | Liệt kê toàn bộ data input port của entity (asset/node/graph): tên, label, type C#, enum values, giá trị hiện tại — để biết cách set value đúng |
| `warudo_list_avatars` | Liệt kê avatar trong scene |
| `warudo_list_hierarchy` | Cây GameObject của avatar — tìm đường dẫn bộ đồ |
| `warudo_switch_outfit` | Đổi đồ: tắt bộ cũ, bật bộ mới |
| `warudo_glow_outfit` | Hiệu ứng chớp sáng (emission) trước khi đổi |
| `warudo_set_gameobject_active` | Bật/tắt 1 mesh bất kỳ |
| `warudo_set_material_property` | Đổi thuộc tính material (`_EmissionColor`, `_EmissionMultiply`…) |
| `warudo_trigger` | Kích hoạt node `On MCP Command` trong blueprint |
| `warudo_list_blueprints` | Xem toàn bộ blueprint + từng node (id, typeId, title, data inputs) |
| `warudo_set_node_data_input` | Đổi giá trị 1 data input của node (giá trị kiểu `float:`, `int:`, `bool:`, `string:`, `enum:`, `color:`, `vector3:`) |
| `warudo_create_blueprint` | Tạo blueprint mới từ JSON định dạng Warudo (`dryRun=true` để kiểm tra an toàn) |

### Ví dụ dùng thử

> **"Đổi sang bộ đồ đầm, có hiệu ứng glow hồng"**

```
1. warudo_list_hierarchy(avatar="Hiyori")
   → thấy đường dẫn "Clothes/Body", "Clothes/Dress", "Clothes/Casual"
2. warudo_glow_outfit(avatar="Hiyori", path="Clothes/Casual", color="#ff66cc", durationMs=400)
3. warudo_switch_outfit(avatar="Hiyori", on=["Clothes/Body","Clothes/Dress"], off=["*"])
```

> ⚠️ **Lưu ý `off=["*"]`**: tắt **mọi mesh con** (kể cả body). Luôn đưa phần thân vào `on`, ví dụ `on=["Clothes/Body", "Clothes/Dress"]`.

---

## 🔌 Giao thức

### Control-plane API (19053) — giao thức tích hợp sẵn của Warudo

```
→ { "action": "getSelectedGraph", "data": { "id": 1 } }
← { "action": "getSelectedGraph", "error": null, "data": { "graph": { ... } } }
```

- **Bắt tay**: `new WebSocket(url, [token])` — subprotocol chính là **API token** (đổi mỗi lần Warudo khởi động).
- Server **không echo `id`** trong phản hồi → client đối chiếu theo action.
- Payload request nằm trong `data.id`; response là `{ action, error, data }`.
- Warudo chủ động đẩy thông báo: `frameUpdate` (trạng thái entity), `confirmation` / `structuredDataInput` (cần xác nhận — MCP server tự **từ chối/hủy** để tránh treo request).

### Legacy bridge (5678) — plugin MCP Bridge

```
→ { "action": "switch_outfit", "data": { "id": 1, "avatar": "Hiyori", "on": [...], "off": ["*"] } }
← { "action": "switch_outfit", "isResponse": true, "data": { "id": 1, "ok": true, "data": { "enabled": [...] } } }
```

Lệnh hỗ trợ: `ping`, `list_avatars`, `list_hierarchy`, `set_active`, `set_material_property`, `switch_outfit`, `glow_outfit`, `trigger`, `list_blueprints`, `list_graphs`, `list_assets`, `inspect_entity`, `set_node_data_input`, `import_blueprint`.

> Một số action (list_graphs, list_assets, inspect_entity) cần **Warudo reload scene / khởi động lại** để Playground biên dịch bản C# mới.

`set_material_property` / `set_node_data_input` nhận `value` dạng: `{ type: "float"|"int"|"bool"|"keyword"|"color"|"string"|"enum"|"vector3", value: ... }` — màu là mảng `[r,g,b,a]` 0–1.

### Token API tự động

Token `{32 ký tự HEX}` được Warudo sinh lại mỗi lần khởi động. MCP server tự dò theo thứ tự:

1. Env `WARUDO_API_TOKEN` (người dùng đặt để ghi đè).
2. `%USERPROFILE%\AppData\LocalLow\HakuyaLabs\Warudo\Player.log` (dòng `One Time API Auth Token: ...`).
3. Dòng lệnh tiến trình `warudo-client-electron.exe --token="..."`.

## 🧩 Blueprint (b + c)

- **`list_blueprints`** → trả về mỗi blueprint (graph) với từng node: `id`, `typeId`, `title`, và các data input (tên + giá trị hiện tại). Dùng để Claude "nhìn" được blueprint đang có.
- **`set_node_data_input`** → đổi 1 data input của node. Tìm node theo `id` hoặc `title`. Giá trị dùng tiền tố kiểu, ví dụ `float:2.5`, `string:hello`, `enum:Joy`, `color:#ff66cc`, `vector3:1,2,3`.
- **`create_blueprint`** → import blueprint mới từ **JSON định dạng "Export Blueprint" của Warudo**. Cách lấy mẫu:
  1. Trong Warudo, tạo 1 blueprint nhỏ mà bạn muốn (chỉ cần chức năng tương tự).
  2. Chuột phải blueprint đó → **Export** → copy nội dung JSON.
  3. Đưa JSON vào `warudo_create_blueprint`, đổi tên/giá trị input theo ý muốn.
  4. Luôn chạy với `dryRun=true` trước để kiểm tra, rồi mới `dryRun=false` để thực sự tạo.

> Lưu ý: `create_blueprint` dùng chính cơ chế *Import Blueprint From JSON* của Warudo (`Context.Service.ImportGraph`), nên định dạng JSON phải đúng format export của Warudo. Nếu bạn gửi 1 file export thật, mình có thể phân tích cấu trúc và soạn blueprint mới giúp bạn.

---

## 🧯 Troubleshooting

- **"Chưa kết nối tới Warudo"** → chắc chắn asset **"MCP Bridge"** đã thêm vào scene và port khớp. Xem log Warudo có dòng `[McpBridge] WebSocket server started` không.
- **`ECONNREFUSED` dù Warudo đang chạy** → Warudo listen trên **IPv6** (`::1`), nên MCP server phải kết nối `localhost`, **không được** `127.0.0.1`. Đừng set `WARUDO_WS_HOST=127.0.0.1`. Kiểm tra: `Get-NetTCPConnection -LocalPort 5678 -State Listen` phải thấy `LocalAddress = ::1`.
- **`warudo_status` báo API disconnected nhưng Warudo đang mở** → token chưa dò được (Player.log chưa có dòng token, hoặc đã tắt "Launch Client On Start" nên không có tiến trình `warudo-client-electron`). Kiểm tra thủ công:
  `Select-String "One Time API Auth Token" "$env:USERPROFILE\AppData\LocalLow\HakuyaLabs\Warudo\Player.log"` — tìm thấy token thì đặt env `WARUDO_API_TOKEN` rồi khởi động lại MCP server.
- **API báo token sai/hết hạn** → token đổi theo lần khởi động Warudo. Khi Warudo khởi động lại, MCP server **tự dò lại và kết nối lại** sau ~3 giây, không cần can thiệp. Nếu vẫn lỗi, xem log MCP server có dòng `[WarudoApi] Bắt tay bị từ chối (HTTP 4xx)` không.
- **Compile C# lỗi** → API SDK có thể khác theo version. Các chỗ dễ đổi nhất:
  - `Asset` base class: `Warudo.Core.Assets.Asset` ↔ `Warudo.Core.Asset`
  - `CharacterAsset.GameObject` — nếu báo lỗi, thử `characterGameObject`
  - `Context.OpenedScene.GetAssets<CharacterAsset>()` trả kiểu khác → dùng `.OfType<CharacterAsset>()`
- **Glow không sáng** → shader material không dùng `_EmissionColor` (MToon thì có). Mở material trong Warudo xem tên property emission thật rồi dùng `warudo_set_material_property`.
- **`_EmissionMultiply`** → một số avatar dùng MToon có `_EmissionMultiply` đi kèm; tăng nó lên (vd `float:2`) để glow rõ hơn.
- **Đổi port trong asset không ăn** → port chỉ đọc lúc asset tạo; đổi xong hãy xóa + thêm lại asset "MCP Bridge".

---

## 📌 Ghi chú kiến trúc

- **Hai kênh song song**: control-plane (19053) đảm nhiệm liệt kê/CRUD asset–graph–node, đọc/ghi port, trigger, import blueprint; bridge cũ (5678) giữ làm fallback cho các thao tác đã có sẵn (đổi đồ, glow, material) — vẫn hoạt động kể cả khi token/API gặp sự cố.
- **`warudo_send_plugin_message`** là kênh "plugin" cho thao tác Unity-specific: action chạy qua `Plugin.OnMessageReceived` (đã implement trong `McpBridgePlugin.cs`). Kênh này **fire-and-forget** — không có kênh trả kết quả trực tiếp (chỉ có `BroadcastFrameUpdate`/`BroadcastEntityDataInputPortValue`), nên chỉ phù hợp cho **thao tác thay đổi** (đổi đồ, glow, material); đọc dữ liệu thì qua WS 5678.
- **Kênh `sendPluginMessage` đang tạm đóng** — cần build mod (Playground không đăng ký được `[PluginType]`), nhưng Warudo hiện chặn plugin mod dùng WebSocketSharp/reflection/DLL thứ 3 (chi tiết ở §Bước 1). `McpBridgePlugin.cs` giữ lại làm khung sẵn; khi Warudo mở giới hạn thì build theo flow Warudo-Mod-Tool ở trên.
- Mô hình này copy chính khuôn mẫu **plugin Stream Deck** của Warudo (`WebSocketService` + `WebSocketHelpers.CreateLocalHostUri` + `CorePlugin.BeforeListenToPort/AfterListenToPort`).
- Chạy **Playground** thì Warudo tự đăng ký asset/node vào "Core" plugin — không cần build; đó là lý do bridge hiện tại chỉ cần 3 file `.cs` là chạy được.
- MCP server là **stdio server** — Claude Code spawn nó, nó tự kết nối lại Warudo khi Warudo mở/đóng.
