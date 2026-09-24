using System;
using System.Collections.Generic;
using UnityEngine;
using Warudo.Core.Attributes;
using Warudo.Core.Graphs;

namespace Warudo.Plugins.McpBridge
{
    [NodeType(Id = "a2f5c8e9-2c4c-4d8b-9c1f-5f99aab2e201", Title = "Eku Hash Face Tracking", Category = "CHARACTERS")]
    public sealed class EkuHashFaceTrackingNode : Node
    {
        [DataInput] public Dictionary<string, float> BlendShapes;
        [DataInput] public bool Enabled = true;
        [DataInput] public bool EnableHashCorrectives = true;
        [DataInput] public float CorrectiveIntensity = 0f;
        [DataInput] public float OSCmSmoothingTime = 0.12f;

        private readonly Dictionary<string, float> output = new(StringComparer.Ordinal);
        private readonly Dictionary<string, float> smoothed = new(StringComparer.Ordinal);

        public override void OnUpdate()
        {
            if (!Enabled || BlendShapes == null) return;
            var alpha = 1f - Mathf.Exp(-Time.deltaTime / Mathf.Max(0.001f, OSCmSmoothingTime));
            foreach (var key in ParameterKeys)
            {
                var target = ComputeParameter(key);
                smoothed[key] = Mathf.Lerp(smoothed.TryGetValue(key, out var current) ? current : target, target, alpha);
            }
        }

        private static readonly string[] ParameterKeys =
        {
            "EyeLeftX", "EyeRightX", "EyeY", "BrowExpressionLeft", "BrowExpressionRight",
            "EyeLidLeft", "EyeLidRight", "EyeSquintLeft", "EyeSquintRight", "JawOpen", "MouthClosed",
            "MouthUpperUpLeft", "MouthUpperUpRight", "MouthLowerDown", "SmileFrownLeft", "SmileFrownRight",
            "CheekPuffSuckLeft", "CheekPuffSuckRight", "LipFunnel", "LipPucker", "MouthX", "NoseSneer",
            "MouthStretchLeft", "MouthStretchRight", "MouthTightenerLeft", "MouthTightenerRight",
            "LipSuckUpper", "LipSuckLower", "JawForward", "JawX", "TongueOut", "TongueX", "TongueY",
            "PupilDilation", "MouthRaiserLower", "MouthRaiserUpper", "MouthPress"
        };

        [DataOutput]
        public Dictionary<string, float> OutputBlendShapes()
        {
            output.Clear();
            if (!Enabled || BlendShapes == null) return output;

            Map("jawOpen", "JawOpen");
            Map("jawLeft", "JawLeft");
            Map("jawRight", "JawRight");
            Map("mouthSmileLeft", "MouthSmileLeft");
            Map("mouthSmileRight", "MouthSmileRight");
            Map("mouthUpperUpLeft", "MouthUpperUpLeft");
            Map("mouthUpperUpRight", "MouthUpperUpRight");
            Map("mouthLowerDownLeft", "MouthLowerDownLeft");
            Map("mouthLowerDownRight", "MouthLowerDownRight");
            Map("mouthClose", "MouthClosed");
            Map("mouthFunnel", "LipFunnel");
            Map("mouthPucker", "LipPucker");
            Map("mouthStretchLeft", "MouthStretchLeft");
            Map("mouthStretchRight", "MouthStretchRight");
            Map("mouthTightenLeft", "MouthTightenerLeft");
            Map("mouthTightenRight", "MouthTightenerRight");
            Map("mouthFrownLeft", "MouthFrownLeft");
            Map("mouthFrownRight", "MouthFrownRight");
            Map("cheekPuff", "CheekPuff");
            Map("cheekSquintLeft", "CheekSquintLeft");
            Map("cheekSquintRight", "CheekSquintRight");
            Map("eyeBlinkLeft", "EyeClosedLeft");
            Map("eyeBlinkRight", "EyeClosedRight");
            Map("eyeSquintLeft", "EyeSquintLeft");
            Map("eyeSquintRight", "EyeSquintRight");
            Map("eyeWideLeft", "EyeWideLeft");
            Map("eyeWideRight", "EyeWideRight");
            Map("browInnerUp", "BrowInnerUp");
            Map("browOuterUpLeft", "BrowOuterUpLeft");
            Map("browOuterUpRight", "BrowOuterUpRight");
            Map("browDownLeft", "BrowDownLeft");
            Map("browDownRight", "BrowDownRight");
            Map("noseSneerLeft", "NoseSneer");
            Map("tongueOut", "TongueOut");

            var smile = Average("mouthSmileLeft", "mouthSmileRight");
            var jaw = Get("jawOpen");
            var upperLeft = Get("mouthUpperUpLeft");
            var upperRight = Get("mouthUpperUpRight");
            var frownLeft = Get("mouthFrownLeft");
            var frownRight = Get("mouthFrownRight");
            var cheekLeft = Get("cheekSquintLeft");
            var cheekRight = Get("cheekSquintRight");
            var intensity = Mathf.Clamp01(CorrectiveIntensity);

            if (EnableHashCorrectives)
            {
                Put("MouthSmile", smile);
                // JawOpen is already the primary Eku jaw deformation. Do not
                // also drive MouthOpen from the same jawOpen input, otherwise
                // the mouth opens twice and looks permanently agape.
                Put("MouthSmileJawOpenTarget", Mathf.Min(smile, jaw) * intensity);
                Put("MouthSmileJawOpenTargetLeft", Mathf.Min(Get("mouthSmileLeft"), jaw) * intensity);
                Put("MouthSmileJawOpenTargetRight", Mathf.Min(Get("mouthSmileRight"), jaw) * intensity);
                Put("MouthUpperUpJawOpen", Mathf.Min(Average(upperLeft, upperRight), jaw) * intensity);
                Put("MouthUpperUpJawOpenLeft", Mathf.Min(upperLeft, jaw) * intensity);
                Put("MouthUpperUpJawOpenRight", Mathf.Min(upperRight, jaw) * intensity);
                Put("MouthSmileLowerDown alt", Mathf.Min(smile, Average(Get("mouthLowerDownLeft"), Get("mouthLowerDownRight"))) * intensity);
                Put("MouthRaiser", Average(upperLeft, upperRight) * intensity);
                Put("MouthRaiserUpper", Average(upperLeft, upperRight) * intensity);
                Put("MouthFrown", Average(frownLeft, frownRight) * intensity);
                Put("FTEffectsCringe", Mathf.Max(cheekLeft, cheekRight) * intensity);
                Put("FTEffectsSadContinuous", Mathf.Max(Average(Get("browDownLeft"), Get("browDownRight")), Average(frownLeft, frownRight)) * intensity);
                Put("FTEffectsSadContinuousLeft", Mathf.Max(Get("browDownLeft"), frownLeft) * intensity);
                Put("FTEffectsSadContinuousRight", Mathf.Max(Get("browDownRight"), frownRight) * intensity);
                Put("FTEffectsSad", Mathf.Max(Average(Get("browDownLeft"), Get("browDownRight")), Average(frownLeft, frownRight)) * intensity);
            }

            return output;
        }

