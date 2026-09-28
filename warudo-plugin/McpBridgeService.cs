using System;
using System.Collections.Generic;
using System.Linq;
using Cysharp.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Warudo.Core;
using Warudo.Core.Graphs;
using Warudo.Core.Data;
using Warudo.Core.Server;
using Warudo.Core.Scenes;
using Warudo.Plugins.Core.Assets.Character;

namespace Warudo.Plugins.McpBridge {

    /// <summary>
    /// WebSocketService nhận lệnh JSON từ MCP clients và thao tác trực tiếp lên scene Warudo.
    /// Giao thức:
    ///   ←  { "action": "<lệnh>", "data": { "_reqId": <số>, ...tham số } }
    ///   →  { "action": "<lệnh>", "isResponse": true, "data": { "_reqId": <số>, "ok": true|false, "data"?|"error"? } }
    /// </summary>
    public class McpBridgeService : WebSocketService {

        public McpBridgePlugin Parent { get; set; }

        private const int MaxRequestBytes = 1024 * 1024;
        private const int MaxResponseBytes = 4 * 1024 * 1024;
        private const int MaxHierarchyEntries = 10000;
        private const int MaxHierarchyVisited = 200000;
        private const int MaxBlueprintGraphs = 256;
        private const int MaxBlueprintNodes = 10000;
        private const int MaxAssets = 10000;
        private const int MaxEntityPorts = 4096;

        private sealed class OutputLimitException : InvalidOperationException {
            public OutputLimitException(string message) : base(message) { }
        }

        protected override async UniTask<bool> HandleAction(string action, JObject data) {
            int id = 0;
            data ??= new JObject();
            try {
                if (data.TryGetValue("_reqId", out var reqTok) && reqTok.Type == JTokenType.Integer) {
                    id = reqTok.Value<int>();
                }
                if (id <= 0) throw new ArgumentException("Missing positive integer _reqId.");
                if (System.Text.Encoding.UTF8.GetByteCount(data.ToString(Formatting.None)) > MaxRequestBytes) throw new ArgumentException("Request payload exceeds 1 MiB.");

                if (Parent == null || !Parent.IsRunning) throw new InvalidOperationException("Bridge is stopping or unavailable.");
                // Handshake and health checks do not touch scene state. Answer them on
                // the WebSocket thread so a busy scene load cannot cause reconnect timeouts.
                if (action != "ping" && action != "bridge_info") await UniTask.SwitchToMainThread();
                var r = ExecuteAction(action, data, Parent);
                if (r.ok) RespondOk(action, id, r.data);
                else RespondError(action, id, r.error);
                return true; // luôn trả về đã xử lý — tránh timeout im lặng cho action lạ
            } catch (Exception e) {
                Debug.LogError($"[McpBridgeService] Lỗi xử lý action '{action}': {e}");
                try {
                    RespondError(action, id, e.Message);
                } catch (Exception responseError) {
                    Debug.LogWarning($"[McpBridgeService] Could not prepare error response for '{action}' ({id}): {responseError.Message}");
                }
                return true;
            }
        }

        /// <summary>
        /// Executes the generic bridge actions not available through native discovery.
        /// The WebSocket handler wraps each result with its request correlation ID.
        /// </summary>
        public static (bool ok, object data, string error) ExecuteAction(string action, JObject data, McpBridgePlugin owner = null) {
            if (action == "ping") return (true, "pong", null);
            if (action == "bridge_info") {
                return (true, new {
                    protocolVersion = 2,
                    bridgeVersion = "0.3.0",
                    capabilities = new[] {
                        "list_hierarchy", "set_active", "set_material_property",
                        "list_blueprints", "list_graphs", "list_assets", "inspect_entity", "set_node_data_input"
                    }
                }, null);
            }
            RequireOpenScene();
            switch (action) {
                case "list_hierarchy":
                    return (true, ListHierarchy(data), null);
                case "set_active":
                    return (true, SetActive(data), null);
                case "set_material_property":
                    return (true, SetMaterialProperty(data, owner), null);
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
                default:
                    return (false, null, "Unknown action: " + action);
            }
        }

        /* ── Phản hồi ── */

        private void RespondOk(string action, int id, object data) {
            var response = SerializeResponse(action, new { _reqId = id, ok = true, data });
            SendResponse(action, id, response);
        }

        private void RespondError(string action, int id, string error) {
            var response = SerializeResponse(action, new { _reqId = id, ok = false, error });
            SendResponse(action, id, response);
        }

