using System.Linq;
using Cysharp.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Warudo.Core;
using Warudo.Core.Attributes;
using Warudo.Core.Plugins;
using Warudo.Core.Utils;
using Warudo.Plugins.McpBridge.Nodes;

namespace Warudo.Plugins.McpBridge {

    /// <summary>
    /// Plugin mod (cần build bằng Unity + Warudo SDK). Ngoài việc đăng ký asset/node,
    /// override OnMessageReceived để nhận lệnh từ control-plane 19053 qua
    /// "sendPluginMessage {pluginId, action, payload}" — kênh dành cho thao tác Unity-specific
    /// mà 60 actions của API không phủ.
    ///
    /// Lưu ý: sendPluginMessage là fire-and-forget (không có kênh trả kết quả trực tiếp);
    /// kết quả thay đổi sẽ tự broadcast về client qua cơ chế port/frame của Warudo.
    /// Với action cần đọc dữ liệu, hãy dùng kênh WS 5678.
    /// </summary>
    [PluginType(
        Id = "com.hasukatsu.warudo.mcpbridge",
        Name = "MCP Bridge",
        Description = "WebSocket bridge để Claude (qua MCP) điều khiển Warudo: đổi đồ, glow, material, trigger blueprint, plugin channel.",
        Version = "0.2.0",
        Author = "Hasukatsu",
        AssetTypes = new[] { typeof(McpBridgeAsset) },
        NodeTypes = new[] { typeof(OnMcpCommandNode), typeof(EkuHashFaceTrackingNode), typeof(EkuHashAnimatorParameterBridgeNode) }
    )]
    public class McpBridgePlugin : Plugin {

        public override void OnMessageReceived(string action, string payload) {
            UniTask.Void(async () => {
                await UniTask.SwitchToMainThread();
                try {
                    if (action == "trigger") {
                        // Không có instance service → tìm asset trong scene và bắn lệnh.
                        var asset = Warudo.Core.Context.OpenedScene.GetAssets().Values
                            .OfType<McpBridgeAsset>()
                            .FirstOrDefault();
                        if (asset == null) {
                            Log.UserError("[McpBridge] sendPluginMessage 'trigger' — không có asset 'MCP Bridge' trong scene.");
                            return;
                        }
                        var data = ParsePayload(payload);
                        asset.TriggerCommand(data?["command"]?.Value<string>());
                        return;
                    }
                    var result = McpBridgeService.ExecuteAction(action, ParsePayload(payload) ?? new JObject());
                    if (result.ok) {
                        Debug.Log("[McpBridge] sendPluginMessage '" + action + "' ok");
                    } else {
                        Log.UserError("[McpBridge] sendPluginMessage '" + action + "' thất bại: " + result.error);
                    }
                } catch (System.Exception e) {
                    Log.UserError("[McpBridge] sendPluginMessage '" + action + "' lỗi: " + e.Message);
                }
            });
        }

        private static JObject ParsePayload(string payload) {
            if (string.IsNullOrWhiteSpace(payload)) return null;
            try { return JObject.Parse(payload); } catch { return null; }
        }
    }
}
