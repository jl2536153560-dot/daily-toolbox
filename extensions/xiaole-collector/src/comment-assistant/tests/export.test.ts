import { describe, expect, it } from "vitest";
import { exportCommentsCsv } from "../src/utils/export-csv";
import { makeComment } from "./fixtures";

describe("评论CSV导出", () => {
  it("支持中文、引号、换行和排名", () => {
    const csv = exportCommentsCsv([
      makeComment({ text: '中文"评论\n第二行' })
    ]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"排名","评论内容","作者"');
    expect(csv).toContain('中文""评论\n第二行');
    expect(csv).toContain('"1"');
  });

  it("防止表格公式注入", () => {
    expect(exportCommentsCsv([makeComment({ text: "=1+1" })])).toContain(
      "'=1+1"
    );
  });
  it("同样防止带前导空白或控制字符的公式注入", () => {
    for (const text of ["  =1+1", "\t@SUM(1)", "\n+2", "\uFEFF-1+1"]) {
      expect(exportCommentsCsv([makeComment({ text })])).toContain(`'${text}`);
    }
  });
  it("缺失的互动数字留空，明确读取到的零仍然保留", () => {
    expect(exportCommentsCsv([makeComment({ likeCount: 0, replyCount: 0, parseWarnings: ["点赞数未明确展示或无法解析", "回复数未明确展示"] })])).toContain('"","","');
    expect(exportCommentsCsv([makeComment({ likeCount: 0, replyCount: 0 })])).toContain('"0","0","');
  });

  it("空结果仍然保留表头", () => {
    expect(exportCommentsCsv([])).toContain("评论内容");
  });

  it("完整导出100000条，不按旧目标截断", () => {
    const comments = Array.from({length: 100000}, (_, index) => makeComment({id: String(index), text: `评论${index + 1}`}));
    const csv = exportCommentsCsv(comments);
    expect(csv.split("\r\n")).toHaveLength(100001);
    expect(csv).toContain('"100000","评论100000"');
  });

  it("只导出清洗后的时间和归属地", () => {
    const csv = exportCommentsCsv([
      makeComment({
        publishTimeText: "2天前·四川 回复 分享 160",
        ipLocationText: "IP属地：四川"
      })
    ]);
    expect(csv).toContain('"2天前·四川"');
    expect(csv).not.toContain("视频标题");
    expect(csv).not.toContain("视频链接");
    expect(csv).not.toContain('"IP属地"');
  });
});
