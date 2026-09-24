using System;
using System.Collections.Generic;
using Cysharp.Threading.Tasks;
using UnityEngine;
using UnityEngine.Rendering;
using Warudo.Core;
using Warudo.Core.Attributes;
using Warudo.Core.Graphs;
using Warudo.Plugins.Core.Assets.Character;

namespace Warudo.Plugins.McpBridge.Nodes {

    /// <summary>
    /// GLOW OUTFIT — hiệu ứng đổi đồ "đồ 1 flash tới peak → biến mất → đồ 2
    /// hiện ra với flash ở peak hạ dần", chạy trên Warudo BiRP, không shader
    /// tự viết, không đụng material gốc.
    ///
    /// Cách hoạt động: với mỗi Renderer dưới các GameObjectPath, tạo một bản
    /// sao mesh (overlay) dùng shader Particles/Additive (BiRP có sẵn). Độ
    /// sáng mã hóa theo ĐỘ CAO từng đỉnh (vertex color) → vệt sáng quét từ
    /// dưới lên trên. Nhịp hiệu ứng:
    ///
    ///   1. GLOW UP (đồ 1): overlay copy của đồ 1 sáng dần, quét dưới→trên.
    ///   2. PEAK:           trắng xóa. Cùng frame: onPeak() swap SetActive,
    ///                      overlay đồ 1 bị HỦY và overlay mới được TẠO LẠI từ
    ///                      mesh của đồ 2 (swapPaths) — sinh ra ngay ở độ sáng
    ///                      đỉnh, phủ đúng silhouette đồ mới (flash > đồ 2).
    ///   3. GLOW DOWN (đồ 2): overlay đồ 2 hạ từ peak: trắng → GLOW COLOR →
    ///                      tan về 0, lộ đồ 2 bình thường.
    ///
    /// Nếu không truyền swapPaths → overlay đồ 1 fade nốt sau peak (hành vi
    /// cũ, dùng cho toggle-off hoặc glow đơn thuần).
    ///
    /// KHÔNG lọc renderer disabled/inactive khi gom: glow có thể trỏ vào
    /// outfit đang tắt (sắp được bật) — overlay tự render độc lập nhờ treo
    /// ở root avatar + bones tham chiếu trực tiếp.
    ///
    /// Nếu mesh không đọc được (isReadable=false) → fallback flash đều qua
    /// _TintColor (mất sweep dưới→trên, còn đầy đủ peak/swap/fade).
    ///
    /// Phương thức Glow(...) là static — dùng chung cho blueprint,
    /// SwitchGroupNode và lệnh MCP glow_outfit.
    /// </summary>
    [NodeType(
        Id = "3f8c1a2e-6d5b-4f7a-9c2e-8b1a4d6f9c3e",
        Title = "GLOW OUTFIT",
        Category = "MCP BRIDGE"
    )]
    public class GlowOutfitNode : Node {

        [DataInput]
        [Label("CHARACTER")]
        public CharacterAsset Character;

        [DataInput]
        [Label("GAMEOBJECT PATHS")]
        [Description("Path tới outfit/thân cần glow (vd Assets/Outfits/SuriMukeki). KHÔNG trỏ vào mặt/tóc che mặt để giữ biểu cảm.")]
        public string[] GameObjectPaths = new[] { "Assets/Outfits/SuriMukeki" };

        [DataInput]
        [Label("GLOW COLOR")]
        [Description("Màu glow ở pha đầu và pha tan. Ở đỉnh lóa overlay chuyển sang TRẮNG.")]
        public Color GlowColor = new Color(1f, 0.4f, 0.8f, 1f);

        [DataInput]
        [Label("INTENSITY")]
        [Description("Độ chói tại đỉnh. Nên 3~4 để trắng xóa che khuất cú swap.")]
        public float Intensity = 3f;

        [DataInput]
        [Label("DURATION (MS)")]
        public int DurationMs = 600;

        [DataInput]
        [Label("PEAK (0-1)")]
        [Description("Thời điểm lóa cực đại tính theo tỉ lệ Duration (0.42 ≈ 0.25s với 600ms). Cú cắt đổi đồ xảy ra đúng lúc này.")]
        public float PeakPercent = 0.42f;

