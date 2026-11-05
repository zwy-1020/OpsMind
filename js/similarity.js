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
      const doc = [item.title, item.content, (item.tags || []).join(' ')].filter(Boolean).join(' ');
      const score = cosine(qGrams, toBigrams(doc));
      return { item, localScore: score };
    });
    scored.sort((a, b) => b.localScore - a.localScore);
    return scored.slice(0, topK);
  };
})();
