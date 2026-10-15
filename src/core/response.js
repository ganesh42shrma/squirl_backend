function sendSuccess(res, data, { status = 200, message, meta } = {}) {
  return res.status(status).json({
    success: true,
    ...(message && { message }),
    data,
    ...(meta && { meta }),
  });
}

module.exports = { sendSuccess };
