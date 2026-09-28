using System;
using System.Collections.Generic;
using UnityEngine;

namespace Warudo.Plugins.McpBridge {

    /// <summary>
    /// Resolves a GameObject path relative to an avatar root. Exact paths are
    /// preferred; suffix lookup is supported for avatars wrapped by extra
    /// parent objects. Suffix matches must be unique to avoid mutating the
    /// wrong object when names repeat in a hierarchy.
    /// </summary>
    internal static class GameObjectPathResolver {

        public static bool TryResolve(GameObject root, string path, out GameObject result, out string error) {
            result = null;
            error = null;
            if (root == null) {
                error = "Root GameObject is null.";
                return false;
            }

            var normalized = Normalize(path);
            if (normalized.Length == 0) {
                result = root;
                return true;
            }

            var exactMatches = new List<Transform>();
            var suffixMatches = new List<Transform>();
            CollectMatches(root.transform, string.Empty, normalized, exactMatches, suffixMatches);
            var matches = exactMatches.Count > 0 ? exactMatches : suffixMatches;
            if (matches.Count == 1) {
                result = matches[0].gameObject;
                return true;
            }

            if (matches.Count == 0) {
                error = "GameObject path was not found: " + path;
            } else {
                error = "GameObject path is ambiguous (" + matches.Count + " matches): " + path;
            }
            return false;
        }

        private static string Normalize(string path) {
            if (string.IsNullOrWhiteSpace(path) || path.Trim() == "/") return string.Empty;
            return path.Trim().Trim('/');
        }

        private static void CollectMatches(
            Transform current,
            string prefix,
            string path,
            List<Transform> exactMatches,
            List<Transform> suffixMatches) {
            foreach (Transform child in current) {
                var relative = string.IsNullOrEmpty(prefix)
                    ? child.name
                    : prefix + "/" + child.name;
                if (string.Equals(relative, path, StringComparison.Ordinal)) {
                    exactMatches.Add(child);
                } else if (string.Equals(relative, path, StringComparison.OrdinalIgnoreCase) ||
                    relative.EndsWith("/" + path, StringComparison.OrdinalIgnoreCase)) {
                    suffixMatches.Add(child);
                }
                CollectMatches(child, relative, path, exactMatches, suffixMatches);
            }
        }
    }
}