        private void SendResponse(string action, int id, string response) {
            try {
                Send(response);
            } catch (Exception e) {
                // A client can time out while Warudo's main thread is loading a scene.
                // Treat the late response as a transport disconnect, not as an action failure.
                Debug.LogWarning($"[McpBridgeService] Client disconnected before response '{action}' ({id}) could be sent: {e.Message}");
            }
        }

        /* ── Lệnh ── */

        private static List<object> ListHierarchy(JObject data) {
            var avatar = FindAvatar(RequireString(data, "avatar"));
            var result = new List<object>();
            if (avatar?.GameObject == null) throw new ArgumentException("Avatar has no GameObject.");

            bool onlyMeshes = data?["onlyMeshes"]?.Value<bool>() ?? false;
            int maxDepth = data?["maxDepth"]?.Value<int>() ?? 50;
            if (maxDepth < 1 || maxDepth > 100) throw new ArgumentException("maxDepth must be between 1 and 100.");

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

            var visited = new[] { 0 };
            CollectPathsOptimized(avatar.GameObject.transform, "", result, meshNodes, nodesWithMeshDescendant, onlyMeshes, maxDepth, 1, visited);
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
            int currentDepth,
            int[] visited) {
            if (currentDepth > maxDepth) return;

            foreach (Transform child in parent) {
                if (++visited[0] > MaxHierarchyVisited) {
                    throw new OutputLimitException($"Hierarchy traversal exceeds the {MaxHierarchyVisited} transform limit; narrow the path or reduce maxDepth.");
                }
                var path = prefix.Length == 0 ? child.name : prefix + "/" + child.name;
                bool hasDirectMesh = meshNodes.Contains(child);
                bool hasMeshInSubtree = nodesWithMeshDescendant.Contains(child);

                if (!onlyMeshes || hasDirectMesh || hasMeshInSubtree) {
                    if (list.Count >= MaxHierarchyEntries) {
                        throw new OutputLimitException($"Hierarchy exceeds the {MaxHierarchyEntries} entry limit; narrow the path or reduce maxDepth.");
                    }
                    list.Add(new {
                        path,
                        hasMesh = hasMeshInSubtree,
                        isMesh = hasDirectMesh,
                        active = child.gameObject.activeSelf
                    });
                }

                CollectPathsOptimized(child, path, list, meshNodes, nodesWithMeshDescendant, onlyMeshes, maxDepth, currentDepth + 1, visited);
            }
        }

        private static object SetActive(JObject data) {
            var avatar = FindAvatar(RequireString(data, "avatar"));
            if (avatar == null) throw new Exception("Không tìm thấy avatar.");
            var go = FindGameObject(avatar, RequirePath(data));
            if (go == null) throw new Exception("Không tìm thấy GameObject với path đã cho.");
            var activeToken = data?["active"];
            if (activeToken == null || activeToken.Type != JTokenType.Boolean) throw new ArgumentException("active must be a boolean.");
            var active = activeToken.Value<bool>();
            go.SetActive(active);
            return new { path = data?["path"]?.Value<string>(), active = go.activeSelf };
        }

        private static object SetMaterialProperty(JObject data, McpBridgePlugin owner) {
            var avatar = FindAvatar(RequireString(data, "avatar"));
            if (avatar == null) throw new Exception("Không tìm thấy avatar.");
            var go = FindGameObject(avatar, RequirePath(data));
            if (go == null) throw new Exception("Không tìm thấy GameObject với path đã cho.");

            var property = RequireString(data, "property");
            var matIndex = data?["materialIndex"]?.Value<int>() ?? 0;

            var renderers = go.GetComponents<Renderer>();
            if (renderers.Length == 0) throw new ArgumentException("The target GameObject has no Renderer; use the exact mesh path.");
            if (renderers.Length != 1) throw new ArgumentException("The target GameObject has multiple Renderers and is ambiguous.");
            var renderer = renderers[0];
            // Reading sharedMaterials does not instantiate material copies.
            var shared = renderer.sharedMaterials;
            if (shared == null || matIndex < 0 || matIndex >= shared.Length) throw new ArgumentOutOfRangeException("materialIndex", "Material index is outside the renderer's material array.");
            if (shared[matIndex] == null) throw new ArgumentException("The selected material slot is empty.");

