import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InputError, result, RuntimeError } from "../results.js";
import { apiCall, asRecord, bridgeCall, registerTool, type Dependencies } from "./shared.js";

/** Unity HumanBodyBones, indexed by enum value. LastBone (55) is not a bone. */
export const HUMAN_BONES = [
  "Hips", "LeftUpperLeg", "RightUpperLeg", "LeftLowerLeg", "RightLowerLeg", "LeftFoot", "RightFoot",
  "Spine", "Chest", "Neck", "Head", "LeftShoulder", "RightShoulder", "LeftUpperArm", "RightUpperArm",
  "LeftLowerArm", "RightLowerArm", "LeftHand", "RightHand", "LeftToes", "RightToes", "LeftEye", "RightEye", "Jaw",
  "LeftThumbProximal", "LeftThumbIntermediate", "LeftThumbDistal",
  "LeftIndexProximal", "LeftIndexIntermediate", "LeftIndexDistal",
  "LeftMiddleProximal", "LeftMiddleIntermediate", "LeftMiddleDistal",
  "LeftRingProximal", "LeftRingIntermediate", "LeftRingDistal",
  "LeftLittleProximal", "LeftLittleIntermediate", "LeftLittleDistal",
  "RightThumbProximal", "RightThumbIntermediate", "RightThumbDistal",
  "RightIndexProximal", "RightIndexIntermediate", "RightIndexDistal",
  "RightMiddleProximal", "RightMiddleIntermediate", "RightMiddleDistal",
  "RightRingProximal", "RightRingIntermediate", "RightRingDistal",
  "RightLittleProximal", "RightLittleIntermediate", "RightLittleDistal",
  "UpperChest",
] as const;

const CHARACTER_TYPE_ID = "726ab674-a550-474e-8b92-66526a5ad55e";
const PORT = "AdditionalBoneOffsets";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_ROTATION = 360;

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const BONE_BY_NAME = new Map(HUMAN_BONES.map((name, id) => [normalize(name), id]));

function boneGroup(id: number): string {
  const name = HUMAN_BONES[id];
  if (/Thumb|Index|Middle|Ring|Little/.test(name)) return name.startsWith("Left") ? "left fingers" : "right fingers";
  if (/Leg|Foot|Toes/.test(name)) return name.startsWith("Left") ? "left leg" : "right leg";
  if (/Shoulder|Arm|Hand/.test(name)) return name.startsWith("Left") ? "left arm" : "right arm";
  if (/Eye|Jaw|Head|Neck/.test(name)) return "head";
  return "torso";
}

/** Accept a bone name in any casing or spacing ("RightUpperArm", "right upper arm") or its numeric id. */
export function resolveBone(input: string | number): number {
  if (typeof input === "number") {
    if (Number.isInteger(input) && input >= 0 && input < HUMAN_BONES.length) return input;
    throw new InputError(`Unknown bone id ${input}. Valid ids are 0..${HUMAN_BONES.length - 1}; call warudo_list_bones.`);
  }
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return resolveBone(Number(trimmed));
  const id = BONE_BY_NAME.get(normalize(trimmed));
  if (id === undefined) throw new InputError(`Unknown bone "${input}". Call warudo_list_bones for valid names.`);
  return id;
}

interface Offset { bone: string; boneId: number; enabled: boolean; rotation: { x: number; y: number; z: number }; applyWhileTracked: boolean }

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function readField(input: unknown): unknown {
  return parseJsonString(asRecord(input).value);
}

function toOffset(element: unknown): Offset | null {
  const inputs = asRecord(asRecord(element).dataInputs);
  const bone = asRecord(readField(inputs.Bone));
  const boneId = typeof bone.value === "number" ? bone.value : NaN;
  if (!Number.isInteger(boneId) || boneId < 0 || boneId >= HUMAN_BONES.length) return null;
  const rotation = asRecord(readField(inputs.RotationOffset));
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const flag = (field: unknown, fallback: boolean) => { const v = readField(field); return typeof v === "boolean" ? v : fallback; };
  return {
    bone: HUMAN_BONES[boneId], boneId,
    enabled: flag(inputs.Enabled, true),
    rotation: { x: num(rotation.x), y: num(rotation.y), z: num(rotation.z) },
    applyWhileTracked: flag(inputs.ApplyWhileTracked, true),
  };
}

