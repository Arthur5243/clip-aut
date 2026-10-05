import express from 'express';
import { getClips, registerClipsRoute } from './clips.mjs';

const app = express();
app.get('/api/clips', async (req, res) => {
  try {
    const players = (req.query.players || '').split(',').map(s => s.trim()).filter(Boolean);
    res.json(await getClips({
      game: req.query.game || 'valorant',
      limit: Number(req.query.limit) || 30,
      ...(players.length ? { players } : {}),
    }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.get('/health', (_, res) => res.send('ok'));
app.use(express.static(new URL('./public', import.meta.url).pathname));
app.listen(process.env.PORT || 3000, () => console.log('clip-rounds up'));
