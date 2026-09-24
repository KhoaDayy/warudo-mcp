using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Cysharp.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Warudo.Core;
using Warudo.Core.Attributes;
using Warudo.Core.Graphs;
using Warudo.Core.Server;
using Warudo.Plugins.Core.Assets.Character;
using Warudo.Plugins.McpBridge.Nodes;

namespace Warudo.Plugins.McpBridge {

    /// <summary>
    /// WebSocketService nhận lệnh JSON từ MCP server (Claude) và thao tác trực tiếp lên scene Warudo.
    /// Giao thức:
    ///   ←  { "action": "<lệnh>", "data": { "id": <số>, ...tham số } }
    ///   →  { "action": "<lệnh>", "isResponse": true, "data": { "id": <số>, "ok": true|false, "data"?|"error"? } }
    /// </summary>
    public class McpBridgeService : WebSocketService {

        public McpBridgeAsset Parent { get; set; }

        protected override async UniTask<bool> HandleAction(string action, JObject data) {
            await UniTask.SwitchToMainThread();
            int id = 0;
            try {
                if (data != null) {
                    if (data.TryGetValue("_reqId", out var reqTok) && reqTok.Type == JTokenType.Integer) {
                        id = reqTok.Value<int>();
                    } else if (data.TryGetValue("id", out var idTok) && idTok.Type == JTokenType.Integer) {
                        id = idTok.Value<int>();
                    }
                }

                // "trigger" cần instance McpBridgeAsset (đăng ký OnMcpCommandNode) → giữ ở đây.
                if (action == "trigger") {
                    Parent?.TriggerCommand(data?["command"]?.Value<string>());
                    RespondOk(action, id, new { message = "triggered" });
                    return true;
                }
                var r = ExecuteAction(action, data);
                if (r.ok) RespondOk(action, id, r.data);
                else RespondError(action, id, r.error);
                return true; // luôn trả về đã xử lý — tránh timeout im lặng cho action lạ
            } catch (Exception e) {
                Debug.LogError($"[McpBridgeService] Lỗi xử lý action '{action}': {e}");
                RespondError(action, id, e.Message);
                return true;
            }
        }

        /// <summary>
        /// Thực thi một action và trả về kết quả. Dùng chung cho 2 kênh:
        ///  - Kênh WS (5678): HandleAction bọc envelope id/ok/error.
        ///  - Plugin mod (sendPluginMessage): McpBridgePlugin.OnMessageReceived.
        /// </summary>
        public static (bool ok, object data, string error) ExecuteAction(string action, JObject data) {
            switch (action) {
                case "ping":
                    return (true, "pong", null);
                case "list_avatars":
                    return (true, ListAvatars(), null);
                case "list_hierarchy":
                    return (true, ListHierarchy(data), null);
                case "set_active":
                    return (true, SetActive(data), null);
                case "set_material_property":
                    return (true, SetMaterialProperty(data), null);
                case "switch_outfit":
                    return (true, SwitchOutfit(data), null);
                case "glow_outfit":
                    GlowOutfit(data); // chạy nền, trả về ngay
                    return (true, new { message = "glow started" }, null);
                case "list_blueprints":
                    return (true, ListBlueprints(), null);
                case "list_graphs":
                    return (true, ListGraphs(), null);
                case "list_assets":
                    return (true, ListAssets(), null);
                case "inspect_entity":
                    return (true, InspectEntity(data), null);
                case "set_node_data_input":
                    return (true, SetNodeDataInput(data), null);
                case "import_blueprint":
                    return (true, ImportBlueprint(data), null);
                case "get_scenes":
                    return (true, Warudo.Core.Context.SceneManager.GetScenes(), null);
                case "open_scene":
                    var sceneName = data?["name"]?.Value<string>();
                    if (string.IsNullOrEmpty(sceneName)) throw new Exception("Thiếu 'name'.");
                    Warudo.Core.Context.SceneManager.OpenScene(sceneName);
                    return (true, new { opened = sceneName }, null);
                default:
                    return (false, null, "Unknown action: " + action);
            }
        }

