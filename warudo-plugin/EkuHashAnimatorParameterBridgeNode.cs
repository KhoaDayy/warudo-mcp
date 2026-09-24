using System;
using System.Collections.Generic;
using UnityEngine;
using Warudo.Core.Attributes;
using Warudo.Core.Graphs;
using Warudo.Plugins.Core.Assets.Character;

namespace Warudo.Plugins.McpBridge
{
    [NodeType(Id = "c74e4c6b-7edb-43c7-9a5d-7e0e7ec6d8b2", Title = "Eku Hash Animator Parameters", Category = "CHARACTERS")]
    public sealed class EkuHashAnimatorParameterBridgeNode : Node
    {
        [DataInput] public CharacterAsset Character;
        [DataInput] public Dictionary<string, float> FTv2Parameters;
        [DataInput] public Dictionary<string, float> OSCmParameters;
        [DataInput] public bool Enabled = true;

        private Animator animator;
        private readonly HashSet<string> available = new(StringComparer.Ordinal);

        public override void OnUpdate()
        {
            if (!Enabled || Character?.GameObject == null) return;
            if (animator == null || animator.gameObject != Character.GameObject)
            {
                animator = Character.GameObject.GetComponent<Animator>();
                available.Clear();
                if (animator != null && animator.runtimeAnimatorController != null)
                    foreach (var p in animator.parameters) available.Add(p.name);
            }
            if (animator == null || animator.runtimeAnimatorController == null) return;
            Apply(FTv2Parameters);
            Apply(OSCmParameters);
        }

        private void Apply(Dictionary<string, float> values)
        {
            if (values == null) return;
            foreach (var pair in values)
                if (available.Contains(pair.Key)) animator.SetFloat(pair.Key, pair.Value);
        }
    }
}