        [DataInput]
        [Label("SWAP GAMEOBJECT PATHS (ĐỒ MỚI)")]
        [Description("Path tới outfit MỚI sẽ hiện sau peak. Nếu có, tại peak overlay đồ cũ bị hủy và overlay đồ mới được tạo từ các path này — đồ mới lộ ra với glow hạ dần (đúng timeline swap). Để trống = overlay đồ cũ fade nốt (không glow đồ mới).")]
        public string[] SwapGameObjectPaths;

        [FlowInput]
        public Continuation Enter() {
            Glow(Character, GameObjectPaths ?? Array.Empty<string>(),
                GlowColor, Intensity, DurationMs, PeakPercent,
                onPeak: () => {
                    try {
                        InvokeFlow(nameof(OnPeak), false);
                    } catch (Exception e) {
                        Debug.LogWarning("[GlowOutfit] InvokeFlow thất bại: " + e.Message);
                    }
                },
                swapPaths: SwapGameObjectPaths).Forget();
            return Exit; // flow chính không bị chặn — glow chạy nền
        }

        [FlowOutput]
        [Label("EXIT (IMMEDIATE)")]
        public Continuation Exit;

        [FlowOutput]
        [Label("SWAP OUTFIT (AT PEAK)")]
        [Description("Kích hoạt đúng frame lóa trắng cực đại — nối các node TOGGLE outfit vào đây để match cut bị ánh sáng che hoàn toàn.")]
        public Continuation OnPeak;

        // ── Overlay tạm của một renderer nguồn ──
        private class Overlay {
            public GameObject Go;                 // GameObject chứa overlay (để hủy khi swap tại peak)
            public SkinnedMeshRenderer SourceSmr; // để sync blendshape (null nếu MeshRenderer)
            public Renderer Renderer;             // renderer của overlay
            public Mesh MeshCopy;                 // null nếu mesh gốc không đọc được
            public float[] Heights;               // null → fallback uniform (không sweep được)
            public Color[] Colors;
            public Material Mat;
        }