        /* ── Phản hồi ── */

        private void RespondOk(string action, int id, object data) => Respond(action, new { _reqId = id, id, ok = true, data });

        private void RespondError(string action, int id, string error) => Respond(action, new { _reqId = id, id, ok = false, error });

        /* ── Lệnh ── */

        private static List<object> ListAvatars() {
            var scene = Warudo.Core.Context.OpenedScene;
            if (scene == null) return new List<object>();
            return scene.GetAssets<CharacterAsset>()
                .Select(a => new {
                    id = a.IdString,
                    name = a.GameObject != null ? a.GameObject.name : a.IdString,
                    active = a.Active
                })
                .Cast<object>()
                .ToList();
        }

        private static List<object> ListHierarchy(JObject data) {
            var avatar = FindAvatar(data?["avatar"]?.Value<string>());
            var result = new List<object>();
            if (avatar?.GameObject == null) return result;

            bool onlyMeshes = data?["onlyMeshes"]?.Value<bool>() ?? false;
            int maxDepth = data?["maxDepth"]?.Value<int>() ?? 50;

            var renderers = avatar.GameObject.GetComponentsInChildren<Renderer>(true);
            var meshNodes = new HashSet<Transform>();
            var nodesWithMeshDescendant = new HashSet<Transform>();

            foreach (var r in renderers) {
                if (r == null) continue;
                meshNodes.Add(r.transform);
                for (var cur = r.transform; cur != null && cur != avatar.GameObject.transform; cur = cur.parent) {
                    nodesWithMeshDescendant.Add(cur);
                }
            }

            CollectPathsOptimized(avatar.GameObject.transform, "", result, meshNodes, nodesWithMeshDescendant, onlyMeshes, maxDepth, 1);
            return result;
        }

        private static void CollectPathsOptimized(
            Transform parent,
            string prefix,
            List<object> list,
            HashSet<Transform> meshNodes,
            HashSet<Transform> nodesWithMeshDescendant,
            bool onlyMeshes,
            int maxDepth,
            int currentDepth) {
            if (currentDepth > maxDepth) return;

            foreach (Transform child in parent) {
                var path = prefix.Length == 0 ? child.name : prefix + "/" + child.name;
                bool hasDirectMesh = meshNodes.Contains(child);
                bool hasMeshInSubtree = nodesWithMeshDescendant.Contains(child);

                if (!onlyMeshes || hasDirectMesh || hasMeshInSubtree) {
                    list.Add(new {
                        path,
                        hasMesh = hasMeshInSubtree,
                        isMesh = hasDirectMesh,
                        active = child.gameObject.activeSelf
                    });
                }

                CollectPathsOptimized(child, path, list, meshNodes, nodesWithMeshDescendant, onlyMeshes, maxDepth, currentDepth + 1);
            }
        }

        private static object SetActive(JObject data) {
            var avatar = FindAvatar(data?["avatar"]?.Value<string>());
            if (avatar == null) throw new Exception("Không tìm thấy avatar.");
            var go = FindGameObject(avatar, data?["path"]?.Value<string>());
            if (go == null) throw new Exception("Không tìm thấy GameObject với path đã cho.");
            var active = data?["active"]?.Value<bool>() ?? false;
            go.SetActive(active);
            return new { path = data?["path"]?.Value<string>(), active = go.activeSelf };
        }

        private static object SetMaterialProperty(JObject data) {
            var avatar = FindAvatar(data?["avatar"]?.Value<string>());
            if (avatar == null) throw new Exception("Không tìm thấy avatar.");
            var go = FindGameObject(avatar, data?["path"]?.Value<string>());
            if (go == null) throw new Exception("Không tìm thấy GameObject với path đã cho.");

            var property = data?["property"]?.Value<string>();
            if (string.IsNullOrEmpty(property)) throw new Exception("Thiếu 'property'.");
            var matIndex = data?["materialIndex"]?.Value<int>() ?? 0;

