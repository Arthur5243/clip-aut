import express from 'express';
import { registerClipsRoute, start } from './clips.mjs';

const app = express();
registerClipsRoute(app);
app.get('/health', (_, res) => res.send('ok'));
app.use(express.static(new URL('./public', import.meta.url).pathname));
app.listen(process.env.PORT || 3000, () => {
  console.log('clip-rounds up');
  start(); // analyse des matchs pro en arrière-plan (max ~27 req/min)
});
