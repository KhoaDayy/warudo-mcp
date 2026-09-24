using System;
using System.Linq;
using Cysharp.Threading.Tasks;
using UnityEngine;
using Warudo.Core;
using Warudo.Core.Attributes;
using Warudo.Core.Graphs;

namespace Warudo.Plugins.McpBridge.Nodes {

    /// <summary>
    /// Node blueprint nhận lệnh từ Claude (qua MCP → WebSocket bridge).
    /// Đặt node này trong blueprint và đặt tên "Command" — khi Claude gọi
    /// tool `warudo_trigger` với đúng tên đó, flow từ "Exit" sẽ được kích hoạt.
    ///
    /// Ví dụ: Command = "switch_to_outfit_B" → Claude gọi warudo_trigger("switch_to_outfit_B").
    /// </summary>
    [NodeType(
        Id = "7e002040-a27f-4f26-b293-a423eb0295a0",
        Title = "ON MCP COMMAND",
        Category = "MCP BRIDGE"
    )]
    public class OnMcpCommandNode : Node {

        [DataInput]
        [Label("COMMAND")]
        public string Command = "default";

        [FlowOutput]
        public Continuation Exit;

        private static McpBridgeAsset Bridge =>
            Context.OpenedScene?.GetAssets<McpBridgeAsset>()?.FirstOrDefault();

        protected override void OnCreate() {
            base.OnCreate();
            RegisterToBridge().Forget();
        }

        private async UniTaskVoid RegisterToBridge() {
            await UniTask.SwitchToMainThread();
            for (int i = 0; i < 5; i++) {
                var bridge = Bridge;
                if (bridge != null) {
                    bridge.SubscribeCommandNode(this);
                    return;
                }
                await UniTask.Delay(500);
            }
            Debug.LogWarning("[McpBridge] Chưa tìm thấy asset 'MCP Bridge' trong scene để đăng ký node 'On MCP Command'.");
        }

        protected override void OnDestroy() {
            base.OnDestroy();
            Bridge?.UnsubscribeCommandNode(this);
        }
    }
}
