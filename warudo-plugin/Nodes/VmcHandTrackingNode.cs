using System;
using UnityEngine;
using Warudo.Core.Attributes;
using Warudo.Core.Graphs;

namespace Warudo.Plugins.McpBridge.Nodes {

    /// <summary>
    /// VMC HAND TRACKING — tách pose VMC ra 2 cờ: tay trái/phải đang track.
    ///
    /// VMC (Virtual Motion Capture) gửi pose toàn thân gộp, KHÔNG có cờ tách
    /// "tay trái/phải đang track". Node GenerateInputInterfacesAnimation cần
    /// IsLeftHandTracked / IsRightHandTracked để biết tay nào đang được track
    /// thật (khi đó nó nhường, không tạo tay ảo gõ phím).
    ///
    /// Cách hoạt động: nhận BONE_ROTATIONS từ output của node Get VMC Receiver
    /// Data, lấy rotation bone tay trái/phải theo index HumanBodyBones.LeftHand /
    /// RightHand. VMC gửi rotation mặc định (identity 0,0,0,1) cho bone không
    /// được track — nếu rotation khác identity → cờ = true (tay ảo nhường, track
    /// theo VMC). Nếu là identity → cờ = false (tay ảo tự đặt lên phím).
    /// </summary>
    [NodeType(
        Id = "a1b2c3d4-0001-4a5b-9c6d-7e8f9a0b1c2d",
        Title = "VMC HAND TRACKING",
        Category = "MCP BRIDGE"
    )]
    public class VmcHandTrackingNode : Node {

        [DataInput]
        [Label("VMC BONE ROTATIONS")]
        [Description("Nối từ output BONE_ROTATIONS của node Get VMC Receiver Data. Mảng rotation bone (index theo HumanBodyBones, tay trái/phải = LeftHand/RightHand).")]
        public Quaternion[] BoneRotations;

        // ── Data outputs: cờ cho GenerateInputInterfacesAnimation ──
        [DataOutput]
        [Label("IS LEFT HAND TRACKED")]
        [Description("true = tay trái VMC đang track (tay ảo nhường). false = tay ảo tự đặt lên phím.")]
        public bool IsLeftHandTracked() => HasBoneRotation(HumanBodyBones.LeftHand);

        [DataOutput]
        [Label("IS RIGHT HAND TRACKED")]
        [Description("true = tay phải VMC đang track (tay ảo nhường). false = tay ảo tự đặt lên phím.")]
        public bool IsRightHandTracked() => HasBoneRotation(HumanBodyBones.RightHand);

        // ── Kiểm tra bone tay có rotation thật không (VMC gửi identity cho bone không track) ──
        private bool HasBoneRotation(HumanBodyBones bone) {
            if (BoneRotations == null || BoneRotations.Length == 0) return false;

            var idx = (int)bone;
            if (idx < 0 || idx >= BoneRotations.Length) return false;

            var r = BoneRotations[idx];
            return r != Quaternion.identity;
        }
    }
}
