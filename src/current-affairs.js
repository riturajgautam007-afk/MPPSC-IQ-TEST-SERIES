const express = require("express");

module.exports = function currentAffairsRouter({ db, requireAuth, requireAdmin }) {
  const router = express.Router();
  router.use(requireAuth, requireAdmin);

  const feeds = [
    { key: "pib", name: "PIB – भारत सरकार", kind: "official", category: "राष्ट्रीय", url: "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3" },
    { key: "the-hindu", name: "The Hindu – National", kind: "newspaper", category: "राष्ट्रीय", url: "https://www.thehindu.com/news/national/feeder/default.rss" },
    { key: "indian-express", name: "Indian Express – India", kind: "newspaper", category: "राष्ट्रीय", url: "https://indianexpress.com/section/india/feed/" }
  ];

  function decode(s) {
    return String(s || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/\s+/g, " ")
      .trim();
  }
  function getTag(xml, tag) {
    const re = new RegExp("<" + tag + "(?:\\\\s[^>]*)?>([\\\\s\\\\S]*?)<\\\\/" + tag + ">", "i");
    const m = xml.match(re);
    return m ? decode(m[1]) : "";
  }
  function parseFeed(xml, feed) {
    const entries = [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(x => x[0]);
    return entries.slice(0, 35).map(item => {
      const title = getTag(item, "title");
      const link = getTag(item, "link") || getTag(item, "guid");
      const summary = getTag(item, "description").slice(0, 1800);
      const dateText = getTag(item, "pubDate") || getTag(item, "dc:date");
      const date = dateText ? new Date(dateText) : new Date();
      if (!title || !/^https?:\/\//i.test(link)) return null;
      return { title: title.slice(0, 500), link: link.slice(0, 1800), summary, date: Number.isNaN(date.getTime()) ? new Date() : date, feed };
    }).filter(Boolean);
  }

  router.get("/sources", (_q, s) => s.json({
    feeds: feeds.map(({ key, name, kind, category, url }) => ({ key, name, kind, category, url, automated: true })),
    manual_sources: [
      { name: "मध्यप्रदेश जनसंपर्क / MPInfo", kind: "official", url: "https://www.mpinfo.org/", automated: false, note: "वेबसाइट की खबरों को मूल सरकारी लिंक से जाँचकर मैन्युअल रूप से जोड़ें; सत्यापित RSS उपलब्ध होने पर स्वचालित फ़ीड जोड़ी जाएगी।" },
      { name: "मध्यप्रदेश शासन विभाग", kind: "official", url: "https://mp.gov.in/", automated: false },
      { name: "Drishti IAS", kind: "exam_prep", url: "https://www.drishtiias.com/", automated: false },
      { name: "Vision IAS", kind: "exam_prep", url: "https://visionias.in/", automated: false },
      { name: "Telegram Current Affairs", kind: "telegram", url: "", automated: false, note: "Telegram सामग्री को स्वतंत्र पुष्टि के बिना सत्यापित नहीं माना जाएगा।" }
    ]
  }));

  router.get("/stats", async (_q, s) => {
    const r = await db.query("SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='unverified')::int unverified, COUNT(*) FILTER (WHERE status='verified')::int verified, COUNT(*) FILTER (WHERE status='published')::int published FROM current_affairs_items");
    s.json(r.rows[0]);
  });

  router.get("/items", async (q, s) => {
    const status = String(q.query.status || "").trim();
    const category = String(q.query.category || "").trim();
    const limit = Math.min(100, Math.max(1, Number(q.query.limit) || 50));
    const clauses = [], values = [];
    if (["unverified", "verified", "published", "rejected"].includes(status)) { values.push(status); clauses.push("status=$" + values.length); }
    if (category) { values.push(category); clauses.push("category=$" + values.length); }
    values.push(limit);
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const r = await db.query("SELECT id,title,summary,link,source_name,source_type,category,published_at,status,fact_notes,exam_relevance,created_at FROM current_affairs_items " + where + " ORDER BY published_at DESC NULLS LAST,id DESC LIMIT $" + values.length, values);
    s.json(r.rows);
  });

  router.post("/sync", async (_q, s) => {
    const results = [];
    for (const feed of feeds) {
      try {
        const response = await fetch(feed.url, { headers: { "user-agent": "MPPSC-IQ-Current-Affairs/1.0 (+https://mppsc-iq-install.onrender.com)" }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const xml = await response.text();
        const entries = parseFeed(xml, feed);
        let added = 0;
        for (const entry of entries) {
          const r = await db.query(
            "INSERT INTO current_affairs_items(title,summary,link,source_name,source_type,category,published_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,'unverified') ON CONFLICT(link) DO NOTHING RETURNING id",
            [entry.title, entry.summary, entry.link, feed.name, feed.kind, feed.category, entry.date]
          );
          if (r.rowCount) added++;
        }
        results.push({ source: feed.name, fetched: entries.length, added, ok: true });
      } catch (e) {
        results.push({ source: feed.name, ok: false, error: String(e.message || e).slice(0, 220) });
      }
    }
    s.json({ ok: results.some(x => x.ok), results, message: "नई खबरें Unverified अवस्था में सेव की गई हैं; प्रकाशन से पहले समीक्षा आवश्यक है।" });
  });

  router.post("/items", async (q, s) => {
    const x = q.body || {};
    if (!String(x.title || "").trim() || !/^https?:\/\//i.test(String(x.link || ""))) return s.status(400).json({ error: "शीर्षक और वैध स्रोत लिंक आवश्यक हैं।" });
    const r = await db.query(
      "INSERT INTO current_affairs_items(title,summary,link,source_name,source_type,category,published_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,'unverified') ON CONFLICT(link) DO UPDATE SET title=EXCLUDED.title,summary=EXCLUDED.summary RETURNING id",
      [String(x.title).slice(0, 500), String(x.summary || "").slice(0, 1800), String(x.link).slice(0, 1800), String(x.source_name || "मैन्युअल स्रोत").slice(0, 200), String(x.source_type || "manual").slice(0, 40), String(x.category || "अन्य").slice(0, 80), x.published_at ? new Date(x.published_at) : new Date()]
    );
    s.json({ id: r.rows[0].id });
  });

  router.patch("/items/:id", async (q, s) => {
    const x = q.body || {}, id = Number(q.params.id);
    const allowed = ["title", "summary", "category", "fact_notes", "exam_relevance"];
    const fields = [], values = [];
    for (const key of allowed) if (x[key] !== undefined) { values.push(String(x[key]).slice(0, key === "summary" ? 1800 : 3000)); fields.push(key + "=$" + values.length); }
    if (x.status !== undefined) {
      if (!["unverified", "verified", "rejected"].includes(x.status)) return s.status(400).json({ error: "मान्य स्थिति चुनें।" });
      values.push(x.status); fields.push("status=$" + values.length);
    }
    if (!fields.length) return s.status(400).json({ error: "अपडेट करने के लिए फ़ील्ड नहीं मिली।" });
    values.push(id);
    const r = await db.query("UPDATE current_affairs_items SET " + fields.join(",") + ",updated_at=NOW() WHERE id=$" + values.length + " RETURNING id,status", values);
    if (!r.rowCount) return s.status(404).json({ error: "खबर नहीं मिली।" });
    s.json(r.rows[0]);
  });

  router.post("/items/:id/publish", async (q, s) => {
    const id = Number(q.params.id);
    const item = (await db.query("SELECT * FROM current_affairs_items WHERE id=$1", [id])).rows[0];
    if (!item) return s.status(404).json({ error: "खबर नहीं मिली।" });
    if (item.status !== "verified") return s.status(409).json({ error: "पहले खबर की जाँच करके Verified करें।" });
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.CURRENT_AFFAIRS_CHAT_ID;
    if (!token || !chatId) return s.status(503).json({ error: "Telegram publishing के लिए Render में CURRENT_AFFAIRS_CHAT_ID सेट करना बाकी है; Bot token भी configured होना चाहिए।" });
    const esc = v => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const text = "<b>" + esc(item.title) + "</b>\n\n" + esc(item.summary || "संक्षिप्त विवरण उपलब्ध नहीं है।") +
      "\n\n<b>MPPSC उपयोगिता:</b> " + esc(item.exam_relevance || "संबंधित सिलेबस से जोड़कर अध्ययन करें।") +
      (item.fact_notes ? "\n\n<b>महत्वपूर्ण तथ्य:</b>\n" + esc(item.fact_notes) : "") +
      "\n\n<b>स्रोत:</b> <a href=\"" + esc(item.link) + "\">" + esc(item.source_name) + "</a>\n\n#MPPSCIQ #CurrentAffairs";
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) return s.status(502).json({ error: "Telegram ने संदेश स्वीकार नहीं किया। Bot की channel/group permissions जाँचें।" });
    await db.query("UPDATE current_affairs_items SET status='published',published_to_telegram_at=NOW(),telegram_message_id=$1,updated_at=NOW() WHERE id=$2", [String(result.result.message_id), id]);
    s.json({ ok: true, message_id: result.result.message_id });
  });

  return router;
};