            var renderers = go.GetComponentsInChildren<Renderer>(true);
            if (renderers.Length == 0) throw new Exception("GameObject không chứa Renderer nào.");
            var renderer = renderers[0];
            var mats = renderer.materials;
            if (mats == null || mats.Length == 0) throw new Exception("Renderer không chứa Material nào.");
            var targetIndex = (matIndex >= 0 && matIndex < mats.Length) ? matIndex : 0;
            var mat = mats[targetIndex];

            var value = data?["value"] as JObject;
            var type = value?["type"]?.Value<string>();
            switch (type) {
                case "float":
                    mat.SetFloat(property, value["value"].Value<float>());
                    break;
                case "int":
                    mat.SetInt(property, value["value"].Value<int>());
                    break;
                case "bool":
                    mat.SetFloat(property, value["value"].Value<bool>() ? 1f : 0f);
                    break;
                case "keyword":
                    if (value["value"].Value<bool>()) mat.EnableKeyword(property);
                    else mat.DisableKeyword(property);
                    break;
                case "color":
                    mat.SetColor(property, ParseColor(value["value"]));
                    break;
                default:
                    throw new Exception("Kiểu giá trị không hợp lệ: " + type);
            }
            renderer.materials = mats;
            return new { path = data?["path"]?.Value<string>(), property, type, materialIndex = targetIndex };
        }

        private static object SwitchOutfit(JObject data) {
            var avatar = FindAvatar(data?["avatar"]?.Value<string>());
            if (avatar == null) throw new Exception("Không tìm thấy avatar.");

            var onList = data?["on"] as JArray ?? new JArray();
            var offList = data?["off"] as JArray ?? new JArray();
            var on = onList.Select(x => x.Value<string>()).Where(x => !string.IsNullOrEmpty(x)).ToList();
            var off = offList.Select(x => x.Value<string>()).Where(x => !string.IsNullOrEmpty(x)).ToList();

            // Tắt trước
            if (off.Contains("*")) {
                // Tắt mọi mesh con (GameObject chứa Renderer), giữ nguyên xương/IK/proxy.
                foreach (Transform child in avatar.GameObject.GetComponentsInChildren<Transform>(true)) {
                    if (child == avatar.GameObject.transform) continue;
                    if (child.GetComponent<Renderer>() != null) child.gameObject.SetActive(false);
                }
            } else {
                foreach (var p in off) FindGameObject(avatar, p)?.SetActive(false);
            }

            // Bật sau
            var enabled = new List<string>();
            foreach (var p in on) {
                var go = FindGameObject(avatar, p);
                if (go != null) {
                    go.SetActive(true);
                    enabled.Add(p);
                }
            }
            return new { enabled, off };
        }

        private static void GlowOutfit(JObject data) {
            var avatar = FindAvatar(data?["avatar"]?.Value<string>());
            if (avatar == null) throw new Exception("Không tìm thấy avatar.");
            var path = data?["path"]?.Value<string>();
            if (string.IsNullOrEmpty(path)) throw new Exception("Thiếu 'path'.");

            var color = data?["color"] is JArray c ? ParseColor(c) : new Color(1f, 0.4f, 0.8f, 1f);
            var durationMs = data?["durationMs"]?.Value<int>() ?? 900;
            var intensity = data?["intensity"]?.Value<float>() ?? 2f;
            var peakPercent = data?["peakPercent"]?.Value<float>() ?? 0.4f;
            // Dùng chung hiệu ứng glow transformation với node GLOW OUTFIT.
            // onPeak = null (test MCP chỉ xem hiệu ứng, không cần match cut).
            GlowOutfitNode.Glow(avatar, new[] { path }, color, intensity, durationMs,
                peakPercent, null).Forget();
        }

        /* ── Lệnh Blueprint ── */