            var value = data?["value"] as JObject;
            var type = value?["type"]?.Value<string>();
            if (value?["value"] == null) throw new ArgumentException("Missing material value.");
            if (type != "float" && type != "int" && type != "bool" && type != "keyword" && type != "color") throw new ArgumentException("Invalid material value type: " + type);
            if (type != "keyword" && !shared[matIndex].HasProperty(property)) throw new ArgumentException("Material does not have shader property: " + property);
            var parsedValue = type == "keyword" ? ParseBoolean(value["value"]) : ParseInputValue(value);
            if (type == "keyword") {
                // Shader keywords need a material instance. The bridge plugin
                // owns that single-slot clone and restores/destroys it on teardown.
                if (owner == null) throw new InvalidOperationException("Keyword writes require a live bridge plugin owner.");
                var ownedMaterial = owner.GetKeywordMaterial(renderer, matIndex);
                if ((bool)parsedValue) ownedMaterial.EnableKeyword(property);
                else ownedMaterial.DisableKeyword(property);
                return new { path = data?["path"]?.Value<string>(), property, type, materialIndex = matIndex, storage = "ownedMaterial" };
            }

            // MaterialPropertyBlock avoids renderer.materials, which creates
            // owned material clones and makes repeated MCP writes leak/duplicate
            // material instances. Values are scoped to this renderer/material slot.
            var block = new MaterialPropertyBlock();
            renderer.GetPropertyBlock(block, matIndex);
            switch (type) {
                case "float":
                    block.SetFloat(property, (float)parsedValue);
                    break;
                case "int":
                    block.SetInt(property, (int)parsedValue);
                    break;
                case "bool":
                    block.SetFloat(property, (bool)parsedValue ? 1f : 0f);
                    break;
                case "color":
                    block.SetColor(property, (Color)parsedValue);
                    break;
                default:
                    throw new Exception("Kiểu giá trị không hợp lệ: " + type);
            }
            renderer.SetPropertyBlock(block, matIndex);
            return new { path = data?["path"]?.Value<string>(), property, type, materialIndex = matIndex, storage = "propertyBlock" };
        }

        /* ── Lệnh Blueprint ── */

