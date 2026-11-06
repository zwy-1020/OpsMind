// 本地相似度计算：字符二元组（bigram）余弦相似度
// 用于候选召回（Top-K），最终语义判定由大模型打分完成
(function () {
  function toBigrams(text) {
    const s = String(text || '')
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, '');
    const grams = new Map();
    if (s.length === 1) {
      grams.set(s, 1);
      return grams;
    }
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      grams.set(g, (grams.get(g) || 0) + 1);
    }
    return grams;
  }

  function cosine(mapA, mapB) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [, v] of mapA) na += v * v;
    for (const [k, v] of mapB) {
      nb += v * v;
      const a = mapA.get(k);
      if (a) dot += a * v;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // 单对相似度
  window.similarityOf = function (textA, textB) {
    return cosine(toBigrams(textA), toBigrams(textB));
  };

  // 从候选列表中取相似度最高的前 topK 条
  // 返回 [{ item, localScore }]，按 localScore 降序
  window.rankCandidates = function (query, items, topK) {
    const qGrams = toBigrams(query);
    const scored = items.map((item) => {
      const doc = [item.title, item.content, item.error_code, (item.tags || []).join(' ')].filter(Boolean).join(' ');
      const score = cosine(qGrams, toBigrams(doc));
      return { item, localScore: score };
    });
    scored.sort((a, b) => b.localScore - a.localScore);
    return scored.slice(0, topK);
  };

  /* ---------- 报错码精确匹配 ----------
     数据库报错的本质是「错误码 → 固定成因 → 固定处理」，语义检索容易把 1045 与 1044
     混为一谈，因此单独走一条精确通道：识别提问中的错误码，直接命中带同一 error_code
     的条目，命中后无需调用大模型（更快、更准、不耗额度）。 */

  function normCode(v) {
    return String(v || '').toUpperCase().replace(/[\s\-_]/g, '');
  }

  // 提取提问中的候选错误码（可能多个）
  window.extractErrorCodes = function (text) {
    const s = String(text || '').toUpperCase();
    const out = new Set();
    const add = (v) => {
      const k = normCode(v);
      // 纯数字码 3-5 位；SQLSTATE 形如 28P01；带前缀码形如 ORA12541
      if (/^\d{3,5}$/.test(k) || /^[0-9][0-9A-Z]{4}$/.test(k) || /^[A-Z]{2,4}\d{4,5}$/.test(k)) out.add(k);
    };
    // Oracle / TNS / 其他带前缀的码
    (s.match(/(?:ORA|TNS|PLS|SP2|IMG)\s*-?\s*\d{5}/g) || []).forEach(add);
    // 显式标注的 SQLSTATE
    (s.match(/SQLSTATE[:：\s]*([0-9A-Z]{5})/g) || []).forEach((m) => add(m.replace(/^.*?([0-9A-Z]{5})$/, '$1')));
    // 裸错误码：1045 / 2003 / 28P01 / 18456 / 12541
    (s.match(/[0-9][0-9A-Z]{2,4}/g) || []).forEach(add);
    return Array.from(out);
  };

  // 用库内 error_code 建索引：归一化码 → 条目数组
  window.buildCodeIndex = function (items) {
    const index = new Map();
    (items || []).forEach((item) => {
      String(item.error_code || '')
        .split(/[,，;；、/\s]+/)
        .forEach((raw) => {
          const k = normCode(raw);
          if (!k) return;
          if (!index.has(k)) index.set(k, []);
          const arr = index.get(k);
          if (!arr.some((x) => x.id === item.id)) arr.push(item);
        });
    });
    return index;
  };

  // 精确匹配：返回 [{ item, code }]，按提问中出现的顺序去重
  window.matchErrorCodes = function (query, itemsOrIndex) {
    const index = itemsOrIndex instanceof Map ? itemsOrIndex : window.buildCodeIndex(itemsOrIndex);
    if (!index.size) return [];
    const codes = window.extractErrorCodes(query);
    const seen = new Set();
    const hits = [];
    codes.forEach((code) => {
      const arr = index.get(code);
      if (!arr) return;
      arr.forEach((item) => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        hits.push({ item, code: String(item.error_code || code) });
      });
    });
    return hits;
  };
})();