        /// <summary>
        /// Chạy glow transformation (dùng chung: blueprint + SwitchGroup + MCP).
        /// swapPaths: nếu có, TẠI PEAK overlay cũ bị hủy và overlay mới được
        /// tạo từ renderer dưới swapPaths (đồ mới) — flash phủ đúng silhouette
        /// bộ mới trong pha tan. Gọi onPeak TRƯỚC khi rebuild nên bộ mới đã
        /// active khi overlay của nó được tạo.
        /// </summary>
        public static async UniTask Glow(CharacterAsset character, string[] paths,
                Color color, float intensity, int durationMs, float peakPercent,
                Action onPeak, string[] swapPaths = null) {
            if (character?.GameObject == null) return;

            var peak = Mathf.Clamp(peakPercent, 0.05f, 0.95f);
            var duration = Math.Max(100, durationMs) / 1000f;

            var overlays = new List<Overlay>();
            var spawned = new List<UnityEngine.Object>();

            try {
                // 1. Container treo vào ROOT avatar — độc lập với outfit bị toggle
                var container = new GameObject("GlowOutfit_Overlays");
                container.hideFlags = HideFlags.DontSave;
                container.transform.SetParent(character.GameObject.transform, false);
                spawned.Add(container);

                // 2. Overlay của bộ HIỆN TẠI (đồ 1)
                BuildOverlays(character, paths, container.transform, overlays, spawned);
                if (overlays.Count == 0) {
                    Debug.LogWarning("[GlowOutfit] Không tạo được overlay nào!");
                    return;
                }

                // 3. Animate: quét dưới→trên, TRẮNG XÓA tại peak, glow màu tan dần
                var elapsed = 0f;
                var peakFired = false;
                const float edge = 0.25f; // độ mềm của mép sáng dẫn đầu
                while (elapsed < duration) {
                    var t = Mathf.Clamp01(elapsed / duration);

                    // Envelope: lên nhanh tới peak, xuống chậm sau peak.
                    // KHÔNG reset khi swap overlay → overlay đồ 2 sinh ra đúng
                    // lúc env=1 (đỉnh) rồi tự hạ dần theo nhịp chung.
                    var env = t <= peak
                        ? Smooth01(t / peak)
                        : 1f - Smooth01((t - peak) / (1f - peak));

                    // Mặt sáng quét từ dưới (-0.15) lên quá đỉnh (1.15) trong pha
                    // lên; sau peak giữ nguyên → toàn thân sáng đều rồi fade
                    var sweep = Mathf.Lerp(-0.15f, 1.15f, Mathf.Clamp01(t / peak));

                    if (!peakFired && t >= peak) {
                        peakFired = true;
                        onPeak?.Invoke(); // ← MATCH CUT: SetActive swap tại đây

                        // Đổi overlay sang mesh đồ MỚI: hủy overlay đồ 1 (nó
                        // "biến mất"), tạo overlay đồ 2 — sinh ra ở env=1,
                        // trắng xóa, rồi hạ dần cùng envelope.
                        if (swapPaths != null && swapPaths.Length > 0) {
                            foreach (var ov in overlays) {
                                if (ov.Go != null) UnityEngine.Object.Destroy(ov.Go);
                                if (ov.Mat != null) UnityEngine.Object.Destroy(ov.Mat);
                                if (ov.MeshCopy != null) UnityEngine.Object.Destroy(ov.MeshCopy);
                            }
                            overlays.Clear();
                            BuildOverlays(character, swapPaths, container.transform, overlays, spawned);
                        }
                    }

                    // Hai pha màu: env cao (quanh đỉnh) → TRẮNG; env thấp (pha tan) → glow color
                    var whiteMix = Mathf.Clamp01((env - 0.55f) / 0.45f);
                    var c = Color.Lerp(color, Color.white, whiteMix);

                    foreach (var ov in overlays) {
                        if (ov.Renderer == null) continue;
                        if (ov.Heights != null) {
                            // Sweep mode: TOÀN THÂN luôn sáng theo env, vệt quét chỉ
                            // làm vùng phía dưới mép sáng hơn → không còn tình trạng
                            // "chỉ sáng một dải, phần còn lại tối" (không sáng hết bộ đồ).
                            for (var i = 0; i < ov.Heights.Length; i++) {
                                var band = Mathf.Clamp01((sweep + edge - ov.Heights[i]) / edge);
                                var fill = Mathf.Lerp(0.35f, 1f, band);
                                var b = env * fill * intensity;
                                ov.Colors[i] = new Color(c.r * b, c.g * b, c.b * b, Mathf.Clamp01(b));
                            }
                            ov.MeshCopy.colors = ov.Colors;
                        } else {
                            // Fallback: mesh không đọc được → flash đều qua tint
                            // (legacy particle shader nhân 2×tint → tint 0.5 = màu đặt vào giữ nguyên)
                            var b = env * intensity * 0.5f;
                            ov.Mat.SetColor("_TintColor", new Color(c.r * b, c.g * b, c.b * b, 0.5f));
                        }
                        // Outfit gốc có thể đã bị tắt tại peak — overlay phải tự sống nốt
                        if (!ov.Renderer.enabled) ov.Renderer.enabled = true;
                        // Sync blendshape để overlay không tách khỏi mesh gốc giữa chừng
                        if (ov.SourceSmr != null && ov.MeshCopy != null && ov.MeshCopy.blendShapeCount > 0) {
                            var dupSmr = (SkinnedMeshRenderer)ov.Renderer;
                            for (var i = 0; i < ov.MeshCopy.blendShapeCount; i++)
                                dupSmr.SetBlendShapeWeight(i, ov.SourceSmr.GetBlendShapeWeight(i));
                        }
                    }

                    await UniTask.Yield(PlayerLoopTiming.Update);
                    elapsed += UnityEngine.Time.deltaTime;
                }
            }
            finally {
                // 4. Dọn dẹp — material gốc chưa từng bị đụng, chỉ hủy overlay.
                // Overlay bị hủy tại peak vẫn nằm trong list → Destroy lần hai
                // là no-op, an toàn.
                foreach (var o in spawned) if (o != null) UnityEngine.Object.Destroy(o);
            }
        }