        private static List<object> ListBlueprints() {
            var result = new List<object>();
            var scene = Warudo.Core.Context.OpenedScene;
            RequireOpenScene();
            var graphCount = 0;
            var totalNodeCount = 0;
            foreach (var graph in scene.GetGraphs().Values) {
                if (++graphCount > MaxBlueprintGraphs) throw new OutputLimitException($"Blueprint inventory exceeds the {MaxBlueprintGraphs} graph limit.");
                var nodes = new List<object>();
                foreach (var kv in graph.GetNodes()) {
                    if (++totalNodeCount > MaxBlueprintNodes) throw new OutputLimitException($"Blueprint inventory exceeds the {MaxBlueprintNodes} node limit; inspect one graph at a time.");
                    var node = kv.Value;
                    var nodeType = node.Type?.NodeType;

                    var inputs = new List<object>();
                    foreach (var pair in node.DataInputPortCollection.GetPorts()) {
                        try {
                            inputs.Add(new { name = pair.Key, value = SafeValue(node.GetDataInput(pair.Key)) });
                    } catch (Exception e) {
                            inputs.Add(new { name = pair.Key, value = (object)null, valueError = e.Message });
                        }
                    }

                    nodes.Add(new {
                        id = node.Id,
                        typeId = nodeType?.id ?? node.GetType().Name,
                        title = nodeType?.title ?? node.Name ?? node.GetType().Name,
                        inputs
                    });
                }
                result.Add(new { id = graph.Id.ToString(), name = graph.Name, enabled = graph.Enabled, nodeCount = nodes.Count, nodes });
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
            RequireOpenScene();
            var assetCount = 0;
            foreach (var kv in scene.GetAssets()) {
                if (++assetCount > MaxAssets) throw new OutputLimitException($"Asset inventory exceeds the {MaxAssets} asset limit.");
                var asset = kv.Value;
                var assetType = asset.Type?.AssetType;
                var category = string.IsNullOrWhiteSpace(assetType?.category) ? "Other" : assetType.category;
                if (!groups.TryGetValue(category, out var list)) groups[category] = list = new List<object>();
                list.Add(new {
                    id = asset.IdString,
                    name = asset.Name,
                    active = asset.Active,
                    typeId = assetType?.id ?? asset.GetType().Name,
                    title = assetType?.title ?? asset.GetType().Name
                });
            }
            var result = new List<object>();
            foreach (var g in groups) result.Add(new { category = g.Key, count = g.Value.Count, assets = g.Value });
            return result;
        }

        /// <summary>Danh sách graph (blueprint) dạng gọn — không kèm node detail.</summary>
        private static List<object> ListGraphs() {
            var scene = Warudo.Core.Context.OpenedScene;
            RequireOpenScene();
            var graphs = scene.GetGraphs().Values.OrderBy(g => g.Order).ToList();
            if (graphs.Count > MaxBlueprintGraphs) throw new OutputLimitException($"Graph inventory exceeds the {MaxBlueprintGraphs} graph limit.");
            return graphs.Select(g => (object)new {
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
            var stableId = entity is Graph resolvedGraph ? resolvedGraph.Id.ToString() : ((Entity)entity).IdString;

            var ports = new List<object>();
            var outputs = new List<object>();
            var triggers = new List<object>();
            var flowInputs = new List<object>();
            var flowOutputs = new List<object>();
            if (entity is Entity portEntity) {
                foreach (var pair in portEntity.DataInputPortCollection.GetPorts()) {
                    if (ports.Count >= MaxEntityPorts) throw new OutputLimitException($"Entity inspection exceeds the {MaxEntityPorts} data input port limit.");
                    var port = pair.Value;
                    var entry = new Dictionary<string, object> {
                        ["name"] = pair.Key,
                        ["label"] = port.Properties?.label ?? pair.Key,
                        ["type"] = TypeLabel(port.Type),
                        ["disabled"] = port.Properties?.disabled ?? false,
                        ["hidden"] = port.Properties?.hidden ?? false
                    };
                    if (port.Type.IsEnum) entry["enumValues"] = Enum.GetNames(port.Type);
                    try {
                        entry["value"] = SafeValue(portEntity.GetDataInput(pair.Key));
                    } catch (Exception e) {
                        entry["value"] = null;
                        entry["valueError"] = e.Message;
                    }
                    ports.Add(entry);
                }
                foreach (var pair in portEntity.TriggerPortCollection.GetPorts()) {
                    if (ports.Count + triggers.Count >= MaxEntityPorts) throw new OutputLimitException($"Entity inspection exceeds the {MaxEntityPorts} port limit.");
                    triggers.Add(new { name = pair.Key, label = pair.Value.Properties?.label ?? pair.Key });
                }
            }
            if (entity is Node graphNode) {
                foreach (var pair in graphNode.DataOutputPortCollection.GetPorts()) {
                    if (ports.Count + triggers.Count + outputs.Count >= MaxEntityPorts) throw new OutputLimitException($"Entity inspection exceeds the {MaxEntityPorts} port limit.");
                    // Metadata only: evaluating an output can run user code.
                    outputs.Add(new { name = pair.Key, label = pair.Value.Properties?.label ?? pair.Key, type = TypeLabel(pair.Value.Type) });
                }
                foreach (var pair in graphNode.FlowInputPortCollection.GetPorts()) {
                    if (ports.Count + triggers.Count + outputs.Count + flowInputs.Count >= MaxEntityPorts) throw new OutputLimitException($"Entity inspection exceeds the {MaxEntityPorts} port limit.");
                    flowInputs.Add(new { name = pair.Key, label = pair.Value.Properties?.label ?? pair.Key });
                }
                foreach (var pair in graphNode.FlowOutputPortCollection.GetPorts()) {
                    if (ports.Count + triggers.Count + outputs.Count + flowInputs.Count + flowOutputs.Count >= MaxEntityPorts) throw new OutputLimitException($"Entity inspection exceeds the {MaxEntityPorts} port limit.");
                    flowOutputs.Add(new { name = pair.Key, label = pair.Value.Properties?.label ?? pair.Key });
                }
            }

            string title = null, typeId = null;
            if (entity is Warudo.Core.Scenes.Asset assetEntity) {
                title = assetEntity.Type?.AssetType?.title;
                typeId = assetEntity.Type?.AssetType?.id;
            } else if (entity is Node nodeEntity) {
                title = nodeEntity.Type?.NodeType?.title;
                typeId = nodeEntity.Type?.NodeType?.id;
            }

            return new {
                id = stableId,
                kind = entity is Warudo.Core.Scenes.Asset ? "asset" : entity is Graph ? "graph" : "node",
                title = title ?? entity.GetType().Name,
                typeId = typeId ?? entity.GetType().Name,
                dataInputCount = ports.Count,
                ports,
                dataOutputs = outputs,
                triggers,
                flowInputs,
                flowOutputs
            };
        }

        /// <summary>Tìm entity theo id: asset → node trong graph → graph (theo id hoặc tên).</summary>
        private static object FindEntity(string id) {
            RequireOpenScene();
            var scene = Warudo.Core.Context.OpenedScene;
            foreach (var kv in scene.GetAssets()) {
                if (string.Equals(kv.Value.IdString, id, StringComparison.OrdinalIgnoreCase)) return kv.Value;
            }
            var graphs = scene.GetGraphs().Values;
            foreach (var graph in graphs) {
                if (string.Equals(graph.Id.ToString(), id, StringComparison.OrdinalIgnoreCase)) return graph;
                foreach (var nkv in graph.GetNodes()) {
                    if (string.Equals(nkv.Value.IdString, id, StringComparison.OrdinalIgnoreCase)) return nkv.Value;
                }
            }
            var graphNames = graphs.Where(graph => string.Equals(graph.Name, id, StringComparison.OrdinalIgnoreCase)).ToList();
            if (graphNames.Count > 1) throw new ArgumentException("Graph name is ambiguous; use its ID: " + id);
            if (graphNames.Count == 1) return graphNames[0];
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
            var graphName = RequireString(data, "blueprint");
            var nodeKey = RequireString(data, "node");
            var input = RequireString(data, "input");

            var graph = FindGraph(graphName);
            if (graph == null) throw new Exception("Không tìm thấy blueprint: " + graphName);

            var node = FindNode(graph, nodeKey);
            if (node == null) throw new Exception("Không tìm thấy node: " + nodeKey);

            var port = node.GetDataInputPort(input);
            if (port == null) throw new ArgumentException("Unknown data input: " + input);
            var value = ParseInputValue(data?["value"] as JObject);
            if (value is JToken jsonValue) value = jsonValue.ToObject(port.Type);
            else if (port.Type.IsEnum && value is string enumName) {
                try {
                    value = Enum.Parse(port.Type, enumName, true);
                    if (!Enum.IsDefined(port.Type, value)) throw new ArgumentException("Enum value is not defined: " + enumName);
                } catch (Exception e) {
                    throw new ArgumentException("Invalid enum value for " + input + ": " + enumName, e);
                }
            }
            if ((value == null && port.Type.IsValueType && Nullable.GetUnderlyingType(port.Type) == null) || (value != null && !port.Type.IsInstanceOfType(value))) throw new ArgumentException("Value type does not match data input " + input + ". Expected " + TypeLabel(port.Type) + ".");
            node.SetDataInput(input, value);
            node.BroadcastDataInput(input);
            return new { blueprint = graphName, node = nodeKey, input, value };
        }

        private static Graph FindGraph(string key) {
            RequireOpenScene();
            var graphs = Warudo.Core.Context.OpenedScene.GetGraphs().Values;
            var byId = graphs.FirstOrDefault(g => string.Equals(g.Id.ToString(), key, StringComparison.OrdinalIgnoreCase));
            if (byId != null) return byId;
            var matches = graphs.Where(g => string.Equals(g.Name, key, StringComparison.OrdinalIgnoreCase)).ToList();
            if (matches.Count > 1) throw new ArgumentException("Blueprint name is ambiguous; use its ID: " + key);
            return matches.FirstOrDefault();
        }

        private static Node FindNode(Graph graph, string key) {
            var nodes = graph.GetNodes().Values;
            var byId = nodes.FirstOrDefault(n => string.Equals(n.IdString, key, StringComparison.OrdinalIgnoreCase));
            if (byId != null) return byId;
            var matches = nodes.Where(node => {
                var nodeType = node.Type?.NodeType;
                return string.Equals(node.GetType().Name, key, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(node.Name, key, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(nodeType?.title, key, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(nodeType?.id, key, StringComparison.OrdinalIgnoreCase);
            }).ToList();
            if (matches.Count > 1) throw new ArgumentException("Node name is ambiguous; use its ID: " + key);
            return matches.FirstOrDefault();
        }

        private static object ParseInputValue(JObject valueObj) {
            if (valueObj == null) throw new Exception("Thiếu 'value'.");
            var type = valueObj["type"]?.Value<string>();
            var v = valueObj["value"];
            if (v == null) throw new ArgumentException("Missing typed value.");
            if (v.Type == JTokenType.Null && type != "json") throw new ArgumentException("Null requires the json value type.");
            switch (type) {
                case "float":
                    return ParseNumber(v);
                case "int":
                    if (v.Type != JTokenType.Integer) throw new ArgumentException("int value must be an integer.");
                    return v.Value<int>();
                case "bool":
                    return ParseBoolean(v);
                case "string":
                case "enum":
                    if (v.Type != JTokenType.String) throw new ArgumentException("String and enum values must be strings.");
                    return v.Value<string>();
                case "json":
                    return v;
                case "vector3": {
                    var a = v as JArray;
                    if (a == null || a.Count != 3) throw new ArgumentException("vector3 requires exactly three numbers.");
                    return new Vector3(ParseNumber(a[0]), ParseNumber(a[1]), ParseNumber(a[2]));
                }
                case "color":
                    return ParseColor(v);
                default:
                    throw new Exception("Kiểu giá trị không hợp lệ: " + type);
            }
        }

        /* ── Tiện ích ── */

        private static void RequireOpenScene() {
            if (Warudo.Core.Context.OpenedScene == null) throw new InvalidOperationException("No Warudo scene is open.");
        }

        private static string RequireString(JObject data, string name) {
            var token = data?[name];
            if (token == null || token.Type != JTokenType.String || string.IsNullOrWhiteSpace(token.Value<string>())) {
                throw new ArgumentException("Missing or invalid '" + name + "'.");
            }
            return token.Value<string>();
        }

        private static string RequirePath(JObject data) {
            var token = data?["path"];
            if (token == null || token.Type != JTokenType.String) throw new ArgumentException("path must be a string (use an empty string for the root).");
            return token.Value<string>();
        }

        private static CharacterAsset FindAvatar(string key) {
            RequireOpenScene();
            var avatars = Warudo.Core.Context.OpenedScene.GetAssets<CharacterAsset>();
            var byId = avatars.FirstOrDefault(a => string.Equals(a.IdString, key, StringComparison.OrdinalIgnoreCase));
            if (byId != null) return byId;
            var matches = avatars.Where(a =>
                string.Equals(a.Name, key, StringComparison.OrdinalIgnoreCase) ||
                (a.GameObject != null && string.Equals(a.GameObject.name, key, StringComparison.OrdinalIgnoreCase))).ToList();
            if (matches.Count > 1) throw new ArgumentException("Avatar name is ambiguous; use its ID: " + key);
            if (matches.Count == 0) throw new ArgumentException("Avatar was not found: " + key);
            return matches[0];
        }

        private static GameObject FindGameObject(CharacterAsset avatar, string path) {
            if (avatar?.GameObject == null) throw new ArgumentException("Avatar has no GameObject.");
            if (!GameObjectPathResolver.TryResolve(avatar.GameObject, path, out var result, out var error)) {
                throw new ArgumentException(error);
            }
            return result;
        }

        private static bool ParseBoolean(JToken token) {
            if (token == null || token.Type != JTokenType.Boolean) throw new ArgumentException("Boolean value must be true or false.");
            return token.Value<bool>();
        }

        private static float ParseNumber(JToken token) {
            if (token == null || (token.Type != JTokenType.Integer && token.Type != JTokenType.Float)) throw new ArgumentException("Expected a finite number.");
            var number = token.Value<float>();
            if (float.IsNaN(number) || float.IsInfinity(number)) throw new ArgumentException("Expected a finite number.");
            return number;
        }

        private static Color ParseColor(JToken token) {
            var arr = token as JArray;
            if (arr == null || (arr.Count != 3 && arr.Count != 4)) throw new ArgumentException("color requires three or four numbers.");
            return new Color(ParseNumber(arr[0]), ParseNumber(arr[1]), ParseNumber(arr[2]), arr.Count == 4 ? ParseNumber(arr[3]) : 1f);
        }


        private static string SerializeResponse(string action, object payload) {
            try {
                var response = JsonConvert.SerializeObject(new { action, isResponse = true, data = payload });
                if (System.Text.Encoding.UTF8.GetByteCount(response) > MaxResponseBytes) {
                    throw new OutputLimitException($"Response exceeds the {MaxResponseBytes} byte limit.");
                }
                return response;
            } catch (OutputLimitException) {
                throw new OutputLimitException($"Action '{action}' exceeds the {MaxResponseBytes} byte response limit. Narrow the query or inspect one graph/entity at a time.");
            } catch (Exception e) {
                throw new OutputLimitException($"Action '{action}' produced a value that cannot be serialized safely: {e.Message}");
            }
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
                        throw new OutputLimitException("A collection value exceeds the 20 item inspection limit; inspect a narrower entity or use the native port getter.");
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

            // Complex values are intentionally summarized to avoid traversing
            // Unity object graphs. The response byte budget is enforced before
            // it is sent to the MCP client.
            try { return v.ToString(); } catch { return "(complex value)"; }
        }
    }
}
