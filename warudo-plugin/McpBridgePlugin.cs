using System;
using System.Threading;
using Cysharp.Threading.Tasks;
using UnityEngine;
using Warudo.Core;
using Warudo.Core.Attributes;
using Warudo.Core.Plugins;
using Warudo.Core.Scenes;
using Warudo.Core.Utils;
using Warudo.Plugins.Core;
using WebSocketSharp.Server;

namespace Warudo.Plugins.McpBridge {

    /// <summary>
    /// Scene-independent loopback WebSocket bridge for the runtime operations
    /// that Warudo's native control plane does not expose.
    /// </summary>
    [PluginType(
        Id = "com.hasukatsu.warudo.mcpbridge",
        Name = "MCP Bridge",
        Description = "Local WebSocket bridge for generic Warudo MCP runtime operations.",
        Version = "0.3.0",
        Author = "Hasukatsu",
        SupportUrl = "https://github.com/KhoaDayy/warudo-mcp"
    )]
    public class McpBridgePlugin : Plugin {

        [DataInput]
        [Label("PORT")]
        [Description("Loopback WebSocket port used by the MCP runtime bridge (Default: 5678).")]
        public int Port = 5678;

        [Trigger]
        [Label("OPEN GITHUB & SETUP GUIDE")]
        [Description("Click to open the GitHub repository for documentation, tools catalog, and setup guides.")]
        public void OpenDocumentation() {
            Application.OpenURL("https://github.com/KhoaDayy/warudo-mcp");
        }

        private WebSocketServer server;
        private CancellationTokenSource lifetime;
        private readonly MaterialKeywordOverrideStore keywordOverrides = new MaterialKeywordOverrideStore();
        private float nextMaterialSweep;
        private int activePort = -1;

        internal Material GetKeywordMaterial(Renderer renderer, int index) => keywordOverrides.GetOwnedMaterial(renderer, index);

        public bool IsRunning => lifetime != null && !lifetime.IsCancellationRequested && server != null;

        protected override void OnCreate() {
            base.OnCreate();
            lifetime = new CancellationTokenSource();
            StartServer(lifetime.Token).Forget();
        }

        public override void OnUpdate() {
            base.OnUpdate();
            if (server != null && activePort != Port) {
                StopServer();
                if (lifetime != null && !lifetime.IsCancellationRequested) StartServer(lifetime.Token).Forget();
                return;
            }
            if (Time.unscaledTime < nextMaterialSweep) return;
            nextMaterialSweep = Time.unscaledTime + 5f;
            keywordOverrides.Sweep();
        }

        public override void OnSceneUnloaded(Scene scene) {
            // The plugin outlives scenes, but renderer/material ownership does not.
            keywordOverrides.Clear();
            base.OnSceneUnloaded(scene);
        }

        protected override void OnDestroy() {
            // Cancel first so an awaited port setup cannot start a new server
            // after the plugin has been disabled or hot-reloaded.
            lifetime?.Cancel();
            StopServer();
            keywordOverrides.Clear();
            lifetime?.Dispose();
            lifetime = null;
            base.OnDestroy();
        }

        private async UniTask StartServer(CancellationToken cancellationToken) {
            await UniTask.SwitchToMainThread();
            if (cancellationToken.IsCancellationRequested || server != null) return;

            var requestedPort = Port;
            if (requestedPort < 1 || requestedPort > 65535) {
                Log.UserError("[McpBridge] Port must be between 1 and 65535.");
                return;
            }

            const int maxRetries = 3;
            for (var attempt = 1; attempt <= maxRetries; attempt++) {
                WebSocketServer pendingServer = null;
                try {
                    cancellationToken.ThrowIfCancellationRequested();
                    var wsUri = WebSocketHelpers.CreateLocalHostUri(requestedPort);
                    var corePlugin = Context.PluginManager?.GetPlugin<CorePlugin>();
                    if (corePlugin != null) await corePlugin.BeforeListenToPort();
                    cancellationToken.ThrowIfCancellationRequested();

                    pendingServer = new WebSocketServer(wsUri);
                    pendingServer.AddWebSocketService<McpBridgeService>("/", it => it.Parent = this);
                    pendingServer.Start();
                    if (corePlugin != null) corePlugin.AfterListenToPort();
                    server = pendingServer;
                    activePort = requestedPort;
                    Debug.Log($"[McpBridge] WebSocket server started at port {requestedPort}");
                    return;
                } catch (OperationCanceledException) {
                    StopSafely(pendingServer);
                    return;
                } catch (Exception e) {
                    StopSafely(pendingServer);
                    if (cancellationToken.IsCancellationRequested) return;
                    if (attempt >= maxRetries) {
                        Log.UserError($"[McpBridge] Cannot start WebSocket server on port {requestedPort}: {e.Message}");
                        return;
                    }
                    Debug.LogWarning($"[McpBridge] Port {requestedPort} unavailable, retrying ({attempt}/{maxRetries}): {e.Message}");
                    try {
                        await UniTask.Delay(500, cancellationToken: cancellationToken);
                    } catch (OperationCanceledException) {
                        return;
                    }
                }
            }
        }

        private void StopServer() {
            var current = server;
            server = null;
            activePort = -1;
            StopSafely(current);
        }

        private static void StopSafely(WebSocketServer target) {
            if (target == null) return;
            try {
                target.Stop();
            } catch (Exception e) {
                Debug.LogWarning("[McpBridge] Error stopping WebSocket server: " + e.Message);
            }
        }
    }
}
