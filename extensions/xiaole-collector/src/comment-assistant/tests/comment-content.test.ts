import { describe, expect, it } from "vitest";
import { hasCommentText } from "../src/utils/comment-content";
import { exportCommentsCsv } from "../src/utils/export-csv";
import { makeComment } from "./fixtures";

describe("跳过表情，保留文字信息", () => {
  it.each(["", " \n\u200b", "😂😂👍🏽", "👨‍👩‍👧‍👦🇨🇳", "1️⃣2️⃣", "！！！……", "[捂脸][笑哭]", "【图片】", "[表情包] [GIF]", "[doge] [赞]", "[强][比心]", "[发呆]😂"])("过滤非文字评论 %j", text => {
    expect(hasCommentText(text)).toBe(false);
  });
  it.each(["这个怎么做😂", "[捂脸]求教程", "[多少钱]", "图片怎么上传？", "有", "不行", "15", "3.5万元", "[赞]预算200够吗", "=1+1", "ありがとう", "Can you share the link?", "明天见👋"])("保留原文字 %j", text => {
    expect(hasCommentText(text)).toBe(true);
  });
  it("识别接口明确标注的自定义表情，但保留同一行的文字", () => {
    expect(hasCommentText("[作者专属_开心]", ["[作者专属_开心]"])).toBe(false);
    expect(hasCommentText("为什么[作者专属_开心]", ["[作者专属_开心]"])).toBe(true);
  });
  it("旧数据导出也过滤，排名连续且保留混合文字原文", () => {
    const csv = exportCommentsCsv([makeComment({ text: "[图片]" }), makeComment({ text: "怎么做😂" }), makeComment({ text: "👍" }), makeComment({ text: "预算100" })]);
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).toContain('"1","怎么做😂"');
    expect(csv).toContain('"2","预算100"');
    expect(csv).not.toContain("[图片]");
  });
});
