const express = require('express');
const path = require('node:path');
const { existsSync } = require('node:fs');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const requestLogger = require('./core/requestLogger');
const { sessionMiddleware } = require('./core/session');
const { csrfGuard } = require('./core/auth');
const notFound = require('./core/notFound');
const errorHandler = require('./core/errorHandler');
const apiRoutes = require('./plugins');

const app = express();
if (config.trustProxyLoopback) app.set('trust proxy', 'loopback');

// requestLogger goes first so even body-parsing errors carry a requestId.
app.use(requestLogger);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'img-src': ["'self'", 'data:', 'blob:', 'https://image.tmdb.org'],
      // HTTPS is terminated by Tailscale Serve; localhost development remains HTTP.
      'upgrade-insecure-requests': config.session.cookieSecure ? [] : null,
    },
  },
}));
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use('/api', csrfGuard);

app.use('/api', apiRoutes);
app.use('/api', notFound);

if (config.serveFrontend) {
  const frontend = path.resolve(__dirname, '../../squirl_frontend/dist');
  if (!existsSync(path.join(frontend, 'index.html'))) throw new Error('Build squirl_frontend before enabling SERVE_FRONTEND');
  app.use(express.static(frontend, {
    index: false,
    setHeaders(res, file) {
      res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  app.get(['/', '/app', '/app/*path', '/login', '/signup', '/forgot-password', '/reset-password'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(frontend, 'index.html'));
  });
}

app.use(notFound);
app.use(errorHandler);

module.exports = app;