        /// <summary>
        /// Gom renderer dưới các path rồi tạo overlay cho từng renderer.
        /// KHÔNG lọc inactive — glow có thể nhắm vào outfit đang tắt (sắp bật).
        /// </summary>
        private static void BuildOverlays(CharacterAsset character, string[] paths,
                Transform container, List<Overlay> overlays, List<UnityEngine.Object> spawned) {
            foreach (var path in paths ?? Array.Empty<string>()) {
                if (string.IsNullOrWhiteSpace(path)) continue;
                var go = FindGameObjectByPath(character.GameObject, path);
                if (go == null) {
                    Debug.LogWarning("[GlowOutfit] path NOT FOUND: " + path);
                    continue;
                }
                var renderers = go.GetComponentsInChildren<Renderer>(true);
                Debug.Log($"[GlowOutfit] path='{path}' → GO='{go.name}' renderers={renderers.Length}");
                foreach (var r in renderers) {
                    if (r == null) continue;
                    if (r.name.EndsWith("_GlowOverlay")) continue; // không tự "ăn" overlay của lần glow trước
                    var ov = CreateOverlay(r, container);
                    if (ov == null) continue;
                    overlays.Add(ov);
                    spawned.Add(ov.Go);
                    spawned.Add(ov.Mat);
                    if (ov.MeshCopy != null) spawned.Add(ov.MeshCopy);
                }
            }
        }

