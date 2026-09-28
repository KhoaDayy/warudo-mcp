import assert from "node:assert/strict";
import { test } from "node:test";
import { parseColor, parseValue, serializeNativeValue } from "../src/values.js";
import { errorResult } from "../src/results.js";

test("typed values preserve supported primitive and structured values", () => {
  assert.deepEqual(parseValue("int:-3"), { type: "int", value: -3 });
  assert.deepEqual(parseValue("float:1.25"), { type: "float", value: 1.25 });
  assert.deepEqual(parseValue("bool:0"), { type: "bool", value: false });
  assert.deepEqual(parseValue("keyword:TRUE"), { type: "keyword", value: true });
  assert.deepEqual(parseValue("string:hello: world"), { type: "string", value: "hello: world" });
  assert.deepEqual(parseValue("vector3:1, -2, 3"), { type: "vector3", value: [1, -2, 3] });
  assert.deepEqual(parseValue('json:{"enabled":true}'), { type: "json", value: { enabled: true } });
});

test("invalid numeric, boolean, vector and JSON values fail before dispatch", () => {
  for (const input of ["float:", "float:NaN", "float:Infinity", "int:2.4", "int:9007199254740993", "bool:yes", "bool:", "keyword:no", "vector3:1,2", "vector3:1,2,3,4", "vector3:1,,3", "vector3:1,Infinity,3", "json:{", "color:1,2", "color:1,2,3,4,5", "color:-1,0,0", "color:256,0,0", "float", "", "text:hello"]) {
    assert.throws(() => parseValue(input), { code: "INVALID_INPUT", execution: "NOT_EXECUTED" }, input);
  }
});

test("colors have explicit alpha and a uniform scale", () => {
  assert.deepEqual(parseColor("#ff0000"), [1, 0, 0, 1]);
  assert.deepEqual(parseColor("#ff000080"), [1, 0, 0, 128 / 255]);
  assert.deepEqual(parseColor("255,0,0,128"), [1, 0, 0, 128 / 255]);
  assert.deepEqual(parseColor("0.2,0.5,1,0.8"), [0.2, 0.5, 1, 0.8]);
});

test("transport error execution metadata survives MCP error formatting", () => {
  const error = Object.assign(new Error("Timed out after send."), { code: "TIMEOUT", execution: "UNKNOWN" });
  const formatted = errorResult(error);
  assert.equal(formatted.isError, true);
  assert.deepEqual(JSON.parse((formatted.content[0] as { text: string }).text), { error: { code: "TIMEOUT", message: error.message, execution: "UNKNOWN" } });
});

test("native serializes Unity values as objects while bridge payloads remain typed arrays", () => {
  const vector = parseValue("vector3:1,2,3");
  assert.deepEqual(vector, { type: "vector3", value: [1, 2, 3] });
  assert.equal(serializeNativeValue(vector), '{"x":1,"y":2,"z":3}');
  assert.equal(serializeNativeValue(parseValue("color:#ff0000")), '{"r":1,"g":0,"b":0,"a":1}');
  assert.throws(() => serializeNativeValue(parseValue("enum:Idle")), { code: "INVALID_INPUT", execution: "NOT_EXECUTED" });
  assert.throws(() => serializeNativeValue(parseValue("keyword:true")), { code: "INVALID_INPUT", execution: "NOT_EXECUTED" });
});
