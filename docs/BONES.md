# Posing characters and taking photos

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

## Photo poses

Keep good poses in a small local library and re-apply them whenever you want to shoot.

| Tool | Purpose |
|---|---|
| `warudo_pose_and_capture` | Pose and photograph in one call. Give a saved `pose` or inline `offsets`; it waits `settleMs` (default 300 ms) and returns a screenshot from the active camera plus a short summary. Use it to iterate: adjust, shoot, look, repeat. |
| `warudo_save_pose` | Save the character's current bone offsets under a name (refuses to overwrite unless `overwrite: true`). |
| `warudo_apply_pose` | Apply a saved pose. `replace` (default) holds exactly that pose; `merge` layers it over the current offsets. |
| `warudo_list_poses` / `warudo_delete_pose` | Browse and remove saved poses. |

Poses are plain JSON files in `~/.warudo-mcp/poses` (set `WARUDO_MCP_POSES_DIR` to move them), one per pose, using bone names so they stay readable and portable between characters. Names are limited to letters, digits, `-` and `_`. Corrupt files are skipped by `warudo_list_poses` and never overwritten.

Typical session: ask for a pose, let `warudo_pose_and_capture` show it, nudge the offsets until it looks right, then `warudo_save_pose` with a name. Later `warudo_pose_and_capture` with `pose: "<name>"` re-creates it. Screenshots come from the active scene camera, so frame the shot in Warudo first. `warudo_capture_viewport` and `warudo_pose_and_capture` need the updated bridge plugin.

Starting values on the test character: arms raised to the side was `RightUpperArm` `[0, 0, 70]` and `LeftUpperArm` `[0, 0, -70]`; a wave was `RightUpperArm` `[0, 0, 140]` with `RightLowerArm` `[0, 0, -40]`. Axes follow each rig's bone orientation, so check the first photo and adjust.

## Animation

Each call updates the pose once. Calls take roughly 25 ms and are not frame-accurate, so a client can step through keyframes for previews but cannot get smooth real-time playback this way. Smooth playback needs a keyframe player inside the bridge plugin, which is not part of these tools.
