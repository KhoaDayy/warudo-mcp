import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { InputError, result } from "../results.js";
import { applyBoneOffsets, boneEntrySchema, HUMAN_BONES, readCharacterOffsets, type BoneEntry } from "./bones.js";
import { registerTool, type Dependencies } from "./shared.js";
import { captureViewport } from "./vision.js";

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_POSE_FILE_BYTES = 64 * 1024;

const nameSchema = z.string().min(1).max(64).describe("Pose name: letters, digits, '-' and '_' (for example 'wave' or 'sitting-cute').");

const poseFileSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  description: z.string().max(500).optional(),
  savedAt: z.string(),
  offsets: z.array(z.object({
    bone: z.string(),
    rotation: z.tuple([z.number(), z.number(), z.number()]),
    enabled: z.boolean(),
    applyWhileTracked: z.boolean(),
  }).strict()).max(HUMAN_BONES.length),
}).strict();

type PoseFile = z.infer<typeof poseFileSchema>;

/** Poses live in ~/.warudo-mcp/poses (override with WARUDO_MCP_POSES_DIR). */
export function posesDir(): string {
  return process.env.WARUDO_MCP_POSES_DIR?.trim() || join(homedir(), ".warudo-mcp", "poses");
}

function poseName(raw: string): string {
  const name = raw.trim();
  if (!NAME.test(name) || RESERVED.test(name)) {
    throw new InputError("Invalid pose name. Use 1-64 letters, digits, '-' or '_', starting with a letter or digit.");
  }
  return name.toLowerCase();
}

const poseFile = (name: string) => join(posesDir(), name + ".json");

async function loadPose(rawName: string): Promise<PoseFile> {
  const name = poseName(rawName);
  let text: string;
  try {
    text = await readFile(poseFile(name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new InputError(`No pose named "${name}". Call warudo_list_poses.`);
    throw error;
  }
  if (Buffer.byteLength(text) > MAX_POSE_FILE_BYTES) throw new InputError(`Pose "${name}" is too large to load.`);
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new InputError(`Pose file "${name}" is not valid JSON.`); }
  const parsed = poseFileSchema.safeParse(json);
  if (!parsed.success) throw new InputError(`Pose file "${name}" is not a valid pose.`);
  return parsed.data;
}

const toEntries = (pose: PoseFile): BoneEntry[] => pose.offsets.map((o) => ({ bone: o.bone, rotation: o.rotation, enabled: o.enabled, applyWhileTracked: o.applyWhileTracked }));

export function registerPoseTools(server: McpServer, deps: Dependencies): void {
  const { api, bridge } = deps;
  const characterSchema = z.string().min(1).optional().describe("Character asset ID or name. Optional when the scene has exactly one character.");

  registerTool(server, "warudo_save_pose", "Save the character's current bone offsets as a named pose in the local pose library, so it can be re-applied later for photos. Poses are stored as small JSON files under ~/.warudo-mcp/poses (override with WARUDO_MCP_POSES_DIR). Refuses to overwrite unless overwrite is true.", {
    name: nameSchema,
    description: z.string().max(500).optional(),
    character: characterSchema,
    overwrite: z.boolean().default(false),
  }, false, async ({ name, description, character, overwrite }) => {
    const key = poseName(name);
    const { character: id, offsets } = await readCharacterOffsets({ api, bridge }, character);
    if (offsets.length === 0) throw new InputError("The character has no bone offsets to save. Pose it with warudo_set_bone_offsets first.");
    const pose: PoseFile = {
      version: 1, name: key, description, savedAt: new Date().toISOString(),
      offsets: offsets.map((o) => ({ bone: o.bone, rotation: [o.rotation.x, o.rotation.y, o.rotation.z], enabled: o.enabled, applyWhileTracked: o.applyWhileTracked })),
    };
    const dir = posesDir();
    await mkdir(dir, { recursive: true });
    const target = poseFile(key);
    if (!overwrite) {
      try { await readFile(target); throw new InputError(`Pose "${key}" already exists. Pass overwrite: true to replace it.`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const temp = target + "." + process.pid + ".tmp";
    await writeFile(temp, JSON.stringify(pose, null, 2), "utf8");
    await rename(temp, target);
    return result({ saved: key, character: id, bones: pose.offsets.length, directory: dir });
  });

  registerTool(server, "warudo_list_poses", "List poses saved in the local pose library.", {}, true, async () => {
    let files: string[] = [];
    try { files = (await readdir(posesDir())).filter((f) => f.endsWith(".json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const poses: Array<{ name: string; description?: string; bones: number; savedAt: string }> = [];
    const skipped: string[] = [];
    for (const file of files.sort()) {
      try {
        const pose = await loadPose(file.slice(0, -5));
        poses.push({ name: pose.name, description: pose.description, bones: pose.offsets.length, savedAt: pose.savedAt });
      } catch { skipped.push(file); }
    }
    return result({ count: poses.length, poses, ...(skipped.length ? { skipped } : {}) });
  });

  registerTool(server, "warudo_apply_pose", "Apply a saved pose to the character. mode 'replace' (default) makes the character hold exactly this pose; 'merge' layers it over existing offsets.", {
    name: nameSchema,
    character: characterSchema,
    mode: z.enum(["replace", "merge"]).default("replace"),
  }, false, async ({ name, character, mode }) => {
    const pose = await loadPose(name);
    return result({ pose: pose.name, ...(await applyBoneOffsets({ api, bridge }, character, toEntries(pose), mode)) });
  });

  registerTool(server, "warudo_delete_pose", "Delete a saved pose from the local pose library.", { name: nameSchema }, false, async ({ name }) => {
    const key = poseName(name);
    try { await rm(poseFile(key)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new InputError(`No pose named "${key}".`);
      throw error;
    }
    return result({ deleted: key });
  });

  registerTool(server, "warudo_pose_and_capture", "Pose the character and take a photo in one call: apply a saved pose (pose) or inline bone offsets (offsets), wait briefly for it to settle, then return a screenshot from the active camera. Use it to iterate on a pose: adjust the offsets, shoot, look, repeat; then warudo_save_pose to keep it.", {
    pose: nameSchema.optional().describe("Saved pose to apply."),
    offsets: z.array(boneEntrySchema).min(1).max(HUMAN_BONES.length).optional().describe("Inline bone offsets, same format as warudo_set_bone_offsets."),
    mode: z.enum(["replace", "merge"]).default("replace"),
    character: characterSchema,
    settleMs: z.number().int().min(0).max(2000).default(300).describe("Wait after posing before the capture (default 300 ms)."),
    width: z.number().int().min(64).max(3840).default(960),
    height: z.number().int().min(64).max(2160).default(540),
    quality: z.number().int().min(1).max(100).default(80),
  }, false, async ({ pose, offsets, mode, character, settleMs, width, height, quality }): Promise<CallToolResult> => {
    if ((pose === undefined) === (offsets === undefined)) throw new InputError("Give exactly one of pose or offsets.");
    const entries = pose !== undefined ? toEntries(await loadPose(pose)) : offsets!;
    const applied = await applyBoneOffsets({ api, bridge }, character, entries, mode);
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const content = await captureViewport(bridge, { width, height, quality });
    return { content: [...content, { type: "text" as const, text: JSON.stringify({ pose: pose ?? null, character: applied.character, mode, bones: applied.count }) }] };
  });
}
