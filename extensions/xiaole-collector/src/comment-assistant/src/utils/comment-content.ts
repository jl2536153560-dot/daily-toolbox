// Only classify non-text reactions. Keep short answers, questions, numbers and
// mixed text/emoji intact; do not guess whether a written opinion is useful.
const COMMENT_EMOTE_LABELS = new Set((
  "微笑 撇嘴 色 发呆 得意 流泪 害羞 闭嘴 睡 大哭 尴尬 发怒 调皮 呲牙 惊讶 难过 酷 冷汗 抓狂 吐 偷笑 可爱 白眼 傲慢 饥饿 困 惊恐 流汗 憨笑 大兵 奋斗 咒骂 疑问 嘘 晕 折磨 衰 骷髅 敲打 再见 擦汗 抠鼻 鼓掌 糗大了 坏笑 左哼哼 右哼哼 哈欠 鄙视 委屈 快哭了 阴险 亲亲 吓 可怜 菜刀 西瓜 啤酒 篮球 乒乓 咖啡 饭 猪头 玫瑰 凋谢 示爱 爱心 心碎 蛋糕 闪电 炸弹 刀 足球 瓢虫 便便 月亮 太阳 礼物 拥抱 强 弱 握手 胜利 抱拳 勾引 拳头 差劲 爱你 no ok 爱情 飞吻 跳跳 发抖 怄火 转圈 磕头 回头 跳绳 挥手 激动 街舞 献吻 左太极 右太极 捂脸 笑哭 泪奔 无语 灵机一动 机智 石化 思考 吐血 惊呆 耶 赞 踩 大笑 比心 送心 666 小鼓掌 感谢来看 看 不看 紫薇别走 绝 耳朵 聪明 得到了 前排 皱眉 发红包 红包 抱抱 加油 奥特曼 脱单doge doge doge_金箍 妙啊 嗑瓜子 吃瓜 打call 滑稽 辣眼睛 捂眼 哦呼 无语了 喜极而泣 酸了 傲娇 保佑 嘟嘟 生气 问号 大笑 可爱 惊喜 点赞 支持 脸红 汗 生病 嘴唇 嘚瑟 眨眼 疯狂 惊吓 呆无辜 疼 蓄力 发财 送花 福烟花 烟花 炸弹 亲亲 飞吻 花 虎年大吉 兔年大吉 龙年大吉 蛇年大吉 马年大吉 马到成功 图片 图 图片评论 表情 表情包 动图 贴纸 image picture photo sticker emoji gif animated_emoticon"
).split(/\s+/u));

export function hasCommentText(value: string | null | undefined, extraEmotes: readonly string[] = []): boolean {
  if (typeof value !== "string") return false;
  const extras = new Set(extraEmotes.map(label => label.trim().toLowerCase()));
  const text = value
    // Keycaps contain ordinary digits; strip the whole emoji before checking text.
    .replace(/[0-9#*]\uFE0F?\u20E3/gu, "")
    .replace(/\[([^\[\]\r\n]{1,50})\]|【([^【】\r\n]{1,50})】/gu, (token, square, wide) => {
      const label = String(square ?? wide).trim().toLowerCase();
      return COMMENT_EMOTE_LABELS.has(label) || extras.has(token.toLowerCase()) || extras.has(label) ? "" : token;
    })
    .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\p{Default_Ignorable_Code_Point}/gu, "");
  return /[\p{L}\p{N}]/u.test(text);
}