        [DataOutput]
        public Dictionary<string, float> FTv2Parameters()
        {
            var result = new Dictionary<string, float>(StringComparer.Ordinal);
            foreach (var key in ParameterKeys) result["FT/v2/" + key] = ComputeParameter(key);
            return result;
        }

        [DataOutput]
        public Dictionary<string, float> OSCmParameters()
        {
            var result = new Dictionary<string, float>(StringComparer.Ordinal);
            foreach (var key in ParameterKeys) result["OSCm/FT/v2/" + key] = smoothed.TryGetValue(key, out var value) ? value : ComputeParameter(key);
            return result;
        }

        private float ComputeParameter(string key)
        {
            switch (key)
            {
                case "JawOpen": return Get("jawOpen");
                case "MouthClosed": return Get("mouthClose");
                case "MouthUpperUpLeft": return Get("mouthUpperUpLeft");
                case "MouthUpperUpRight": return Get("mouthUpperUpRight");
                case "MouthLowerDown": return Average("mouthLowerDownLeft", "mouthLowerDownRight");
                case "SmileFrownLeft": return Mathf.Clamp01(Get("mouthSmileLeft") - Get("mouthFrownLeft"));
                case "SmileFrownRight": return Mathf.Clamp01(Get("mouthSmileRight") - Get("mouthFrownRight"));
                case "CheekPuffSuckLeft": return Get("cheekPuff");
                case "CheekPuffSuckRight": return Get("cheekPuff");
                case "LipFunnel": return Get("mouthFunnel");
                case "LipPucker": return Get("mouthPucker");
                case "MouthStretchLeft": return Get("mouthStretchLeft");
                case "MouthStretchRight": return Get("mouthStretchRight");
                case "MouthTightenerLeft": return Get("mouthTightenLeft");
                case "MouthTightenerRight": return Get("mouthTightenRight");
                case "TongueOut": return Get("tongueOut");
                case "EyeLidLeft": return Get("eyeBlinkLeft");
                case "EyeLidRight": return Get("eyeBlinkRight");
                case "EyeSquintLeft": return Get("eyeSquintLeft");
                case "EyeSquintRight": return Get("eyeSquintRight");
                case "BrowExpressionLeft": return Mathf.Clamp01(Get("browInnerUp") + Get("browOuterUpLeft") - Get("browDownLeft"));
                case "BrowExpressionRight": return Mathf.Clamp01(Get("browInnerUp") + Get("browOuterUpRight") - Get("browDownRight"));
                case "PupilDilation": return Get("eyeWideLeft") + Get("eyeWideRight") > 0 ? Average("eyeWideLeft", "eyeWideRight") : 0.733f;
                default: return 0f;
            }
        }

        private void Map(string source, string target) => Put(target, Get(source));

        private float Get(string key) => BlendShapes != null && BlendShapes.TryGetValue(key, out var value) ? Mathf.Clamp01(value) : 0f;

        private float Average(string left, string right) => (Get(left) + Get(right)) * .5f;

        private static float Average(float left, float right) => (left + right) * .5f;

        private void Put(string key, float value) => output[key] = Mathf.Clamp01(value);
    }
}
