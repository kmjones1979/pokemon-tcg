// HTTP routes for the read-along Reading Mode. Distinct from the
// battle-based Story Mode (server-modules/story.js) — this is just
// content delivery: a list endpoint + a story-by-id endpoint. No
// auth required; the content is for kids and contains no PII.
//
//   GET /api/reading/stories        — list summaries (no section text)
//   GET /api/reading/stories/:id    — full story including section text + audio URLs

const { listStories, getStory } = require("../shared/reading-stories");

function mount(app) {
  app.get("/api/reading/stories", (_req, res) => {
    res.json({ stories: listStories() });
  });

  app.get("/api/reading/stories/:id", (req, res) => {
    const story = getStory(req.params.id);
    if (!story) return res.status(404).json({ error: "Story not found." });
    res.json({ story });
  });
}

module.exports = { mount };
