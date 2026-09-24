using System;
using System.Collections.Generic;
using System.Linq;
using Cysharp.Threading.Tasks;
using UnityEngine;
using Warudo.Core;
using Warudo.Core.Attributes;
using Warudo.Core.Scenes;
using Warudo.Core.Utils;
using Warudo.Plugins.Core;
using Warudo.Plugins.McpBridge.Nodes;
using WebSocketSharp.Server;

namespace Warudo.Plugins.McpBridge {

    /// <summary>
    /// Asset chủ của cầu nối MCP: mở một WebSocket server trong Warudo để
    /// MCP server (Claude) kết nối tới và điều khiển scene.
    ///
    /// Cách cài (nhanh nhất — Playground, không cần Unity):
    ///   1. Copy 3 file McpBridgeAsset.cs, McpBridgeService.cs, Nodes/OnMcpCommandNode.cs
    ///      vào thư mục Playground của Warudo.
    ///   2. Trong Warudo: thêm asset "MCP Bridge" vào scene, đổi port nếu cần.
    /// </summary>
    [AssetType(
        Id = "20d17238-0341-46d3-b6f5-fede75284315",
        Title = "MCP Bridge",
        Category = "MCP BRIDGE"
    )]
    public class McpBridgeAsset : Asset {

        [DataInput]
        [Label("PORT")]
        public int Port = 5678;

        private WebSocketServer server;
        private readonly HashSet<OnMcpCommandNode> commandNodes = new();

        protected override void OnCreate() {
            base.OnCreate();
            StartServer().Forget();
        }

        protected override void OnDestroy() {
            base.OnDestroy();
            StopServer();
        }

        private async UniTaskVoid StartServer() {
            await UniTask.SwitchToMainThread();
            if (server != null) return;

            const int maxRetries = 3;
            for (int attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    var wsUri = WebSocketHelpers.CreateLocalHostUri(Port);
                    var corePlugin = Context.PluginManager?.GetPlugin<CorePlugin>();
                    if (corePlugin != null) await corePlugin.BeforeListenToPort();

                    server = new WebSocketServer(wsUri);
                    server.AddWebSocketService<McpBridgeService>("/", it => it.Parent = this);
                    server.Start();

                    if (corePlugin != null) corePlugin.AfterListenToPort();
                    Debug.Log($"[McpBridge] WebSocket server started at port {Port} (attempt {attempt})");
                    return;
                } catch (Exception e) {
                    server = null;
                    if (attempt < maxRetries) {
                        Debug.LogWarning($"[McpBridge] Cổng {Port} chưa sẵn sàng, thử lại sau 500ms... ({e.Message})");
                        await UniTask.Delay(500);
                    } else {
                        Log.UserError($"[McpBridge] Không thể khởi động WebSocket server ở port {Port} sau {maxRetries} lần thử: {e.Message}");
                    }
                }
            }
        }

        private void StopServer() {
            if (server != null) {
                try {
                    server.Stop();
                    Debug.Log("[McpBridge] WebSocket server stopped");
                } catch (Exception e) {
                    Debug.LogWarning("[McpBridge] Lỗi khi dừng WebSocket server: " + e.Message);
                }
            }
            server = null;
        }

        /* ── Node đăng ký nhận lệnh ── */

        public void SubscribeCommandNode(OnMcpCommandNode node) {
            if (node != null) commandNodes.Add(node);
        }

        public void UnsubscribeCommandNode(OnMcpCommandNode node) {
            if (node != null) commandNodes.Remove(node);
        }

        public void TriggerCommand(string command) {
            if (string.IsNullOrEmpty(command)) return;
            commandNodes.RemoveWhere(n => n == null);
            foreach (var node in commandNodes) {
                try {
                    if (node != null && node.Command == command) {
                        node.InvokeFlow(nameof(OnMcpCommandNode.Exit));
                    }
                } catch (Exception e) {
                    Debug.LogWarning($"[McpBridge] Trigger command '{command}' lỗi: {e.Message}");
                }
            }
        }
    }
}