/** Minimal serialized AdditionalBoneOffset; Warudo fills in labels and metadata. */
function toElement(offset: Offset, id: string): Record<string, unknown> {
  return {
    header: null, collapsed: false, id, version: 0, triggers: {},
    dataInputs: {
      Enabled: { value: String(offset.enabled) },
      Bone: { value: JSON.stringify({ value: offset.boneId }) },
      RotationOffset: { value: JSON.stringify(offset.rotation) },
      ApplyWhileTracked: { value: String(offset.applyWhileTracked) },
    },
  };
}

async function resolveCharacter(bridge: Dependencies["bridge"], key: string | undefined): Promise<string> {
  if (key && UUID.test(key)) return key;
  if (!bridge.isConnected()) {
    throw new InputError("Pass the character's asset ID (see warudo_list_assets); resolving by name needs the MCP Bridge plugin.");
  }
  const groups = await bridgeCall(bridge, "list_assets");
  const characters = (Array.isArray(groups) ? groups : [])
    .flatMap((group) => { const a = asRecord(group).assets; return Array.isArray(a) ? a.map(asRecord) : []; })
    .filter((asset) => asset.typeId === CHARACTER_TYPE_ID && typeof asset.id === "string");
  const wanted = key?.trim().toLowerCase();
  const matches = wanted ? characters.filter((asset) => String(asset.name ?? "").toLowerCase() === wanted) : characters;
  if (matches.length === 1) return matches[0].id as string;
  const options = characters.map((asset) => `${asset.name} (${asset.id})`).join(", ") || "none";
  throw new InputError(matches.length === 0
    ? `No character matches "${key ?? ""}". Characters: ${options}.`
    : `Several characters match; pass one ID or name. Characters: ${options}.`);
}

async function readOffsets(api: Dependencies["api"], id: string): Promise<{ offsets: Offset[]; elements: unknown[] }> {
  const raw = parseJsonString(await apiCall(api, "getEntityDataInputPortValue", { id, port: PORT }));
  if (!Array.isArray(raw)) throw new RuntimeError("Character has no AdditionalBoneOffsets port (requires Warudo 0.15.2 or newer).", "UNSUPPORTED");
  return { offsets: raw.map(toOffset).filter((o): o is Offset => o !== null), elements: raw };
}

async function writeOffsets(api: Dependencies["api"], id: string, elements: Array<Record<string, unknown>>): Promise<void> {
  await apiCall(api, "setEntityDataInputPortValue", { id, port: PORT, value: JSON.stringify(elements), broadcast: true });
}

const rotationSchema = z.tuple([z.number().min(-MAX_ROTATION).max(MAX_ROTATION), z.number().min(-MAX_ROTATION).max(MAX_ROTATION), z.number().min(-MAX_ROTATION).max(MAX_ROTATION)])
  .describe("Euler rotation offset in degrees [x, y, z], each between -360 and 360.");
const characterSchema = z.string().min(1).optional().describe("Character asset ID or name. Optional when the scene has exactly one character.");

export const boneEntrySchema = z.object({
  bone: z.union([z.string().min(1), z.number().int()]).describe("Bone name (for example RightUpperArm or 'right upper arm') or id from warudo_list_bones."),
  rotation: rotationSchema.optional().describe("Required for a bone that has no entry yet."),
  enabled: z.boolean().optional(),
  applyWhileTracked: z.boolean().optional().describe("Keep applying the offset while motion capture is tracking this bone."),
}).strict();

export type BoneEntry = z.infer<typeof boneEntrySchema>;
type BoneDeps = Pick<Dependencies, "api" | "bridge">;

export async function readCharacterOffsets({ api, bridge }: BoneDeps, character: string | undefined): Promise<{ character: string; offsets: Offset[] }> {
  const id = await resolveCharacter(bridge, character);
  return { character: id, offsets: (await readOffsets(api, id)).offsets };
}