        /// <summary>
        /// Tạo bản sao additive của renderer. Nếu mesh đọc được → copy mesh +
        /// mã hóa độ cao vào vertex color (sweep dưới→trên). Nếu không → dùng
        /// mesh gốc, flash đều bằng tint.
        /// </summary>
        private static Overlay CreateOverlay(Renderer src, Transform parent) {
            Mesh mesh = null;
            if (src is SkinnedMeshRenderer smr) mesh = smr.sharedMesh;
            else if (src is MeshRenderer) mesh = src.GetComponent<MeshFilter>()?.sharedMesh;
            if (mesh == null) return null;

            // Log chẩn đoán — đọc dữ liệu mesh an toàn: mesh không đọc được
            // (isReadable=false) sẽ NÉM exception khi truy cập .triangles/.bounds,
            // nên bọc try/catch để không làm hỏng cả glow.
            var isReadable = false;
            var triCount = -1;
            var by0 = float.NaN; var by1 = float.NaN;
            try {
                isReadable = mesh.isReadable;
                triCount = mesh.triangles.Length / 3;
                var b = mesh.bounds;
                by0 = b.min.y; by1 = b.max.y;
            } catch (Exception e) {
                Debug.LogWarning("[GlowOutfit] mesh '" + src.name + "' không đọc được (" + e.Message + ") → fallback tint đều");
            }
            Debug.Log($"[GlowOutfit] renderer='{src.name}' isReadable={isReadable} tris={triCount} boundsY={by0:F2}..{by1:F2}");

            // CHANNEL VERTEX COLOR — dứt điểm lỗi "glow không sáng dù mesh đọc được":
            // shader Particles/Additive (BiRP) nhân 2×TintColor×VertexColor, và lấy
            // VertexColor từ attribute UV1 (TEXCOORD1) của mesh — KHÔNG phải mesh.colors.
            // Nếu UV1 của mesh có sẵn dữ liệu đen/cũ → overlay không bao giờ sáng,
            // đổi công thức fill tới đâu cũng vô ích. Ép UV1 = hằng số trắng (1,1) để
            // shader luôn nhìn thấy vertex trắng → màu do tint + fill quyết định hoàn toàn.
            // Mesh gốc KHÔNG bị đụng — chỉ sửa trên bản copy mà overlay sẽ dùng.
            var copy = UnityEngine.Object.Instantiate(mesh);
            copy.name = mesh.name + "_GlowCopy";
            try {
                var uv1 = new Vector2[copy.vertexCount];
                for (var i = 0; i < uv1.Length; i++) uv1[i] = new Vector2(1f, 1f);
                copy.SetUVs(1, uv1);
            } catch (Exception e) {
                Debug.LogWarning("[GlowOutfit] copy UV1 fail: " + e.Message);
            }

            var shader = Shader.Find("Particles/Additive");
            if (shader == null) shader = Shader.Find("Legacy Shaders/Particles/Additive");
            if (shader == null) {
                Debug.LogWarning("[GlowOutfit] Không tìm thấy Particles/Additive shader!");
                return null;
            }

            var ov = new Overlay();
            ov.Mat = new Material(shader) { name = "GlowOutfit_Mat", hideFlags = HideFlags.DontSave };
            ov.Mat.renderQueue = 3100; // vẽ sau opaque → đè lên bộ đồ
            // Legacy particle shader nhân 2×tint×vertexColor → tint 0.5 = vertex color quyết định
            ov.Mat.SetColor("_TintColor", new Color(0.5f, 0.5f, 0.5f, 0.5f));

            // Thử đọc độ cao đỉnh (sweep mode) trên copy đã có UV1 trắng.
            // Đọc từ copy sẽ không ném dù mesh gốc isReadable=false — vì
            // Instantiate(mesh) cho bản phát lại với dữ liệu chứa trong đó.
            Mesh useMesh = copy;
            ov.MeshCopy = copy;
            try {
                var verts = copy.vertices;
                var b = copy.bounds;
                var min = b.min.y;
                var range = Mathf.Max(1e-5f, b.max.y - b.min.y);
                ov.Heights = new float[verts.Length];
                ov.Colors = new Color[verts.Length];
                for (var i = 0; i < verts.Length; i++)
                    ov.Heights[i] = (verts[i].y - min) / range; // 0 = đáy mesh, 1 = đỉnh mesh
            } catch (Exception e) {
                // Mesh không có dữ liệu vertices khả dụng (hiếm) → fallback tint đều
                Debug.LogWarning("[GlowOutfit] mesh '" + src.name + "' không đọc được để sweep: " + e.Message + " → tint đều");
                ov.Heights = null; ov.MeshCopy = null; useMesh = mesh;
            }

            var go = new GameObject(src.name + "_GlowOverlay");
            go.hideFlags = HideFlags.DontSave;
            go.transform.SetParent(parent, false);
            // Giữ đúng pose thế giới (quan trọng cho MeshRenderer tĩnh;
            // SMR được bones điều khiển nên không phụ thuộc transform này)
            go.transform.position = src.transform.position;
            go.transform.rotation = src.transform.rotation;
            go.transform.localScale = src.transform.lossyScale;
            ov.Go = go;

            var subCount = Mathf.Max(1, useMesh.subMeshCount);
            var mats = new Material[subCount];
            for (var i = 0; i < subCount; i++) mats[i] = ov.Mat;

            if (src is SkinnedMeshRenderer srcSmr) {
                var dup = go.AddComponent<SkinnedMeshRenderer>();
                dup.sharedMesh = useMesh;
                dup.bones = srcSmr.bones;       // bones của avatar — sống độc lập
                dup.rootBone = srcSmr.rootBone; // với việc outfit bị toggle
                dup.updateWhenOffscreen = true;
                if (srcSmr.sharedMesh != null)
                    for (var i = 0; i < srcSmr.sharedMesh.blendShapeCount; i++)
                        dup.SetBlendShapeWeight(i, srcSmr.GetBlendShapeWeight(i));
                dup.sharedMaterials = mats;
                ov.SourceSmr = srcSmr;
                ov.Renderer = dup;
            } else {
                go.AddComponent<MeshFilter>().sharedMesh = useMesh;
                var dup = go.AddComponent<MeshRenderer>();
                dup.sharedMaterials = mats;
                ov.Renderer = dup;
            }
            ov.Renderer.shadowCastingMode = ShadowCastingMode.Off; // không đổ bóng kép
            ov.Renderer.receiveShadows = false;
            return ov;
        }

        private static float Smooth01(float x) {
            x = Mathf.Clamp01(x);
            return x * x * (3f - 2f * x);
        }

        /// <summary>
        /// Resolve path như Warudo: thử path trực tiếp từ gốc avatar, rồi tìm
        /// khớp đuôi trong toàn cây (avatar bọc trong "Character Parent/Root/...").
        /// </summary>
        public static GameObject FindGameObjectByPath(GameObject root, string path) {
            if (root == null || string.IsNullOrWhiteSpace(path)) return null;
            var t = root.transform.Find(path);
            if (t != null) return t.gameObject;
            var hit = SearchSuffix(root.transform, "", path);
            return hit != null ? hit.gameObject : null;
        }

        private static Transform SearchSuffix(Transform current, string prefix, string path) {
            foreach (Transform child in current) {
                var rel = string.IsNullOrEmpty(prefix) ? child.name : prefix + "/" + child.name;
                if (rel == path || rel.EndsWith("/" + path, StringComparison.OrdinalIgnoreCase)) {
                    return child;
                }
                var hit = SearchSuffix(child, rel, path);
                if (hit != null) return hit;
            }
            return null;
        }
    }
}
