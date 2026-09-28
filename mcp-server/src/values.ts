import { InputError } from "./results.js";

export type ColorValue = [number, number, number, number];

function finiteNumber(raw: string, label: string): number {
  if (raw.trim() === "") throw new InputError(`${label} không được để trống.`);
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) throw new InputError(`${label} phải là số hữu hạn.`);
  return value;
}

function ensureRange(values: number[], min = 0, max = 1): void {
  if (values.some((value) => value < min || value > max)) {
    throw new InputError(`Giá trị màu phải nằm trong khoảng ${min}..${max}.`);
  }
}

export function parseColor(raw: string): ColorValue {
  const input = raw.trim();
  if (input.startsWith("#")) {
    const hex = input.slice(1);
    if (!/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) {
      throw new InputError(`Màu không hợp lệ: "${raw}" (dùng dạng #rrggbb hoặc #rrggbbaa).`);
    }
    const full = hex.length === 6 ? `${hex}ff` : hex;
    return [0, 2, 4, 6].map((offset) => parseInt(full.slice(offset, offset + 2), 16) / 255) as ColorValue;
  }

  const parts = input.split(",").map((part) => finiteNumber(part, "Màu"));
  if (parts.length !== 3 && parts.length !== 4) {
    throw new InputError(`Màu không hợp lệ: "${raw}" (dùng "r,g,b" hoặc "r,g,b,a").`);
  }
  const scale = parts.some((value) => value > 1) ? 255 : 1;
  const normalized = parts.map((value) => value / scale);
  ensureRange(normalized);
  return [normalized[0], normalized[1], normalized[2], normalized[3] ?? 1];
}

export interface ParsedValue {
  type: "float" | "int" | "bool" | "keyword" | "color" | "string" | "enum" | "vector3" | "json";
  value: unknown;
}

/** Parse the backwards-compatible typed value syntax used by Warudo tools. */
export function parseValue(raw: string): ParsedValue {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new InputError("Giá trị phải là chuỗi có tiền tố kiểu, ví dụ float:0.5.");
  }
  const index = raw.indexOf(":");
  if (index < 1) throw new InputError("Thiếu tiền tố kiểu. Dùng float:, int:, bool:, color:, string:, enum:, vector3: hoặc json:.");
  const kind = raw.slice(0, index).trim().toLowerCase() as ParsedValue["type"];
  const rest = raw.slice(index + 1).trim();

  switch (kind) {
    case "float": {
      return { type: kind, value: finiteNumber(rest, "float") };
    }
    case "int": {
      const value = finiteNumber(rest, "int");
      if (!Number.isSafeInteger(value)) throw new InputError("int phải là số nguyên.");
      return { type: kind, value };
    }
    case "bool":
    case "keyword": {
      const normalized = rest.toLowerCase();
      if (normalized !== "true" && normalized !== "false" && normalized !== "1" && normalized !== "0") {
        throw new InputError(`${kind} chỉ nhận true, false, 1 hoặc 0.`);
      }
      return { type: kind, value: normalized === "true" || normalized === "1" };
    }
    case "color":
      return { type: kind, value: parseColor(rest) };
    case "string":
    case "enum":
      return { type: kind, value: rest };
    case "vector3": {
      const parts = rest.split(",").map((part) => finiteNumber(part, "vector3"));
      if (parts.length !== 3) throw new InputError(`vector3 không hợp lệ: "${rest}" (dùng "x,y,z").`);
      return { type: kind, value: parts };
    }
    case "json": {
      try {
        return { type: kind, value: JSON.parse(rest) };
      } catch (error) {
        throw new InputError(`json không hợp lệ: ${(error as Error).message}`);
      }
    }
    default:
      throw new InputError(`Kiểu giá trị không hỗ trợ: "${kind}".`);
  }
}

/** Native data ports deserialize JSON text; the bridge uses typed arrays instead. */
export function serializeNativeValue(parsed: ParsedValue): string {
  if (parsed.type === "enum") throw new InputError("Native enums require the runtime enum name and numeric value. Use json:{\"name\":\"...\",\"value\":0} from runtime metadata, or use the blueprint node setter with enum:Name.");
  if (parsed.type === "keyword") throw new InputError("keyword: is only supported by the material property tool. Use bool: for a data input.");
  if (parsed.type === "vector3") {
    const [x, y, z] = parsed.value as number[];
    return JSON.stringify({ x, y, z });
  }
  if (parsed.type === "color") {
    const [r, g, b, a] = parsed.value as number[];
    return JSON.stringify({ r, g, b, a });
  }
  return JSON.stringify(parsed.value);
}
