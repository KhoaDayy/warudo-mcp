using System;
using System.Collections.Generic;
using UnityEngine;

namespace Warudo.Plugins.McpBridge {

    /// <summary>
    /// Owns keyword override clones for one bridge plugin instance. Each renderer slot is
    /// cloned at most once while its assignment remains unchanged. Teardown
    /// restores only assignments still owned by the bridge.
    /// </summary>
    internal sealed class MaterialKeywordOverrideStore {
        private const int MaxOwnedMaterials = 256;

        private sealed class Entry {
            public Renderer Renderer;
            public int Index;
            public Material Original;
            public Material Clone;
        }

        private readonly List<Entry> entries = new List<Entry>();

        public Material GetOwnedMaterial(Renderer renderer, int materialIndex) {
            if (renderer == null) throw new ArgumentNullException(nameof(renderer));
            Sweep();
            var current = renderer.sharedMaterials;
            if (current == null || materialIndex < 0 || materialIndex >= current.Length || current[materialIndex] == null) {
                throw new ArgumentOutOfRangeException(nameof(materialIndex));
            }

            foreach (var entry in entries) {
                if (entry.Renderer == renderer && entry.Index == materialIndex) return entry.Clone;
            }
            if (entries.Count >= MaxOwnedMaterials) {
                throw new InvalidOperationException($"Bridge owns {MaxOwnedMaterials} keyword material overrides; unload the scene or disable/reload the MCP Bridge plugin to release them.");
            }

            var original = current[materialIndex];
            var clone = UnityEngine.Object.Instantiate(original);
            clone.name = original.name + "_McpBridgeOverride";
            clone.hideFlags = HideFlags.DontSave;
            try {
                current[materialIndex] = clone;
                renderer.sharedMaterials = current;
                entries.Add(new Entry { Renderer = renderer, Index = materialIndex, Original = original, Clone = clone });
                return clone;
            } catch {
                UnityEngine.Object.Destroy(clone);
                throw;
            }
        }

        public void Sweep() {
            for (var i = entries.Count - 1; i >= 0; i--) {
                var entry = entries[i];
                var current = entry.Renderer != null ? entry.Renderer.sharedMaterials : null;
                if (current != null && entry.Index < current.Length && current[entry.Index] == entry.Clone) continue;
                DestroyClone(entry);
                entries.RemoveAt(i);
            }
        }

        public void Clear() {
            foreach (var entry in entries) {
                try {
                    var current = entry.Renderer != null ? entry.Renderer.sharedMaterials : null;
                    if (current != null && entry.Index < current.Length && current[entry.Index] == entry.Clone) {
                        current[entry.Index] = entry.Original;
                        entry.Renderer.sharedMaterials = current;
                    }
                } catch (Exception e) {
                    Debug.LogWarning("[McpBridge] Could not restore material override: " + e.Message);
                } finally {
                    DestroyClone(entry);
                }
            }
            entries.Clear();
        }

        private static void DestroyClone(Entry entry) {
            if (entry.Clone != null) UnityEngine.Object.Destroy(entry.Clone);
        }
    }
}