        private static List<object> ListBlueprints() {
            var result = new List<object>();
            var scene = Warudo.Core.Context.OpenedScene;
            if (scene == null) return result;
            foreach (var graph in scene.GetGraphs().Values) {
                var nodes = new List<object>();
                foreach (var kv in graph.GetNodes()) {
                    var node = kv.Value;
                    var nodeType = node.GetType();
                    var attr = nodeType.GetCustomAttribute<NodeTypeAttribute>();

                    var inputs = new List<object>();
                    foreach (var field in nodeType.GetFields(BindingFlags.Public | BindingFlags.Instance)) {
                        if (field.GetCustomAttribute<DataInputAttribute>() == null) continue;
                        inputs.Add(new { name = field.Name, value = SafeValue(field.GetValue(node)) });
                    }

                    nodes.Add(new {
                        id = node.Id,
                        typeId = attr?.Id ?? "",
                        title = attr?.Title ?? nodeType.Name,
                        inputs
                    });
                }
                result.Add(new { name = graph.Name, enabled = graph.Enabled, nodeCount = nodes.Count, nodes });
            }
            return result;
        }

        /* ── Scene inventory (P0) ── */

        /// <summary>
        /// Toàn bộ asset trong scene, nhóm theo category — đây là nguồn duy nhất
        /// để MCP "nhìn thấy" cả scene (control-plane 19053 không có action liệt kê).
        /// </summary>
        private static List<object> ListAssets() {
            var groups = new SortedDictionary<string, List<object>>(StringComparer.OrdinalIgnoreCase);
            var scene = Warudo.Core.Context.OpenedScene;
            if (scene == null) return new List<object>();
            foreach (var kv in scene.GetAssets()) {
                var asset = kv.Value;
                var attr = asset.GetType().GetCustomAttribute<AssetTypeAttribute>();
                var category = attr?.Category ?? "Other";
                if (!groups.TryGetValue(category, out var list)) groups[category] = list = new List<object>();
                list.Add(new {
                    id = asset.IdString,
                    name = asset.Name,
                    active = asset.Active,
                    typeId = attr?.Id ?? asset.GetType().Name,
                    title = attr?.Title ?? asset.GetType().Name
                });
            }
            var result = new List<object>();
            foreach (var g in groups) result.Add(new { category = g.Key, count = g.Value.Count, assets = g.Value });
            return result;
        }

        /// <summary>Danh sách graph (blueprint) dạng gọn — không kèm node detail.</summary>
        private static List<object> ListGraphs() {
            var scene = Warudo.Core.Context.OpenedScene;
            if (scene == null) return new List<object>();
            return scene.GetGraphs().Values
                .OrderBy(g => g.Order)
                .Select(g => (object)new {
                    id = g.Id.ToString(),
                    name = g.Name,
                    enabled = g.Enabled,
                    nodeCount = g.GetNodes().Count
                })
                .ToList();
        }

        /// <summary>
        /// Liệt kê toàn bộ data input port của một entity (asset/node/graph) kèm type C#,
        /// label, enum values và giá trị hiện tại — để biết cách set value chính xác.
        /// </summary>
        private static object InspectEntity(JObject data) {
            var id = data?["entityId"]?.Value<string>() ?? data?["id"]?.Value<string>();
            if (string.IsNullOrWhiteSpace(id)) throw new Exception("Thiếu 'id'.");
            var entity = FindEntity(id);
            if (entity == null) throw new Exception("Không tìm thấy entity: " + id);

            var ports = new List<object>();
            foreach (var field in entity.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance)) {
                try {
                    var attr = field.GetCustomAttribute<DataInputAttribute>();
                    if (attr == null) continue;
                    var fieldType = field.FieldType;
                    var entry = new Dictionary<string, object> {
                        ["name"] = field.Name,
                        ["label"] = field.GetCustomAttribute<LabelAttribute>()?.Label ?? field.Name,
                        ["type"] = TypeLabel(fieldType)
                    };
                    if (fieldType.IsEnum) entry["enumValues"] = Enum.GetNames(fieldType);
                    try {
                        entry["value"] = SafeValue(field.GetValue(entity));
                    } catch {
                        entry["value"] = null;
                    }
                    ports.Add(entry);
                } catch {}
            }

            string title = null, typeId = null;
            var aAttr = entity.GetType().GetCustomAttribute<AssetTypeAttribute>();
            var nAttr = entity.GetType().GetCustomAttribute<NodeTypeAttribute>();
            if (aAttr != null) { title = aAttr.Title; typeId = aAttr.Id; }
            else if (nAttr != null) { title = nAttr.Title; typeId = nAttr.Id; }

