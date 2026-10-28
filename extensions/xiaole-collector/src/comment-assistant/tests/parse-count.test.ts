import { describe, expect, it } from "vitest";
import { parseCount, parseCountDetailed } from "../src/utils/parse-count";

describe("parseCount", () => {
  it.each([
    ["", 0],
    ["赞", 0],
    ["0", 0],
    ["1", 1],
    ["999", 999],
    ["999+", 999],
    ["1.2万", 12_000],
    ["1.2 万", 12_000],
    ["3万+", 30_000],
    ["10.5万", 105_000],
    ["1亿", 100_000_000],
    ["1.3亿", 130_000_000],
    ["1.2w", 12_000],
    ["1.2W", 12_000],
    [" 1,234 ", 1234],
    ["展开 3 条回复", 3],
    ["共 12 条回复", 12],
    ["查看 5 条回复", 5],
    ["还有 8 条回复", 8],
    ["23 条回复", 23]
  ])("解析%s", (input, expected) => {
    expect(parseCount(input)).toBe(expected);
  });

  it("异常内容返回0并保留原文", () => {
    expect(parseCountDetailed("无法识别")).toEqual({
      value: 0,
      raw: "无法识别",
      parsed: false
    });
  });
});
