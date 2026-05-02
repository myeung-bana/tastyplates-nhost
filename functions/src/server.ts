import './env-load';
import express from 'express';
import healthzRouter from './routes/healthz';
import docsRouter from './routes/docs';

// Function handlers
import imageUpload from './uploads/image';
import batchUpload from './uploads/batch';
import downloadGooglePhoto from './images/download-google-photo';
import reviewCreate from './reviews/create';
import reviewCreateComment from './reviews/create-comment';
import reviewUpdate from './reviews/update';
import reviewDelete from './reviews/delete';
import reviewFollowingFeed from './reviews/following-feed';
import userMe from './users/me';
import userFollow from './users/follow';
import userUnfollow from './users/unfollow';
import userSuggested from './users/suggested';
import userDelete from './users/delete';
import restaurantSearch from './restaurants/search';
import restaurantMatch from './restaurants/match';
import adminBackfill from './admin/backfill-rating-summary';
import adminMonitoring from './admin/monitoring';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-hasura-admin-secret');
  next();
});

// Express 5 / path-to-regexp v8: bare `*` is invalid — use a regex for OPTIONS preflight
app.options(/.*/, (_req, res) => res.sendStatus(204));

// Health and docs (no /v0 prefix so they're reachable at the root)
app.use(healthzRouter);
app.use(docsRouter);

// ---------------------------------------------------------------------------
// API routes — all under /v0 to match Nhost Functions URL convention
// ---------------------------------------------------------------------------

// Uploads — raw body for binary image data; JSON body for batch
app.post('/v0/uploads/image', express.raw({ type: '*/*', limit: '15mb' }), imageUpload);
app.post('/v0/uploads/batch', express.json({ limit: '50mb' }), batchUpload);

// Images
app.post('/v0/images/download-google-photo', express.json(), downloadGooglePhoto);

// Reviews
app.post('/v0/reviews/create', express.json(), reviewCreate);
app.post('/v0/reviews/create-comment', express.json(), reviewCreateComment);
app.put('/v0/reviews/update', express.json(), reviewUpdate);
app.delete('/v0/reviews/delete', express.json(), reviewDelete);
app.get('/v0/reviews/following-feed', reviewFollowingFeed);

// Users
app.get('/v0/users/me', userMe);
app.post('/v0/users/follow', express.json(), userFollow);
app.post('/v0/users/unfollow', express.json(), userUnfollow);
app.get('/v0/users/suggested', userSuggested);
app.delete('/v0/users/delete', userDelete);

// Restaurants
app.get('/v0/restaurants/search', restaurantSearch);
app.post('/v0/restaurants/match', express.json(), restaurantMatch);

// Admin
app.post('/v0/admin/backfill-rating-summary', express.json(), adminBackfill);
app.get('/v0/admin/monitoring', adminMonitoring);

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`\n🍽  Tastyplates Functions — standalone dev server`);
  console.log(`   API:    http://localhost:${PORT}/v0/...`);
  console.log(`   Health: http://localhost:${PORT}/healthz`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`   Docs:   http://localhost:${PORT}/docs`);
  }
  console.log('');
});

export default app;