            return new {
                id,
                kind = entity is Warudo.Core.Scenes.Asset ? "asset" : "node",
                title = title ?? entity.GetType().Name,
                typeId = typeId ?? entity.GetType().Name,
                dataInputCount = ports.Count,
                ports
            };
        }

        /// <summary>Tìm entity theo id: asset → node trong graph → graph (theo id hoặc tên).</summary>
        private static object FindEntity(string id) {
            var scene = Warudo.Core.Context.OpenedScene;
            foreach (var kv in scene.GetAssets()) {
                if (string.Equals(kv.Value.IdString, id, StringComparison.OrdinalIgnoreCase)) return kv.Value;
            }
            foreach (var graph in scene.GetGraphs().Values) {
                if (string.Equals(graph.Id.ToString(), id, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(graph.Name, id, StringComparison.OrdinalIgnoreCase)) return graph;
                foreach (var nkv in graph.GetNodes()) {
                    if (string.Equals(nkv.Value.IdString, id, StringComparison.OrdinalIgnoreCase)) return nkv.Value;
                }
            }
            return null;
        }

        private static string TypeLabel(Type t) {
            if (t == null) return "?";
            if (t.IsGenericType) {
                var def = t.GetGenericTypeDefinition().Name;
                def = def.Split('`')[0];
                return def + "<" + string.Join(",", t.GetGenericArguments().Select(TypeLabel)) + ">";
            }
            return t.Name;
        }

        private static object SetNodeDataInput(JObject data) {
            var graphName = data?["blueprint"]?.Value<string>();
            var nodeKey = data?["node"]?.Value<string>();
            var input = data?["input"]?.Value<string>();
            if (string.IsNullOrEmpty(input)) throw new Exception("Thiếu 'input'.");

            var graph = FindGraph(graphName);
            if (graph == null) throw new Exception("Không tìm thấy blueprint: " + graphName);

            var node = FindNode(graph, nodeKey);
            if (node == null) throw new Exception("Không tìm thấy node: " + nodeKey);

            var value = ParseInputValue(data?["value"] as JObject);
            node.SetDataInput(input, value);
            node.BroadcastDataInput(input);
            return new { blueprint = graphName, node = nodeKey, input, value };
        }

        private static object ImportBlueprint(JObject data) {
            var json = data?["json"]?.Value<string>();
            if (string.IsNullOrWhiteSpace(json)) throw new Exception("Thiếu 'json'.");
            Warudo.Core.Context.Service.ImportGraph(json);
            Warudo.Core.Context.Service.BroadcastOpenedScene();
            return new { message = "blueprint imported" };
        }

        private static Graph FindGraph(string name) {
            if (string.IsNullOrWhiteSpace(name)) return null;
            return Warudo.Core.Context.OpenedScene.GetGraphs().Values
                .FirstOrDefault(g => string.Equals(g.Name, name, StringComparison.OrdinalIgnoreCase));
        }

