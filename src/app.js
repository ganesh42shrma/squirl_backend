const express = require('express');
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

// requestLogger goes first so even body-parsing errors carry a requestId.
app.use(requestLogger);
app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);
app.use('/api', csrfGuard);

app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
