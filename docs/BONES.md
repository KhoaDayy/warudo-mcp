# Posing characters with bone offsets

Warudo 0.15.2 added per-entry toggles to a character's **Additional Bone Offsets**. The MCP server exposes them so an AI client can pose a character and build animation frames.

| Tool | Purpose |
|---|---|
| `warudo_list_bones` | The 55 humanoid bones (Unity `HumanBodyBones`) with ids and body-part groups. Static; does not contact Warudo. |
| `warudo_get_bone_offsets` | Current offsets: bone, `enabled`, rotation, `applyWhileTracked`. |
| `warudo_set_bone_offsets` | Set offsets in one call. `mode: "merge"` (default) updates only the listed bones; `"replace"` makes the list exactly what you pass. Returns the stored result. |
| `warudo_clear_bone_offsets` | Remove all offsets, or only the listed bones. |

## How an offset behaves

* It is an **additive rotation in degrees** `[x, y, z]` (each -360..360) on top of whatever animation or motion capture is running. `[0, 0, 0]` means no change.
* One entry per bone. Bones can be given by name in any casing (`RightUpperArm`, `right upper arm`) or by id.
* `enabled: false` keeps the stored rotation but stops applying it, so a pose can be toggled per bone without losing values.
* `applyWhileTracked` keeps the offset active while motion capture drives that bone.
* `character` accepts an asset ID or name and may be omitted when the scene has exactly one character.
* Only rotation is exposed by Warudo here; there is no position offset.
* Requires Warudo 0.15.2 or newer (the port does not exist before that). On older versions the tools return `UNSUPPORTED`.

## Example

```json
{ "name": "warudo_set_bone_offsets", "arguments": { "offsets": [
  { "bone": "RightUpperArm", "rotation": [0, 0, 70] },
  { "bone": "RightLowerArm", "rotation": [0, -50, 0] },
  { "bone": "Head", "rotation": [0, 0, 12] }
] } }
```

Then call `warudo_capture_viewport` (when available) to look at the result and adjust. Undo with `warudo_clear_bone_offsets`.

## Animation

Each call updates the pose once. Calls take roughly 25 ms and are not frame-accurate, so a client can step through keyframes for previews but cannot get smooth real-time playback this way. Smooth playback needs a keyframe player inside the bridge plugin, which is not part of these tools.
