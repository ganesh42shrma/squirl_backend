const AppError = require('./AppError');

/**
 * validate(z.object({ body?, query?, params? }))
 * Parses the request and writes the parsed (coerced, defaulted) values back onto req.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, query: req.query, params: req.params });

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return next(AppError.badRequest('Validation failed', 'VALIDATION_ERROR', details));
    }

    const { body, query, params } = result.data;
    if (body !== undefined) req.body = body;
    // req.query is a getter in Express 5, so it has to be redefined instead of assigned.
    if (query !== undefined) Object.defineProperty(req, 'query', { value: query, writable: true });
    if (params !== undefined) Object.defineProperty(req, 'params', { value: params, writable: true });

    next();
  };
}

module.exports = validate;