/** Merge or replace the character's bone offsets and return what Warudo stored. */
export async function applyBoneOffsets({ api, bridge }: BoneDeps, character: string | undefined, entries: BoneEntry[], mode: "merge" | "replace") {
  const wanted = new Map<number, BoneEntry>();
  for (const entry of entries) {
    const boneId = resolveBone(entry.bone);
    if (wanted.has(boneId)) throw new InputError(`Bone ${HUMAN_BONES[boneId]} is listed twice.`);
    wanted.set(boneId, entry);
  }
  const id = await resolveCharacter(bridge, character);
  const current = mode === "merge" ? (await readOffsets(api, id)).offsets : [];
  const byBone = new Map(current.map((o) => [o.boneId, o]));
  for (const [boneId, entry] of wanted) {
    const existing = byBone.get(boneId);
    if (!existing && !entry.rotation) throw new InputError(`Bone ${HUMAN_BONES[boneId]} has no entry yet; give a rotation.`);
    const [x, y, z] = entry.rotation ?? [existing!.rotation.x, existing!.rotation.y, existing!.rotation.z];
    byBone.set(boneId, {
      bone: HUMAN_BONES[boneId], boneId,
      enabled: entry.enabled ?? existing?.enabled ?? true,
      rotation: { x, y, z },
      applyWhileTracked: entry.applyWhileTracked ?? existing?.applyWhileTracked ?? true,
    });
  }
  await writeOffsets(api, id, [...byBone.values()].map((offset) => toElement(offset, randomUUID())));
  const stored = (await readOffsets(api, id)).offsets;
  return { character: id, mode, count: stored.length, offsets: stored };
}

export function registerBoneTools(server: McpServer, { api, bridge }: Dependencies): void {
  registerTool(server, "warudo_list_bones", "List the humanoid bones that warudo_set_bone_offsets accepts (Unity HumanBodyBones), with ids and body-part groups. Static list; does not contact Warudo.", {
    group: z.enum(["torso", "head", "left arm", "right arm", "left leg", "right leg", "left fingers", "right fingers"]).optional(),
  }, true, async ({ group }) => {
    const bones = HUMAN_BONES.map((name, id) => ({ id, name, group: boneGroup(id) })).filter((b) => !group || b.group === group);
    return result({ count: bones.length, bones });
  });

  registerTool(server, "warudo_get_bone_offsets", "Read the character's Additional Bone Offsets: per-bone rotation offsets layered on top of the current animation, each with its own enabled toggle. Requires Warudo 0.15.2 or newer.", {
    character: characterSchema,
  }, true, async ({ character }) => {
    const { character: id, offsets } = await readCharacterOffsets({ api, bridge }, character);
    return result({ character: id, count: offsets.length, offsets });
  });

  registerTool(server, "warudo_set_bone_offsets", "Set per-bone rotation offsets on a character to build poses and animation frames. Offsets add to the running animation, so 0,0,0 means no change. Use mode 'merge' (default) to update only the listed bones, or 'replace' to make the list exactly this. At most one entry per bone. Returns the offsets as stored. Reversible with warudo_clear_bone_offsets. Combine with warudo_capture_viewport to check the result.", {
    character: characterSchema,
    offsets: z.array(boneEntrySchema).min(1).max(HUMAN_BONES.length),
    mode: z.enum(["merge", "replace"]).default("merge"),
  }, false, async ({ character, offsets, mode }) => result(await applyBoneOffsets({ api, bridge }, character, offsets, mode)));

  registerTool(server, "warudo_clear_bone_offsets", "Remove bone offsets from a character, returning those bones to the running animation. Without 'bones' every offset is removed.", {
    character: characterSchema,
    bones: z.array(z.union([z.string().min(1), z.number().int()])).min(1).max(HUMAN_BONES.length).optional(),
  }, false, async ({ character, bones }) => {
    const ids = bones ? new Set(bones.map(resolveBone)) : null;
    const id = await resolveCharacter(bridge, character);
    const { offsets } = await readOffsets(api, id);
    const keep = ids ? offsets.filter((o) => !ids.has(o.boneId)) : [];
    await writeOffsets(api, id, keep.map((offset) => toElement(offset, randomUUID())));
    const stored = (await readOffsets(api, id)).offsets;
    return result({ character: id, removed: offsets.length - keep.length, count: stored.length, offsets: stored });
  });
}