        private static Node FindNode(Graph graph, string key) {
            if (string.IsNullOrWhiteSpace(key)) return null;
            foreach (var kv in graph.GetNodes()) {
                var attr = kv.Value.GetType().GetCustomAttribute<NodeTypeAttribute>();
                if (string.Equals(kv.Value.IdString, key, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(kv.Value.GetType().Name, key, StringComparison.OrdinalIgnoreCase) ||
                    (attr != null && string.Equals(attr.Title, key, StringComparison.OrdinalIgnoreCase))) {
                    return kv.Value;
                }
            }
            return null;
        }

        private static object ParseInputValue(JObject valueObj) {
            if (valueObj == null) throw new Exception("Thiếu 'value'.");
            var type = valueObj["type"]?.Value<string>();
            var v = valueObj["value"];
            switch (type) {
                case "float":
                    return v.Value<float>();
                case "int":
                    return v.Value<int>();
                case "bool":
                    return v.Value<bool>();
                case "string":
                    // GameObjectPaths (string[]) — tool gửi "string:[...]".
                    // Giá trị có thể là JArray (["a","b"]) hoặc string JSON ("[\"a\",\"b\"]").
                    // Convert cả hai về string[] để SetDataInput gán đúng field mảng.
                    if (v is JArray jarr) return jarr.Select(x => x.Value<string>()).ToArray();
                    if (v is JValue jv && jv.Type == JTokenType.String) {
                        var s = jv.Value<string>();
                        if (s != null && s.TrimStart().StartsWith("[")) {
                            try {
                                var parsed = JArray.Parse(s);
                                return parsed.Select(x => x.Value<string>()).ToArray();
                            } catch { /* không phải JSON array → fallthrough */ }
                        }
                        return s;
                    }
                    return v.Value<string>();
                case "enum":
                    return v.Value<string>(); // Warudo tự convert string→enum
                case "vector3": {
                        var a = (JArray)v;
                        return new Vector3(a[0].Value<float>(), a[1].Value<float>(), a[2].Value<float>());
                    }
                case "color":
                    return ParseColor(v);
                default:
                    throw new Exception("Kiểu giá trị không hợp lệ: " + type);
            }
        }

        /* ── Tiện ích ── */

        private static CharacterAsset FindAvatar(string key) {
            if (string.IsNullOrWhiteSpace(key)) return null;
            return Warudo.Core.Context.OpenedScene.GetAssets<CharacterAsset>()
                .FirstOrDefault(a =>
                    string.Equals(a.IdString, key, StringComparison.OrdinalIgnoreCase) ||
                    (a.GameObject != null && string.Equals(a.GameObject.name, key, StringComparison.OrdinalIgnoreCase)));
        }

        private static GameObject FindGameObject(CharacterAsset avatar, string path) {
            if (avatar?.GameObject == null) return null;
            if (string.IsNullOrEmpty(path) || path == "/") return avatar.GameObject;
            // Fallback suffix-search: avatar bọc trong "Character Parent/Root/...",
            // nên path "Assets/Outfits/..." cũng resolve được như path đầy đủ.
            return GlowOutfitNode.FindGameObjectByPath(avatar.GameObject, path);
        }

        private static Color ParseColor(JToken token) {
            var arr = (JArray)token;
            return new Color(
                arr[0].Value<float>(),
                arr[1].Value<float>(),
                arr[2].Value<float>(),
                arr.Count > 3 ? arr[3].Value<float>() : 1f);
        }

        private static object SafeValue(object v) {
            if (v == null) return null;
            if (v is UnityEngine.Object uo && uo == null) return null;

            // Chỉ trả về các kiểu "nhẹ" — tránh Newtonsoft serialize lọt vào
            // object graph (vd MappingData có StructuredDataParent → self-reference loop).
            var t = v.GetType();
            if (t.IsPrimitive || t.IsEnum || v is string || v is decimal) return v;
            if (v is Vector2 v2) return new[] { v2.x, v2.y };
            if (v is Vector3 v3) return new[] { v3.x, v3.y, v3.z };
            if (v is Vector4 v4) return new[] { v4.x, v4.y, v4.z, v4.w };
            if (v is Color c) return new[] { c.r, c.g, c.b, c.a };
            if (v is Quaternion q) return new[] { q.x, q.y, q.z, q.w };

            if (v is System.Collections.IEnumerable enumerable && !(v is string)) {
                var list = new List<object>();
                int count = 0;
                foreach (var item in enumerable) {
                    if (count++ >= 20) {
                        list.Add("...(truncated)");
                        break;
                    }
                    if (item == null) {
                        list.Add(null);
                    } else {
                        var it = item.GetType();
                        if (it.IsPrimitive || it.IsEnum || item is string || item is decimal) {
                            list.Add(item);
                        } else {
                            try { list.Add(item.ToString()); } catch { list.Add("(item)"); }
                        }
                    }
                }
                return list;
            }

            // Kiểu phức tạp (mapping, list, structured data…) — chỉ lấy mô tả ngắn.
            try { return v.ToString(); } catch { return "(complex value)"; }
        }
    }
}
